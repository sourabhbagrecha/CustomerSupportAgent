import "../server/src/env.js";

import { resolveAgentProvider, resolveJudgeProvider } from "../server/src/agent/providerConfig.js";
import {
  buildRunId,
  countJudgeStates,
  fixturesSha256,
  gitCommit,
  groupByScenario,
  loadArtifacts,
  promptSha256,
  writeLegacyResults,
  writeRun,
  type EvalRun,
} from "../server/src/evals/runRecord.js";
import { lookupModelPricing } from "../server/src/evals/pricing.js";

// Recovery tool, no longer part of `npm run eval` (scripts/run-eval.ts
// exports in-process now). Rebuilds a run record, evals/results.json, and
// evals/RESULTS.md from whatever per-scenario artifacts are currently in
// evals/.artifacts, for the case where a run finished but its export did not
// (for example the server restarted mid-run and the UI runner never wrote the
// record). Models and base URL are read from the current environment, so run
// it with the same .env the suite ran under.
//
// Usage: npx tsx scripts/export-results.ts [--label <text>]
//   npx tsx runs a TypeScript file directly, no build step; --label names the
//   run record (defaults to PRIMARY_MODEL).

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const labelIdx = argv.indexOf("--label");
  const label = labelIdx >= 0 ? argv[labelIdx + 1] ?? null : null;

  const records = loadArtifacts();
  if (records.length === 0) {
    console.warn("export-results: no artifacts found in evals/.artifacts, nothing to export.");
    return;
  }
  const agent = resolveAgentProvider();
  const judge = resolveJudgeProvider();
  const scenarios = groupByScenario(records);
  const now = new Date().toISOString();
  const run: EvalRun = {
    schemaVersion: 1,
    runId: buildRunId(now, label ?? agent.primaryModel ?? "eval"),
    label: label ?? agent.primaryModel ?? "eval",
    source: "cli",
    status: "completed",
    startedAt: now,
    finishedAt: now,
    durationMs: null,
    exitCode: null,
    failureReason: null,
    provider: {
      baseUrl: agent.baseUrl,
      primaryModel: agent.primaryModel ?? null,
      fallbackModel: agent.fallbackModel ?? null,
      judgeModel: judge.model ?? null,
      judgeBaseUrl: judge.baseUrl,
    },
    scenarioFilter: null,
    gitCommit: gitCommit(),
    promptSha256: promptSha256(),
    fixturesSha256: fixturesSha256(),
    judgeStates: countJudgeStates(scenarios),
    scenarios,
    // Today's OpenRouter price, since the run's own start time is unknown here.
    pricing: await lookupModelPricing(agent.primaryModel ?? null, agent.baseUrl),
    // This recovery tool rebuilds a record from whatever artifacts are on
    // disk; it has no notion of "expected" scenarios or a live judge run to
    // reconcile/calibrate against, so both are left at their neutral values
    // (task P1-6 added these fields to EvalRun after this script existed).
    incompleteScenarios: [],
    judgeCalibration: null,
  };
  const path = writeRun(run);
  writeLegacyResults(run);
  console.log(`Wrote ${path}, evals/results.json and evals/RESULTS.md (${scenarios.length} scenarios).`);
}

void main();
