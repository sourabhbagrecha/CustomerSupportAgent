import type Database from "better-sqlite3";
import { z } from "zod";
import type { ActionType } from "../tools/schemas.js";

// Zod is the source of truth so the /api/ledger query-param schema can reuse
// the same seven values instead of keeping a second copy of them. The CHECK
// constraint in schema.sql stays as the database-level guard.
export const LedgerStatusSchema = z.enum([
  "pending",
  "succeeded",
  "failed",
  "failed_unknown",
  "reconciled",
  "denied",
  "awaiting_approval",
]);

export type LedgerStatus = z.infer<typeof LedgerStatusSchema>;

export interface LedgerRow {
  id: number;
  idempotencyKey: string;
  threadId: string;
  actionType: ActionType;
  customerId: string;
  orderId: string | null;
  amount: number;
  currency: string;
  status: LedgerStatus;
  reason: string;
  createdAt: string;
  resolvedAt: string | null;
  rawResponse: string | null;
  // Human-resolution metadata (P0-1 hardening). See schema.sql's comment on
  // actions_ledger: `resolution` is set exactly once, the first time a human
  // resolves this row, and its presence is what pipeline.ts's
  // resolveApprovedAction/resolveRejectedAction check before ever acting on
  // or overwriting an already-settled row again.
  resolution: "approved" | "rejected" | null;
  resolvedBy: string | null;
  resolutionRemark: string | null;
  overrideBy: string | null;
}

interface LedgerRowSql {
  id: number;
  idempotency_key: string;
  thread_id: string;
  action_type: ActionType;
  customer_id: string;
  order_id: string | null;
  amount: number;
  currency: string;
  status: LedgerStatus;
  reason: string;
  created_at: string;
  resolved_at: string | null;
  raw_response: string | null;
  resolution: "approved" | "rejected" | null;
  resolved_by: string | null;
  resolution_remark: string | null;
  override_by: string | null;
}

function fromSql(row: LedgerRowSql): LedgerRow {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    threadId: row.thread_id,
    actionType: row.action_type,
    customerId: row.customer_id,
    orderId: row.order_id,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    rawResponse: row.raw_response,
    resolution: row.resolution,
    resolvedBy: row.resolved_by,
    resolutionRemark: row.resolution_remark,
    overrideBy: row.override_by,
  };
}

export function findLedgerByIdempotencyKey(db: Database.Database, key: string): LedgerRow | undefined {
  const row = db.prepare(`SELECT * FROM actions_ledger WHERE idempotency_key = ?`).get(key) as
    | LedgerRowSql
    | undefined;
  return row ? fromSql(row) : undefined;
}

export function getLedgerById(db: Database.Database, id: number): LedgerRow | undefined {
  const row = db.prepare(`SELECT * FROM actions_ledger WHERE id = ?`).get(id) as LedgerRowSql | undefined;
  return row ? fromSql(row) : undefined;
}

// Fallback lookup for escalate_to_human when the model omits relatedLedgerId:
// the most recent terminal refusal on this thread, so the escalation queue
// item still carries a denial reason for the admin to review.
export function findLatestRefusalForThread(db: Database.Database, threadId: string): LedgerRow | undefined {
  const row = db
    .prepare(
      `SELECT * FROM actions_ledger WHERE thread_id = ? AND status IN ('denied', 'failed_unknown') ORDER BY id DESC LIMIT 1`,
    )
    .get(threadId) as LedgerRowSql | undefined;
  return row ? fromSql(row) : undefined;
}

// Used by graph.ts's status-transition rule: a thread only reaches
// "resolved" once at least one of its ledger rows has hit a terminal
// outcome (money moved, was denied, or failed unrecoverably). "pending" and
// "awaiting_approval" are deliberately excluded, since neither is a
// concrete outcome yet.
export function hasTerminalLedgerRowForThread(db: Database.Database, threadId: string): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM actions_ledger
        WHERE thread_id = ? AND status IN ('succeeded', 'reconciled', 'denied', 'failed_unknown')`,
    )
    .get(threadId) as { n: number };
  return row.n > 0;
}

export interface LedgerListFilter {
  status?: LedgerStatus;
  threadId?: string;
}

// Read-only, for the audit view. Ordered by id rather than created_at because
// id is INTEGER PRIMARY KEY AUTOINCREMENT and therefore a stable total order,
// while created_at is an ISO string that can tie at millisecond resolution and
// give a non-deterministic page boundary.
//
// No idx_ledger_status exists and none is added: applying a schema change means
// running `npm run seed`, which deletes data/app.db, and the row counts here do
// not justify that. Revisit only if the table grows large enough to matter.
export function listLedgerRows(
  db: Database.Database,
  filter: LedgerListFilter & { limit: number; offset: number },
): LedgerRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM actions_ledger
        WHERE (@status IS NULL OR status = @status)
          AND (@threadId IS NULL OR thread_id = @threadId)
        ORDER BY id DESC
        LIMIT @limit OFFSET @offset`,
    )
    // better-sqlite3 throws on undefined named parameters, so absent filters
    // must be normalized to null rather than left off the object.
    .all({
      status: filter.status ?? null,
      threadId: filter.threadId ?? null,
      limit: filter.limit,
      offset: filter.offset,
    }) as LedgerRowSql[];
  return rows.map(fromSql);
}

export function countLedgerRows(db: Database.Database, filter: LedgerListFilter): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM actions_ledger
        WHERE (@status IS NULL OR status = @status)
          AND (@threadId IS NULL OR thread_id = @threadId)`,
    )
    .get({ status: filter.status ?? null, threadId: filter.threadId ?? null }) as { n: number };
  return row.n;
}

export interface InsertLedgerInput {
  idempotencyKey: string;
  threadId: string;
  actionType: ActionType;
  customerId: string;
  orderId: string | null;
  amount: number;
  currency: string;
  status: LedgerStatus;
  reason: string;
}

// Callers MUST insert a ledger row (status pending/denied/awaiting_approval)
// BEFORE any external mock-API call, per CLAUDE.md invariant 1.
export function insertLedgerRow(db: Database.Database, input: InsertLedgerInput): LedgerRow {
  const createdAt = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO actions_ledger
         (idempotency_key, thread_id, action_type, customer_id, order_id, amount, currency, status, reason, created_at)
       VALUES (@idempotencyKey, @threadId, @actionType, @customerId, @orderId, @amount, @currency, @status, @reason, @createdAt)`,
    )
    .run({ ...input, createdAt });
  const row = getLedgerById(db, Number(info.lastInsertRowid));
  if (!row) throw new Error("Failed to read back inserted ledger row");
  return row;
}

export function updateLedgerStatus(
  db: Database.Database,
  id: number,
  status: LedgerStatus,
  rawResponse?: unknown,
  reason?: string,
): LedgerRow {
  const resolvedAt = new Date().toISOString();
  const current = getLedgerById(db, id);
  if (!current) throw new Error(`Ledger row ${id} not found`);
  db.prepare(
    `UPDATE actions_ledger SET status = @status, resolved_at = @resolvedAt, raw_response = @rawResponse, reason = @reason WHERE id = @id`,
  ).run({
    id,
    status,
    resolvedAt,
    rawResponse: rawResponse === undefined ? current.rawResponse : JSON.stringify(rawResponse),
    reason: reason ?? current.reason,
  });
  const row = getLedgerById(db, id);
  if (!row) throw new Error(`Ledger row ${id} disappeared after update`);
  return row;
}
