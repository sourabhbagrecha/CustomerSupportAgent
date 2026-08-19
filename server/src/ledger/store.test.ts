import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { applySchema, openDb } from "../db/client.js";
import { countLedgerRows, insertLedgerRow, listLedgerRows, type LedgerStatus } from "./store.js";

// actions_ledger has foreign keys onto customers and orders, and client.ts
// turns foreign_keys ON, so the parents have to exist before any insert.
function seedParents(db: Database.Database) {
  db.prepare(
    `INSERT INTO customers (id, name, email, phone, created_at) VALUES ('c1','Test','t@x.com',NULL,'2026-01-01')`,
  ).run();
  for (const id of ["ord_a", "ord_b"]) {
    db.prepare(
      `INSERT INTO orders (id, customer_id, item_name, amount, currency, status, order_date, delivery_date)
       VALUES (@id, 'c1', 'Widget', 100, 'INR', 'delivered', '2026-01-01', '2026-01-02')`,
    ).run({ id });
  }
}

function addRow(db: Database.Database, key: string, threadId: string, status: LedgerStatus) {
  return insertLedgerRow(db, {
    idempotencyKey: key,
    threadId,
    actionType: "refund",
    customerId: "c1",
    orderId: "ord_a",
    amount: 100,
    currency: "INR",
    status,
    reason: `row ${key}`,
  });
}

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
  applySchema(db);
  seedParents(db);
  // Five rows, three statuses, two threads. Insertion order is also id order.
  addRow(db, "k1", "t1", "succeeded");
  addRow(db, "k2", "t1", "denied");
  addRow(db, "k3", "t2", "denied");
  addRow(db, "k4", "t2", "awaiting_approval");
  addRow(db, "k5", "t1", "succeeded");
});

describe("listLedgerRows", () => {
  it("returns every row, newest id first, when no filter is given", () => {
    const rows = listLedgerRows(db, { limit: 100, offset: 0 });
    expect(rows.map((r) => r.idempotencyKey)).toEqual(["k5", "k4", "k3", "k2", "k1"]);
  });

  it("does not throw when both optional filters are absent", () => {
    // better-sqlite3 rejects undefined named parameters, so this guards the
    // `?? null` normalization rather than the SQL itself.
    expect(() => listLedgerRows(db, { limit: 10, offset: 0 })).not.toThrow();
    expect(() => countLedgerRows(db, {})).not.toThrow();
  });

  it("filters by status", () => {
    const rows = listLedgerRows(db, { status: "denied", limit: 100, offset: 0 });
    expect(rows.map((r) => r.idempotencyKey)).toEqual(["k3", "k2"]);
    expect(rows.every((r) => r.status === "denied")).toBe(true);
  });

  it("filters by threadId", () => {
    const rows = listLedgerRows(db, { threadId: "t1", limit: 100, offset: 0 });
    expect(rows.map((r) => r.idempotencyKey)).toEqual(["k5", "k2", "k1"]);
  });

  it("combines both filters", () => {
    const rows = listLedgerRows(db, { threadId: "t1", status: "succeeded", limit: 100, offset: 0 });
    expect(rows.map((r) => r.idempotencyKey)).toEqual(["k5", "k1"]);
  });

  it("pages without gaps or overlaps", () => {
    const all = listLedgerRows(db, { limit: 100, offset: 0 }).map((r) => r.id);
    const page1 = listLedgerRows(db, { limit: 2, offset: 0 }).map((r) => r.id);
    const page2 = listLedgerRows(db, { limit: 2, offset: 2 }).map((r) => r.id);
    const page3 = listLedgerRows(db, { limit: 2, offset: 4 }).map((r) => r.id);
    expect([...page1, ...page2, ...page3]).toEqual(all);
  });

  it("returns an empty array past the end", () => {
    expect(listLedgerRows(db, { limit: 10, offset: 99 })).toEqual([]);
  });
});

describe("countLedgerRows", () => {
  it("matches the unpaginated length for every filter", () => {
    const filters = [{}, { status: "denied" as const }, { threadId: "t1" }, { threadId: "t2", status: "denied" as const }];
    for (const filter of filters) {
      expect(countLedgerRows(db, filter)).toBe(listLedgerRows(db, { ...filter, limit: 999, offset: 0 }).length);
    }
  });

  it("is unaffected by limit and offset", () => {
    expect(countLedgerRows(db, {})).toBe(5);
    expect(listLedgerRows(db, { limit: 2, offset: 0 })).toHaveLength(2);
  });
});
