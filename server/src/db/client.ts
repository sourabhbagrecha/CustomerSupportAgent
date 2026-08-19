import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "schema.sql");

export function openDb(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function applySchema(db: Database.Database): void {
  const schema = readFileSync(SCHEMA_PATH, "utf-8");
  db.exec(schema);
}

// Default app DB path, overridable (evals point this at a temp file).
export const DEFAULT_DB_PATH = join(__dirname, "..", "..", "..", "data", "app.db");

let singleton: Database.Database | undefined;

// Lazily-created shared connection for the running server process. Evals and
// scripts should call openDb() directly with their own path instead, so they
// never share state with each other or with a running dev server.
export function getDb(): Database.Database {
  if (!singleton) {
    singleton = openDb(process.env.APP_DB_PATH ?? DEFAULT_DB_PATH);
  }
  return singleton;
}
