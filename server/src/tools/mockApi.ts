import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { consumeFault } from "../faults/registry.js";
import { ToolNotFoundError, ToolServerError, ToolTimeoutError } from "./errors.js";
import type {
  ActionType,
  Customer,
  ConversationSummaryHit,
  Order,
  Payment,
  PolicyChunkHit,
} from "./schemas.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Applied at the top of every mock call: realistic base latency, plus the
// two generic faults (Section 5) that any endpoint can suffer.
async function simulateCall(latencyRangeMs: [number, number] = [50, 200]): Promise<void> {
  if (consumeFault("tool_slow")) {
    await sleep(2000 + Math.random() * 2000);
  }
  const [min, max] = latencyRangeMs;
  await sleep(min + Math.random() * (max - min));
  if (consumeFault("tool_500")) {
    throw new ToolServerError("Mock support API returned a 500 (tool_500 fault active).");
  }
}

// ---------------------------------------------------------------------------
// Read APIs
// ---------------------------------------------------------------------------

export async function getCustomer(db: Database.Database, customerId: string): Promise<Customer> {
  await simulateCall();
  const row = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(customerId) as
    | { id: string; name: string; email: string; phone: string | null; created_at: string }
    | undefined;
  if (!row) throw new ToolNotFoundError(`No customer found with id ${customerId}.`);
  return { id: row.id, name: row.name, email: row.email, phone: row.phone, createdAt: row.created_at };
}

export async function getOrders(db: Database.Database, customerId: string): Promise<Order[]> {
  await simulateCall();
  const rows = db
    .prepare(`SELECT * FROM orders WHERE customer_id = ? ORDER BY order_date DESC`)
    .all(customerId) as Array<{
    id: string;
    customer_id: string;
    item_name: string;
    amount: number;
    currency: "INR";
    status: Order["status"];
    order_date: string;
    delivery_date: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    customerId: r.customer_id,
    itemName: r.item_name,
    amount: r.amount,
    currency: r.currency,
    status: r.status,
    orderDate: r.order_date,
    deliveryDate: r.delivery_date,
  }));
}

export async function getPayments(db: Database.Database, orderId: string): Promise<Payment[]> {
  await simulateCall();
  const rows = db.prepare(`SELECT * FROM payments WHERE order_id = ? ORDER BY created_at ASC`).all(orderId) as Array<{
    id: string;
    order_id: string | null;
    customer_id: string;
    amount: number;
    currency: "INR";
    type: Payment["type"];
    status: Payment["status"];
    idempotency_key: string | null;
    provider_reference: string | null;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    orderId: r.order_id ?? "",
    customerId: r.customer_id,
    amount: r.amount,
    currency: r.currency,
    type: r.type,
    status: r.status,
    idempotencyKey: r.idempotency_key,
    providerReference: r.provider_reference,
    createdAt: r.created_at,
  }));
}

const FTS_MAX_SNIPPET = 500;
const TRANSCRIPT_MESSAGE_LIMIT = 12;
const TRANSCRIPT_CHAR_LIMIT = 500;

// FTS5 free-text queries choke on bare punctuation/operators. Tokenize and
// quote each word so arbitrary customer phrasing is always valid MATCH input.
function toFtsQuery(text: string): string | undefined {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (tokens.length === 0) return undefined;
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

interface ConversationSummaryCandidateRow {
  id: number;
  conversation_id: string;
  customer_id: string;
  order_id: string | null;
  date: string;
  topic_tags: string;
  outcome: string | null;
  summary_text: string;
  bm25_score: number;
}

export async function getConversationHistory(
  db: Database.Database,
  customerId: string,
  query?: string,
  opts: { relatedOrderIds?: string[]; limit?: number; now?: string } = {},
): Promise<ConversationSummaryHit[]> {
  await simulateCall();

  const limit = opts.limit ?? 5;
  const now = opts.now ?? new Date().toISOString();
  const ftsQuery = query ? toFtsQuery(query) : undefined;

  let candidates: ConversationSummaryCandidateRow[];
  if (ftsQuery) {
    candidates = db
      .prepare(
        `SELECT cs.id, cs.conversation_id, cs.customer_id, cs.order_id, cs.date, cs.topic_tags, cs.outcome, cs.summary_text,
                bm25(conversation_summaries_fts) AS bm25_score
         FROM conversation_summaries_fts
         JOIN conversation_summaries cs ON cs.id = conversation_summaries_fts.rowid
         WHERE conversation_summaries_fts MATCH ? AND cs.customer_id = ?
         ORDER BY bm25_score ASC
         LIMIT 20`,
      )
      .all(ftsQuery, customerId) as ConversationSummaryCandidateRow[];
  } else {
    candidates = (
      db
        .prepare(
          `SELECT id, conversation_id, customer_id, order_id, date, topic_tags, outcome, summary_text, 0 AS bm25_score
           FROM conversation_summaries
           WHERE customer_id = ?
           ORDER BY date DESC
           LIMIT 20`,
        )
        .all(customerId) as ConversationSummaryCandidateRow[]
    );
  }

  const relatedOrderIds = new Set(opts.relatedOrderIds ?? []);
  const nowMs = new Date(now).getTime();

  const scored = candidates.map((c) => {
    const orderBoost = c.order_id && (relatedOrderIds.has(c.order_id) || (query?.includes(c.order_id) ?? false)) ? -5 : 0;
    const ageDays = Math.max(0, (nowMs - new Date(c.date).getTime()) / (1000 * 60 * 60 * 24));
    const recencyBoost = -(1 / (1 + ageDays)) * 2;
    const finalScore = c.bm25_score + orderBoost + recencyBoost;
    return { c, finalScore };
  });
  scored.sort((a, b) => a.finalScore - b.finalScore);
  const top = scored.slice(0, limit);

  const transcriptStmt = db.prepare(
    `SELECT role, content, ts FROM conversation_messages WHERE conversation_id = ? ORDER BY ts ASC LIMIT ?`,
  );

  return top.map(({ c, finalScore }, index) => {
    const hit: ConversationSummaryHit = {
      conversationId: c.conversation_id,
      date: c.date,
      orderId: c.order_id,
      topicTags: c.topic_tags ? c.topic_tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
      outcome: c.outcome,
      summaryText: c.summary_text.slice(0, FTS_MAX_SNIPPET),
      score: Math.round(-finalScore * 100) / 100,
    };
    if (index < 2) {
      const messages = transcriptStmt.all(c.conversation_id, TRANSCRIPT_MESSAGE_LIMIT) as Array<{
        role: "customer" | "agent";
        content: string;
        ts: string;
      }>;
      hit.transcript = messages.map((m) => ({
        role: m.role,
        content: m.content.slice(0, TRANSCRIPT_CHAR_LIMIT),
        ts: m.ts,
      }));
    }
    return hit;
  });
}

export async function searchPolicy(db: Database.Database, query: string, limit = 5): Promise<PolicyChunkHit[]> {
  await simulateCall();
  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) return [];
  const rows = db
    .prepare(
      `SELECT pc.heading, pc.chunk_text, bm25(policy_chunks_fts) AS bm25_score
       FROM policy_chunks_fts
       JOIN policy_chunks pc ON pc.id = policy_chunks_fts.rowid
       WHERE policy_chunks_fts MATCH ?
       ORDER BY bm25_score ASC
       LIMIT ?`,
    )
    .all(ftsQuery, limit) as Array<{ heading: string; chunk_text: string; bm25_score: number }>;
  return rows.map((r) => ({ heading: r.heading, text: r.chunk_text, score: Math.round(-r.bm25_score * 100) / 100 }));
}

// ---------------------------------------------------------------------------
// Money APIs. Idempotency: a repeated key returns the original committed
// result without acting again, mirroring real payment-provider semantics
// (e.g. Stripe). Callers (the ledger pipeline) are responsible for policy
// checks and the ledger row; this layer only owns "did this exact key already
// move money."
// ---------------------------------------------------------------------------

export interface MoneyCallResult {
  paymentId: string;
  providerReference: string;
}

function findByIdempotencyKey(db: Database.Database, idempotencyKey: string): MoneyCallResult | undefined {
  const row = db.prepare(`SELECT id, provider_reference FROM payments WHERE idempotency_key = ?`).get(idempotencyKey) as
    | { id: string; provider_reference: string | null }
    | undefined;
  if (!row) return undefined;
  return { paymentId: row.id, providerReference: row.provider_reference ?? "" };
}

async function issueMoneyMovement(
  db: Database.Database,
  type: Extract<ActionType, "refund" | "credit">,
  params: { orderId: string | null; customerId: string; amount: number; idempotencyKey: string },
): Promise<MoneyCallResult> {
  const existing = findByIdempotencyKey(db, params.idempotencyKey);
  if (existing) {
    await sleep(20 + Math.random() * 30);
    return existing;
  }

  await simulateCall();

  const paymentId = `pay_${randomUUID().slice(0, 12)}`;
  const providerReference = `prov_${randomUUID().slice(0, 10)}`;
  db.prepare(
    `INSERT INTO payments (id, order_id, customer_id, amount, currency, type, status, idempotency_key, provider_reference, created_at)
     VALUES (@id, @orderId, @customerId, @amount, 'INR', @type, 'succeeded', @idempotencyKey, @providerReference, @createdAt)`,
  ).run({
    id: paymentId,
    orderId: params.orderId,
    customerId: params.customerId,
    amount: params.amount,
    type,
    idempotencyKey: params.idempotencyKey,
    providerReference,
    createdAt: new Date().toISOString(),
  });

  if (type === "refund" && consumeFault("refund_timeout_after_success")) {
    throw new ToolTimeoutError(
      "The refund call timed out before a response was received (refund_timeout_after_success fault active). The refund was actually committed.",
    );
  }

  return { paymentId, providerReference };
}

export function issueRefundRaw(
  db: Database.Database,
  params: { orderId: string; customerId: string; amount: number; idempotencyKey: string },
): Promise<MoneyCallResult> {
  return issueMoneyMovement(db, "refund", params);
}

export function issueCreditRaw(
  db: Database.Database,
  params: { orderId: string | null; customerId: string; amount: number; idempotencyKey: string },
): Promise<MoneyCallResult> {
  return issueMoneyMovement(db, "credit", params);
}
