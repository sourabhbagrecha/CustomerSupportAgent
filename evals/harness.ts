import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { buildAgentGraph, type AgentGraph } from "../server/src/agent/graph.js";
import { applySchema, openDb } from "../server/src/db/client.js";
import type { AgentEvent } from "../server/src/events/types.js";
import { loadFixturesInto } from "../scripts/seedFixtures.js";
import type { JudgeState, JudgeVerdict, ScenarioRecord, ScenarioStatus } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// PLAN Section 10 / the assignment prompt: each scenario gets its own
// isolated in-memory SQLite db, fixture-seeded, with its own compiled graph.
// Nothing is shared across scenarios or with the evaluator's data/app.db.
export interface ScenarioContext {
  db: Database.Database;
  graph: AgentGraph;
}

export function createScenario(): ScenarioContext {
  const db = openDb(":memory:");
  applySchema(db);
  loadFixturesInto(db);
  const graph = buildAgentGraph(db);
  return { db, graph };
}

// ---------------------------------------------------------------------------
// Result recording: each scenario test writes one small JSON record after
// its assertions. scripts/export-results.ts reads every file in this
// directory and regenerates evals/results.json + evals/RESULTS.md.
// ---------------------------------------------------------------------------

export const ARTIFACTS_DIR = join(__dirname, ".artifacts");

export type { ScenarioRecord, ScenarioStatus };

export function recordScenarioResult(record: ScenarioRecord): void {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const padded = String(record.number).padStart(2, "0");
  const fileName = record.suffix ? `${padded}-${record.suffix}.json` : `${padded}.json`;
  writeFileSync(join(ARTIFACTS_DIR, fileName), JSON.stringify(record, null, 2));
}

// Sums latency/tokens across every llm_call event for a thread. Token counts
// are omitted (not summed as 0) when the model API never reported them, per
// CLAUDE.md guidance not to fabricate numbers.
export function summarizeLlmCalls(events: AgentEvent[]): {
  latencyMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
} {
  const llmEvents = events.filter((e) => e.type === "llm_call");
  const latencyMs = llmEvents.reduce((sum, e) => sum + (e.latencyMs ?? 0), 0);
  const hasTokensIn = llmEvents.some((e) => e.tokensIn != null);
  const hasTokensOut = llmEvents.some((e) => e.tokensOut != null);
  const tokensIn = hasTokensIn ? llmEvents.reduce((sum, e) => sum + (e.tokensIn ?? 0), 0) : null;
  const tokensOut = hasTokensOut ? llmEvents.reduce((sum, e) => sum + (e.tokensOut ?? 0), 0) : null;
  return { latencyMs, tokensIn, tokensOut };
}

export interface ScenarioOutcome {
  note: string;
  status?: ScenarioStatus;
  judge?: JudgeVerdict | null;
  // "scored" | "unscored" | null (null = this scenario never calls the
  // judge). Scenarios that do call judgeReply should pass judge.state
  // straight through here so it survives into the artifact and RESULTS.md.
  judgeState?: JudgeState;
  latencyMs?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
}

// Wraps one scenario `it()` body: runs it, times it, and always writes an
// artifact record (pass, fail with the thrown error's message, or whatever
// status the scenario body itself declares, e.g. "documented_red"). Failures
// are recorded and then rethrown so vitest still reports the test as failed;
// this is what makes `npm run eval`'s exit status meaningful while still
// producing a full RESULTS.md even when a run is a mix of pass/fail.
export async function withScenarioResult(
  meta: { number: number; name: string; suffix?: string },
  fn: () => Promise<ScenarioOutcome>,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const outcome = await fn();
    recordScenarioResult({
      number: meta.number,
      suffix: meta.suffix,
      name: meta.name,
      status: outcome.status ?? "pass",
      latencyMs: outcome.latencyMs ?? Date.now() - startedAt,
      tokensIn: outcome.tokensIn ?? null,
      tokensOut: outcome.tokensOut ?? null,
      judge: outcome.judge ?? null,
      judgeState: outcome.judgeState ?? null,
      note: outcome.note,
    });
  } catch (err) {
    recordScenarioResult({
      number: meta.number,
      suffix: meta.suffix,
      name: meta.name,
      status: "fail",
      latencyMs: Date.now() - startedAt,
      judgeState: null,
      note: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export function readFixtureJson<T>(name: string): T {
  const path = join(__dirname, "..", "fixtures", name);
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}
