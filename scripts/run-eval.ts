import "../server/src/env.js";

import { resolveAgentProvider, resolveJudgeProvider } from "../server/src/agent/providerConfig.js";
import { startEvalRun } from "../server/src/evals/runner.js";

// `npm run eval`. Runs the full scenario suite (real model calls, costs
// credit) through the shared runner in server/src/evals/runner.ts: clears
// evals/.artifacts, spawns `vitest run --config vitest.eval.config.ts` with
// the terminal inherited so vitest's own reporter prints live, then writes
// one run record to evals/runs/ and regenerates evals/results.json and
// evals/RESULTS.md (the regression-gate snapshot that gets committed with a
// code change). The process exit code is vitest's, so a failing scenario
// still fails the command.
//
// Usage:
//   npm run eval                       full suite, label defaults to PRIMARY_MODEL
//   npx tsx scripts/run-eval.ts --label "gpt-5.4-mini after prompt change"
//   npx tsx scripts/run-eval.ts 14 18  only scenarios 14 and 18 (numbers as
//                                      listed in evals/scenarios/), run record only,
//                                      the gate snapshot is NOT rewritten for a subset
//
// Provider comes from the environment exactly as for the server: OPENAI_API_KEY,
// optional OPENAI_BASE_URL, PRIMARY_MODEL, FALLBACK_MODEL, optional JUDGE_*.

function parseArgs(argv: string[]): { label: string | null; scenarios: number[] | null } {
  let label: string | null = null;
  const scenarios: number[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--label") {
      label = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (/^\d+$/.test(arg)) {
      scenarios.push(Number.parseInt(arg, 10));
      continue;
    }
    console.error(`Unknown argument "${arg}". Usage: npx tsx scripts/run-eval.ts [--label <text>] [scenario numbers...]`);
    process.exit(2);
  }
  return { label, scenarios: scenarios.length > 0 ? scenarios : null };
}

async function main(): Promise<void> {
  const { label, scenarios } = parseArgs(process.argv.slice(2));
  const agent = resolveAgentProvider();
  const judge = resolveJudgeProvider();
  const handle = startEvalRun({
    label: label ?? agent.primaryModel ?? "eval",
    source: "cli",
    scenarioNumbers: scenarios,
    envOverrides: {},
    provider: {
      baseUrl: agent.baseUrl,
      primaryModel: agent.primaryModel ?? null,
      fallbackModel: agent.fallbackModel ?? null,
      judgeModel: judge.model ?? null,
      judgeBaseUrl: judge.baseUrl,
    },
    stdio: "inherit",
    writeLegacy: scenarios === null,
  });
  const run = await handle.done;
  console.log(
    `\neval run ${run.runId}: ${run.status}, ${run.scenarios.length} scenario(s) recorded, ` +
      `${run.scenarios.filter((s) => s.status === "pass").length} passing. Record: evals/runs/${run.runId}.json` +
      (scenarios === null && run.status === "completed" ? "; evals/results.json and evals/RESULTS.md regenerated." : "."),
  );
  if (run.status === "failed") console.error(run.failureReason ?? "eval run failed");
  process.exit(run.status === "completed" ? (run.exitCode ?? 1) : 1);
}

void main();
