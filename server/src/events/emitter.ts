import { EventEmitter as NodeEventEmitter } from "node:events";
import type Database from "better-sqlite3";
import { resolveAgentProvider, resolveModelEndpoint } from "../agent/providerConfig.js";
import { lookupModelPricing } from "../evals/pricing.js";
import type { AgentEvent, AgentStreamEvent, NewAgentEvent } from "./types.js";

// Module-level pub/sub so the Fastify SSE route can subscribe to events for
// a given thread without coupling to whichever graph node emitted them.
const bus = new NodeEventEmitter();
bus.setMaxListeners(100);

function channel(threadId: string): string {
  return `thread:${threadId}`;
}

function streamChannel(threadId: string): string {
  return `thread:${threadId}:stream`;
}

export function subscribe(threadId: string, listener: (event: AgentEvent) => void): () => void {
  bus.on(channel(threadId), listener);
  return () => bus.off(channel(threadId), listener);
}

// Ephemeral token-stream publish/subscribe (see AgentStreamEvent): no DB
// write, separate channel from the durable AgentEvent bus above.
export function publishStreamEvent(threadId: string, event: AgentStreamEvent): void {
  bus.emit(streamChannel(threadId), event);
}

export function subscribeStream(threadId: string, listener: (event: AgentStreamEvent) => void): () => void {
  bus.on(streamChannel(threadId), listener);
  return () => bus.off(streamChannel(threadId), listener);
}

const insertStmt = (db: Database.Database) =>
  db.prepare(
    `INSERT INTO events (thread_id, ts, type, payload, latency_ms, tokens_in, tokens_out, model)
     VALUES (@threadId, @ts, @type, @payload, @latencyMs, @tokensIn, @tokensOut, @model)`,
  );

// Writes the event to SQLite first (durable, queryable by the harness and by
// a reloaded trace panel), then publishes it to any live SSE subscribers.
export function emitEvent(db: Database.Database, event: NewAgentEvent): AgentEvent {
  const ts = new Date().toISOString();
  const row = {
    threadId: event.threadId,
    ts,
    type: event.type,
    payload: JSON.stringify(event.payload ?? {}),
    latencyMs: event.latencyMs ?? null,
    tokensIn: event.tokensIn ?? null,
    tokensOut: event.tokensOut ?? null,
    model: event.model ?? null,
  };
  const info = insertStmt(db).run(row);
  const full: AgentEvent = {
    id: Number(info.lastInsertRowid),
    threadId: event.threadId,
    ts,
    type: event.type,
    payload: event.payload ?? {},
    latencyMs: event.latencyMs ?? null,
    tokensIn: event.tokensIn ?? null,
    tokensOut: event.tokensOut ?? null,
    model: event.model ?? null,
  };
  bus.emit(channel(event.threadId), full);
  return full;
}

// ---------------------------------------------------------------------------
// Turn rollup (P2-9)
// ---------------------------------------------------------------------------
// One rollup event closes out every turn: TracePanel renders it as the last
// item for that turn, and the Chat header sums every rollup event in the
// thread for its running cost/latency badge. A "turn" is bounded by the
// `context` step event loadContext.ts writes right after context assembly
// (see loadContext.ts): everything from there up to now, including any
// human-approval detour in between, belongs to the same customer turn. The
// only call site is server/src/agent/graph.ts's agentNode, fired exactly
// when the graph is about to return to the caller with no further tool
// calls queued, which is true both on the normal path and after an
// approval resume re-enters agentNode.
interface ContextMarkerRow {
  id: number;
  ts: string;
  payload: string;
}

interface LlmCallRow {
  tokens_in: number | null;
  tokens_out: number | null;
  model: string | null;
  cache_read_tokens: number | null;
}

function findTurnStartMarker(db: Database.Database, threadId: string): ContextMarkerRow | undefined {
  return db
    .prepare(
      `SELECT id, ts, payload FROM events
       WHERE thread_id = ? AND type = 'step' AND json_extract(payload, '$.step') = 'context'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(threadId) as ContextMarkerRow | undefined;
}

// Best-effort: a rollup is observability, never load-bearing for the turn
// itself, so a failure here is recorded as an `error` event (CLAUDE.md: never
// swallow an error silently) and otherwise ignored rather than thrown, which
// would break the customer-facing reply that is finishing at the same time.
export async function emitTurnRollup(db: Database.Database, threadId: string): Promise<AgentEvent | null> {
  try {
    const marker = findTurnStartMarker(db, threadId);
    if (!marker) return null; // nothing to close out: no context event exists yet for this thread

    let traceId: string | null = null;
    try {
      const markerPayload = JSON.parse(marker.payload) as { traceId?: unknown };
      if (typeof markerPayload.traceId === "string") traceId = markerPayload.traceId;
    } catch {
      // Malformed marker payload: still close out the turn, just without a traceId.
    }

    const llmRows = db
      .prepare(
        `SELECT tokens_in, tokens_out, model,
                json_extract(payload, '$.cacheReadTokens') AS cache_read_tokens
         FROM events
         WHERE thread_id = ? AND type = 'llm_call' AND id > ?
         ORDER BY id ASC`,
      )
      .all(threadId, marker.id) as LlmCallRow[];

    const tokensIn = llmRows.reduce((sum, r) => sum + (r.tokens_in ?? 0), 0);
    const tokensOut = llmRows.reduce((sum, r) => sum + (r.tokens_out ?? 0), 0);
    // Provider-reported cached-prefix input tokens (see modelClient.ts).
    // Distinguishes "no call reported caching" (null) from a real reported
    // total, so the trace never shows a fake "0 cached" for providers that
    // do not report the field at all.
    const cachedRows = llmRows.filter((r) => r.cache_read_tokens !== null);
    const tokensCachedIn = cachedRows.length === 0 ? null : cachedRows.reduce((sum, r) => sum + (r.cache_read_tokens ?? 0), 0);

    // Priced per distinct model, resolved via the same provider/endpoint
    // routing modelClient.ts uses for the real call (resolveModelEndpoint),
    // so an OpenRouter-routed model is priced against the listing it was
    // actually served from.
    const provider = resolveAgentProvider();
    const rates = new Map<string, { promptUsdPerMillion: number; completionUsdPerMillion: number } | null>();
    let costUsd = 0;
    let allPriced = true;
    for (const row of llmRows) {
      if (!row.model) {
        allPriced = false;
        continue;
      }
      if (!rates.has(row.model)) {
        const endpoint = resolveModelEndpoint(provider, row.model);
        rates.set(row.model, await lookupModelPricing(row.model, endpoint.baseUrl));
      }
      const rate = rates.get(row.model) ?? null;
      if (!rate) {
        allPriced = false;
        continue;
      }
      costUsd += ((row.tokens_in ?? 0) * rate.promptUsdPerMillion + (row.tokens_out ?? 0) * rate.completionUsdPerMillion) / 1_000_000;
    }
    // A confident dollar figure only when every call in the turn was priced;
    // otherwise n/a rather than a silently-partial number (same philosophy as
    // server/src/evals/pricing.ts). Zero calls is a known $0, not unknown.
    const finalCostUsd = llmRows.length === 0 ? 0 : allPriced ? Number(costUsd.toPrecision(6)) : null;

    const wallTimeMs = Math.max(0, Date.now() - new Date(marker.ts).getTime());

    return emitEvent(db, {
      threadId,
      type: "step",
      payload: {
        step: "rollup",
        traceId,
        llmCalls: llmRows.length,
        tokensIn,
        tokensCachedIn,
        tokensOut,
        costUsd: finalCostUsd,
        wallTimeMs,
      },
      latencyMs: wallTimeMs,
      tokensIn,
      tokensOut,
    });
  } catch (err) {
    try {
      emitEvent(db, {
        threadId,
        type: "error",
        payload: { stage: "turn_rollup", message: err instanceof Error ? err.message : String(err) },
      });
    } catch {
      // If even the error event fails to write, there is nothing left to do.
    }
    return null;
  }
}

export function listEventsForThread(db: Database.Database, threadId: string): AgentEvent[] {
  const rows = db
    .prepare(`SELECT * FROM events WHERE thread_id = ? ORDER BY id ASC`)
    .all(threadId) as Array<{
    id: number;
    thread_id: string;
    ts: string;
    type: AgentEvent["type"];
    payload: string;
    latency_ms: number | null;
    tokens_in: number | null;
    tokens_out: number | null;
    model: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    threadId: r.thread_id,
    ts: r.ts,
    type: r.type,
    payload: JSON.parse(r.payload),
    latencyMs: r.latency_ms,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    model: r.model,
  }));
}
