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

// Inserts an additional payment (charge, refund or credit) on an order seeded
// by seedOrder above. The payments table has a BEFORE INSERT trigger
// requiring payments.customer_id to own payments.order_id, so this always
// uses customer 'c1', matching the order seedOrder creates. `status` defaults
// to 'succeeded'; pass 'pending' for money already submitted to the provider
// and still in flight, or 'failed' for money that never moved.
function seedPayment(
  db: Database.Database,
  paymentId: string,
  orderId: string,
  type: "charge" | "refund" | "credit",
  amount: number,
  status: "succeeded" | "pending" | "failed" = "succeeded",
) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO payments (id, order_id, customer_id, amount, currency, type, status, idempotency_key, provider_reference, created_at)
     VALUES (@paymentId, @orderId, 'c1', @amount, 'INR', @type, @status, NULL, NULL, @now)`,
  ).run({ paymentId, orderId, amount, type, status, now });
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

// An in-flight (pending) refund or credit is money already committed: it has
// been submitted to the provider and is expected to land, so both balance
// functions must reserve it. A pending CHARGE is the opposite case, money we
// have not collected, so it must never raise what we are willing to pay out.
describe("evaluatePolicy with in-flight (pending) payments", () => {
  it("reserves a pending refund against the refundable balance, leaving only the remainder refundable", () => {
    seedOrder(db, { amount: 500 });
    seedPayment(db, "pay_refund_pending1", "o1", "refund", 200, "pending");

    const remainder = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "refund", orderId: "o1", amount: 300 });
    expect(remainder.verdict).toBe("allow");

    // Without the reservation this second full refund would be auto-approved
    // on top of the 200 already moving, paying out 700 on a 500 charge.
    const full = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "refund", orderId: "o1", amount: 500 });
    expect(full.verdict).toBe("deny");
    if (full.verdict === "deny") expect(full.denyReason).toBe("exceeds_refundable_amount");
  });

  it("denies any further refund once a pending refund covers the full charge, and names the in-flight refund", () => {
    seedOrder(db, { amount: 450 });
    seedPayment(db, "pay_refund_pending2", "o1", "refund", 450, "pending");

    const verdict = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "refund", orderId: "o1", amount: 100 });
    expect(verdict.verdict).toBe("deny");
    if (verdict.verdict === "deny") {
      expect(verdict.denyReason).toBe("exceeds_refundable_amount");
      expect(verdict.reason).toContain("refundable balance of 0");
      // The agent relays this text, so a zero balance on an order with no
      // settled refund has to explain itself.
      expect(verdict.reason).toContain("450 INR on this order is already in progress");
    }
  });

  it("omits the in-flight sentence when the balance is exhausted by settled refunds only", () => {
    seedOrder(db, { amount: 450 });
    seedPayment(db, "pay_refund_settled1", "o1", "refund", 450);

    const verdict = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "refund", orderId: "o1", amount: 100 });
    expect(verdict.verdict).toBe("deny");
    if (verdict.verdict === "deny") {
      expect(verdict.reason).toContain("refundable balance of 0");
      expect(verdict.reason).not.toContain("in progress");
    }
  });

  it("reserves a pending credit against the creditable balance, pushing an otherwise allowable credit to approval", () => {
    seedOrder(db, { amount: 500 });
    seedPayment(db, "pay_credit_pending1", "o1", "credit", 400, "pending");

    const over = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "credit", orderId: "o1", amount: 200 });
    expect(over.verdict).toBe("requires_approval");
    if (over.verdict === "requires_approval") expect(over.reason).toContain("creditable balance of 100");

    const within = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "credit", orderId: "o1", amount: 100 });
    expect(within.verdict).toBe("allow");
  });

  it("reserves a pending refund against the creditable balance too", () => {
    seedOrder(db, { amount: 500 });
    seedPayment(db, "pay_refund_pending3", "o1", "refund", 500, "pending");

    const verdict = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "credit", orderId: "o1", amount: 200 });
    expect(verdict.verdict).toBe("requires_approval");
    if (verdict.verdict === "requires_approval") expect(verdict.reason).toContain("creditable balance of 0");
  });

  it("ignores a failed refund in both balances", () => {
    seedOrder(db, { amount: 300 });
    seedPayment(db, "pay_refund_failed1", "o1", "refund", 300, "failed");

    const refund = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "refund", orderId: "o1", amount: 300 });
    expect(refund.verdict).toBe("allow");

    const credit = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "credit", orderId: "o1", amount: 300 });
    expect(credit.verdict).toBe("allow");
  });

  it("ignores a failed credit in the creditable balance", () => {
    seedOrder(db, { amount: 300 });
    seedPayment(db, "pay_credit_failed1", "o1", "credit", 300, "failed");

    const verdict = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "credit", orderId: "o1", amount: 300 });
    expect(verdict.verdict).toBe("allow");
  });

  it("does not let a pending charge inflate the refundable balance", () => {
    // 300 collected, 200 still being collected. Only the 300 is ours to
    // refund; treating the pending charge as settled would let us pay out
    // against a charge that may still fail.
    seedOrder(db, { amount: 300 });
    seedPayment(db, "pay_charge_pending1", "o1", "charge", 200, "pending");

    const settledOnly = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "refund", orderId: "o1", amount: 300 });
    expect(settledOnly.verdict).toBe("allow");

    const overSettled = evaluatePolicy(db, POLICY, { customerId: "c1", actionType: "refund", orderId: "o1", amount: 301 });
    expect(overSettled.verdict).toBe("deny");
    if (overSettled.verdict === "deny") {
      expect(overSettled.denyReason).toBe("exceeds_refundable_amount");
      expect(overSettled.reason).toContain("refundable balance of 300");
    }
  });
});
