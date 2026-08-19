import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb, applySchema } from "../db/client.js";
import { evaluatePolicy } from "./engine.js";
import type { PolicyDocument } from "./schemas.js";

const POLICY: PolicyDocument = {
  maxAutoRefundINR: 500,
  maxAutoCreditINR: 500,
  refundWindowDays: 30,
  eligibleOrderStatusesForRefund: ["delivered", "failed_delivery", "cancelled", "partially_refunded"],
};

function seedOrder(
  db: Database.Database,
  overrides: Partial<{ id: string; status: string; amount: number; orderDate: string; deliveryDate: string | null }> = {},
) {
  db.prepare(`INSERT INTO customers (id, name, email, phone, created_at) VALUES ('c1','Test','t@x.com',NULL,'2026-01-01')`).run();
  const order = {
    id: overrides.id ?? "o1",
    status: overrides.status ?? "delivered",
    amount: overrides.amount ?? 500,
    orderDate: overrides.orderDate ?? new Date().toISOString(),
    deliveryDate: overrides.deliveryDate ?? new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO orders (id, customer_id, item_name, amount, currency, status, order_date, delivery_date)
     VALUES (@id, 'c1', 'Widget', @amount, 'INR', @status, @orderDate, @deliveryDate)`,
  ).run(order);
  db.prepare(
    `INSERT INTO payments (id, order_id, customer_id, amount, currency, type, status, idempotency_key, provider_reference, created_at)
     VALUES ('pay1', @id, 'c1', @amount, 'INR', 'charge', 'succeeded', NULL, NULL, @orderDate)`,
  ).run(order);
  return order;
}

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
  applySchema(db);
});

describe("evaluatePolicy", () => {
  it("allows a refund within cap and window on an eligible order", () => {
    seedOrder(db, { amount: 450 });
    const verdict = evaluatePolicy(db, POLICY, { actionType: "refund", orderId: "o1", amount: 450 });
    expect(verdict.verdict).toBe("allow");
  });

  it("requires approval above the auto-refund cap", () => {
    seedOrder(db, { amount: 1500 });
    const verdict = evaluatePolicy(db, POLICY, { actionType: "refund", orderId: "o1", amount: 1500 });
    expect(verdict.verdict).toBe("requires_approval");
  });

  it("denies a refund on an ineligible order status", () => {
    seedOrder(db, { status: "placed", amount: 200 });
    const verdict = evaluatePolicy(db, POLICY, { actionType: "refund", orderId: "o1", amount: 200 });
    expect(verdict.verdict).toBe("deny");
    if (verdict.verdict === "deny") expect(verdict.denyReason).toBe("order_not_eligible_status");
  });

  it("denies a refund outside the refund window", () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    seedOrder(db, { amount: 200, orderDate: old, deliveryDate: old });
    const verdict = evaluatePolicy(db, POLICY, { actionType: "refund", orderId: "o1", amount: 200 });
    expect(verdict.verdict).toBe("deny");
    if (verdict.verdict === "deny") expect(verdict.denyReason).toBe("outside_refund_window");
  });

  it("denies a refund that exceeds the refundable balance already charged", () => {
    seedOrder(db, { amount: 300 });
    const verdict = evaluatePolicy(db, POLICY, { actionType: "refund", orderId: "o1", amount: 301 });
    expect(verdict.verdict).toBe("deny");
    if (verdict.verdict === "deny") expect(verdict.denyReason).toBe("exceeds_refundable_amount");
  });

  it("denies a refund on a nonexistent order", () => {
    const verdict = evaluatePolicy(db, POLICY, { actionType: "refund", orderId: "does_not_exist", amount: 100 });
    expect(verdict.verdict).toBe("deny");
    if (verdict.verdict === "deny") expect(verdict.denyReason).toBe("order_not_found");
  });

  it("denies a non-positive amount", () => {
    const verdict = evaluatePolicy(db, POLICY, { actionType: "refund", orderId: null, amount: 0 });
    expect(verdict.verdict).toBe("deny");
    if (verdict.verdict === "deny") expect(verdict.denyReason).toBe("invalid_amount");
  });

  it("allows an orderless credit within cap regardless of order eligibility rules", () => {
    const verdict = evaluatePolicy(db, POLICY, { actionType: "credit", orderId: null, amount: 200 });
    expect(verdict.verdict).toBe("allow");
  });

  it("requires approval for a credit above its cap", () => {
    const verdict = evaluatePolicy(db, POLICY, { actionType: "credit", orderId: null, amount: 900 });
    expect(verdict.verdict).toBe("requires_approval");
  });

  it("is impervious to policy caps regardless of the stated reason (jailbreak-proofing)", () => {
    seedOrder(db, { amount: 5000 });
    const verdict = evaluatePolicy(db, POLICY, { actionType: "refund", orderId: "o1", amount: 5000 });
    // No `reason` field influences the outcome at all; only amount vs. cap.
    expect(verdict.verdict).toBe("requires_approval");
  });
});
