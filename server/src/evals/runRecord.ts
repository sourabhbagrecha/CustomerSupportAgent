import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { JudgeState, ScenarioRecord, ScenarioStatus } from "../../../evals/types.js";

// One eval run = one JSON file under evals/runs/. This module owns that
// record: the Zod schema (single source of truth, the web types mirror it),
// the artifact grouping that turns the per-scenario JSON files the harness
// writes into scenario rows, the metadata hashing, and the legacy
// evals/results.json + evals/RESULTS.md export that `npm run eval` still
// produces as the regression-gate snapshot. Both scripts/export-results.ts
// and the in-process runner (server/src/evals/runner.ts) go through here so
// a CLI run and a UI-started run are grouped and summarised identically.
//
// Dependency-free on purpose (node:fs/crypto plus evals/types.ts): the CLI
// script imports it without dragging in better-sqlite3 or LangGraph.

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, "..", "..", "..");
export const ARTIFACTS_DIR = join(REPO_ROOT, "evals", ".artifacts");
export const RUNS_DIR = join(REPO_ROOT, "evals", "runs");
export const SCENARIOS_DIR = join(REPO_ROOT, "evals", "scenarios");
const RESULTS_JSON_PATH = join(REPO_ROOT, "evals", "results.json");
const RESULTS_MD_PATH = join(REPO_ROOT, "evals", "RESULTS.md");
const PROMPT_PATH = join(REPO_ROOT, "server", "src", "agent", "prompt.ts");
const FIXTURES_DIR = join(REPO_ROOT, "fixtures");

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const EvalScenarioStatusSchema = z.enum(["pass", "fail", "documented_red"]);
export const EvalJudgeStateSchema = z.enum(["scored", "unscored"]).nullable();

export const EvalScenarioSchema = z.object({
  number: z.number().int(),
  name: z.string(),
  status: EvalScenarioStatusSchema,
  latencyMs: z.number().nullable(),
  tokensIn: z.number().nullable(),
  tokensOut: z.number().nullable(),
  notes: z.array(z.string()),
  judgeNotes: z.array(z.string()),
  judgeState: EvalJudgeStateSchema,
  // Repeat-run fields (task P1-6 "repeats"). Defaults keep a run record
  // written before this existed parsing unchanged; repeatSummary() below is
  // the one place that reconciles those legacy defaults against `status`
  // rather than trusting repeatPassCount/repeatStatuses blindly, since a
  // pre-repeats record has no real repeat data at all.
  repeatCount: z.number().int().positive().default(1),
  repeatPassCount: z.number().int().nonnegative().default(0),
  repeatStatuses: z.array(EvalScenarioStatusSchema).default([]),
  // Mean/spread (max - min) of latencyMs across repeats, present whenever at
  // least one repeat reported a latency; null for a scenario with none.
  latencyMeanMs: z.number().nullable().default(null),
  latencySpreadMs: z.number().nullable().default(null),
});

export const EvalRunSourceSchema = z.enum(["cli", "ui"]);
export const EvalRunStatusSchema = z.enum(["running", "completed", "failed", "cancelled"]);

// Provider block deliberately has no key field anywhere: keys live in the
// server's environment and never reach a run record or the browser.
export const EvalRunProviderSchema = z.object({
  baseUrl: z.string(),
  primaryModel: z.string().nullable(),
  fallbackModel: z.string().nullable(),
  judgeModel: z.string().nullable(),
  judgeBaseUrl: z.string(),
});

// Price snapshot taken when the run started (plan 008), from OpenRouter's
// public model listing; null when the listing was unreachable or does not
// price the run's primary model. Rates, not a total: cost is derived from
// the token columns so it works per scenario and for subset runs alike.
// Defaults to null on parse so records written before this field existed
// still validate unchanged.
export const EvalRunPricingSchema = z.object({
  source: z.literal("openrouter"),
  openrouterModelId: z.string(),
  promptUsdPerMillion: z.number().nonnegative(),
  completionUsdPerMillion: z.number().nonnegative(),
  fetchedAt: z.string(),
});

export const EvalJudgeStatesSchema = z.object({
  scored: z.number().int(),
  unscored: z.number().int(),
  notApplicable: z.number().int(),
});

// Judge calibration (task P1-6 "judge calibration"): agreement between the
// real judge model and evals/goldenSet.ts, a small hand-labeled (drafted,
// not human-verified; see that file's header) set of transcripts. Computed
// once per full-suite run (never for a subset run) so the number is always
// tied to the judge actually grading that run, at the cost of a bounded
// dozen extra short judge calls, not per-scenario or per-repeat.
export const EvalRunJudgeCalibrationSchema = z.object({
  goldenSetVersion: z.string(),
  computedAt: z.string(),
  total: z.number().int().nonnegative(),
  agreeing: z.number().int().nonnegative(),
  agreementPct: z.number(),
  judgeModel: z.string().nullable(),
  disagreements: z.array(
    z.object({
      id: z.string(),
      goldenLabel: z.enum(["pass", "fail"]),
      judgeVerdict: z.enum(["pass", "fail", "unscored"]),
    }),
  ),
});
export type EvalRunJudgeCalibration = z.infer<typeof EvalRunJudgeCalibrationSchema>;

export const EvalRunSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  label: z.string(),
  source: EvalRunSourceSchema,
  status: EvalRunStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  exitCode: z.number().nullable(),
  // Set only when status is "failed" (the runner could not produce a suite
  // result): the spawn error or the last lines of vitest output. Null for
  // every other status; scenario-level failures live on the scenario rows.
  failureReason: z.string().nullable(),
  provider: EvalRunProviderSchema,
  // null = the full suite; otherwise the scenario numbers that were run.
  scenarioFilter: z.array(z.number().int()).nullable(),
  gitCommit: z.string().nullable(),
  promptSha256: z.string(),
  fixturesSha256: z.string(),
  judgeStates: EvalJudgeStatesSchema,
  scenarios: z.array(EvalScenarioSchema),
  pricing: EvalRunPricingSchema.nullable().default(null),
  // Denominator discipline (task P1-6): scenario numbers that were expected
  // (from the full suite, or the requested subset) but produced no artifact
  // for at least one repeat, either because the scenario crashed before
  // withScenarioResult ever wrote a record or because vitest never reached
  // it. Each is still present in `scenarios` above as a synthetic "fail"
  // (see reconcileExpectedScenarios), so the pass/total ratio never shrinks
  // silently; this list exists only so the reason is visible rather than
  // indistinguishable from a real assertion failure.
  incompleteScenarios: z.array(z.number().int()).default([]),
  judgeCalibration: EvalRunJudgeCalibrationSchema.nullable().default(null),
});

export type EvalScenario = z.infer<typeof EvalScenarioSchema>;
export type EvalRun = z.infer<typeof EvalRunSchema>;
export type EvalRunStatus = z.infer<typeof EvalRunStatusSchema>;
export type EvalRunSource = z.infer<typeof EvalRunSourceSchema>;
export type EvalRunProvider = z.infer<typeof EvalRunProviderSchema>;
export type EvalRunPricing = z.infer<typeof EvalRunPricingSchema>;

// tokens x rate, per million, for whatever token counts are present; null
// when unpriced or when neither count was recorded (a subset run of
// model-free scenarios), never a fabricated 0.
export function costUsd(tokensIn: number | null, tokensOut: number | null, pricing: EvalRunPricing | null): number | null {
  if (!pricing) return null;
  if (tokensIn === null && tokensOut === null) return null;
  return ((tokensIn ?? 0) * pricing.promptUsdPerMillion + (tokensOut ?? 0) * pricing.completionUsdPerMillion) / 1_000_000;
}

export function runCostUsd(run: Pick<EvalRun, "scenarios" | "pricing">): number | null {
  const costs = run.scenarios.map((s) => costUsd(s.tokensIn, s.tokensOut, run.pricing)).filter((c): c is number => c !== null);
  return costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null;
}

export function formatUsd(amount: number | null): string {
  return amount === null ? "n/a" : `$${amount.toFixed(4)}`;
}

// The shape evals/results.json has always had (the regression-gate
// snapshot). Kept byte-compatible with what scripts/export-results.ts wrote
// before run records existed, so git diffs of that file stay meaningful.
export interface LegacyResultsMetadata {
  primaryModel: string | null;
  fallbackModel: string | null;
  gitCommit: string | null;
  runCount: number;
  judgeStates: { scored: number; unscored: number; notApplicable: number };
  promptSha256: string;
  fixturesSha256: string;
}

// ---------------------------------------------------------------------------
// Run ids
// ---------------------------------------------------------------------------

// "2026-08-19T15:15:56.157Z" -> "20260819T151556Z". Sorts lexically by time,
// which is what the runs list relies on as a tiebreak.
export function compactTimestamp(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "run";
}

export function buildRunId(startedAt: string, label: string): string {
  return `${compactTimestamp(startedAt)}-${slugify(label)}`;
}

// Run ids come back from the browser as a URL param for GET/DELETE, so
// anything that could escape evals/runs/ is rejected before touching disk.
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export function isValidRunId(runId: string): boolean {
  return RUN_ID_PATTERN.test(runId) && runId.length <= 120;
}

// ---------------------------------------------------------------------------
// Artifacts -> scenario rows
// ---------------------------------------------------------------------------

export function loadArtifacts(dir: string = ARTIFACTS_DIR): ScenarioRecord[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const records: ScenarioRecord[] = [];
  for (const file of files) {
    // A file being written by the child at the exact moment the runner
    // polls can be empty or truncated; skip it this tick, it is picked up
    // whole on the next one.
    try {
      records.push(JSON.parse(readFileSync(join(dir, file), "utf-8")) as ScenarioRecord);
    } catch {
      continue;
    }
  }
  return records;
}

// A scenario with multiple sub-cases (scenario 7: approve + reject) is green
// overall only if every sub-case is; a single documented_red sub-case marks
// the whole scenario documented_red unless another sub-case outright failed.
export function combineStatus(statuses: ScenarioStatus[]): ScenarioStatus {
  if (statuses.some((s) => s === "fail")) return "fail";
  if (statuses.some((s) => s === "documented_red")) return "documented_red";
  return "pass";
}

// A group is "unscored" if any sub-case came back unscored (judge outage
// anywhere in the group is worth surfacing), "scored" if at least one
// sub-case was scored and none were unscored, and null if the judge was
// never called for this scenario at all.
export function combineJudgeState(states: JudgeState[]): JudgeState {
  if (states.some((s) => s === "unscored")) return "unscored";
  if (states.some((s) => s === "scored")) return "scored";
  return null;
}

function sumOrNull(values: Array<number | null | undefined>): number | null {
  const present = values.filter((v): v is number => v != null);
  return present.length > 0 ? present.reduce((a, b) => a + b, 0) : null;
}

export function groupByScenario(records: ScenarioRecord[]): EvalScenario[] {
  const byNumber = new Map<number, ScenarioRecord[]>();
  for (const record of records) {
    const existing = byNumber.get(record.number) ?? [];
    existing.push(record);
    byNumber.set(record.number, existing);
  }

  const groups: EvalScenario[] = [];
  for (const [number, recs] of byNumber) {
    recs.sort((a, b) => (a.suffix ?? "").localeCompare(b.suffix ?? ""));
    const name = recs[0]?.name ?? `scenario_${number}`;
    const status = combineStatus(recs.map((r) => r.status));
    const latencyMs = sumOrNull(recs.map((r) => r.latencyMs));
    // groupByScenario groups sub-cases (e.g. scenario 7's approve/reject)
    // within ONE repeat, not across repeats, so it describes exactly one
    // real run: repeat fields are filled from that single outcome here, the
    // same defaults mergeRepeatGroups' single-repeat identity branch would
    // produce. mergeRepeatGroups (called by the runner after this) is what
    // actually combines multiple repeats together.
    groups.push({
      number,
      name,
      status,
      latencyMs,
      tokensIn: sumOrNull(recs.map((r) => r.tokensIn)),
      tokensOut: sumOrNull(recs.map((r) => r.tokensOut)),
      notes: recs.map((r) => (r.suffix ? `[${r.suffix}] ${r.note}` : r.note)),
      judgeNotes: recs.filter((r) => r.judge).map((r) => `${r.suffix ? `[${r.suffix}] ` : ""}${r.judge!.notes}`),
      judgeState: combineJudgeState(recs.map((r) => r.judgeState ?? null)),
      repeatCount: 1,
      repeatPassCount: status === "pass" ? 1 : 0,
      repeatStatuses: [status],
      latencyMeanMs: latencyMs,
      latencySpreadMs: latencyMs !== null ? 0 : null,
    });
  }
  return groups.sort((a, b) => a.number - b.number);
}

export function countJudgeStates(scenarios: EvalScenario[]): EvalRun["judgeStates"] {
  return {
    scored: scenarios.filter((g) => g.judgeState === "scored").length,
    unscored: scenarios.filter((g) => g.judgeState === "unscored").length,
    notApplicable: scenarios.filter((g) => g.judgeState === null).length,
  };
}

// ---------------------------------------------------------------------------
// Denominator discipline (task P1-6): a scenario that crashed, was skipped,
// or that vitest never reached must count as failed against the expected
// total, never simply be absent from `scenarios` (the bug behind the
// drifting 19/19 -> 18/19 -> 15/18 ratios in the archived runs).
// ---------------------------------------------------------------------------

function syntheticFailScenario(expected: ScenarioFile): EvalScenario {
  return {
    number: expected.number,
    name: expected.name,
    status: "fail",
    latencyMs: null,
    tokensIn: null,
    tokensOut: null,
    notes: [
      "No result was recorded for this scenario: it crashed before writing an artifact, was skipped, or the run ended before vitest reached it. Counted as failed, not omitted, so the pass/total ratio never shrinks silently.",
    ],
    judgeNotes: [],
    judgeState: null,
    repeatCount: 1,
    repeatPassCount: 0,
    repeatStatuses: ["fail"],
    latencyMeanMs: null,
    latencySpreadMs: null,
  };
}

export interface ReconcileResult {
  scenarios: EvalScenario[];
  missingNumbers: number[];
}

// Fills in a synthetic "fail" row for every expected scenario number that
// has no group in `scenarios`, so the returned array always has exactly
// `expected.length` entries, sorted by number. Applied per repeat, before
// mergeRepeatGroups combines repeats together.
export function reconcileExpectedScenarios(scenarios: EvalScenario[], expected: ScenarioFile[]): ReconcileResult {
  const present = new Map(scenarios.map((s) => [s.number, s]));
  const missingNumbers: number[] = [];
  const filled: EvalScenario[] = [];
  for (const exp of expected) {
    const found = present.get(exp.number);
    if (found) {
      filled.push(found);
    } else {
      missingNumbers.push(exp.number);
      filled.push(syntheticFailScenario(exp));
    }
  }
  filled.sort((a, b) => a.number - b.number);
  return { scenarios: filled, missingNumbers };
}

// The pass/total ratio and status a scenario should be reported with,
// reconciling the legacy case (a run record written before repeats existed
// has repeatStatuses: [] and repeatPassCount: 0 by schema default,
// regardless of whether `status` was actually "pass") against the modern
// case (repeatStatuses populated by mergeRepeatGroups). Always use this
// instead of reading repeatCount/repeatPassCount directly.
export function repeatSummary(
  s: Pick<EvalScenario, "status" | "repeatCount" | "repeatPassCount" | "repeatStatuses">,
): { count: number; passCount: number; statuses: ScenarioStatus[] } {
  if (s.repeatStatuses.length > 0) {
    return { count: s.repeatCount, passCount: s.repeatPassCount, statuses: s.repeatStatuses };
  }
  return { count: 1, passCount: s.status === "pass" ? 1 : 0, statuses: [s.status] };
}

export function repeatRatioLabel(
  s: Pick<EvalScenario, "status" | "repeatCount" | "repeatPassCount" | "repeatStatuses">,
): string {
  const { count, passCount } = repeatSummary(s);
  return `${passCount}/${count}`;
}

// Combines one EvalScenario[] per repeat (each already reconciled against
// the same expected set via reconcileExpectedScenarios, so every array has
// identical scenario numbers) into the final per-scenario view: an overall
// status that is only "pass" when every repeat passed (fail beats
// documented_red beats pass, same rule combineStatus already applies across
// sub-cases, now applied across repeats too), plus the repeat ratio and
// latency mean/spread. repeats.length === 1 is the exact common case (no
// repeat flag passed) and returns scenarios whose repeat fields describe
// that one real run, never a merge artifact.
export function mergeRepeatGroups(perRepeat: EvalScenario[][]): EvalScenario[] {
  if (perRepeat.length <= 1) {
    const only = perRepeat[0] ?? [];
    return only.map((s) => ({
      ...s,
      repeatCount: 1,
      repeatPassCount: s.status === "pass" ? 1 : 0,
      repeatStatuses: [s.status],
      latencyMeanMs: s.latencyMs,
      latencySpreadMs: s.latencyMs !== null ? 0 : null,
    }));
  }
  const repeatCount = perRepeat.length;
  const byNumber = new Map<number, EvalScenario[]>();
  for (const group of perRepeat) {
    for (const s of group) {
      const arr = byNumber.get(s.number) ?? [];
      arr.push(s);
      byNumber.set(s.number, arr);
    }
  }
  const merged: EvalScenario[] = [];
  for (const [number, reps] of byNumber) {
    const statuses = reps.map((r) => r.status);
    const latencies = reps.map((r) => r.latencyMs).filter((v): v is number => v !== null);
    const mean = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;
    const spread = latencies.length > 0 ? Math.max(...latencies) - Math.min(...latencies) : null;
    merged.push({
      number,
      name: reps[0]!.name,
      status: combineStatus(statuses),
      latencyMs: reps[0]!.latencyMs,
      tokensIn: reps[0]!.tokensIn,
      tokensOut: reps[0]!.tokensOut,
      notes: reps.flatMap((r, i) => r.notes.map((n) => `[run ${i + 1}] ${n}`)),
      judgeNotes: reps.flatMap((r, i) => r.judgeNotes.map((n) => `[run ${i + 1}] ${n}`)),
      judgeState: combineJudgeState(reps.map((r) => r.judgeState)),
      repeatCount,
      repeatPassCount: statuses.filter((s) => s === "pass").length,
      repeatStatuses: statuses,
      latencyMeanMs: mean,
      latencySpreadMs: spread,
    });
  }
  return merged.sort((a, b) => a.number - b.number);
}

// ---------------------------------------------------------------------------
// CI regression gate (task P1-6, npm run evals:gate): pure comparison logic,
// unit-tested directly (see runRecord.test.ts) rather than only exercised by
// an actual paid gate run. A scenario regresses when the stored baseline
// (evals/results.json, the last `npm run eval` gate snapshot) has it
// passing and the current run's same-numbered scenario is not passing,
// including the case where it is missing entirely from the current run
// (treated as failed, never silently skipped, same denominator-discipline
// rule as reconcileExpectedScenarios above).
// ---------------------------------------------------------------------------

export interface ScenarioRegression {
  number: number;
  name: string;
  previousStatus: ScenarioStatus;
  currentStatus: ScenarioStatus;
}

export function findRegressions(baseline: EvalScenario[], current: EvalScenario[]): ScenarioRegression[] {
  const currentByNumber = new Map(current.map((s) => [s.number, s]));
  const regressions: ScenarioRegression[] = [];
  for (const prior of baseline) {
    if (prior.status !== "pass") continue;
    const now = currentByNumber.get(prior.number);
    const currentStatus = now?.status ?? "fail";
    if (currentStatus !== "pass") {
      regressions.push({ number: prior.number, name: prior.name, previousStatus: prior.status, currentStatus });
    }
  }
  return regressions.sort((a, b) => a.number - b.number);
}

export function describeJudgeCalibration(cal: EvalRunJudgeCalibration | null): string {
  if (!cal) return "not computed for this run (only computed for a full-suite run)";
  return (
    `${cal.agreeing}/${cal.total} (${cal.agreementPct.toFixed(0)}%) agreement with the hand-labeled golden set ` +
    `(${cal.goldenSetVersion}, evals/goldenSet.ts; labels are drafted/ASSUMED, pending human review), judge ${cal.judgeModel ?? "unset"}`
  );
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

function sha256Bytes(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function promptSha256(): string {
  if (!existsSync(PROMPT_PATH)) return "";
  return sha256Bytes(readFileSync(PROMPT_PATH));
}

// Hashes the sorted list of fixtures/*.json: each file's bytes concatenated
// with its own name, in filename order, so the hash changes if a fixture's
// content OR its filename changes, and is stable across re-exports when
// nothing in fixtures/ has changed.
export function fixturesSha256(): string {
  if (!existsSync(FIXTURES_DIR)) return "";
  const files = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(readFileSync(join(FIXTURES_DIR, file)));
    hash.update(file);
  }
  return hash.digest("hex");
}

export function gitCommit(): string | null {
  try {
    return execSync("git rev-parse HEAD", { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scenario catalogue (for subset runs): parsed from the test filenames,
// "14-all-models-down-degraded.eval.test.ts" -> { number: 14, name, file }.
// ---------------------------------------------------------------------------

export interface ScenarioFile {
  number: number;
  name: string;
  file: string;
}

export function listScenarioFiles(dir: string = SCENARIOS_DIR): ScenarioFile[] {
  if (!existsSync(dir)) return [];
  const out: ScenarioFile[] = [];
  for (const file of readdirSync(dir).sort()) {
    const match = /^(\d+)-(.+)\.eval\.test\.ts$/.exec(file);
    if (!match) continue;
    out.push({ number: Number.parseInt(match[1]!, 10), name: match[2]!, file });
  }
  return out.sort((a, b) => a.number - b.number);
}

// ---------------------------------------------------------------------------
// Run files
// ---------------------------------------------------------------------------

export function runFilePath(runId: string): string {
  return join(RUNS_DIR, `${runId}.json`);
}

export function writeRun(run: EvalRun): string {
  const parsed = EvalRunSchema.parse(run);
  mkdirSync(RUNS_DIR, { recursive: true });
  const path = runFilePath(parsed.runId);
  writeFileSync(path, JSON.stringify(parsed, null, 2) + "\n");
  return path;
}

export function readRun(runId: string): EvalRun | null {
  if (!isValidRunId(runId)) return null;
  const path = runFilePath(runId);
  if (!existsSync(path)) return null;
  const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
  return EvalRunSchema.parse(raw);
}

export function deleteRun(runId: string): boolean {
  if (!isValidRunId(runId)) return false;
  const path = runFilePath(runId);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

// Newest first. A file that fails schema validation is skipped, not fatal:
// one hand-edited or half-written record must not take the whole archive
// down with it. The skipped ids are returned so the route can log them.
export function listRuns(): { runs: EvalRun[]; invalid: string[] } {
  if (!existsSync(RUNS_DIR)) return { runs: [], invalid: [] };
  const runs: EvalRun[] = [];
  const invalid: string[] = [];
  for (const file of readdirSync(RUNS_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw: unknown = JSON.parse(readFileSync(join(RUNS_DIR, file), "utf-8"));
      runs.push(EvalRunSchema.parse(raw));
    } catch {
      invalid.push(file);
    }
  }
  runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  return { runs, invalid };
}

// ---------------------------------------------------------------------------
// Legacy results.json + RESULTS.md (the regression-gate snapshot)
// ---------------------------------------------------------------------------

// Old-format results.json (pre-metadata) still parses fine here: this only
// ever reads the `scenarios` key, and tolerates it being missing or not an
// array rather than throwing.
export function loadPreviousResults(): EvalScenario[] | null {
  if (!existsSync(RESULTS_JSON_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(RESULTS_JSON_PATH, "utf-8")) as { scenarios?: unknown };
    return Array.isArray(raw.scenarios) ? (raw.scenarios as EvalScenario[]) : null;
  } catch {
    return null;
  }
}

function diffLine(current: EvalScenario, previous: EvalScenario[] | null): string {
  if (!previous) return `scenario ${current.number}: first run, no prior results to diff against`;
  const prior = previous.find((p) => p.number === current.number);
  if (!prior) return `scenario ${current.number}: new scenario, no prior result`;
  if (prior.status === current.status) return `scenario ${current.number}: unchanged (${current.status})`;
  if (prior.status !== "pass" && current.status === "pass") {
    return `scenario ${current.number}: newly passing (was ${prior.status})`;
  }
  if (prior.status === "pass" && current.status !== "pass") {
    return `scenario ${current.number}: regressed (was pass, now ${current.status})`;
  }
  return `scenario ${current.number}: changed from ${prior.status} to ${current.status}`;
}

function formatMs(ms: number | null): string {
  return ms === null ? "n/a" : `${ms} ms`;
}

// "2453 ms" for a single run (repeatCount 1, the common case, unchanged from
// before repeats existed); "2453 ms (mean 2510 ms, spread 320 ms)" once more
// than one repeat actually ran, so RESULTS.md reports the per-run mean and
// spread task P1-6 asks for without cluttering the common single-run case.
function formatLatencyCell(g: EvalScenario): string {
  const base = formatMs(g.latencyMs);
  if (repeatSummary(g).count <= 1 || g.latencyMeanMs === null) return base;
  const spread = g.latencySpreadMs === null ? "n/a" : `${Math.round(g.latencySpreadMs)} ms`;
  return `${base} (mean ${Math.round(g.latencyMeanMs)} ms, spread ${spread})`;
}

function statusBadge(status: ScenarioStatus): string {
  if (status === "pass") return "PASS";
  if (status === "fail") return "FAIL";
  return "DOCUMENTED RED";
}

// "$0.1258 (openai/gpt-5.4-mini at $0.75 in / $4.50 out per 1M tokens,
// OpenRouter list price fetched 2026-08-19; agent tokens only, judge calls
// not counted)" or the reason there is no figure.
export function describeRunCost(run: EvalRun): string {
  if (!run.pricing) return "n/a (no OpenRouter price recorded for the primary model)";
  const total = runCostUsd(run);
  const rates = `${run.pricing.openrouterModelId} at $${run.pricing.promptUsdPerMillion} in / $${run.pricing.completionUsdPerMillion} out per 1M tokens, OpenRouter list price fetched ${run.pricing.fetchedAt.slice(0, 10)}`;
  if (total === null) return `n/a (no token counts recorded; ${rates})`;
  return `${formatUsd(total)} (${rates}; agent tokens only, judge calls not counted)`;
}

export function buildLegacyMetadata(run: EvalRun): LegacyResultsMetadata {
  return {
    primaryModel: run.provider.primaryModel,
    fallbackModel: run.provider.fallbackModel,
    gitCommit: run.gitCommit,
    runCount: 1,
    judgeStates: run.judgeStates,
    promptSha256: run.promptSha256,
    fixturesSha256: run.fixturesSha256,
  };
}

export function buildMarkdown(run: EvalRun, previous: EvalScenario[] | null): string {
  const groups = run.scenarios;
  const metadata = buildLegacyMetadata(run);
  const passCount = groups.filter((g) => g.status === "pass").length;
  const redCount = groups.filter((g) => g.status === "documented_red").length;
  const failCount = groups.filter((g) => g.status === "fail").length;

  const lines: string[] = [];
  lines.push("# Eval Results");
  lines.push("");
  lines.push(
    `Generated by \`npm run eval\` (\`scripts/run-eval.ts\`). ${groups.length} scenarios: ${passCount} passing, ${redCount} documented red, ${failCount} failing. ${metadata.judgeStates.scored} judge-scored, ${metadata.judgeStates.unscored} unscored (judge unavailable).`,
  );
  lines.push("");
  lines.push("## Metadata");
  lines.push("");
  lines.push(`- Run id: ${run.runId} (\`evals/runs/${run.runId}.json\`)`);
  lines.push(`- Primary model: ${metadata.primaryModel ?? "unset"} (from \`PRIMARY_MODEL\`)`);
  lines.push(`- Fallback model: ${metadata.fallbackModel ?? "unset"} (from \`FALLBACK_MODEL\`)`);
  lines.push(`- Judge model: ${run.provider.judgeModel ?? "unset"} (from \`JUDGE_MODEL\`, defaults to \`FALLBACK_MODEL\`)`);
  lines.push(`- Base URL: ${run.provider.baseUrl} (from \`OPENAI_BASE_URL\`); judge base URL: ${run.provider.judgeBaseUrl}`);
  lines.push(`- Git commit: ${metadata.gitCommit ?? "unknown (git rev-parse failed)"}`);
  lines.push(`- Run count: ${metadata.runCount}`);
  lines.push(`- Judge states: ${metadata.judgeStates.scored} scored, ${metadata.judgeStates.unscored} unscored, ${metadata.judgeStates.notApplicable} not applicable`);
  lines.push(`- Prompt sha256 (\`server/src/agent/prompt.ts\`): ${metadata.promptSha256 || "n/a"}`);
  lines.push(`- Fixtures sha256 (\`fixtures/*.json\`): ${metadata.fixturesSha256 || "n/a"}`);
  lines.push(`- Cost: ${describeRunCost(run)}`);
  lines.push(`- Judge calibration: ${describeJudgeCalibration(run.judgeCalibration)}`);
  if (run.incompleteScenarios.length > 0) {
    lines.push(
      `- Incomplete scenarios (no result recorded for at least one repeat, counted as failed per the denominator-discipline rule): ${run.incompleteScenarios.join(", ")}`,
    );
  }
  lines.push("");
  lines.push("| # | Scenario | Status | Repeats (pass/total) | Latency | Tokens (in/out) | Judge notes |");
  lines.push("|---|----------|--------|-----------------------|---------|------------------|-------------|");
  for (const g of groups) {
    const tokens = g.tokensIn != null || g.tokensOut != null ? `${g.tokensIn ?? "n/a"} / ${g.tokensOut ?? "n/a"}` : "n/a";
    const judge =
      g.judgeState === "unscored"
        ? "UNSCORED (judge unavailable)"
        : g.judgeNotes.length > 0
          ? g.judgeNotes.join("; ")
          : "n/a";
    lines.push(
      `| ${g.number} | ${g.name} | ${statusBadge(g.status)} | ${repeatRatioLabel(g)} | ${formatLatencyCell(g)} | ${tokens} | ${judge.replace(/\|/g, "/")} |`,
    );
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  for (const g of groups) {
    for (const note of g.notes) {
      if (note.trim().length > 0) lines.push(`- scenario ${g.number}: ${note}`);
    }
  }
  lines.push("");
  lines.push("## Diff vs previous run");
  lines.push("");
  if (!previous) {
    lines.push("First run, no prior results to diff against.");
  } else {
    for (const g of groups) lines.push(`- ${diffLine(g, previous)}`);
  }
  lines.push("");
  return lines.join("\n");
}

// Writes the gate snapshot pair. Only `npm run eval` calls this; UI-started
// runs write a run record and nothing else.
export function writeLegacyResults(run: EvalRun): void {
  const previous = loadPreviousResults();
  mkdirSync(dirname(RESULTS_JSON_PATH), { recursive: true });
  writeFileSync(
    RESULTS_JSON_PATH,
    JSON.stringify(
      { generatedAt: run.finishedAt ?? run.startedAt, metadata: buildLegacyMetadata(run), scenarios: run.scenarios },
      null,
      2,
    ),
  );
  writeFileSync(RESULTS_MD_PATH, buildMarkdown(run, previous));
}
