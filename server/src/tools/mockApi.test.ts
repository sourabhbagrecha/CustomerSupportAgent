import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDb, applySchema } from "../db/client.js";
import { getConversationHistory } from "./mockApi.js";

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
