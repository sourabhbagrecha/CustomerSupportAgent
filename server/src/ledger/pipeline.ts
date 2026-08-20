import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { ZodError } from "zod";
import { emitEvent, listEventsForThread } from "../events/emitter.js";
import { evaluatePolicy } from "../policy/engine.js";
import type { PolicyDocument } from "../policy/schemas.js";
import { compactZodIssues, ToolTimeoutError } from "../tools/errors.js";
import { getPayments, issueCreditRaw, issueRefundRaw, type MoneyCallResult } from "../tools/mockApi.js";
import { RawPaymentResultSchema, type ActionType, type MoneyActionResult } from "../tools/schemas.js";
import { insertApproval } from "./approvals.js";
import { deriveIdempotencyKey } from "./idempotency.js";
import { findLedgerByIdempotencyKey, insertLedgerRow, updateLedgerStatus, type LedgerRow } from "./store.js";

export interface MoneyActionInput {
  threadId: string;
  customerId: string;
  actionType: ActionType;
  orderId: string | null;
  amount: number;
  reason: string;
  // P1-4/P1-9 hardening: set by agentTools.ts when the model's stated reason
  // for this call rests on the customer's claim that a prior agent already
  // promised this outcome (prompt.ts hard rule instructs the model to flag
  // this honestly). When true, runMoneyAction refuses to move any money,
  // capped or not, unless get_conversation_history was actually called
  // earlier in this same turn AND that call actually found something: see
  // promiseEvidenceFoundThisTurn below. This is the deterministic backstop
  // for a claim the model cannot verify on its own.
  citesPriorPromise?: boolean;
}

// P1-4 (fix P1-9): did this thread's current turn call get_conversation_history
// AND get back at least one hit before this money action? "This turn" =
// since the most recent user_message step event for the thread
// (server/src/index.ts emits one at the top of every POST /api/chat).
// Deliberately reads the durable events table rather than carrying a new
// field through AgentState/graph.ts: CLAUDE.md keeps the graph at exactly
// three nodes, and the events table is already the single source of truth
// for "what happened this turn" (CLAUDE.md invariant 4).
//
// This used to check only that a get_conversation_history tool_call
// happened, not that it returned anything relevant (scenario 22,
// "fabricated-promise"): a model could call get_conversation_history, get
// zero matching hits back, and still set citesPriorPromise: true on the
// money action, and the old check let that through because a lookup had
// technically occurred. get_conversation_history's own tool_result event
// (agentTools.ts) always carries `count: validated.hits.length`, so this now
// requires a tool_result for that tool, this turn, with count > 0: actual
// evidence a promise-shaped conversation was found, not merely that a call
// was made.
function promiseEvidenceFoundThisTurn(db: Database.Database, threadId: string): boolean {
  const events = listEventsForThread(db, threadId);
  let turnStartId = -1;
  for (const e of events) {
    if (e.type === "step" && (e.payload as { step?: string } | undefined)?.step === "user_message") {
      turnStartId = e.id ?? turnStartId;
    }
  }
  return events.some((e) => {
    if ((e.id ?? -1) <= turnStartId) return false;
    if (e.type !== "tool_result") return false;
    const payload = e.payload as { tool?: string; count?: number } | undefined;
    return payload?.tool === "get_conversation_history" && (payload.count ?? 0) > 0;
  });
}

function parseRaw(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// Maps a resolved (non-pending, non-failed) ledger row to the shape the
// model sees. Every branch of MoneyActionResultSchema is covered. Exported
// so callers outside the money path (the approval-resolve route) can read
// back the outcome of a row they did not themselves resolve, to compose a
// customer notice (see server/src/agent/notify.ts).
export function mapRowToResult(row: LedgerRow): MoneyActionResult {
  const base = {
    ledgerId: row.id,
    actionType: row.actionType,
    amount: row.amount,
    currency: "INR" as const,
    orderId: row.orderId,
  };
  const raw = parseRaw(row.rawResponse);
  // The String(raw.paymentId ?? "") coercion below is defensive, not the
  // primary guard: as of Phase 3, callRawMockApi parses the raw provider
  // result with RawPaymentResultSchema before it is ever persisted, so a row
  // written from here on always has a well-formed paymentId. This stays only
  // to read back rows persisted before that validation existed.
  switch (row.status) {
    case "succeeded":
      return {
        ...base,
        status: "succeeded",
        receipt: { paymentId: String(raw.paymentId ?? ""), providerReference: (raw.providerReference as string) ?? null },
      };
    case "reconciled":
      return {
        ...base,
        status: "reconciled",
        receipt: { paymentId: String(raw.paymentId ?? ""), providerReference: (raw.providerReference as string) ?? null },
        // P1-7: this `note` crosses the tool boundary into the model's
        // context and, for a plain (non-approval) reconciled result, the
        // model composes the customer reply directly from it. It must
        // therefore read as a first-time success, never as internal
        // machinery ("reconciliation", "duplicate", "no retry issued"). The
        // real technical note (what actually happened, for the audit trail)
        // stays in raw_response/reason untouched; this is a separate,
        // deliberately generic customer-safe string, not derived from it.
        note: "Processed successfully.",
      };
    case "denied":
      return { ...base, status: "denied", policyReason: row.reason };
    case "awaiting_approval":
      return { ...base, status: "awaiting_approval", policyReason: row.reason };
    case "failed_unknown":
      return {
        ...base,
        status: "failed_unknown",
        policyReason: row.reason || "The action could not be confirmed and has been escalated to a human.",
      };
    default:
      throw new Error(`Ledger row ${row.id} has non-terminal status "${row.status}" and cannot be mapped to a result.`);
  }
}

// Parses the raw provider response with RawPaymentResultSchema before
// anything downstream trusts it. A malformed response throws ZodError, which
// attemptAndHandle below routes exactly like a ToolTimeoutError: an uncertain
// outcome (the provider may have moved money but the response is unreadable)
// that must reconcile via get_payments before any retry, never a blind
// retry with a fresh key.
async function callRawMockApi(
  db: Database.Database,
  row: Pick<LedgerRow, "actionType" | "orderId" | "customerId" | "amount" | "idempotencyKey">,
): Promise<MoneyCallResult> {
  let raw: MoneyCallResult;
  if (row.actionType === "refund") {
    if (!row.orderId) throw new Error("Refund requires an orderId; this should have been denied by policy.");
    raw = await issueRefundRaw(db, {
      orderId: row.orderId,
      customerId: row.customerId,
      amount: row.amount,
      idempotencyKey: row.idempotencyKey,
    });
  } else {
    raw = await issueCreditRaw(db, {
      orderId: row.orderId,
      customerId: row.customerId,
      amount: row.amount,
      idempotencyKey: row.idempotencyKey,
    });
  }
  return RawPaymentResultSchema.parse(raw);
}

// Section 7 step 5: on timeout/unknown, reconcile via get_payments before any
// retry; retry once with the SAME key; never issue a second key.
async function reconcileAndFinalize(db: Database.Database, row: LedgerRow): Promise<MoneyActionResult> {
  let matching: MoneyCallResult | undefined;
  if (row.orderId) {
    const payments = await getPayments(db, row.orderId);
    const hit = payments.find((p) => p.idempotencyKey === row.idempotencyKey && p.status === "succeeded");
    if (hit) matching = { paymentId: hit.id, providerReference: hit.providerReference ?? "" };
  }

  if (matching) {
    const updated = updateLedgerStatus(db, row.id, "reconciled", {
      paymentId: matching.paymentId,
      providerReference: matching.providerReference,
      note: "Reconciliation found the action had already completed; no duplicate was issued.",
    });
    emitEvent(db, {
      threadId: row.threadId,
      type: "guardrail",
      payload: { stage: "reconciliation", outcome: "matched_existing_payment", ledgerId: row.id },
    });
    return mapRowToResult(updated);
  }

  try {
    const result = await callRawMockApi(db, row);
    const updated = updateLedgerStatus(db, row.id, "succeeded", result);
    return mapRowToResult(updated);
  } catch (err) {
    const updated = updateLedgerStatus(
      db,
      row.id,
      "failed_unknown",
      { error: err instanceof Error ? err.message : String(err) },
      "Could not be confirmed after reconciliation and one retry; escalated for manual review.",
    );
    emitEvent(db, {
      threadId: row.threadId,
      type: "escalation",
      payload: {
        reason: "unknown_failure",
        ledgerId: row.id,
        actionType: row.actionType,
        amount: row.amount,
        orderId: row.orderId,
        detail: "Action status could not be confirmed after reconciliation and one retry.",
      },
    });
    return mapRowToResult(updated);
  }
}

async function attemptAndHandle(
  db: Database.Database,
  row: LedgerRow,
  successReasonOverride?: string,
): Promise<MoneyActionResult> {
  try {
    const result = await callRawMockApi(db, row);
    const updated = updateLedgerStatus(db, row.id, "succeeded", result, successReasonOverride);
    return mapRowToResult(updated);
  } catch (err) {
    if (err instanceof ToolTimeoutError) {
      emitEvent(db, {
        threadId: row.threadId,
        type: "fault",
        payload: { fault: "refund_timeout_after_success", ledgerId: row.id, message: err.message },
      });
      return await reconcileAndFinalize(db, row);
    }
    if (err instanceof ZodError) {
      // The provider's response failed RawPaymentResultSchema validation:
      // an uncertain outcome, not a confirmed failure. The provider may have
      // moved money and returned a garbled response, so this is treated
      // exactly like ToolTimeoutError above, never as grounds to retry blind.
      emitEvent(db, {
        threadId: row.threadId,
        type: "error",
        payload: { stage: "provider_response_validation", ledgerId: row.id, issues: compactZodIssues(err) },
      });
      return await reconcileAndFinalize(db, row);
    }
    updateLedgerStatus(db, row.id, "failed", { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

// The money path (CLAUDE.md invariant 1 / PLAN Section 7). The LLM proposes
// via issue_refund/issue_credit tool calls; this function disposes. It is
// the only code path allowed to move money, and it always writes a ledger
// row before any external call.
export async function runMoneyAction(
  db: Database.Database,
  policy: PolicyDocument,
  input: MoneyActionInput,
): Promise<MoneyActionResult> {
  const idempotencyKey = deriveIdempotencyKey(input.threadId, input.actionType, input.orderId, input.amount);
  const existing = findLedgerByIdempotencyKey(db, idempotencyKey);

  if (existing) {
    if (existing.status === "pending") return await reconcileAndFinalize(db, existing);
    if (existing.status === "failed") return await attemptAndHandle(db, existing);
    return mapRowToResult(existing);
  }

  // P1-4 hardening: a claimed prior promise must be verified by an actual
  // get_conversation_history call in this same turn that actually found
  // something before ANY automatic money moves on the strength of it, capped
  // amount included. This runs ahead of (and instead of) the normal policy
  // check: an unverified claim is denied outright, never partially honored,
  // regardless of whether a lookup call happened at all.
  if (input.citesPriorPromise && !promiseEvidenceFoundThisTurn(db, input.threadId)) {
    emitEvent(db, {
      threadId: input.threadId,
      type: "guardrail",
      payload: {
        stage: "promise_verification",
        outcome: "blocked_no_history_evidence",
        actionType: input.actionType,
        orderId: input.orderId,
        amount: input.amount,
      },
    });
    const row = insertLedgerRow(db, {
      idempotencyKey,
      threadId: input.threadId,
      actionType: input.actionType,
      customerId: input.customerId,
      orderId: input.orderId,
      amount: input.amount,
      currency: "INR",
      status: "denied",
      reason:
        "claimed promise not found in history: get_conversation_history was not called this turn to verify the customer's claim of a prior commitment.",
    });
    return mapRowToResult(row);
  }

  const verdict = evaluatePolicy(db, policy, {
    actionType: input.actionType,
    orderId: input.orderId,
    amount: input.amount,
    customerId: input.customerId,
  });

  emitEvent(db, {
    threadId: input.threadId,
    type: "guardrail",
    payload: {
      stage: "policy_check",
      verdict: verdict.verdict,
      reason: verdict.reason,
      actionType: input.actionType,
      orderId: input.orderId,
      amount: input.amount,
    },
  });

  if (verdict.verdict === "deny") {
    const row = insertLedgerRow(db, {
      idempotencyKey,
      threadId: input.threadId,
      actionType: input.actionType,
      customerId: input.customerId,
      orderId: input.orderId,
      amount: input.amount,
      currency: "INR",
      status: "denied",
      reason: verdict.reason,
    });
    return mapRowToResult(row);
  }

  if (verdict.verdict === "requires_approval") {
    const row = insertLedgerRow(db, {
      idempotencyKey,
      threadId: input.threadId,
      actionType: input.actionType,
      customerId: input.customerId,
      orderId: input.orderId,
      amount: input.amount,
      currency: "INR",
      status: "awaiting_approval",
      reason: verdict.reason,
    });
    insertApproval(db, {
      ledgerId: row.id,
      threadId: input.threadId,
      actionType: input.actionType,
      customerId: input.customerId,
      orderId: input.orderId,
      amount: input.amount,
      policyReason: verdict.reason,
    });
    return mapRowToResult(row);
  }

  const row = insertLedgerRow(db, {
    idempotencyKey,
    threadId: input.threadId,
    actionType: input.actionType,
    customerId: input.customerId,
    orderId: input.orderId,
    amount: input.amount,
    currency: "INR",
    status: "pending",
    reason: verdict.reason,
  });
  return await attemptAndHandle(db, row);
}

// P0-1 hardening: creates a NEW ledger row for a money amount an escalation
// is about (typically the above-cap remainder after a policy-capped portion
// already auto-succeeded, prompt.ts hard rule 6), instead of the old bug of
// tying the escalation to the already-settled capped row. Status is
// `awaiting_approval` from the start: nothing here calls the policy engine
// (the whole point of escalating is that a human decides), and nothing here
// calls the raw mock API, so this is exactly as safe pre-decision as any
// other awaiting_approval row. The idempotency key intentionally differs
// from deriveIdempotencyKey's formula (thread+action+order+amount): a
// monotonic per-thread sequence is folded in so this row's key can never
// collide with a "real" issue_refund/issue_credit call for the same
// thread/action/order/amount, past or future.
export function createEscalationLedgerRow(
  db: Database.Database,
  input: { threadId: string; customerId: string; actionType: ActionType; orderId: string | null; amount: number; reason: string },
): LedgerRow {
  const sequence = (
    db.prepare(`SELECT COUNT(*) AS n FROM actions_ledger WHERE thread_id = ?`).get(input.threadId) as { n: number }
  ).n;
  const idempotencyKey = createHash("sha256")
    .update(`escalation:${input.threadId}:${input.actionType}:${input.orderId ?? "none"}:${input.amount.toFixed(2)}:${sequence}`)
    .digest("hex");
  const row = insertLedgerRow(db, {
    idempotencyKey,
    threadId: input.threadId,
    actionType: input.actionType,
    customerId: input.customerId,
    orderId: input.orderId,
    amount: input.amount,
    currency: "INR",
    status: "awaiting_approval",
    reason: input.reason,
  });
  emitEvent(db, {
    threadId: input.threadId,
    type: "guardrail",
    payload: { stage: "escalation_ledger_row_created", ledgerId: row.id, actionType: row.actionType, orderId: row.orderId, amount: row.amount },
  });
  return row;
}

// Writes the human-resolution metadata columns (schema.sql). Separate from
// the `reason`/`status`/`raw_response` write in attemptAndHandle /
// updateLedgerStatus above so a crash between the two leaves the row at
// worst missing this bookkeeping, never in a state where the ledger's
// primary status/reason are inconsistent with each other.
function finalizeHumanResolution(
  db: Database.Database,
  ledgerId: number,
  input: { resolution: "approved" | "rejected"; resolvedBy: string; resolutionRemark: string | null; overrideBy: string | null },
): void {
  db.prepare(
    `UPDATE actions_ledger SET resolution = @resolution, resolved_by = @resolvedBy, resolution_remark = @resolutionRemark, override_by = @overrideBy WHERE id = @id`,
  ).run({ id: ledgerId, ...input });
}

// Called when a human resolves an `awaiting_approval` row via the approval
// panel, OR grants an exception on a `denied`/`awaiting_approval` row via the
// escalation queue (server/src/index.ts). Both re-run the exact same
// pipeline path a policy `allow` would have taken, reusing the row's
// existing idempotency key, so this is still exactly-once safe: the row has
// never actually called the raw mock API before this point (deny and
// requires_approval both short-circuit before any external call), so this is
// the first real attempt either way.
//
// P0-1 hardening: append-only guard. `ledgerRow.resolution !== null` means a
// human has already resolved this exact row once before (double-click, two
// tabs, a retried request racing itself, or a stale reference from an old
// escalation); `status === "succeeded" | "reconciled"` means money already
// moved, by any path. Either way this returns the row's existing outcome
// completely unchanged rather than re-executing or overwriting `reason`
// again: settled rows are append-only from here on. The idempotency key at
// the mock-provider layer (mockApi.ts's findByIdempotencyKey) is the second,
// independent line of defense against ever moving money twice.
//
// `remark` is the human reviewer's INTERNAL note (P0-3: never the
// customer-facing text); when present it replaces the ledger row's reason so
// the audit trail carries the human's stated justification. `resolvedBy` is
// the approver identity recorded on the row; `isOverride` marks a grant that
// bypassed the policy engine entirely (an escalation "grant exception"), and
// is what populates `override_by`.
export async function resolveApprovedAction(
  db: Database.Database,
  ledgerRow: LedgerRow,
  remark?: string | null,
  label: string = "Approved by human reviewer",
  resolvedBy: string = "human_agent",
  isOverride: boolean = false,
): Promise<MoneyActionResult> {
  if (ledgerRow.resolution !== null || ledgerRow.status === "succeeded" || ledgerRow.status === "reconciled") {
    return mapRowToResult(ledgerRow);
  }
  const reasonOverride = remark ? `${label}: ${remark}` : undefined;
  const result = await attemptAndHandle(db, ledgerRow, reasonOverride);
  finalizeHumanResolution(db, ledgerRow.id, {
    resolution: "approved",
    resolvedBy,
    resolutionRemark: remark ?? null,
    overrideBy: isOverride ? resolvedBy : null,
  });
  return result;
}

export function resolveRejectedAction(
  db: Database.Database,
  ledgerRow: LedgerRow,
  remark?: string | null,
  label: string = "Rejected by human approver",
  resolvedBy: string = "human_agent",
): MoneyActionResult {
  if (ledgerRow.resolution !== null || ledgerRow.status === "succeeded" || ledgerRow.status === "reconciled") {
    return mapRowToResult(ledgerRow);
  }
  const reason = remark ? `${label}: ${remark}` : `${label}.`;
  const updated = updateLedgerStatus(db, ledgerRow.id, "denied", undefined, reason);
  finalizeHumanResolution(db, ledgerRow.id, {
    resolution: "rejected",
    resolvedBy,
    resolutionRemark: remark ?? null,
    overrideBy: null,
  });
  return mapRowToResult(updated);
}
