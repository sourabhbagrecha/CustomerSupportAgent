import type Database from "better-sqlite3";
import type { ActionType } from "../tools/schemas.js";

export type LedgerStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "failed_unknown"
  | "reconciled"
  | "denied"
  | "awaiting_approval";

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
