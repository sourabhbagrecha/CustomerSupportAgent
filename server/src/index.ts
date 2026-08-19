import "./env.js";

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { buildAgentGraph } from "./agent/graph.js";
import { runTurn, resumeApprovalTurn } from "./agent/runTurn.js";
import type { AgentState } from "./agent/state.js";
import { getDb } from "./db/client.js";
import { emitEvent, listEventsForThread, subscribe, subscribeStream } from "./events/emitter.js";
import { clearAllFaults, getSnapshot, setFault } from "./faults/registry.js";
import { getApprovalById, getPendingApprovalForThread, resolveApproval } from "./ledger/approvals.js";
import { ApprovalResolveRequestSchema, ChatRequestSchema, FaultRequestSchema } from "./httpSchemas.js";
import { DEMO_PERSONAS } from "./personas.js";

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
    if (approval.status !== "pending") {
      return reply.code(409).send({ error: `Approval already ${approval.status}.` });
    }

    try {
      // Record the human's decision on the approvals row itself before
      // resuming the graph: this is what makes the approval banner
      // disappear, independent of whatever the downstream money outcome
      // (succeeded/reconciled/failed_unknown) turns out to be in the ledger.
      resolveApproval(db, approvalId, parsed.data.decision === "approve" ? "approved" : "rejected");
      const result = await resumeApprovalTurn({
        db,
        graph,
        threadId: request.params.threadId,
        customerId: approval.customerId,
        decision: parsed.data.decision,
      });
      return result;
    } catch (err) {
      request.log.error(err);
      emitEvent(db, {
        threadId: request.params.threadId,
        type: "error",
        payload: { stage: "approval_resolve_route", message: err instanceof Error ? err.message : String(err) },
      });
      return reply.code(500).send({ error: "Failed to resolve approval." });
    }
  },
);

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
