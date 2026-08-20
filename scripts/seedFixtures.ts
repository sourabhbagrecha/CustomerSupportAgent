import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

// Fixture-loading logic, extracted from scripts/seed.ts so both the real
// file-backed seed script and the eval harness (isolated in-memory db per
// scenario) can load the exact same committed fixtures without duplicating
// insert order or shapes. See CLAUDE.md: fixtures are committed, never
// generated at the evaluator's runtime.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "fixtures");

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf-8")) as T;
}

interface CustomerFixture {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  createdAt: string;
}

interface OrderFixture {
  id: string;
  customerId: string;
  itemName: string;
  amount: number;
  currency: string;
  status: string;
  orderDate: string;
  deliveryDate: string | null;
}

interface PaymentFixture {
  id: string;
  orderId: string | null;
  customerId: string;
  amount: number;
  currency: string;
  type: string;
  status: string;
  idempotencyKey: string | null;
  providerReference: string | null;
  createdAt: string;
}

interface ConversationFixture {
  id: string;
  customerId: string;
  startedAt: string;
  endedAt: string | null;
  outcome: string | null;
}

interface ConversationMessageFixture {
  conversationId: string;
  role: string;
  content: string;
  ts: string;
}

interface ConversationSummaryFixture {
  conversationId: string;
  customerId: string;
  orderId: string | null;
  date: string;
  topicTags: string[];
  outcome: string | null;
  summaryText: string;
}

interface PolicyChunkFixture {
  chunkIndex: number;
  heading: string;
  chunkText: string;
}

// ---------------------------------------------------------------------------
// Date stability (docs/plans/013, Track A).
//
// Fixture dates are committed as absolute ISO strings, which keeps them
// readable and diffable, but the policy engine measures the 30-day refund
// window against the real current date. Left alone, the committed orders age
// out: the money-path eval suite would start denying by window a few weeks
// after the fixtures were written, and anyone cloning this repository later
// would see a red suite that says nothing about the system.
//
// So seeding shifts every date-bearing field forward by a whole number of UTC
// days, computed once per load as (today - fixtures/epoch.json generatedAt).
// Every relative age is preserved exactly and forever: an order that was 21
// days old on the day the fixtures were generated is 21 days old a year
// later.
//
// This does not violate CLAUDE.md invariant 5. The fixtures stay committed
// and nothing is generated at the evaluator's runtime; seeding resolves a
// committed offset against a committed epoch, which is arithmetic over
// committed data, not data generation.
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// A committed date string is either date-only ("2026-08-19") or a full
// timestamp ("2026-08-06T10:14:00.000Z"). Group 1 is the calendar date, group
// 2 is whatever followed it, kept verbatim.
const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})(.*)$/;

export interface FixtureEpoch {
  generatedAt: string;
  note: string;
}

// Reads the committed epoch: the UTC date fixtures/ was generated on.
// Malformed content throws rather than silently defaulting to "no shift",
// because a silent zero shift is exactly the drift this mechanism exists to
// prevent (CLAUDE.md: never swallow an error).
export function loadFixtureEpoch(): FixtureEpoch {
  const epoch = loadJson<Partial<FixtureEpoch>>("epoch.json");
  if (typeof epoch.generatedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(epoch.generatedAt)) {
    throw new Error(
      `fixtures/epoch.json has no valid "generatedAt" (expected a YYYY-MM-DD UTC date, got ${JSON.stringify(epoch.generatedAt)}). Run "npm run fixtures" to regenerate it.`,
    );
  }
  return { generatedAt: epoch.generatedAt, note: typeof epoch.note === "string" ? epoch.note : "" };
}

// Whole UTC days between the fixture epoch and today, both truncated to a
// UTC calendar date first so the result never depends on the time of day.
// Clamped at 0: a clock behind the epoch must never shift fixture dates
// backwards, which would make committed orders look like they happen in the
// future.
export function computeShiftDays(generatedAt: string, today: Date): number {
  const match = DATE_PREFIX.exec(generatedAt);
  if (!match) throw new Error(`Fixture epoch "${generatedAt}" is not a YYYY-MM-DD UTC date.`);
  const epochMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const todayMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.max(0, Math.round((todayMs - epochMs) / MS_PER_DAY));
}

// Adds `days` to the calendar-date portion of a committed date string and
// re-renders it in exactly the shape it arrived in: a date-only string stays
// date-only, a timestamp keeps its original time, precision and zone suffix
// byte for byte. Both the retrieval FTS index and the current_date context
// block read these values back, so normalising a date-only field into a
// timestamp (or the reverse) is not acceptable.
//
// The arithmetic is done in UTC on purpose: UTC has no DST, so adding whole
// days is always exactly N * 24h and never lands on a skipped or repeated
// local hour.
export function shiftDateString(value: string, days: number): string {
  if (days === 0) return value;
  const match = DATE_PREFIX.exec(value);
  if (!match) throw new Error(`Fixture date "${value}" is not an ISO date or timestamp; cannot shift it.`);
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + days * MS_PER_DAY);
  const yyyy = String(shifted.getUTCFullYear()).padStart(4, "0");
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}${match[4] ?? ""}`;
}

// Nullable variant for the fields that are legitimately absent
// (orders.deliveryDate, conversations.endedAt).
function shiftNullable(value: string | null, days: number): string | null {
  return value === null ? null : shiftDateString(value, days);
}

export interface LoadFixturesOptions {
  // Pins "today" for the date shift. Defaults to the real clock; tests pass
  // an explicit instant so they never depend on when they run.
  today?: Date;
}

// Loads every fixtures/*.json file into an already-schema'd db, inside one
// transaction, in the fixed insert order required by foreign keys: customers,
// orders, payments, conversations, conversation_messages,
// conversation_summaries, policy_chunks. Every date-bearing field is shifted
// forward by the committed epoch offset on the way in (see above).
export function loadFixturesInto(db: Database.Database, options: LoadFixturesOptions = {}): void {
  const customers = loadJson<CustomerFixture[]>("customers.json");
  const orders = loadJson<OrderFixture[]>("orders.json");
  const payments = loadJson<PaymentFixture[]>("payments.json");
  const conversations = loadJson<ConversationFixture[]>("conversations.json");
  const conversationMessages = loadJson<ConversationMessageFixture[]>("conversation_messages.json");
  const conversationSummaries = loadJson<ConversationSummaryFixture[]>("conversation_summaries.json");
  const policyChunks = loadJson<PolicyChunkFixture[]>("policy_chunks.json");

  // Computed once per load, so every table shifts by the same amount and no
  // two rows can disagree about what "today" was mid-transaction.
  const shiftDays = computeShiftDays(loadFixtureEpoch().generatedAt, options.today ?? new Date());

  const insertCustomer = db.prepare(
    `INSERT INTO customers (id, name, email, phone, created_at) VALUES (@id, @name, @email, @phone, @createdAt)`,
  );
  const insertOrder = db.prepare(
    `INSERT INTO orders (id, customer_id, item_name, amount, currency, status, order_date, delivery_date)
     VALUES (@id, @customerId, @itemName, @amount, @currency, @status, @orderDate, @deliveryDate)`,
  );
  const insertPayment = db.prepare(
    `INSERT INTO payments (id, order_id, customer_id, amount, currency, type, status, idempotency_key, provider_reference, created_at)
     VALUES (@id, @orderId, @customerId, @amount, @currency, @type, @status, @idempotencyKey, @providerReference, @createdAt)`,
  );
  const insertConversation = db.prepare(
    `INSERT INTO conversations (id, customer_id, started_at, ended_at, outcome) VALUES (@id, @customerId, @startedAt, @endedAt, @outcome)`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO conversation_messages (conversation_id, role, content, ts) VALUES (@conversationId, @role, @content, @ts)`,
  );
  const insertSummary = db.prepare(
    `INSERT INTO conversation_summaries (conversation_id, customer_id, order_id, date, topic_tags, outcome, summary_text)
     VALUES (@conversationId, @customerId, @orderId, @date, @topicTags, @outcome, @summaryText)`,
  );
  const insertPolicyChunk = db.prepare(
    `INSERT INTO policy_chunks (chunk_index, heading, chunk_text) VALUES (@chunkIndex, @heading, @chunkText)`,
  );

  const seedAll = db.transaction(() => {
    for (const row of customers) {
      insertCustomer.run({ ...row, createdAt: shiftDateString(row.createdAt, shiftDays) });
    }
    for (const row of orders) {
      insertOrder.run({
        ...row,
        orderDate: shiftDateString(row.orderDate, shiftDays),
        deliveryDate: shiftNullable(row.deliveryDate, shiftDays),
      });
    }
    for (const row of payments) {
      insertPayment.run({ ...row, createdAt: shiftDateString(row.createdAt, shiftDays) });
    }
    for (const row of conversations) {
      insertConversation.run({
        ...row,
        startedAt: shiftDateString(row.startedAt, shiftDays),
        endedAt: shiftNullable(row.endedAt, shiftDays),
      });
    }
    for (const row of conversationMessages) {
      insertMessage.run({ ...row, ts: shiftDateString(row.ts, shiftDays) });
    }
    for (const row of conversationSummaries) {
      insertSummary.run({
        ...row,
        date: shiftDateString(row.date, shiftDays),
        topicTags: row.topicTags.join(","),
      });
    }
    // policy_chunks carry no dates, so they are inserted verbatim.
    for (const row of policyChunks) insertPolicyChunk.run(row);
  });

  seedAll();
}
