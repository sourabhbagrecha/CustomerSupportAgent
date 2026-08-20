import "./env.js";

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import type { StateSnapshot } from "@langchain/langgraph";
import type Database from "better-sqlite3";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { buildAgentGraph, type AgentGraph } from "./agent/graph.js";
import { appendDecisionNotice, buildDecisionNotice } from "./agent/notify.js";
import { runTurn, resumeApprovalTurn, type RunTurnResult } from "./agent/runTurn.js";
import type { AgentState } from "./agent/state.js";
import { getDb } from "./db/client.js";
import { resetDemoData } from "./db/resetDemo.js";
import { emitEvent, listEventsForThread, subscribe, subscribeStream } from "./events/emitter.js";
import {
  BASE_URL_PRESETS,
  listApiKeyEnvNames,
  normalizeBaseUrl,
  resolveAgentProvider,
  resolveJudgeProvider,
} from "./agent/providerConfig.js";
import { deleteRun, isValidRunId, listRuns, listScenarioFiles, readRun } from "./evals/runRecord.js";
import { EvalRunInProgressError, getCurrentRun, startEvalRun, type EvalRunHandle } from "./evals/runner.js";
import { clearAllFaults, getSnapshot, setFault } from "./faults/registry.js";
import {
  getApprovalById,
  getPendingApprovalForThread,
  listPendingApprovals,
  markApprovalExecuted,
  resolveApprovalWithDecisionEvent,
  type ApprovalRow,
} from "./ledger/approvals.js";
import { mapRowToResult, resolveApprovedAction, resolveRejectedAction } from "./ledger/pipeline.js";
import { countLedgerRows, getLedgerById, listLedgerRows } from "./ledger/store.js";
import {
  ApprovalResolveRequestSchema,
  ChatRequestSchema,
  EvalRunRequestSchema,
  FaultRequestSchema,
  LedgerQuerySchema,
} from "./httpSchemas.js";
import { DEMO_PERSONAS } from "./personas.js";
import type { MoneyActionResult } from "./tools/schemas.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = join(__dirname, "..", "..", "dist", "web");

const db = getDb();
const graph = buildAgentGraph(db);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

await app.register(fastifyCors, { origin: true });

if (existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, { root: WEB_DIST, prefix: "/" });
}

app.get("/api/health", async () => ({ ok: true }));

// Restores seed customers/orders/payments/policies from /fixtures and clears
// all runtime demo state (ledger, approvals/escalations, events, threads,
// faults); leaves evals/runs/ untouched. See server/src/db/resetDemo.ts. The
// frontend reset button that calls this route is owned by another group.
app.post("/api/demo/reset", async (request, reply) => {
  try {
    return resetDemoData();
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ error: "Failed to reset demo data." });
  }
});

// ---------------------------------------------------------------------------
// Eval runs (plan 007). The archive under evals/runs/ is read-only here
// except for DELETE; POST /api/evals/runs starts the same vitest suite
// `npm run eval` runs, as a child process with the chosen provider in its
// environment. API keys are referenced by env var name and resolved
// server-side; no key is ever read from or written to a request or a record.
// ---------------------------------------------------------------------------

function currentRunView(handle: EvalRunHandle | null) {
  if (!handle) return null;
  return { run: handle.run, logTail: handle.logTail.slice(-60), expectedScenarioCount: handle.expectedScenarioCount };
}

app.get("/api/evals/config", async () => {
  const agent = resolveAgentProvider();
  const judge = resolveJudgeProvider();
  return {
    defaults: {
      baseUrl: agent.baseUrl,
      primaryModel: agent.primaryModel ?? "",
      fallbackModel: agent.fallbackModel ?? "",
      apiKeyEnv: "OPENAI_API_KEY",
      judgeModel: judge.model ?? "",
      judgeBaseUrl: judge.baseUrl,
      judgeApiKeyEnv: process.env.JUDGE_API_KEY ? "JUDGE_API_KEY" : "OPENAI_API_KEY",
    },
    apiKeyEnvs: listApiKeyEnvNames(),
    presets: BASE_URL_PRESETS,
    scenarios: listScenarioFiles().map((s) => ({ number: s.number, name: s.name })),
  };
});

app.get("/api/evals/runs", async (request) => {
  const { runs, invalid } = listRuns();
  if (invalid.length > 0) request.log.warn({ invalid }, "evals/runs contains files that do not match the run schema");
  return { runs };
});

app.get<{ Params: { runId: string } }>("/api/evals/runs/:runId", async (request, reply) => {
  const run = readRun(request.params.runId);
  if (!run) return reply.code(404).send({ error: "No such eval run." });
  return { run };
});

app.delete<{ Params: { runId: string } }>("/api/evals/runs/:runId", async (request, reply) => {
  const { runId } = request.params;
  if (!isValidRunId(runId)) return reply.code(400).send({ error: "Invalid run id." });
  if (!deleteRun(runId)) return reply.code(404).send({ error: "No such eval run." });
  return { ok: true };
});

app.post("/api/evals/runs", async (request, reply) => {
  const parsed = EvalRunRequestSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
  const body = parsed.data;

  const availableKeys = listApiKeyEnvNames();
  const apiKeyEnv = body.apiKeyEnv;
  if (!availableKeys.includes(apiKeyEnv)) {
    return reply.code(400).send({ error: `${apiKeyEnv} is not set in the server's environment (.env).` });
  }
  const serverJudge = resolveJudgeProvider();
  // The judge defaults to whatever this server's own env resolves (normally
  // FALLBACK_MODEL on OPENAI_API_KEY), not to the run's provider, so a run
  // against another provider is still graded by the same model as the rest
  // of the archive unless the operator overrides it on purpose.
  const judgeApiKeyEnv = body.judgeApiKeyEnv ?? (process.env.JUDGE_API_KEY ? "JUDGE_API_KEY" : "OPENAI_API_KEY");
  const judgeApiKey = process.env[judgeApiKeyEnv];
  if (!judgeApiKey) {
    return reply.code(400).send({ error: `${judgeApiKeyEnv} is not set in the server's environment (.env).` });
  }
  const catalogue = listScenarioFiles();
  const unknown = (body.scenarios ?? []).filter((n) => !catalogue.some((s) => s.number === n));
  if (unknown.length > 0) {
    return reply.code(400).send({ error: `Unknown scenario number(s): ${unknown.join(", ")}.` });
  }

  const baseUrl = normalizeBaseUrl(body.baseUrl);
  const primaryModel = body.primaryModel;
  const fallbackModel = body.fallbackModel ?? body.primaryModel;
  const judgeModel = body.judgeModel ?? serverJudge.model ?? fallbackModel;
  const judgeBaseUrl = body.judgeBaseUrl ? normalizeBaseUrl(body.judgeBaseUrl) : serverJudge.baseUrl;
  const label = body.label && body.label.length > 0 ? body.label : primaryModel;

  try {
    const handle = startEvalRun({
      label,
      source: "ui",
      scenarioNumbers: body.scenarios ?? null,
      envOverrides: {
        OPENAI_API_KEY: process.env[apiKeyEnv] ?? "",
        OPENAI_BASE_URL: baseUrl,
        PRIMARY_MODEL: primaryModel,
        FALLBACK_MODEL: fallbackModel,
        JUDGE_MODEL: judgeModel,
        JUDGE_BASE_URL: judgeBaseUrl,
        JUDGE_API_KEY: judgeApiKey,
      },
      provider: { baseUrl, primaryModel, fallbackModel, judgeModel, judgeBaseUrl },
      stdio: "pipe",
      writeLegacy: false,
    });
    request.log.info({ runId: handle.run.runId, baseUrl, primaryModel, scenarios: body.scenarios ?? "all" }, "eval run started");
    return reply.code(202).send({ current: currentRunView(handle) });
  } catch (err) {
    if (err instanceof EvalRunInProgressError) return reply.code(409).send({ error: err.message });
    request.log.error(err);
    return reply.code(500).send({ error: err instanceof Error ? err.message : "Failed to start eval run." });
  }
});

app.get("/api/evals/current", async () => ({ current: currentRunView(getCurrentRun()) }));

app.post("/api/evals/current/cancel", async (_request, reply) => {
  const handle = getCurrentRun();
  if (!handle) return reply.code(404).send({ error: "No eval run is in progress." });
  handle.cancel();
  return { ok: true };
});

app.get("/api/personas", async () => ({ personas: DEMO_PERSONAS }));

app.get("/api/faults", async () => ({ faults: getSnapshot() }));

app.post("/api/faults", async (request, reply) => {
  const parsed = FaultRequestSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
  setFault(parsed.data.name, parsed.data.enabled, parsed.data.uses);
  return { faults: getSnapshot() };
});

app.post("/api/faults/clear", async () => {
  clearAllFaults();
  return { faults: getSnapshot() };
});

app.post("/api/chat", async (request, reply) => {
  const parsed = ChatRequestSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
  const { threadId, customerId, message } = parsed.data;
  try {
    emitEvent(db, { threadId, type: "step", payload: { step: "user_message", customerId } });
    const result = await runTurn({ db, graph, threadId, customerId, userMessage: message });
    return result;
  } catch (err) {
    request.log.error(err);
    emitEvent(db, {
      threadId,
      type: "error",
      payload: { stage: "chat_route", message: err instanceof Error ? err.message : String(err) },
    });
    return reply.code(500).send({ error: "Failed to process message." });
  }
});

function displayableMessages(state: AgentState | undefined) {
  if (!state?.messages) return [];
  return state.messages
    .filter((m): m is HumanMessage | AIMessage => m instanceof HumanMessage || m instanceof AIMessage)
    .map((m) => ({
      role: m instanceof HumanMessage ? ("customer" as const) : ("agent" as const),
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }))
    .filter((m) => m.content.trim().length > 0);
}

app.get("/api/threads", async () => {
  const rows = db
    .prepare(
      `SELECT thread_id AS threadId,
              MIN(ts) AS startedAt,
              MAX(ts) AS lastActivity,
              (SELECT json_extract(payload, '$.customerId')
                 FROM events e2
                WHERE e2.thread_id = e1.thread_id
                  AND json_extract(payload, '$.customerId') IS NOT NULL
                ORDER BY e2.id ASC LIMIT 1) AS customerId
         FROM events e1
        GROUP BY thread_id
        ORDER BY lastActivity DESC`,
    )
    .all() as Array<{ threadId: string; startedAt: string; lastActivity: string; customerId: string | null }>;

  const threads = await Promise.all(
    rows.map(async (row) => {
      const snapshot = await graph.getState({ configurable: { thread_id: row.threadId, db } });
      const state = snapshot.values as AgentState | undefined;
      const messages = displayableMessages(state);
      const last = messages[messages.length - 1];
      const persona = DEMO_PERSONAS.find((p) => p.customerId === row.customerId);
      return {
        threadId: row.threadId,
        customerId: row.customerId,
        personaName: persona?.name ?? null,
        personaLabel: persona?.label ?? null,
        startedAt: row.startedAt,
        lastActivity: row.lastActivity,
        resolutionStatus: state?.resolutionStatus ?? "open",
        messageCount: messages.length,
        preview: last ? last.content.slice(0, 140) : "",
      };
    }),
  );
  return { threads };
});

app.get<{ Params: { threadId: string } }>("/api/threads/:threadId/state", async (request) => {
  const { threadId } = request.params;
  const snapshot = await graph.getState({ configurable: { thread_id: threadId, db } });
  const state = snapshot.values as AgentState | undefined;
  return {
    threadId,
    resolutionStatus: state?.resolutionStatus ?? "open",
    messages: displayableMessages(state),
    pendingApproval: getPendingApprovalForThread(db, threadId) ?? null,
  };
});

app.get<{ Params: { threadId: string } }>("/api/threads/:threadId/approvals/pending", async (request) => {
  const approval = getPendingApprovalForThread(db, request.params.threadId);
  return { approval: approval ?? null };
});

// Cross-thread queue for the audit view. Deliberately unpaginated: the number
// of pending approvals is bounded by the number of simultaneously interrupted
// threads, which is bounded by how many conversations one operator has open.
app.get("/api/approvals/pending", async () => {
  const approvals = listPendingApprovals(db).map((approval) => {
    const persona = DEMO_PERSONAS.find((p) => p.customerId === approval.customerId);
    return {
      ...approval,
      personaName: persona?.name ?? null,
      personaLabel: persona?.label ?? null,
    };
  });
  return { approvals };
});

// A graph interrupt() only pauses at the "tools" node, so `next` naming a
// queued node and `tasks[].interrupts` carrying the interrupt payload are two
// independent signals of the same fact; requiring both is how "still
// actually paused" is told apart from "already ran to completion" on a
// retry after an earlier resume finished but the response never made it back
// (crash, or the process died before markApprovalExecuted ran).
function isGraphPausedAtInterrupt(snapshot: StateSnapshot): boolean {
  return snapshot.next.length > 0 && snapshot.tasks.some((task) => Array.isArray(task.interrupts) && task.interrupts.length > 0);
}

function decisionMatchesStoredStatus(decision: "approve" | "reject", status: ApprovalRow["status"]): boolean {
  return (decision === "approve" && status === "approved") || (decision === "reject" && status === "rejected");
}

// The execute step of the approval state machine: pending -> approved/rejected
// (decision recorded, executed_at still null) -> executed_at set (the effect
// has actually been applied). Only called once the decision itself is already
// durably recorded (either just now via the CAS resolve, or on an earlier
// attempt this call is retrying), so every code path below is safe to re-run.
async function executeApprovalDecision(params: {
  db: Database.Database;
  graph: AgentGraph;
  approval: ApprovalRow;
  decision: "approve" | "reject";
  // P0-3: internalNote is audit-only (feeds the ledger row's `reason`, never
  // sent to the customer); customerNote is the only field notify.ts ever
  // relays to the customer. The two travel separately end to end.
  internalNote: string | null;
  customerNote: string | null;
  threadId: string;
}): Promise<RunTurnResult> {
  const { db: database, graph: agentGraph, approval, decision, internalNote, customerNote, threadId } = params;
  const resolvedBy = approval.resolvedBy ?? "human_agent";
  let result: RunTurnResult;

  if (approval.kind === "policy_approval") {
    const snapshot = await agentGraph.getState({ configurable: { thread_id: threadId, db: database } });
    if (isGraphPausedAtInterrupt(snapshot)) {
      // The graph is paused at an issue_refund/issue_credit interrupt();
      // resuming it lets the agent's own turn finish (it may still need to
      // say more to the customer). internalNote travels with the resume so
      // it lands in the ledger row's reason (see agentTools.ts); customerNote
      // travels separately for the deterministic notice below.
      result = await resumeApprovalTurn({
        db: database,
        graph: agentGraph,
        threadId,
        customerId: approval.customerId,
        decision,
        internalNote,
        customerNote,
      });
    } else {
      // No pending interrupt: the resume already ran to completion on an
      // earlier attempt before this request's predecessor crashed. There is
      // nothing left to resume into, so build the response from the ledger
      // row's own terminal state instead of invoking the graph again.
      const ledgerRow = approval.ledgerId ? getLedgerById(database, approval.ledgerId) : undefined;
      const moneyResult = ledgerRow ? mapRowToResult(ledgerRow) : null;
      const notice = buildDecisionNotice({ approval, decision, moneyResult, customerNote });
      result = { reply: notice, status: "resolved", degraded: false };
    }
    if (customerNote) {
      const moneyResult = approval.ledgerId ? mapRowToResult(getLedgerById(database, approval.ledgerId)!) : null;
      const notice = buildDecisionNotice({ approval, decision, moneyResult, customerNote });
      await appendDecisionNotice(database, agentGraph, threadId, notice);
    }
  } else {
    // kind === "escalation": the agent's turn already completed by the time
    // this got reviewed, so there is no interrupt() to resume. Act on the
    // ledger row directly (same idempotency key, first real external call
    // either way, per pipeline.ts) and notify the customer out of band. Safe
    // to re-run on a retry: re-denying is harmless, and resolveApprovedAction
    // / resolveRejectedAction's append-only guard means a re-approval is a
    // no-op returning the already-settled outcome unchanged, so money cannot
    // move twice. `isOverride: true` on approve records who authorized
    // bypassing the policy engine (override_by on the ledger row).
    let moneyResult: MoneyActionResult | null = null;
    if (approval.ledgerId) {
      const ledgerRow = getLedgerById(database, approval.ledgerId);
      if (!ledgerRow) throw new Error(`Ledger row ${approval.ledgerId} referenced by approval ${approval.id} not found.`);
      moneyResult =
        decision === "approve"
          ? await resolveApprovedAction(database, ledgerRow, internalNote, "Exception granted by human reviewer", resolvedBy, true)
          : resolveRejectedAction(database, ledgerRow, internalNote, "Denial upheld by human reviewer", resolvedBy);
    }
    const notice = buildDecisionNotice({ approval, decision, moneyResult, customerNote });
    await appendDecisionNotice(database, agentGraph, threadId, notice);
    result = { reply: notice, status: "resolved", degraded: false };
  }

  // Only mark executed, and only emit the terminal event, once the effect
  // above has actually happened; on the accepted duplicate-notice residual
  // risk (README known failure modes), see the "not paused" branch above.
  markApprovalExecuted(database, approval.id);
  emitEvent(database, {
    threadId,
    type: "guardrail",
    payload: { stage: "approval_execution", approvalId: approval.id, kind: approval.kind, outcome: "executed" },
  });
  return result;
}

app.post<{ Params: { threadId: string; approvalId: string }; Body: unknown }>(
  "/api/threads/:threadId/approvals/:approvalId/resolve",
  async (request, reply) => {
    const parsed = ApprovalResolveRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const approvalId = Number(request.params.approvalId);
    const approval = getApprovalById(db, approvalId);
    if (!approval || approval.threadId !== request.params.threadId) {
      return reply.code(404).send({ error: "Approval not found for this thread." });
    }

    const { decision, internalNote, customerNote } = parsed.data;
    const internalNoteText = internalNote && internalNote.length > 0 ? internalNote : null;
    const customerNoteText = customerNote && customerNote.length > 0 ? customerNote : null;
    const threadId = request.params.threadId;

    try {
      let resolvedApproval: ApprovalRow;

      if (approval.status !== "pending") {
        if (approval.executedAt) {
          return reply.code(409).send({ error: `Approval already ${approval.status}.` });
        }
        if (!decisionMatchesStoredStatus(decision, approval.status)) {
          return reply
            .code(409)
            .send({ error: `The decision was already recorded as ${approval.status} and cannot be changed.` });
        }
        // Resolved but never executed: a crash (or a 500 from this very
        // route) happened after the decision was durably recorded but before
        // markApprovalExecuted ran. Retry the execute step only; re-running
        // the CAS resolve would be a no-op anyway since the row is no longer
        // pending, so skip straight past it.
        emitEvent(db, {
          threadId,
          type: "guardrail",
          payload: { stage: "approval_execution_retry", approvalId, kind: approval.kind, decision },
        });
        resolvedApproval = approval;
      } else {
        // Record the human's decision on the approvals row itself before
        // acting on it: this is what makes the queue row disappear,
        // independent of whatever the downstream money outcome
        // (succeeded/reconciled/failed_unknown) turns out to be in the
        // ledger. The compare-and-set update and the human_decision event
        // commit together in one transaction, closing the TOCTOU window
        // between the status check above and this write: a concurrent
        // resolver racing this request either wins the CAS (and this request
        // 409s below) or loses it (and that request 409s instead).
        const resolved = resolveApprovalWithDecisionEvent(db, {
          approvalId,
          status: decision === "approve" ? "approved" : "rejected",
          remark: internalNoteText,
          customerNote: customerNoteText,
          threadId,
          kind: approval.kind,
          decision,
        });
        if (!resolved) {
          return reply.code(409).send({ error: "Approval already resolved." });
        }
        resolvedApproval = resolved;
      }

      return await executeApprovalDecision({
        db,
        graph,
        approval: resolvedApproval,
        decision,
        internalNote: internalNoteText,
        customerNote: customerNoteText,
        threadId,
      });
    } catch (err) {
      request.log.error(err);
      emitEvent(db, {
        threadId,
        type: "error",
        payload: { stage: "approval_resolve_route", message: err instanceof Error ? err.message : String(err) },
      });
      return reply
        .code(500)
        .send({ error: "Decision recorded but execution failed; retry the same decision to complete it." });
    }
  },
);

// The full money audit trail: every refund and credit the agent ever proposed,
// including the denied and awaiting_approval rows that never moved money. The
// `total` alongside the page is what lets the UI say how much it is not showing.
app.get<{ Querystring: unknown }>("/api/ledger", async (request, reply) => {
  const parsed = LedgerQuerySchema.safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
  const { status, threadId, limit, offset } = parsed.data;
  return {
    rows: listLedgerRows(db, { status, threadId, limit, offset }),
    total: countLedgerRows(db, { status, threadId }),
    limit,
    offset,
  };
});

app.get<{ Params: { threadId: string } }>("/api/events/:threadId", async (request, reply) => {
  const { threadId } = request.params;
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  reply.hijack();

  for (const event of listEventsForThread(db, threadId)) {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  const unsubscribe = subscribe(threadId, (event) => {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  // Named "token" SSE event, same connection: live text deltas for the chat
  // bubble, kept separate from the default "message" event so useEvents.ts
  // can tell durable AgentEvent rows apart from ephemeral stream chunks.
  const unsubscribeStream = subscribeStream(threadId, (streamEvent) => {
    reply.raw.write(`event: token\ndata: ${JSON.stringify(streamEvent)}\n\n`);
  });

  const heartbeat = setInterval(() => reply.raw.write(":heartbeat\n\n"), 15_000);

  request.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    unsubscribeStream();
    reply.raw.end();
  });
});

if (existsSync(WEB_DIST)) {
  app.setNotFoundHandler((request, reply) => {
    if (request.raw.method === "GET" && !request.url.startsWith("/api/")) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not found." });
  });
}

const port = Number(process.env.PORT ?? 3000);
app
  .listen({ port, host: "0.0.0.0" })
  .then(() => app.log.info(`Server listening on http://localhost:${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
