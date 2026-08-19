import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb, applySchema } from "../db/client.js";
import { getConversationHistory, issueRefundRaw, orderBelongsToCustomer } from "./mockApi.js";

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function seedConversation(
  db: Database.Database,
  id: string,
  opts: { date: string; orderId: string | null; summary: string; tags?: string },
) {
  db.prepare(`INSERT INTO conversations (id, customer_id, started_at, ended_at, outcome) VALUES (?, 'c1', ?, ?, 'resolved')`).run(
    id,
    opts.date,
    opts.date,
  );
  db.prepare(
    `INSERT INTO conversation_summaries (conversation_id, customer_id, order_id, date, topic_tags, outcome, summary_text)
     VALUES (?, 'c1', ?, ?, ?, 'resolved', ?)`,
  ).run(id, opts.orderId, opts.date, opts.tags ?? "", opts.summary);
}

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
  applySchema(db);
  db.prepare(`INSERT INTO customers (id, name, email, phone, created_at) VALUES ('c1','Test','t@x.com',NULL,'2026-01-01')`).run();
});

describe("getConversationHistory retrieval ranking", () => {
  it("ranks a keyword match above an irrelevant conversation, regardless of recency", async () => {
    seedConversation(db, "conv_relevant", {
      date: daysAgo(60),
      orderId: null,
      summary: "Customer asked about a refund for a delayed shipment.",
    });
    seedConversation(db, "conv_irrelevant", {
      date: daysAgo(1),
      orderId: null,
      summary: "Customer asked how to update their shipping address.",
    });

    const hits = await getConversationHistory(db, "c1", "refund delayed shipment");
    expect(hits[0]?.conversationId).toBe("conv_relevant");
  });

  it("boosts a conversation linked to a related order over an equally-worded one that is not", async () => {
    db.prepare(`INSERT INTO orders (id, customer_id, item_name, amount, currency, status, order_date, delivery_date)
                VALUES ('ord_a','c1','Widget',100,'INR','delivered', ?, ?)`).run(daysAgo(10), daysAgo(8));

    seedConversation(db, "conv_linked", {
      date: daysAgo(10),
      orderId: "ord_a",
      summary: "Customer asked about warranty coverage for their order.",
    });
    seedConversation(db, "conv_unlinked", {
      date: daysAgo(10),
      orderId: null,
      summary: "Customer asked about warranty coverage for their order.",
    });

    const hits = await getConversationHistory(db, "c1", "warranty coverage", { relatedOrderIds: ["ord_a"] });
    expect(hits[0]?.conversationId).toBe("conv_linked");
  });

  it("breaks ties between equally relevant conversations by recency", async () => {
    seedConversation(db, "conv_older", { date: daysAgo(90), orderId: null, summary: "Customer asked about billing." });
    seedConversation(db, "conv_newer", { date: daysAgo(2), orderId: null, summary: "Customer asked about billing." });

    const hits = await getConversationHistory(db, "c1", "billing");
    expect(hits[0]?.conversationId).toBe("conv_newer");
  });

  it("attaches full transcripts only to the top 2 hits, not lower-ranked ones", async () => {
    for (let i = 0; i < 4; i++) {
      const id = `conv_${i}`;
      seedConversation(db, id, { date: daysAgo(i + 1), orderId: null, summary: `Customer asked about topic number ${i}.` });
      db.prepare(`INSERT INTO conversation_messages (conversation_id, role, content, ts) VALUES (?, 'customer', 'hello', ?)`).run(
        id,
        daysAgo(i + 1),
      );
    }
    const hits = await getConversationHistory(db, "c1", "topic number", { limit: 4 });
    expect(hits).toHaveLength(4);
    expect(hits[0]?.transcript).toBeDefined();
    expect(hits[1]?.transcript).toBeDefined();
    expect(hits[2]?.transcript).toBeUndefined();
    expect(hits[3]?.transcript).toBeUndefined();
  });

  it("falls back to recency-only ranking when no query is given", async () => {
    seedConversation(db, "conv_old", { date: daysAgo(50), orderId: null, summary: "Old conversation." });
    seedConversation(db, "conv_recent", { date: daysAgo(1), orderId: null, summary: "Recent conversation." });
    const hits = await getConversationHistory(db, "c1", undefined);
    expect(hits[0]?.conversationId).toBe("conv_recent");
  });
});

// ---------------------------------------------------------------------------
// Ownership enforcement (docs/plans/005 Phase 1). Defense in depth: these
// tests exercise the shared orderBelongsToCustomer helper, the raw
// money-movement path's own ownership assertion, and the two BEFORE INSERT
// triggers in schema.sql directly, independent of the policy engine (which
// has its own coverage in policy/engine.test.ts) and of the ledger pipeline
// (ledger/pipeline.test.ts).
// ---------------------------------------------------------------------------

function seedCustomer(db: Database.Database, id: string): void {
  db.prepare(`INSERT INTO customers (id, name, email, phone, created_at) VALUES (?, ?, ?, NULL, '2026-01-01')`).run(
    id,
    `Name ${id}`,
    `${id}@example.com`,
  );
}

function seedOrderFor(db: Database.Database, id: string, customerId: string, amount = 300): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO orders (id, customer_id, item_name, amount, currency, status, order_date, delivery_date)
     VALUES (?, ?, 'Widget', ?, 'INR', 'delivered', ?, ?)`,
  ).run(id, customerId, amount, now, now);
}

describe("orderBelongsToCustomer", () => {
  it("returns true when the order belongs to the customer", () => {
    seedOrderFor(db, "o1", "c1");
    expect(orderBelongsToCustomer(db, "o1", "c1")).toBe(true);
  });

  it("returns false when the order belongs to a different customer", () => {
    seedCustomer(db, "c2");
    seedOrderFor(db, "o1", "c2");
    expect(orderBelongsToCustomer(db, "o1", "c1")).toBe(false);
  });

  it("returns false for a nonexistent order, indistinguishably from a foreign one", () => {
    expect(orderBelongsToCustomer(db, "does_not_exist", "c1")).toBe(false);
  });
});

describe("issueRefundRaw ownership guard (defense in depth below the policy engine)", () => {
  it("throws on a foreign order and writes no payments row", async () => {
    seedCustomer(db, "c2");
    seedOrderFor(db, "o_foreign", "c2");

    await expect(
      issueRefundRaw(db, { orderId: "o_foreign", customerId: "c1", amount: 300, idempotencyKey: "key_foreign_1" }),
    ).rejects.toThrow(/does not belong to customer/);

    const count = (
      db.prepare(`SELECT COUNT(*) AS n FROM payments WHERE order_id = ?`).get("o_foreign") as { n: number }
    ).n;
    expect(count).toBe(0);
  });
});

describe("payments_order_owner_guard trigger", () => {
  it("aborts a direct insert whose customer_id does not own the order", () => {
    seedCustomer(db, "c2");
    seedOrderFor(db, "o_foreign", "c2");

    expect(() =>
      db
        .prepare(
          `INSERT INTO payments (id, order_id, customer_id, amount, currency, type, status, idempotency_key, provider_reference, created_at)
           VALUES ('pay_bad', 'o_foreign', 'c1', 300, 'INR', 'refund', 'succeeded', 'k_bad', NULL, '2026-01-01')`,
        )
        .run(),
    ).toThrow(/does not own/);

    const count = (
      db.prepare(`SELECT COUNT(*) AS n FROM payments WHERE order_id = ?`).get("o_foreign") as { n: number }
    ).n;
    expect(count).toBe(0);
  });

  it("succeeds for a direct insert whose customer_id matches the order's owner", () => {
    seedOrderFor(db, "o_owned", "c1");

    expect(() =>
      db
        .prepare(
          `INSERT INTO payments (id, order_id, customer_id, amount, currency, type, status, idempotency_key, provider_reference, created_at)
           VALUES ('pay_good', 'o_owned', 'c1', 300, 'INR', 'refund', 'succeeded', 'k_good', NULL, '2026-01-01')`,
        )
        .run(),
    ).not.toThrow();

    const count = (
      db.prepare(`SELECT COUNT(*) AS n FROM payments WHERE order_id = ?`).get("o_owned") as { n: number }
    ).n;
    expect(count).toBe(1);
  });
});

describe("ledger_order_owner_guard trigger", () => {
  it("allows a denied row with a foreign order_id (the audit record of refusing exactly this mismatch)", () => {
    seedCustomer(db, "c2");
    seedOrderFor(db, "o_foreign", "c2");

    expect(() =>
      db
        .prepare(
          `INSERT INTO actions_ledger (idempotency_key, thread_id, action_type, customer_id, order_id, amount, currency, status, reason, created_at)
           VALUES ('k_denied', 't1', 'refund', 'c1', 'o_foreign', 300, 'INR', 'denied', 'No order found with id o_foreign for this customer.', '2026-01-01')`,
        )
        .run(),
    ).not.toThrow();

    const row = db.prepare(`SELECT status FROM actions_ledger WHERE idempotency_key = 'k_denied'`).get() as
      | { status: string }
      | undefined;
    expect(row?.status).toBe("denied");
  });

  it("aborts a pending row with a foreign order_id", () => {
    seedCustomer(db, "c2");
    seedOrderFor(db, "o_foreign", "c2");

    expect(() =>
      db
        .prepare(
          `INSERT INTO actions_ledger (idempotency_key, thread_id, action_type, customer_id, order_id, amount, currency, status, reason, created_at)
           VALUES ('k_pending', 't1', 'refund', 'c1', 'o_foreign', 300, 'INR', 'pending', 'test', '2026-01-01')`,
        )
        .run(),
    ).toThrow(/does not own/);

    const count = (
      db.prepare(`SELECT COUNT(*) AS n FROM actions_ledger WHERE idempotency_key = 'k_pending'`).get() as { n: number }
    ).n;
    expect(count).toBe(0);
  });
});
