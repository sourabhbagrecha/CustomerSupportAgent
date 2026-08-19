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

// Inserts an additional succeeded payment (refund or credit) on an order
// seeded by seedOrder above. The payments table has a BEFORE INSERT trigger
// requiring payments.customer_id to own payments.order_id, so this always
// uses customer 'c1', matching the order seedOrder creates.
function seedPayment(db: Database.Database, paymentId: string, orderId: string, type: "refund" | "credit", amount: number) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO payments (id, order_id, customer_id, amount, currency, type, status, idempotency_key, provider_reference, created_at)
     VALUES (@paymentId, @orderId, 'c1', @amount, 'INR', @type, 'succeeded', NULL, NULL, @now)`,
  ).run({ paymentId, orderId, amount, type, now });
}

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
  applySchema(db);
});

describe("evaluatePolicy", () => {
  it("allows a refund within cap and window on an eligible order", () => {
    seedOrder(db, { amount: 450 });
    const verdict = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "refund", orderId: "o1", amount: 450 });
    expect(verdict.verdict).toBe("allow");
  });

  it("requires approval above the auto-refund cap", () => {
    seedOrder(db, { amount: 1500 });
    const verdict = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "refund", orderId: "o1", amount: 1500 });
    expect(verdict.verdict).toBe("requires_approval");
  });

  it("denies a refund on an ineligible order status", () => {
    seedOrder(db, { status: "placed", amount: 200 });
    const verdict = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "refund", orderId: "o1", amount: 200 });
    expect(verdict.verdict).toBe("deny");
    if (verdict.verdict === "deny") expect(verdict.denyReason).toBe("order_not_eligible_status");
  });

  it("denies a refund outside the refund window", () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    seedOrder(db, { amount: 200, orderDate: old, deliveryDate: old });
    const verdict = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "refund", orderId: "o1", amount: 200 });
    expect(verdict.verdict).toBe("deny");
    if (verdict.verdict === "deny") expect(verdict.denyReason).toBe("outside_refund_window");
  });

  it("denies a refund that exceeds the refundable balance already charged", () => {
    seedOrder(db, { amount: 300 });
    const verdict = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "refund", orderId: "o1", amount: 301 });
    expect(verdict.verdict).toBe("deny");
    if (verdict.verdict === "deny") expect(verdict.denyReason).toBe("exceeds_refundable_amount");
  });

  it("denies a refund on a nonexistent order", () => {
    const verdict = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "refund", orderId: "does_not_exist", amount: 100 });
    expect(verdict.verdict).toBe("deny");
    if (verdict.verdict === "deny") expect(verdict.denyReason).toBe("order_not_found");
  });

  it("denies a refund on an order owned by a different customer, with the order_not_found text shape (no oracle)", () => {
    // c1 is the requesting customer (seeded by seedOrder above with its own
    // order o1); o_foreign belongs to a second customer, c2. The ownership
    // check runs immediately after loadOrder, before any refund-eligibility
    // check, so this must deny even though the order itself would otherwise
    // be perfectly refundable.
    seedOrder(db, { id: "o1", amount: 450 });
    db.prepare(`INSERT INTO customers (id, name, email, phone, created_at) VALUES ('c2','Other','o@x.com',NULL,'2026-01-01')`).run();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO orders (id, customer_id, item_name, amount, currency, status, order_date, delivery_date)
       VALUES ('o_foreign', 'c2', 'Widget', 300, 'INR', 'delivered', @now, @now)`,
    ).run({ now });

    const verdict = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "refund", orderId: "o_foreign", amount: 300 });
    expect(verdict.verdict).toBe("deny");
    if (verdict.verdict === "deny") {
      expect(verdict.denyReason).toBe("order_not_owned_by_customer");
      // Mirrors order_not_found's exact text shape ("No order found with id
      // X.") plus "for this customer", so a foreign order and a nonexistent
      // one are indistinguishable to the caller (no oracle).
      expect(verdict.reason).toBe("No order found with id o_foreign for this customer.");
    }
  });

  it("denies a credit tied to an order owned by a different customer", () => {
    db.prepare(`INSERT INTO customers (id, name, email, phone, created_at) VALUES ('c1','Test','t@x.com',NULL,'2026-01-01')`).run();
    db.prepare(`INSERT INTO customers (id, name, email, phone, created_at) VALUES ('c2','Other','o@x.com',NULL,'2026-01-01')`).run();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO orders (id, customer_id, item_name, amount, currency, status, order_date, delivery_date)
       VALUES ('o_foreign', 'c2', 'Widget', 300, 'INR', 'delivered', @now, @now)`,
    ).run({ now });

    const verdict = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "credit", orderId: "o_foreign", amount: 300 });
    expect(verdict.verdict).toBe("deny");
    if (verdict.verdict === "deny") {
      expect(verdict.denyReason).toBe("order_not_owned_by_customer");
      expect(verdict.reason).toBe("No order found with id o_foreign for this customer.");
    }
  });

  it("denies a non-positive amount", () => {
    const verdict = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "refund", orderId: null, amount: 0 });
    expect(verdict.verdict).toBe("deny");
    if (verdict.verdict === "deny") expect(verdict.denyReason).toBe("invalid_amount");
  });

  it("requires approval for an orderless credit, even within cap", () => {
    const verdict = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "credit", orderId: null, amount: 200 });
    expect(verdict.verdict).toBe("requires_approval");
  });

  it("requires approval for an order-tied credit above its cap", () => {
    seedOrder(db, { amount: 2000 });
    const verdict = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "credit", orderId: "o1", amount: 900 });
    expect(verdict.verdict).toBe("requires_approval");
  });

  it("allows a credit within the order's creditable balance and cap", () => {
    seedOrder(db, { amount: 1500 });
    const verdict = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "credit", orderId: "o1", amount: 200 });
    expect(verdict.verdict).toBe("allow");
  });

  it("requires approval for a credit on an order that was already refunded in full", () => {
    seedOrder(db, { amount: 450 });
    seedPayment(db, "pay_refund1", "o1", "refund", 450);
    const verdict = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "credit", orderId: "o1", amount: 500 });
    expect(verdict.verdict).toBe("requires_approval");
    if (verdict.verdict === "requires_approval") {
      expect(verdict.reason).toContain("creditable balance of 0");
    }
  });

  it("requires approval for a credit above the order's charged amount", () => {
    seedOrder(db, { amount: 150 });
    const verdict = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "credit", orderId: "o1", amount: 200 });
    expect(verdict.verdict).toBe("requires_approval");
    if (verdict.verdict === "requires_approval") {
      expect(verdict.reason).toContain("creditable balance of 150");
    }
  });

  it("counts prior credits toward the creditable balance", () => {
    seedOrder(db, { amount: 500 });
    seedPayment(db, "pay_credit1", "o1", "credit", 400);
    const overVerdict = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "credit", orderId: "o1", amount: 200 });
    expect(overVerdict.verdict).toBe("requires_approval");
    const withinVerdict = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "credit", orderId: "o1", amount: 100 });
    expect(withinVerdict.verdict).toBe("allow");
  });

  it("leaves refund verdicts unchanged by prior credits", () => {
    seedOrder(db, { amount: 300 });
    seedPayment(db, "pay_credit2", "o1", "credit", 300);
    const verdict = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "refund", orderId: "o1", amount: 300 });
    expect(verdict.verdict).toBe("allow");
  });

  it("is impervious to policy caps regardless of the stated reason (jailbreak-proofing)", () => {
    seedOrder(db, { amount: 5000 });
    const verdict = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "refund", orderId: "o1", amount: 5000 });
    // No `reason` field influences the outcome at all; only amount vs. cap.
    expect(verdict.verdict).toBe("requires_approval");
  });
});
