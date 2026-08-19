import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScenarioRecord, ScenarioStatus } from "../evals/types.js";

// Reads every JSON artifact written by evals/harness.ts's withScenarioResult
// (one per scenario, or one per sub-case for scenario 7's approve/reject
// paths), groups them by scenario number, diffs against the previously
// committed evals/results.json, then writes a fresh evals/results.json and
// evals/RESULTS.md. Run as the second half of `npm run eval`.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = join(__dirname, "..", "evals", ".artifacts");
const RESULTS_JSON_PATH = join(__dirname, "..", "evals", "results.json");
const RESULTS_MD_PATH = join(__dirname, "..", "evals", "RESULTS.md");

interface ScenarioGroup {
  number: number;
  name: string;
  status: ScenarioStatus;
  latencyMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  notes: string[];
  judgeNotes: string[];
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
    });
  }
  return groups.sort((a, b) => a.number - b.number);
}

function loadPreviousResults(): ScenarioGroup[] | null {
  if (!existsSync(RESULTS_JSON_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(RESULTS_JSON_PATH, "utf-8")) as { scenarios: ScenarioGroup[] };
    return raw.scenarios;
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

function buildMarkdown(groups: ScenarioGroup[], previous: ScenarioGroup[] | null): string {
  const passCount = groups.filter((g) => g.status === "pass").length;
  const redCount = groups.filter((g) => g.status === "documented_red").length;
  const failCount = groups.filter((g) => g.status === "fail").length;

  const lines: string[] = [];
  lines.push("# Eval Results");
  lines.push("");
  lines.push(`Generated by \`npm run eval\` (\`scripts/export-results.ts\`). ${groups.length} scenarios: ${passCount} passing, ${redCount} documented red, ${failCount} failing.`);
  lines.push("");
  lines.push("| # | Scenario | Status | Latency | Tokens (in/out) | Judge notes |");
  lines.push("|---|----------|--------|---------|------------------|-------------|");
  for (const g of groups) {
    const tokens = g.tokensIn != null || g.tokensOut != null ? `${g.tokensIn ?? "n/a"} / ${g.tokensOut ?? "n/a"}` : "n/a";
    const judge = g.judgeNotes.length > 0 ? g.judgeNotes.join("; ") : "n/a";
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

  mkdirSync(dirname(RESULTS_JSON_PATH), { recursive: true });
  writeFileSync(RESULTS_JSON_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), scenarios: groups }, null, 2));
  writeFileSync(RESULTS_MD_PATH, buildMarkdown(groups, previous));

  console.log(`Wrote ${RESULTS_JSON_PATH} and ${RESULTS_MD_PATH} (${groups.length} scenarios).`);
}

main();
