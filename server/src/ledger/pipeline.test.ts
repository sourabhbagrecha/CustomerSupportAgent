import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDb, applySchema } from "../db/client.js";
import { clearAllFaults, setFault } from "../faults/registry.js";
import type { PolicyDocument } from "../policy/schemas.js";
import { issueRefundRaw } from "../tools/mockApi.js";
import { getPendingApprovalForThread } from "./approvals.js";
import { resolveApprovedAction, resolveRejectedAction, runMoneyAction } from "./pipeline.js";

// Phase 3 (docs/plans/005) provider-response-validation coverage needs a way
// to make the raw mock provider return a malformed shape without a
// production fault seam for it (the fault registry only injects thrown
// errors, e.g. refund_timeout_after_success, never a bad return value).
// vitest hoists this vi.mock call above the imports above at transform time,
// so it wraps the real implementation before pipeline.ts's own import of it
// resolves. Every existing test in this file still exercises the real mock
// provider; only the one test below overrides it, once, via
// mockImplementationOnce.
vi.mock("../tools/mockApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/mockApi.js")>();
  return { ...actual, issueRefundRaw: vi.fn(actual.issueRefundRaw) };
});

const POLICY: PolicyDocument = {
  maxAutoRefundINR: 500,
  maxAutoCreditINR: 500,
  refundWindowDays: 30,
  eligibleOrderStatusesForRefund: ["delivered", "failed_delivery", "cancelled", "partially_refunded"],
};

function seedOrder(db: Database.Database, id: string, amount: number, status = "delivered") {
  db.prepare(`INSERT INTO customers (id, name, email, phone, created_at) VALUES ('c1','Test','t@x.com',NULL,'2026-01-01')`).run();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO orders (id, customer_id, item_name, amount, currency, status, order_date, delivery_date)
     VALUES (@id, 'c1', 'Widget', @amount, 'INR', @status, @now, @now)`,
  ).run({ id, amount, status, now });
  db.prepare(
    `INSERT INTO payments (id, order_id, customer_id, amount, currency, type, status, idempotency_key, provider_reference, created_at)
     VALUES (@pid, @id, 'c1', @amount, 'INR', 'charge', 'succeeded', NULL, NULL, @now)`,
  ).run({ id, amount, now, pid: `pay_charge_${id}` });
}

function countPayments(db: Database.Database, orderId: string, type: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM payments WHERE order_id = ? AND type = ?`).get(orderId, type) as { n: number }
  ).n;
}

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
  applySchema(db);
});

afterEach(() => {
  clearAllFaults();
});

describe("runMoneyAction", () => {
  it("allow path: writes a ledger row before calling the mock API and ends succeeded", async () => {
    seedOrder(db, "o1", 450);
    const result = await runMoneyAction(db, POLICY, {
      threadId: "t1",
      customerId: "c1",
      actionType: "refund",
      orderId: "o1",
      amount: 450,
      reason: "test",
    });
    expect(result.status).toBe("succeeded");
    expect(countPayments(db, "o1", "refund")).toBe(1);
    const ledgerRows = db.prepare(`SELECT status FROM actions_ledger WHERE thread_id = 't1'`).all() as { status: string }[];
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.status).toBe("succeeded");
  });

  it("deny path: writes a denied ledger row and never calls the mock API", async () => {
    seedOrder(db, "o2", 450, "placed");
    const result = await runMoneyAction(db, POLICY, {
      threadId: "t2",
      customerId: "c1",
      actionType: "refund",
      orderId: "o2",
      amount: 450,
      reason: "test",
    });
    expect(result.status).toBe("denied");
    expect(countPayments(db, "o2", "refund")).toBe(0);
  });

  it("requires_approval path: writes an awaiting_approval ledger row and a pending approval row", async () => {
    seedOrder(db, "o3", 5000);
    const result = await runMoneyAction(db, POLICY, {
      threadId: "t3",
      customerId: "c1",
      actionType: "refund",
      orderId: "o3",
      amount: 5000,
      reason: "test",
    });
    expect(result.status).toBe("awaiting_approval");
    expect(countPayments(db, "o3", "refund")).toBe(0);
    const approval = getPendingApprovalForThread(db, "t3");
    expect(approval?.status).toBe("pending");
    expect(approval?.amount).toBe(5000);
  });

  it("is exactly-once idempotent: repeating the identical logical action never moves money twice", async () => {
    seedOrder(db, "o4", 300);
    const first = await runMoneyAction(db, POLICY, {
      threadId: "t4",
      customerId: "c1",
      actionType: "refund",
      orderId: "o4",
      amount: 300,
      reason: "attempt 1",
    });
    const second = await runMoneyAction(db, POLICY, {
      threadId: "t4",
      customerId: "c1",
      actionType: "refund",
      orderId: "o4",
      amount: 300,
      reason: "attempt 2 (retry with same logical action)",
    });
    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
    if (first.status === "succeeded" && second.status === "succeeded") {
      expect(second.receipt.paymentId).toBe(first.receipt.paymentId);
    }
    expect(countPayments(db, "o4", "refund")).toBe(1);
  });

  it("the double-refund trap: refund_timeout_after_success reconciles to exactly one payment, never two", async () => {
    seedOrder(db, "o5", 400);
    setFault("refund_timeout_after_success", true, 1);

    const result = await runMoneyAction(db, POLICY, {
      threadId: "t5",
      customerId: "c1",
      actionType: "refund",
      orderId: "o5",
      amount: 400,
      reason: "test timeout",
    });

    expect(result.status).toBe("reconciled");
    expect(countPayments(db, "o5", "refund")).toBe(1);

    const ledgerRow = db.prepare(`SELECT status FROM actions_ledger WHERE thread_id = 't5'`).get() as { status: string };
    expect(ledgerRow.status).toBe("reconciled");

    // A later call with the same logical action (same key) must not act again.
    const replay = await runMoneyAction(db, POLICY, {
      threadId: "t5",
      customerId: "c1",
      actionType: "refund",
      orderId: "o5",
      amount: 400,
      reason: "customer asks again",
    });
    expect(replay.status).toBe("reconciled");
    expect(countPayments(db, "o5", "refund")).toBe(1);
  });

  it("a malformed provider response (fails RawPaymentResultSchema) reconciles to exactly one payment, never a blind retry", async () => {
    seedOrder(db, "o12", 400);

    vi.mocked(issueRefundRaw).mockImplementationOnce(async (dbArg, params) => {
      // Simulate the provider having actually moved money but returned an
      // unreadable response (paymentId missing entirely), mirroring how
      // refund_timeout_after_success is injected in mockApi.ts AFTER the
      // real payment row is already committed: the uncertainty is in the
      // response, not in whether money moved.
      dbArg
        .prepare(
          `INSERT INTO payments (id, order_id, customer_id, amount, currency, type, status, idempotency_key, provider_reference, created_at)
           VALUES (@id, @orderId, @customerId, @amount, 'INR', 'refund', 'succeeded', @idempotencyKey, @providerReference, @createdAt)`,
        )
        .run({
          id: "pay_malformed_test",
          orderId: params.orderId,
          customerId: params.customerId,
          amount: params.amount,
          idempotencyKey: params.idempotencyKey,
          providerReference: "prov_malformed_test",
          createdAt: new Date().toISOString(),
        });
      // Malformed: no paymentId field at all, so RawPaymentResultSchema.parse
      // in callRawMockApi (pipeline.ts) throws a ZodError.
      return { providerReference: "prov_malformed_test" } as unknown as Awaited<ReturnType<typeof issueRefundRaw>>;
    });

    const result = await runMoneyAction(db, POLICY, {
      threadId: "t12",
      customerId: "c1",
      actionType: "refund",
      orderId: "o12",
      amount: 400,
      reason: "test malformed provider response",
    });

    expect(result.status).toBe("reconciled");
    expect(countPayments(db, "o12", "refund")).toBe(1);

    const ledgerRow = db.prepare(`SELECT status FROM actions_ledger WHERE thread_id = 't12'`).get() as { status: string };
    expect(ledgerRow.status).toBe("reconciled");

    const errorEvents = db
      .prepare(`SELECT payload FROM events WHERE thread_id = 't12' AND type = 'error'`)
      .all() as Array<{ payload: string }>;
    const validationEvent = errorEvents
      .map((e) => JSON.parse(e.payload) as { stage?: string })
      .find((p) => p.stage === "provider_response_validation");
    expect(validationEvent).toBeDefined();
  });

  it("resolveApprovedAction completes the money movement for an approved ledger row", async () => {
    seedOrder(db, "o6", 5000);
    const pending = await runMoneyAction(db, POLICY, {
      threadId: "t6",
      customerId: "c1",
      actionType: "refund",
      orderId: "o6",
      amount: 5000,
      reason: "test",
    });
    expect(pending.status).toBe("awaiting_approval");
    const ledgerRow = db.prepare(`SELECT * FROM actions_ledger WHERE thread_id = 't6'`).get() as {
      id: number;
      idempotency_key: string;
      thread_id: string;
      action_type: "refund" | "credit";
      customer_id: string;
      order_id: string | null;
      amount: number;
      currency: string;
      status: "pending" | "succeeded" | "failed" | "failed_unknown" | "reconciled" | "denied" | "awaiting_approval";
      reason: string;
      created_at: string;
      resolved_at: string | null;
      raw_response: string | null;
    };
    const resolved = await resolveApprovedAction(db, {
      id: ledgerRow.id,
      idempotencyKey: ledgerRow.idempotency_key,
      threadId: ledgerRow.thread_id,
      actionType: ledgerRow.action_type,
      customerId: ledgerRow.customer_id,
      orderId: ledgerRow.order_id,
      amount: ledgerRow.amount,
      currency: ledgerRow.currency,
      status: ledgerRow.status,
      reason: ledgerRow.reason,
      createdAt: ledgerRow.created_at,
      resolvedAt: ledgerRow.resolved_at,
      rawResponse: ledgerRow.raw_response,
    });
    expect(resolved.status).toBe("succeeded");
    expect(countPayments(db, "o6", "refund")).toBe(1);
  });

  it("a foreign order denies with policyReason containing 'No order found', exactly one denied ledger row, and zero payments", async () => {
    // o10 belongs to c1 (seedOrder always creates its order under customer
    // c1); c2 is a different customer requesting a refund on it.
    seedOrder(db, "o10", 300);
    db.prepare(`INSERT INTO customers (id, name, email, phone, created_at) VALUES ('c2','Other','o@x.com',NULL,'2026-01-01')`).run();

    const result = await runMoneyAction(db, POLICY, {
      threadId: "t10",
      customerId: "c2",
      actionType: "refund",
      orderId: "o10",
      amount: 300,
      reason: "test",
    });

    expect(result.status).toBe("denied");
    if (result.status === "denied") {
      expect(result.policyReason).toContain("No order found");
    }
    expect(countPayments(db, "o10", "refund")).toBe(0);
    const ledgerRows = db.prepare(`SELECT status FROM actions_ledger WHERE thread_id = 't10'`).all() as { status: string }[];
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.status).toBe("denied");
  });

  it("a nonexistent order id denies rather than throwing, since the ledger FK on order_id was intentionally removed for exactly this", async () => {
    db.prepare(`INSERT INTO customers (id, name, email, phone, created_at) VALUES ('c1','Test','t@x.com',NULL,'2026-01-01')`).run();

    const result = await runMoneyAction(db, POLICY, {
      threadId: "t11",
      customerId: "c1",
      actionType: "refund",
      orderId: "does_not_exist",
      amount: 100,
      reason: "test",
    });

    expect(result.status).toBe("denied");
    if (result.status === "denied") {
      expect(result.policyReason).toContain("No order found");
    }
    const ledgerRows = db
      .prepare(`SELECT status, order_id FROM actions_ledger WHERE thread_id = 't11'`)
      .all() as Array<{ status: string; order_id: string | null }>;
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.status).toBe("denied");
    expect(ledgerRows[0]?.order_id).toBe("does_not_exist");
  });

  it("resolveRejectedAction denies without ever calling the mock API", () => {
    seedOrder(db, "o7", 5000);
    const ledgerRow = {
      id: 1,
      idempotencyKey: "fake_key",
      threadId: "t7",
      actionType: "refund" as const,
      customerId: "c1",
      orderId: "o7",
      amount: 5000,
      currency: "INR",
      status: "awaiting_approval" as const,
      reason: "over cap",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      rawResponse: null,
    };
    db.prepare(
      `INSERT INTO actions_ledger (id, idempotency_key, thread_id, action_type, customer_id, order_id, amount, currency, status, reason, created_at)
       VALUES (@id, @idempotencyKey, @threadId, @actionType, @customerId, @orderId, @amount, @currency, @status, @reason, @createdAt)`,
    ).run(ledgerRow);
    const result = resolveRejectedAction(db, ledgerRow);
    expect(result.status).toBe("denied");
    expect(countPayments(db, "o7", "refund")).toBe(0);
  });
});

describe("human exception review on a denied row", () => {
  it("granting an exception reuses the same idempotency key and yields exactly one payment", async () => {
    seedOrder(db, "o8", 450, "placed");
    const denied = await runMoneyAction(db, POLICY, {
      threadId: "t8",
      customerId: "c1",
      actionType: "refund",
      orderId: "o8",
      amount: 450,
      reason: "test",
    });
    expect(denied.status).toBe("denied");
    const before = db.prepare(`SELECT * FROM actions_ledger WHERE thread_id = 't8'`).get() as {
      id: number;
      idempotency_key: string;
    };

    const resolved = await resolveApprovedAction(
      db,
      {
        id: before.id,
        idempotencyKey: before.idempotency_key,
        threadId: "t8",
        actionType: "refund",
        customerId: "c1",
        orderId: "o8",
        amount: 450,
        currency: "INR",
        status: "denied",
        reason: "Order status \"placed\" is not eligible for a refund.",
        createdAt: new Date().toISOString(),
        resolvedAt: null,
        rawResponse: null,
      },
      "Customer provided proof of delivery over the phone",
      "Exception granted by human reviewer",
    );

    expect(resolved.status).toBe("succeeded");
    expect(countPayments(db, "o8", "refund")).toBe(1);
    const after = db.prepare(`SELECT idempotency_key, reason FROM actions_ledger WHERE thread_id = 't8'`).get() as {
      idempotency_key: string;
      reason: string;
    };
    expect(after.idempotency_key).toBe(before.idempotency_key);
    expect(after.reason).toBe("Exception granted by human reviewer: Customer provided proof of delivery over the phone");
  });

  it("upholding a denial writes the remark into the reason and never moves money", async () => {
    seedOrder(db, "o9", 450, "placed");
    const denied = await runMoneyAction(db, POLICY, {
      threadId: "t9",
      customerId: "c1",
      actionType: "refund",
      orderId: "o9",
      amount: 450,
      reason: "test",
    });
    expect(denied.status).toBe("denied");
    const row = db.prepare(`SELECT * FROM actions_ledger WHERE thread_id = 't9'`).get() as {
      id: number;
      idempotency_key: string;
    };

    const result = resolveRejectedAction(
      db,
      {
        id: row.id,
        idempotencyKey: row.idempotency_key,
        threadId: "t9",
        actionType: "refund",
        customerId: "c1",
        orderId: "o9",
        amount: 450,
        currency: "INR",
        status: "denied",
        reason: "Order status \"placed\" is not eligible for a refund.",
        createdAt: new Date().toISOString(),
        resolvedAt: null,
        rawResponse: null,
      },
      "Policy is correct here, order was never delivered",
      "Denial upheld by human reviewer",
    );

    expect(result.status).toBe("denied");
    expect(countPayments(db, "o9", "refund")).toBe(0);
    const after = db.prepare(`SELECT reason FROM actions_ledger WHERE thread_id = 't9'`).get() as { reason: string };
    expect(after.reason).toBe("Denial upheld by human reviewer: Policy is correct here, order was never delivered");
  });
});
