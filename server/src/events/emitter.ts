import { EventEmitter as NodeEventEmitter } from "node:events";
import type Database from "better-sqlite3";
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
