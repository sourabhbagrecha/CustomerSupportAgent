-- Schema for the customer support agent. One SQLite file, no migrations
-- framework: this file is the single source of truth and is applied fresh
-- by scripts/seed.ts on every `npm run seed`. LangGraph's SqliteSaver owns
-- its own checkpoint tables in the same file; they are created by that
-- library, not here.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Core CRM / order / payment data
-- ---------------------------------------------------------------------------

CREATE TABLE customers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  phone      TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE orders (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  item_name     TEXT NOT NULL,
  amount        REAL NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'INR',
  status        TEXT NOT NULL CHECK (status IN (
                   'placed', 'delivered', 'failed_delivery', 'cancelled',
                   'refunded', 'partially_refunded'
                 )),
  order_date    TEXT NOT NULL,
  delivery_date TEXT
);

CREATE INDEX idx_orders_customer ON orders(customer_id);

CREATE TABLE payments (
  id                TEXT PRIMARY KEY,
  order_id          TEXT REFERENCES orders(id),
  customer_id       TEXT NOT NULL REFERENCES customers(id),
  amount            REAL NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'INR',
  type              TEXT NOT NULL CHECK (type IN ('charge', 'refund', 'credit')),
  status            TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'pending')),
  idempotency_key   TEXT UNIQUE,
  provider_reference TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX idx_payments_order ON payments(order_id);
CREATE INDEX idx_payments_customer ON payments(customer_id);

-- ---------------------------------------------------------------------------
-- Historical support conversations (fixture data used for retrieval)
-- ---------------------------------------------------------------------------

CREATE TABLE conversations (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  outcome     TEXT
);

CREATE INDEX idx_conversations_customer ON conversations(customer_id);

CREATE TABLE conversation_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role            TEXT NOT NULL CHECK (role IN ('customer', 'agent')),
  content         TEXT NOT NULL,
  ts              TEXT NOT NULL
);

CREATE INDEX idx_conv_messages_conversation ON conversation_messages(conversation_id);

-- One row per historical conversation: a 1-2 line summary plus metadata used
-- for retrieval ranking (order-ID linkage, recency, topic).
CREATE TABLE conversation_summaries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  order_id        TEXT REFERENCES orders(id),
  date            TEXT NOT NULL,
  topic_tags      TEXT NOT NULL DEFAULT '',
  outcome         TEXT,
  summary_text    TEXT NOT NULL
);

CREATE INDEX idx_conv_summaries_customer ON conversation_summaries(customer_id);
CREATE INDEX idx_conv_summaries_order ON conversation_summaries(order_id);

-- FTS5 external-content index over the summary text + tags. Kept in sync via
-- triggers so callers only ever write to conversation_summaries.
CREATE VIRTUAL TABLE conversation_summaries_fts USING fts5(
  summary_text,
  topic_tags,
  content='conversation_summaries',
  content_rowid='id'
);

CREATE TRIGGER conversation_summaries_ai AFTER INSERT ON conversation_summaries BEGIN
  INSERT INTO conversation_summaries_fts(rowid, summary_text, topic_tags)
  VALUES (new.id, new.summary_text, new.topic_tags);
END;

CREATE TRIGGER conversation_summaries_ad AFTER DELETE ON conversation_summaries BEGIN
  INSERT INTO conversation_summaries_fts(conversation_summaries_fts, rowid, summary_text, topic_tags)
  VALUES ('delete', old.id, old.summary_text, old.topic_tags);
END;

CREATE TRIGGER conversation_summaries_au AFTER UPDATE ON conversation_summaries BEGIN
  INSERT INTO conversation_summaries_fts(conversation_summaries_fts, rowid, summary_text, topic_tags)
  VALUES ('delete', old.id, old.summary_text, old.topic_tags);
  INSERT INTO conversation_summaries_fts(rowid, summary_text, topic_tags)
  VALUES (new.id, new.summary_text, new.topic_tags);
END;

-- ---------------------------------------------------------------------------
-- Policy (human-readable chunks, searchable). Machine-enforced limits live in
-- fixtures/policy.json, loaded directly by the policy engine, not via FTS.
-- ---------------------------------------------------------------------------

CREATE TABLE policy_chunks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_index  INTEGER NOT NULL,
  heading      TEXT NOT NULL,
  chunk_text   TEXT NOT NULL
);

CREATE VIRTUAL TABLE policy_chunks_fts USING fts5(
  heading,
  chunk_text,
  content='policy_chunks',
  content_rowid='id'
);

CREATE TRIGGER policy_chunks_ai AFTER INSERT ON policy_chunks BEGIN
  INSERT INTO policy_chunks_fts(rowid, heading, chunk_text)
  VALUES (new.id, new.heading, new.chunk_text);
END;

CREATE TRIGGER policy_chunks_ad AFTER DELETE ON policy_chunks BEGIN
  INSERT INTO policy_chunks_fts(policy_chunks_fts, rowid, heading, chunk_text)
  VALUES ('delete', old.id, old.heading, old.chunk_text);
END;

CREATE TRIGGER policy_chunks_au AFTER UPDATE ON policy_chunks BEGIN
  INSERT INTO policy_chunks_fts(policy_chunks_fts, rowid, heading, chunk_text)
  VALUES ('delete', old.id, old.heading, old.chunk_text);
  INSERT INTO policy_chunks_fts(rowid, heading, chunk_text)
  VALUES (new.id, new.heading, new.chunk_text);
END;

-- ---------------------------------------------------------------------------
-- The money path: action ledger, approvals, events
-- ---------------------------------------------------------------------------

-- Every refund/credit attempt (allowed, denied, or requiring approval) gets a
-- row here BEFORE any external call. idempotency_key is derived as
-- sha256(threadId + actionType + orderId + amount) so retries of the same
-- logical action always collide on the same row instead of creating a new one.
CREATE TABLE actions_ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  thread_id       TEXT NOT NULL,
  action_type     TEXT NOT NULL CHECK (action_type IN ('refund', 'credit')),
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  order_id        TEXT REFERENCES orders(id),
  amount          REAL NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'INR',
  status          TEXT NOT NULL CHECK (status IN (
                     'pending', 'succeeded', 'failed', 'failed_unknown',
                     'reconciled', 'denied', 'awaiting_approval'
                   )),
  reason          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  resolved_at     TEXT,
  raw_response    TEXT
);

CREATE INDEX idx_ledger_thread ON actions_ledger(thread_id);
CREATE INDEX idx_ledger_customer ON actions_ledger(customer_id);
CREATE INDEX idx_ledger_order ON actions_ledger(order_id);

-- One row per `requires_approval` verdict. The graph interrupt()s until a
-- human resolves this row via the approval panel.
CREATE TABLE approvals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id     INTEGER NOT NULL REFERENCES actions_ledger(id),
  thread_id     TEXT NOT NULL,
  action_type   TEXT NOT NULL CHECK (action_type IN ('refund', 'credit')),
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  order_id      TEXT REFERENCES orders(id),
  amount        REAL NOT NULL,
  policy_reason TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at    TEXT NOT NULL,
  resolved_at   TEXT,
  resolved_by   TEXT
);

CREATE INDEX idx_approvals_thread ON approvals(thread_id);
CREATE INDEX idx_approvals_status ON approvals(status);

-- Every meaningful step in a turn: context loads, LLM calls, tool calls,
-- guardrail verdicts, faults, failovers, ledger transitions, escalations,
-- errors. Written at the moment the code executes; streamed over SSE and
-- rendered by the trace panel.
CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  TEXT NOT NULL,
  ts         TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN (
               'step', 'llm_call', 'tool_call', 'tool_result', 'guardrail',
               'fault', 'failover', 'escalation', 'error'
             )),
  payload    TEXT NOT NULL DEFAULT '{}',
  latency_ms INTEGER,
  tokens_in  INTEGER,
  tokens_out INTEGER,
  model      TEXT
);

CREATE INDEX idx_events_thread ON events(thread_id);
CREATE INDEX idx_events_ts ON events(ts);
