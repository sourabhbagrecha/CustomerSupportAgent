import { getDb } from "./client.js";
import { loadFixturesInto } from "../../../scripts/seedFixtures.js";
import { clearAllFaults } from "../faults/registry.js";

// Demo reset (paired with the frontend's reset button, owned by another
// group; this file only implements the CALLER contract they build against:
// resetDemoData() plus the POST /api/demo/reset route in index.ts).
//
// Operates on the SAME live singleton connection the running server uses
// (getDb()), via raw DELETE statements inside one transaction, rather than
// deleting and reopening the db file: this is a long-running Fastify process
// with an already-open WAL connection and a graph bound to it, so nothing
// about the process needs to restart for a reset to take effect.
//
// Deletion order matters (PRAGMA foreign_keys = ON, schema.sql): every table
// with a foreign key is deleted before the table it references. Runtime
// tables (the money ledger, the human decision queue, the full event/trace
// log, and LangGraph's own checkpoint tables — one row per graph state
// snapshot, i.e. one "thread" in the UI) are simply cleared, never reloaded.
// Fixture-backed tables are cleared and then reloaded from the committed
// fixtures via the same loadFixturesInto() the real seed script and the eval
// harness both use (CLAUDE.md: fixtures are committed, never generated at
// the evaluator's runtime; this reuses them, it does not regenerate them).
// evals/runs/ is a file-based archive on disk, untouched by any of this.
const DELETE_ORDER = [
  "conversation_summaries",
  "conversation_messages",
  "approvals",
  "actions_ledger",
  "payments",
  "conversations",
  "orders",
  "customers",
  "policy_chunks",
  "events",
  "writes",
  "checkpoints",
];

export function resetDemoData(): { ok: true } {
  const db = getDb();
  const run = db.transaction(() => {
    for (const table of DELETE_ORDER) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    // Nested transaction: better-sqlite3 uses a SAVEPOINT when a
    // db.transaction()-wrapped function is invoked from inside another one,
    // so this composes safely with loadFixturesInto's own transaction.
    loadFixturesInto(db);
  });
  run();

  // In-memory fault registry state (server/src/faults/registry.ts): not
  // part of the db, so it is cleared separately, outside the db transaction.
  clearAllFaults();

  return { ok: true };
}
