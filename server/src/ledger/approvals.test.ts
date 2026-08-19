import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { applySchema, openDb } from "../db/client.js";
import { insertApproval, listPendingApprovals, resolveApproval, type ApprovalRow } from "./approvals.js";
import { insertLedgerRow } from "./store.js";

function seedParents(db: Database.Database) {
  db.prepare(
    `INSERT INTO customers (id, name, email, phone, created_at) VALUES ('c1','Test','t@x.com',NULL,'2026-01-01')`,
  ).run();
  db.prepare(
    `INSERT INTO orders (id, customer_id, item_name, amount, currency, status, order_date, delivery_date)
     VALUES ('ord_a', 'c1', 'Widget', 1500, 'INR', 'delivered', '2026-01-01', '2026-01-02')`,
  ).run();
}

function addPending(db: Database.Database, threadId: string, amount: number): ApprovalRow {
  const ledger = insertLedgerRow(db, {
    idempotencyKey: `key_${threadId}_${amount}`,
    threadId,
    actionType: "refund",
    customerId: "c1",
    orderId: "ord_a",
    amount,
    currency: "INR",
    status: "awaiting_approval",
    reason: "Above the auto-approval cap.",
  });
  return insertApproval(db, {
    ledgerId: ledger.id,
    threadId,
    actionType: "refund",
    customerId: "c1",
    orderId: "ord_a",
    amount,
    policyReason: "Above the auto-approval cap.",
  });
}

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
  applySchema(db);
  seedParents(db);
});

describe("listPendingApprovals", () => {
  it("returns approvals from different threads, oldest first", () => {
    // This is the property the cross-thread queue rests on: a supervisor sees
    // every waiting approval without knowing any threadId in advance.
    addPending(db, "t1", 1500);
    addPending(db, "t2", 900);
    addPending(db, "t3", 2000);

    const pending = listPendingApprovals(db);
    expect(pending.map((a) => a.threadId)).toEqual(["t1", "t2", "t3"]);
  });

  it("is empty when nothing is waiting", () => {
    expect(listPendingApprovals(db)).toEqual([]);
  });

  it("excludes resolved approvals and records who resolved them", () => {
    const first = addPending(db, "t1", 1500);
    addPending(db, "t2", 900);

    const resolved = resolveApproval(db, first.id, "approved");
    expect(resolved.status).toBe("approved");
    expect(resolved.resolvedBy).toBe("human_agent");
    expect(resolved.resolvedAt).not.toBeNull();

    expect(listPendingApprovals(db).map((a) => a.threadId)).toEqual(["t2"]);
  });

  it("excludes rejected approvals too", () => {
    const only = addPending(db, "t1", 1500);
    resolveApproval(db, only.id, "rejected");
    expect(listPendingApprovals(db)).toEqual([]);
  });
});

describe("escalation kind", () => {
  it("accepts a null ledger/action/amount for an escalation with no related money action", () => {
    const approval = insertApproval(db, {
      kind: "escalation",
      threadId: "t1",
      customerId: "c1",
      policyReason: "Customer described a legal threat.",
      category: "legal_threat",
      context: "Customer said they will contact their lawyer.",
    });
    expect(approval.kind).toBe("escalation");
    expect(approval.ledgerId).toBeNull();
    expect(approval.actionType).toBeNull();
    expect(approval.amount).toBeNull();
    expect(approval.denialReason).toBeNull();
    expect(approval.category).toBe("legal_threat");
    expect(listPendingApprovals(db).map((a) => a.id)).toContain(approval.id);
  });

  it("carries the underlying denial reason for an escalation tied to a denied ledger row", () => {
    const ledger = insertLedgerRow(db, {
      idempotencyKey: "key_escalation_1",
      threadId: "t1",
      actionType: "refund",
      customerId: "c1",
      orderId: "ord_a",
      amount: 3200,
      currency: "INR",
      status: "denied",
      reason: "Order is 90 days past delivery, outside the 30-day refund window.",
    });
    const approval = insertApproval(db, {
      kind: "escalation",
      ledgerId: ledger.id,
      threadId: "t1",
      actionType: "refund",
      customerId: "c1",
      orderId: "ord_a",
      amount: 3200,
      policyReason: "Order is 90 days past delivery, outside the 30-day refund window.",
      denialReason: "Order is 90 days past delivery, outside the 30-day refund window.",
      category: "cap_breach",
      context: "Customer pushed back after the denial.",
    });
    expect(approval.ledgerId).toBe(ledger.id);
    expect(approval.denialReason).toContain("30-day refund window");
  });

  it("persists the reviewer's remark when the escalation is resolved", () => {
    const approval = insertApproval(db, {
      kind: "escalation",
      threadId: "t1",
      customerId: "c1",
      policyReason: "Customer described a legal threat.",
      category: "legal_threat",
      context: "Customer said they will contact their lawyer.",
    });
    const resolved = resolveApproval(db, approval.id, "rejected", "Handed off to the legal team directly.");
    expect(resolved.status).toBe("rejected");
    expect(resolved.remark).toBe("Handed off to the legal team directly.");
    expect(listPendingApprovals(db)).toEqual([]);
  });
});
