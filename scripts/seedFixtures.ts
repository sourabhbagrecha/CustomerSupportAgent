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

// Loads every fixtures/*.json file into an already-schema'd db, inside one
// transaction, in the fixed insert order required by foreign keys: customers,
// orders, payments, conversations, conversation_messages,
// conversation_summaries, policy_chunks.
export function loadFixturesInto(db: Database.Database): void {
  const customers = loadJson<CustomerFixture[]>("customers.json");
  const orders = loadJson<OrderFixture[]>("orders.json");
  const payments = loadJson<PaymentFixture[]>("payments.json");
  const conversations = loadJson<ConversationFixture[]>("conversations.json");
  const conversationMessages = loadJson<ConversationMessageFixture[]>("conversation_messages.json");
  const conversationSummaries = loadJson<ConversationSummaryFixture[]>("conversation_summaries.json");
  const policyChunks = loadJson<PolicyChunkFixture[]>("policy_chunks.json");

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
    for (const row of customers) insertCustomer.run(row);
    for (const row of orders) insertOrder.run(row);
    for (const row of payments) insertPayment.run(row);
    for (const row of conversations) insertConversation.run(row);
    for (const row of conversationMessages) insertMessage.run(row);
    for (const row of conversationSummaries) {
      insertSummary.run({ ...row, topicTags: row.topicTags.join(",") });
    }
    for (const row of policyChunks) insertPolicyChunk.run(row);
  });

  seedAll();
}
