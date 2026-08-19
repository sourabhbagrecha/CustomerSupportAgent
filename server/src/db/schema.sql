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

-- A CHECK constraint cannot reach across tables, so ownership (a payment's
-- customer_id must match the order it is attached to) is enforced with a
-- BEFORE INSERT trigger instead. This is the last line of defense behind the
-- policy engine's own ownership check; it exists so a bug anywhere upstream
-- still cannot write a payment row that crosses customers.
CREATE TRIGGER payments_order_owner_guard BEFORE INSERT ON payments
WHEN NEW.order_id IS NOT NULL AND (SELECT customer_id FROM orders WHERE id = NEW.order_id) IS NOT NEW.customer_id
BEGIN
  SELECT RAISE(ABORT, 'payments.customer_id does not own payments.order_id');
END;

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
  -- Deliberately NOT `REFERENCES orders(id)`: a denied row for
  -- order_not_found records a model-supplied order_id that does not exist
  -- by definition, so a foreign key here would abort the exact denial it is
  -- meant to record. Existence and ownership for any row that could
  -- actually move money are enforced by the policy engine before insert and
  -- by ledger_order_owner_guard above, not by a schema-level FK.
  order_id        TEXT,
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

-- Same cross-table ownership guard as payments_order_owner_guard above, for
-- the ledger row itself: a CHECK constraint cannot reach across tables.
-- Denied rows are exempt: a denied row IS the audit record of refusing
-- exactly this mismatch (order not found, or order not owned by this
-- customer), so it must be writable with whatever order_id the model
-- supplied. No money ever moves on a denied row, so nothing unsafe is let
-- through; only succeeded/pending/awaiting_approval/etc. rows, which
-- precede or record an actual money movement, are guarded.
CREATE TRIGGER ledger_order_owner_guard BEFORE INSERT ON actions_ledger
WHEN NEW.status <> 'denied' AND NEW.order_id IS NOT NULL AND (SELECT customer_id FROM orders WHERE id = NEW.order_id) IS NOT NEW.customer_id
BEGIN
  SELECT RAISE(ABORT, 'actions_ledger.customer_id does not own actions_ledger.order_id');
END;

-- The admin decision queue. Two kinds share this table:
--   'policy_approval': one row per `requires_approval` verdict. The graph
--     interrupt()s until a human resolves this row via the approval panel.
--   'escalation': one row per escalate_to_human call. No graph interrupt;
--     the agent's turn already completed, so resolving this row acts
--     out-of-band (see server/src/agent/notify.ts) instead of resuming a
--     paused graph.
-- ledger_id/action_type/amount are nullable because an escalation is not
-- always tied to a money action (e.g. distress, legal threat).
CREATE TABLE approvals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL DEFAULT 'policy_approval' CHECK (kind IN ('policy_approval', 'escalation')),
  ledger_id     INTEGER REFERENCES actions_ledger(id),
  thread_id     TEXT NOT NULL,
  action_type   TEXT CHECK (action_type IN ('refund', 'credit')),
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  -- Deliberately NOT `REFERENCES orders(id)`, same reasoning as
  -- actions_ledger.order_id above: an escalation row can be built from a
  -- denied ledger row whose order_id never existed (an order_not_found
  -- denial), and that escalation must still be recordable.
  order_id      TEXT,
  amount        REAL,
  policy_reason TEXT NOT NULL,
  denial_reason TEXT,
  category      TEXT,
  context       TEXT,
  remark        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at    TEXT NOT NULL,
  resolved_at   TEXT,
  resolved_by   TEXT,
  -- Set when the post-decision execution (graph resume or ledger action plus
  -- customer notice) completed. NULL on a resolved row means execution
  -- crashed and the resolve endpoint may retry it.
  executed_at   TEXT
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
