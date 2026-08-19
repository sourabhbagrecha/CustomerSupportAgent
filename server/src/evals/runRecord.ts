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
    groups.push({
      number,
      name,
      status: combineStatus(recs.map((r) => r.status)),
      latencyMs: sumOrNull(recs.map((r) => r.latencyMs)),
      tokensIn: sumOrNull(recs.map((r) => r.tokensIn)),
      tokensOut: sumOrNull(recs.map((r) => r.tokensOut)),
      notes: recs.map((r) => (r.suffix ? `[${r.suffix}] ${r.note}` : r.note)),
      judgeNotes: recs.filter((r) => r.judge).map((r) => `${r.suffix ? `[${r.suffix}] ` : ""}${r.judge!.notes}`),
      judgeState: combineJudgeState(recs.map((r) => r.judgeState ?? null)),
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
  lines.push("");
  lines.push("| # | Scenario | Status | Latency | Tokens (in/out) | Judge notes |");
  lines.push("|---|----------|--------|---------|------------------|-------------|");
  for (const g of groups) {
    const tokens = g.tokensIn != null || g.tokensOut != null ? `${g.tokensIn ?? "n/a"} / ${g.tokensOut ?? "n/a"}` : "n/a";
    const judge =
      g.judgeState === "unscored"
        ? "UNSCORED (judge unavailable)"
        : g.judgeNotes.length > 0
          ? g.judgeNotes.join("; ")
          : "n/a";
    lines.push(`| ${g.number} | ${g.name} | ${statusBadge(g.status)} | ${formatMs(g.latencyMs)} | ${tokens} | ${judge.replace(/\|/g, "/")} |`);
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
