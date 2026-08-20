import "../server/src/env.js";

import { resolveAgentProvider, resolveJudgeProvider } from "../server/src/agent/providerConfig.js";
import { findRegressions, loadPreviousResults } from "../server/src/evals/runRecord.js";
import { startEvalRun } from "../server/src/evals/runner.js";

// `npm run evals:gate` (task P1-6, CI gate). Runs the full scenario suite
// against the current commit exactly the way `npm run eval` does (real
// model calls, costs credit, same startEvalRun mechanism in
// server/src/evals/runner.ts), then compares every scenario that is "pass"
// in the last committed evals/results.json baseline against this run's
// result for that same scenario number (findRegressions in
// server/src/evals/runRecord.ts, unit-tested there). Any baseline pass that
// is not a pass now, including a scenario missing entirely from this run
// (denominator discipline: never a silent skip), is a regression: printed
// by number and name, and the process exits 1. A clean run exits 0.
//
// Unlike `npm run eval`, a gate run never rewrites evals/results.json or
// evals/RESULTS.md (writeLegacy: false): it is a verification step against
// the existing baseline, not a new baseline, so a broken run can never
// silently become the new "passing" snapshot. It only adds a record under
// evals/runs/, same as a UI-started or subset run.
//
// Usage:
//   npm run evals:gate

async function main(): Promise<void> {
  const baseline = loadPreviousResults();
  if (!baseline) {
    console.error(
      "evals:gate: no evals/results.json baseline found to gate against; run `npm run eval` at least once first.",
    );
    process.exit(1);
    return;
  }

  const agent = resolveAgentProvider();
  const judge = resolveJudgeProvider();
  const handle = startEvalRun({
    label: "evals-gate",
    source: "cli",
    scenarioNumbers: null,
    envOverrides: {},
    provider: {
      baseUrl: agent.baseUrl,
      primaryModel: agent.primaryModel ?? null,
      fallbackModel: agent.fallbackModel ?? null,
      judgeModel: judge.model ?? null,
      judgeBaseUrl: judge.baseUrl,
    },
    stdio: "inherit",
    writeLegacy: false,
  });

  const run = await handle.done;

  if (run.status !== "completed") {
    console.error(
      `evals:gate: run did not complete (status ${run.status}${run.failureReason ? `: ${run.failureReason}` : ""}); treating as a gate failure since regressions cannot be checked. Record: evals/runs/${run.runId}.json`,
    );
    process.exit(1);
    return;
  }

  const regressions = findRegressions(baseline, run.scenarios);
  if (regressions.length > 0) {
    console.error(`evals:gate: ${regressions.length} scenario(s) regressed against the evals/results.json baseline:`);
    for (const r of regressions) {
      console.error(`  - #${r.number} ${r.name}: was ${r.previousStatus}, now ${r.currentStatus}`);
    }
    console.error(`Record: evals/runs/${run.runId}.json`);
    process.exit(1);
    return;
  }

  console.log(`evals:gate: no regressions across ${run.scenarios.length} scenarios. Record: evals/runs/${run.runId}.json`);
  process.exit(0);
}

void main();
