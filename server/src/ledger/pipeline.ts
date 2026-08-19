import type Database from "better-sqlite3";
import { emitEvent } from "../events/emitter.js";
import { evaluatePolicy } from "../policy/engine.js";
import type { PolicyDocument } from "../policy/schemas.js";
import { ToolTimeoutError } from "../tools/errors.js";
import { getPayments, issueCreditRaw, issueRefundRaw, type MoneyCallResult } from "../tools/mockApi.js";
import type { ActionType, MoneyActionResult } from "../tools/schemas.js";
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
        note: (raw.note as string) ?? "Reconciliation confirmed the action had already completed.",
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

function callRawMockApi(
  db: Database.Database,
  row: Pick<LedgerRow, "actionType" | "orderId" | "customerId" | "amount" | "idempotencyKey">,
): Promise<MoneyCallResult> {
  if (row.actionType === "refund") {
    if (!row.orderId) throw new Error("Refund requires an orderId; this should have been denied by policy.");
    return issueRefundRaw(db, {
      orderId: row.orderId,
      customerId: row.customerId,
      amount: row.amount,
      idempotencyKey: row.idempotencyKey,
    });
  }
  return issueCreditRaw(db, {
    orderId: row.orderId,
    customerId: row.customerId,
    amount: row.amount,
    idempotencyKey: row.idempotencyKey,
  });
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

  const verdict = evaluatePolicy(db, policy, {
    actionType: input.actionType,
    orderId: input.orderId,
    amount: input.amount,
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

// Called when a human resolves an `awaiting_approval` row via the approval
// panel, OR grants an exception on a `denied` row via the escalation queue
// (server/src/index.ts). Both re-run the exact same pipeline path a policy
// `allow` would have taken, reusing the row's existing idempotency key, so
// this is still exactly-once safe: the row has never actually called the raw
// mock API before this point (deny and requires_approval both short-circuit
// before any external call), so this is the first real attempt either way.
// `remark` is the human reviewer's note; when present it replaces the ledger
// row's reason so the audit trail carries the human's stated justification
// instead of (or alongside) the original policy verdict text.
export async function resolveApprovedAction(
  db: Database.Database,
  ledgerRow: LedgerRow,
  remark?: string | null,
  label: string = "Approved by human reviewer",
): Promise<MoneyActionResult> {
  const reasonOverride = remark ? `${label}: ${remark}` : undefined;
  return await attemptAndHandle(db, ledgerRow, reasonOverride);
}

export function resolveRejectedAction(
  db: Database.Database,
  ledgerRow: LedgerRow,
  remark?: string | null,
  label: string = "Rejected by human approver",
): MoneyActionResult {
  const reason = remark ? `${label}: ${remark}` : `${label}.`;
  const updated = updateLedgerStatus(db, ledgerRow.id, "denied", undefined, reason);
  return mapRowToResult(updated);
}
