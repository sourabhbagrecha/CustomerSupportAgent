try {
  process.loadEnvFile();
} catch {
  // No .env file; rely on real environment variables (e.g. CI). Mirrors
  // evals/setupEnv.ts so PRIMARY_MODEL/FALLBACK_MODEL are readable here too
  // when this script is run standalone (npm run eval invokes it as a
  // separate tsx process, not through vitest's setupFiles).
}

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JudgeState, ScenarioRecord, ScenarioStatus } from "../evals/types.js";

// Reads every JSON artifact written by evals/harness.ts's withScenarioResult
// (one per scenario, or one per sub-case for scenario 7's approve/reject
// paths), groups them by scenario number, diffs against the previously
// committed evals/results.json, then writes a fresh evals/results.json and
// evals/RESULTS.md. Run as the second half of `npm run eval`.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const ARTIFACTS_DIR = join(REPO_ROOT, "evals", ".artifacts");
const RESULTS_JSON_PATH = join(REPO_ROOT, "evals", "results.json");
const RESULTS_MD_PATH = join(REPO_ROOT, "evals", "RESULTS.md");
const PROMPT_PATH = join(REPO_ROOT, "server", "src", "agent", "prompt.ts");
const FIXTURES_DIR = join(REPO_ROOT, "fixtures");

interface ScenarioGroup {
  number: number;
  name: string;
  status: ScenarioStatus;
  latencyMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  notes: string[];
  judgeNotes: string[];
  judgeState: JudgeState;
}

interface ResultsMetadata {
  primaryModel: string | null;
  fallbackModel: string | null;
  gitCommit: string | null;
  runCount: number;
  judgeStates: { scored: number; unscored: number; notApplicable: number };
  promptSha256: string;
  fixturesSha256: string;
}

function loadArtifacts(): ScenarioRecord[] {
  if (!existsSync(ARTIFACTS_DIR)) return [];
  const files = readdirSync(ARTIFACTS_DIR).filter((f) => f.endsWith(".json"));
  return files.map((f) => JSON.parse(readFileSync(join(ARTIFACTS_DIR, f), "utf-8")) as ScenarioRecord);
}

// A scenario with multiple sub-cases (scenario 7: approve + reject) is green
// overall only if every sub-case is; a single documented_red sub-case marks
// the whole scenario documented_red unless another sub-case outright failed.
function combineStatus(statuses: ScenarioStatus[]): ScenarioStatus {
  if (statuses.some((s) => s === "fail")) return "fail";
  if (statuses.some((s) => s === "documented_red")) return "documented_red";
  return "pass";
}

// A group is "unscored" if any sub-case came back unscored (judge outage
// anywhere in the group is worth surfacing), "scored" if at least one
// sub-case was scored and none were unscored, and null if the judge was
// never called for this scenario at all.
function combineJudgeState(states: JudgeState[]): JudgeState {
  if (states.some((s) => s === "unscored")) return "unscored";
  if (states.some((s) => s === "scored")) return "scored";
  return null;
}

function groupByScenario(records: ScenarioRecord[]): ScenarioGroup[] {
  const byNumber = new Map<number, ScenarioRecord[]>();
  for (const record of records) {
    const existing = byNumber.get(record.number) ?? [];
    existing.push(record);
    byNumber.set(record.number, existing);
  }

  const groups: ScenarioGroup[] = [];
  for (const [number, recs] of byNumber) {
    recs.sort((a, b) => (a.suffix ?? "").localeCompare(b.suffix ?? ""));
    const name = recs[0]?.name ?? `scenario_${number}`;
    const latencies = recs.map((r) => r.latencyMs).filter((v): v is number => v != null);
    const tokensInVals = recs.map((r) => r.tokensIn).filter((v): v is number => v != null);
    const tokensOutVals = recs.map((r) => r.tokensOut).filter((v): v is number => v != null);
    groups.push({
      number,
      name,
      status: combineStatus(recs.map((r) => r.status)),
      latencyMs: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) : null,
      tokensIn: tokensInVals.length > 0 ? tokensInVals.reduce((a, b) => a + b, 0) : null,
      tokensOut: tokensOutVals.length > 0 ? tokensOutVals.reduce((a, b) => a + b, 0) : null,
      notes: recs.map((r) => (r.suffix ? `[${r.suffix}] ${r.note}` : r.note)),
      judgeNotes: recs.filter((r) => r.judge).map((r) => `${r.suffix ? `[${r.suffix}] ` : ""}${r.judge!.notes}`),
      judgeState: combineJudgeState(recs.map((r) => r.judgeState ?? null)),
    });
  }
  return groups.sort((a, b) => a.number - b.number);
}

// Old-format results.json (pre-metadata) still parses fine here: this only
// ever reads the `scenarios` key, and tolerates it being missing or not an
// array rather than throwing.
function loadPreviousResults(): ScenarioGroup[] | null {
  if (!existsSync(RESULTS_JSON_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(RESULTS_JSON_PATH, "utf-8")) as { scenarios?: unknown };
    return Array.isArray(raw.scenarios) ? (raw.scenarios as ScenarioGroup[]) : null;
  } catch {
    return null;
  }
}

function diffLine(current: ScenarioGroup, previous: ScenarioGroup[] | null): string {
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

function sha256Bytes(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function promptSha256(): string {
  if (!existsSync(PROMPT_PATH)) return "";
  return sha256Bytes(readFileSync(PROMPT_PATH));
}

// Hashes the sorted list of fixtures/*.json: each file's bytes concatenated
// with its own name, in filename order, so the hash changes if a fixture's
// content OR its filename changes, and is stable across re-exports when
// nothing in fixtures/ has changed.
function fixturesSha256(): string {
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

function gitCommit(): string | null {
  try {
    return execSync("git rev-parse HEAD", { cwd: REPO_ROOT }).toString().trim();
  } catch {
    return null;
  }
}

function buildMetadata(groups: ScenarioGroup[]): ResultsMetadata {
  return {
    primaryModel: process.env.PRIMARY_MODEL ?? null,
    fallbackModel: process.env.FALLBACK_MODEL ?? null,
    gitCommit: gitCommit(),
    runCount: 1,
    judgeStates: {
      scored: groups.filter((g) => g.judgeState === "scored").length,
      unscored: groups.filter((g) => g.judgeState === "unscored").length,
      notApplicable: groups.filter((g) => g.judgeState === null).length,
    },
    promptSha256: promptSha256(),
    fixturesSha256: fixturesSha256(),
  };
}

function buildMarkdown(groups: ScenarioGroup[], previous: ScenarioGroup[] | null, metadata: ResultsMetadata): string {
  const passCount = groups.filter((g) => g.status === "pass").length;
  const redCount = groups.filter((g) => g.status === "documented_red").length;
  const failCount = groups.filter((g) => g.status === "fail").length;

  const lines: string[] = [];
  lines.push("# Eval Results");
  lines.push("");
  lines.push(
    `Generated by \`npm run eval\` (\`scripts/export-results.ts\`). ${groups.length} scenarios: ${passCount} passing, ${redCount} documented red, ${failCount} failing. ${metadata.judgeStates.scored} judge-scored, ${metadata.judgeStates.unscored} unscored (judge unavailable).`,
  );
  lines.push("");
  lines.push("## Metadata");
  lines.push("");
  lines.push(`- Primary model: ${metadata.primaryModel ?? "unset"} (from \`PRIMARY_MODEL\`)`);
  lines.push(`- Fallback / judge model: ${metadata.fallbackModel ?? "unset"} (from \`FALLBACK_MODEL\`)`);
  lines.push(`- Git commit: ${metadata.gitCommit ?? "unknown (git rev-parse failed)"}`);
  lines.push(`- Run count: ${metadata.runCount}`);
  lines.push(`- Judge states: ${metadata.judgeStates.scored} scored, ${metadata.judgeStates.unscored} unscored, ${metadata.judgeStates.notApplicable} not applicable`);
  lines.push(`- Prompt sha256 (\`server/src/agent/prompt.ts\`): ${metadata.promptSha256 || "n/a"}`);
  lines.push(`- Fixtures sha256 (\`fixtures/*.json\`): ${metadata.fixturesSha256 || "n/a"}`);
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

function main(): void {
  const records = loadArtifacts();
  if (records.length === 0) {
    console.warn("export-results: no artifacts found in evals/.artifacts, nothing to export.");
    return;
  }
  const groups = groupByScenario(records);
  const previous = loadPreviousResults();
  const metadata = buildMetadata(groups);

  mkdirSync(dirname(RESULTS_JSON_PATH), { recursive: true });
  writeFileSync(
    RESULTS_JSON_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), metadata, scenarios: groups }, null, 2),
  );
  writeFileSync(RESULTS_MD_PATH, buildMarkdown(groups, previous, metadata));

  console.log(`Wrote ${RESULTS_JSON_PATH} and ${RESULTS_MD_PATH} (${groups.length} scenarios).`);
}

main();
