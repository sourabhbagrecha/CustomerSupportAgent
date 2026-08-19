import type Database from "better-sqlite3";
import type { ActionType } from "../tools/schemas.js";

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface ApprovalRow {
  id: number;
  ledgerId: number;
  threadId: string;
  actionType: ActionType;
  customerId: string;
  orderId: string | null;
  amount: number;
  policyReason: string;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

interface ApprovalRowSql {
  id: number;
  ledger_id: number;
  thread_id: string;
  action_type: ActionType;
  customer_id: string;
  order_id: string | null;
  amount: number;
  policy_reason: string;
  status: ApprovalStatus;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

function fromSql(row: ApprovalRowSql): ApprovalRow {
  return {
    id: row.id,
    ledgerId: row.ledger_id,
    threadId: row.thread_id,
    actionType: row.action_type,
    customerId: row.customer_id,
    orderId: row.order_id,
    amount: row.amount,
    policyReason: row.policy_reason,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
  };
}

export interface InsertApprovalInput {
  ledgerId: number;
  threadId: string;
  actionType: ActionType;
  customerId: string;
  orderId: string | null;
  amount: number;
  policyReason: string;
}

export function insertApproval(db: Database.Database, input: InsertApprovalInput): ApprovalRow {
  const createdAt = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO approvals (ledger_id, thread_id, action_type, customer_id, order_id, amount, policy_reason, status, created_at)
       VALUES (@ledgerId, @threadId, @actionType, @customerId, @orderId, @amount, @policyReason, 'pending', @createdAt)`,
    )
    .run({ ...input, createdAt });
  const row = getApprovalById(db, Number(info.lastInsertRowid));
  if (!row) throw new Error("Failed to read back inserted approval row");
  return row;
}

export function getApprovalById(db: Database.Database, id: number): ApprovalRow | undefined {
  const row = db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as ApprovalRowSql | undefined;
  return row ? fromSql(row) : undefined;
}

export function getPendingApprovalForThread(db: Database.Database, threadId: string): ApprovalRow | undefined {
  const row = db
    .prepare(`SELECT * FROM approvals WHERE thread_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`)
    .get(threadId) as ApprovalRowSql | undefined;
  return row ? fromSql(row) : undefined;
}

export function listPendingApprovals(db: Database.Database): ApprovalRow[] {
  const rows = db.prepare(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY id ASC`).all() as ApprovalRowSql[];
  return rows.map(fromSql);
}

export function resolveApproval(
  db: Database.Database,
  id: number,
  status: "approved" | "rejected",
  resolvedBy: string = "human_agent",
): ApprovalRow {
  const resolvedAt = new Date().toISOString();
  db.prepare(`UPDATE approvals SET status = @status, resolved_at = @resolvedAt, resolved_by = @resolvedBy WHERE id = @id`).run({
    id,
    status,
    resolvedAt,
    resolvedBy,
  });
  const row = getApprovalById(db, id);
  if (!row) throw new Error(`Approval row ${id} disappeared after update`);
  return row;
}
