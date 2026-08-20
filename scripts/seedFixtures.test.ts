import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applySchema, openDb } from "../server/src/db/client.js";
import { computeShiftDays, loadFixtureEpoch, loadFixturesInto, shiftDateString } from "./seedFixtures.js";

// docs/plans/013, Track A. The committed fixtures carry absolute dates but
// the policy engine measures the 30-day refund window against the real
// current date, so seeding shifts every date-bearing field forward by
// (today - fixtures/epoch.json generatedAt) whole UTC days. These tests are
// the guard on that arithmetic: relative ages must survive an arbitrarily
// late clone, the shift must never run backwards, and the exact string shape
// of every field must come through untouched (the retrieval FTS index and the
// current_date context block read these values back).
//
// Deterministic and model-free by construction: every case pins "today"
// explicitly, so nothing here depends on when the suite runs.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "fixtures");

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf-8")) as T;
}

interface RawOrder {
  id: string;
  orderDate: string;
  deliveryDate: string | null;
}

const RAW_ORDERS = readFixture<RawOrder[]>("orders.json");
const EPOCH = loadFixtureEpoch();

function rawOrder(id: string): RawOrder {
  const order = RAW_ORDERS.find((o) => o.id === id);
  if (!order) throw new Error(`Fixture order ${id} is missing; this test needs it.`);
  return order;
}

// Every committed order date shares the generation run's time of day. Pinning
// "today" to that same time of day makes each age an exact whole number of
// days instead of a whole number plus a fraction, which keeps the assertions
// below readable without weakening them.
const ORDER_TIME_OF_DAY = rawOrder("ord_001").orderDate.slice(10);

function pinToday(dateOnly: string): Date {
  return new Date(`${dateOnly}${ORDER_TIME_OF_DAY}`);
}

function seed(today: Date): Database.Database {
  const db = openDb(":memory:");
  applySchema(db);
  loadFixturesInto(db, { today });
  return db;
}

// The policy engine's own window anchor: delivery date when there is one,
// order date otherwise (server/src/policy/engine.ts).
function anchorAgeDays(db: Database.Database, orderId: string, today: Date): number {
  const row = db.prepare(`SELECT order_date, delivery_date FROM orders WHERE id = ?`).get(orderId) as
    | { order_date: string; delivery_date: string | null }
    | undefined;
  if (!row) throw new Error(`Order ${orderId} was not seeded.`);
  const anchor = row.delivery_date ?? row.order_date;
  return (today.getTime() - new Date(anchor).getTime()) / (24 * 60 * 60 * 1000);
}

const DATE_TABLES: Array<{ table: string; columns: string[] }> = [
  { table: "customers", columns: ["created_at"] },
  { table: "orders", columns: ["order_date", "delivery_date"] },
  { table: "payments", columns: ["created_at"] },
  { table: "conversations", columns: ["started_at", "ended_at"] },
  { table: "conversation_messages", columns: ["ts"] },
  { table: "conversation_summaries", columns: ["date"] },
];

const ROW_COUNT_TABLES = [
  "customers",
  "orders",
  "payments",
  "conversations",
  "conversation_messages",
  "conversation_summaries",
  "policy_chunks",
];

function countRows(db: Database.Database): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of ROW_COUNT_TABLES) {
    counts[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
  return counts;
}

let open: Database.Database[] = [];

function track(db: Database.Database): Database.Database {
  open.push(db);
  return db;
}

afterEach(() => {
  for (const db of open) db.close();
  open = [];
});

describe("fixture date shifting keeps relative ages stable", () => {
  it("leaves ord_006 and ord_001 exactly as old as they were generated, however late the clone", () => {
    // Two clones almost three years apart. Both must see the same ages.
    for (const day of ["2027-06-15", "2030-01-01"]) {
      const today = pinToday(day);
      const db = track(seed(today));

      // Measured from the committed fixtures, not assumed: ord_006 is the
      // prior-promise order and ord_001 the failed-delivery one.
      expect(anchorAgeDays(db, "ord_006", today)).toBe(21);
      expect(anchorAgeDays(db, "ord_001", today)).toBe(13);
      expect(anchorAgeDays(db, "ord_002", today)).toBe(6);
      expect(anchorAgeDays(db, "ord_003", today)).toBe(4);
      expect(anchorAgeDays(db, "ord_005", today)).toBe(3);

      // The whole point: still comfortably inside the 30-day refund window.
      for (const id of ["ord_001", "ord_002", "ord_003", "ord_005", "ord_006"]) {
        expect(anchorAgeDays(db, id, today)).toBeLessThan(30);
      }

      // ord_008_05 is the deliberately-stale order scenario 10 leans on; it
      // must stay far outside the window rather than being dragged inside.
      expect(anchorAgeDays(db, "ord_008_05", today)).toBe(116);
    }
  });

  it("shifts by whole days only, so seeding a day later ages every order by exactly one day", () => {
    const first = pinToday("2027-06-15");
    const second = pinToday("2027-06-16");
    const dbFirst = track(seed(first));
    const dbSecond = track(seed(second));
    // Same clock offset within the day, one calendar day apart, one extra
    // shift day: the age is identical, not drifting.
    expect(anchorAgeDays(dbSecond, "ord_006", second)).toBe(anchorAgeDays(dbFirst, "ord_006", first));
  });
});

describe("shift calculation", () => {
  it("is zero on the epoch date itself, whatever the time of day", () => {
    expect(computeShiftDays(EPOCH.generatedAt, new Date(`${EPOCH.generatedAt}T00:00:00.000Z`))).toBe(0);
    expect(computeShiftDays(EPOCH.generatedAt, new Date(`${EPOCH.generatedAt}T23:59:59.999Z`))).toBe(0);
  });

  it("clamps a clock behind the epoch to zero rather than shifting dates backwards", () => {
    expect(computeShiftDays(EPOCH.generatedAt, new Date("2026-08-18T12:00:00.000Z"))).toBe(0);
    expect(computeShiftDays(EPOCH.generatedAt, new Date("2020-01-01T00:00:00.000Z"))).toBe(0);
  });

  it("counts whole UTC days forward", () => {
    expect(computeShiftDays("2026-08-19", new Date("2026-08-20T00:00:00.000Z"))).toBe(1);
    expect(computeShiftDays("2026-08-19", new Date("2026-09-18T06:00:00.000Z"))).toBe(30);
    expect(computeShiftDays("2026-08-19", new Date("2027-08-19T00:00:00.000Z"))).toBe(365);
  });

  it("rejects an epoch that is not a UTC calendar date", () => {
    expect(() => computeShiftDays("not-a-date", new Date("2026-08-20T00:00:00.000Z"))).toThrow();
  });
});

describe("string-preserving date shifter", () => {
  it("keeps a date-only string date-only and a timestamp a timestamp", () => {
    expect(shiftDateString("2026-08-19", 5)).toBe("2026-08-24");
    expect(shiftDateString("2026-08-06T10:14:00.000Z", 5)).toBe("2026-08-11T10:14:00.000Z");
  });

  it("preserves the exact time, sub-second precision and zone suffix it was given", () => {
    expect(shiftDateString("2026-08-06T19:38:02.155Z", 1)).toBe("2026-08-07T19:38:02.155Z");
    expect(shiftDateString("2026-08-06T19:38:02Z", 1)).toBe("2026-08-07T19:38:02Z");
    expect(shiftDateString("2026-08-06T19:38:02+05:30", 1)).toBe("2026-08-07T19:38:02+05:30");
  });

  it("rolls over months, years and leap days in UTC", () => {
    expect(shiftDateString("2026-08-31T00:00:00.000Z", 1)).toBe("2026-09-01T00:00:00.000Z");
    expect(shiftDateString("2026-12-31T00:00:00.000Z", 1)).toBe("2027-01-01T00:00:00.000Z");
    expect(shiftDateString("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("is the identity at zero days", () => {
    expect(shiftDateString("2026-08-06T19:38:02.155Z", 0)).toBe("2026-08-06T19:38:02.155Z");
    expect(shiftDateString("2026-08-06", 0)).toBe("2026-08-06");
  });

  it("throws on a value that is not an ISO date rather than passing it through", () => {
    expect(() => shiftDateString("yesterday", 1)).toThrow();
  });
});

describe("seeding on the epoch date is byte-identical to the committed fixtures", () => {
  it("writes every date column through unchanged when the shift is zero", () => {
    const db = track(seed(new Date(`${EPOCH.generatedAt}T12:00:00.000Z`)));

    const seededOrders = db.prepare(`SELECT id, order_date, delivery_date FROM orders`).all() as Array<{
      id: string;
      order_date: string;
      delivery_date: string | null;
    }>;
    for (const row of seededOrders) {
      const raw = rawOrder(row.id);
      expect(row.order_date).toBe(raw.orderDate);
      expect(row.delivery_date).toBe(raw.deliveryDate);
    }

    // Nothing anywhere moved: the full set of distinct date values in the db
    // is exactly the set committed on disk.
    const seededValues = new Set<string>();
    for (const { table, columns } of DATE_TABLES) {
      for (const column of columns) {
        const rows = db.prepare(`SELECT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`).all() as Array<{
          v: string;
        }>;
        for (const row of rows) seededValues.add(row.v);
      }
    }
    const committedValues = collectCommittedDateValues();
    expect([...seededValues].sort()).toEqual([...committedValues].sort());
  });

  it("produces the same zero shift for a clock behind the epoch", () => {
    const db = track(seed(new Date("2026-08-01T00:00:00.000Z")));
    const row = db.prepare(`SELECT order_date FROM orders WHERE id = 'ord_001'`).get() as { order_date: string };
    expect(row.order_date).toBe(rawOrder("ord_001").orderDate);
  });
});

describe("shifting changes dates only", () => {
  it("leaves every row count identical to an unshifted seed", () => {
    const unshifted = track(seed(new Date(`${EPOCH.generatedAt}T12:00:00.000Z`)));
    const shifted = track(seed(pinToday("2031-03-09")));
    expect(countRows(shifted)).toEqual(countRows(unshifted));
    // And matches what is actually committed, so neither seed dropped rows.
    expect(countRows(shifted).orders).toBe(RAW_ORDERS.length);
  });

  it("keeps every seeded timestamp a timestamp and every date-only value date-only", () => {
    const db = track(seed(pinToday("2029-11-30")));
    const committedShapes = new Set([...collectCommittedDateValues()].map(shapeOf));
    for (const { table, columns } of DATE_TABLES) {
      for (const column of columns) {
        const rows = db.prepare(`SELECT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`).all() as Array<{
          v: string;
        }>;
        for (const row of rows) expect(committedShapes).toContain(shapeOf(row.v));
      }
    }
  });
});

// "date-only" or the literal time suffix, so a normalised value (a date-only
// field turned into a timestamp, or a dropped millisecond field) shows up as
// a shape the committed fixtures never contained.
function shapeOf(value: string): string {
  return value.length === 10 ? "date-only" : value.slice(10);
}

function collectCommittedDateValues(): Set<string> {
  const values = new Set<string>();
  const push = (v: string | null | undefined): void => {
    if (typeof v === "string") values.add(v);
  };
  for (const row of readFixture<Array<{ createdAt: string }>>("customers.json")) push(row.createdAt);
  for (const row of RAW_ORDERS) {
    push(row.orderDate);
    push(row.deliveryDate);
  }
  for (const row of readFixture<Array<{ createdAt: string }>>("payments.json")) push(row.createdAt);
  for (const row of readFixture<Array<{ startedAt: string; endedAt: string | null }>>("conversations.json")) {
    push(row.startedAt);
    push(row.endedAt);
  }
  for (const row of readFixture<Array<{ ts: string }>>("conversation_messages.json")) push(row.ts);
  for (const row of readFixture<Array<{ date: string }>>("conversation_summaries.json")) push(row.date);
  return values;
}
