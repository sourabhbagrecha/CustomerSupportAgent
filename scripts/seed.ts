import { existsSync, rmSync } from "node:fs";
import { applySchema, DEFAULT_DB_PATH, openDb } from "../server/src/db/client.js";
import { loadFixturesInto } from "./seedFixtures.js";

// Thin wrapper: opens the real file-backed db, wipes any prior copy, applies
// the schema, then delegates fixture loading to seedFixtures.ts (shared with
// the eval harness, which does the same thing against an isolated in-memory
// db per scenario instead of this file).
function main(): void {
  const dbPath = process.env.APP_DB_PATH ?? DEFAULT_DB_PATH;

  for (const suffix of ["", "-shm", "-wal"]) {
    const candidate = dbPath + suffix;
    if (existsSync(candidate)) rmSync(candidate);
  }

  const db = openDb(dbPath);
  applySchema(db);

  try {
    loadFixturesInto(db);
  } catch (err) {
    console.error("Seed failed, DB left in place for inspection:", err);
    db.close();
    process.exit(1);
  }

  const tables = [
    "customers",
    "orders",
    "payments",
    "conversations",
    "conversation_messages",
    "conversation_summaries",
    "policy_chunks",
  ];
  console.log(`Seeded ${dbPath}`);
  for (const table of tables) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    console.log(`  ${table}: ${row.n}`);
  }

  db.close();
}

main();
