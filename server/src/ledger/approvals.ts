import type Database from "better-sqlite3";
import type { ActionType } from "../tools/schemas.js";

export type ApprovalStatus = "pending" | "approved" | "rejected";
export type ApprovalKind = "policy_approval" | "escalation";

export interface ApprovalRow {
  id: number;
  kind: ApprovalKind;
  ledgerId: number | null;
  threadId: string;
  actionType: ActionType | null;
  customerId: string;
  orderId: string | null;
  amount: number | null;
  policyReason: string;
  denialReason: string | null;
  category: string | null;
  context: string | null;
  remark: string | null;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

interface ApprovalRowSql {
  id: number;
  kind: ApprovalKind;
  ledger_id: number | null;
  thread_id: string;
  action_type: ActionType | null;
  customer_id: string;
  order_id: string | null;
  amount: number | null;
  policy_reason: string;
  denial_reason: string | null;
  category: string | null;
  context: string | null;
  remark: string | null;
  status: ApprovalStatus;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

function fromSql(row: ApprovalRowSql): ApprovalRow {
  return {
    id: row.id,
    kind: row.kind,
    ledgerId: row.ledger_id,
    threadId: row.thread_id,
    actionType: row.action_type,
    customerId: row.customer_id,
    orderId: row.order_id,
    amount: row.amount,
    policyReason: row.policy_reason,
    denialReason: row.denial_reason,
    category: row.category,
    context: row.context,
    remark: row.remark,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
  };
}

export interface InsertApprovalInput {
  kind?: ApprovalKind;
  ledgerId?: number | null;
  threadId: string;
  actionType?: ActionType | null;
  customerId: string;
  orderId?: string | null;
  amount?: number | null;
  policyReason: string;
  denialReason?: string | null;
  category?: string | null;
  context?: string | null;
}

export function insertApproval(db: Database.Database, input: InsertApprovalInput): ApprovalRow {
  const createdAt = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO approvals
         (kind, ledger_id, thread_id, action_type, customer_id, order_id, amount, policy_reason, denial_reason, category, context, status, created_at)
       VALUES
         (@kind, @ledgerId, @threadId, @actionType, @customerId, @orderId, @amount, @policyReason, @denialReason, @category, @context, 'pending', @createdAt)`,
    )
    .run({
      kind: input.kind ?? "policy_approval",
      ledgerId: input.ledgerId ?? null,
      threadId: input.threadId,
      actionType: input.actionType ?? null,
      customerId: input.customerId,
      orderId: input.orderId ?? null,
      amount: input.amount ?? null,
      policyReason: input.policyReason,
      denialReason: input.denialReason ?? null,
      category: input.category ?? null,
      context: input.context ?? null,
      createdAt,
    });
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
  remark: string | null = null,
  resolvedBy: string = "human_agent",
): ApprovalRow {
  const resolvedAt = new Date().toISOString();
  db.prepare(
    `UPDATE approvals SET status = @status, remark = @remark, resolved_at = @resolvedAt, resolved_by = @resolvedBy WHERE id = @id`,
  ).run({
    id,
    status,
    remark,
    resolvedAt,
    resolvedBy,
  });
  const row = getApprovalById(db, id);
  if (!row) throw new Error(`Approval row ${id} disappeared after update`);
  return row;
}
