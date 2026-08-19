import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  ARTIFACTS_DIR,
  REPO_ROOT,
  buildRunId,
  countJudgeStates,
  fixturesSha256,
  gitCommit,
  groupByScenario,
  listScenarioFiles,
  loadArtifacts,
  promptSha256,
  writeLegacyResults,
  writeRun,
  type EvalRun,
  type EvalRunProvider,
  type EvalRunSource,
} from "./runRecord.js";
import { lookupModelPricing } from "./pricing.js";

// Runs the eval suite as a child process and turns its artifacts into a run
// record (plan 007). Used by `npm run eval` (scripts/run-eval.ts, terminal
// inherited, legacy results.json/RESULTS.md also written) and by the
// POST /api/evals/runs route (output captured, run record only).
//
// The child is the exact vitest invocation `npm run eval` has always made:
// `vitest run --config vitest.eval.config.ts [scenario files]`. It lives for
// the duration of one suite and is gone afterwards; it is not a second
// service (CLAUDE.md invariant 3). One run at a time, process-wide: the
// artifacts directory is shared, so two concurrent suites would interleave
// their records.

const VITEST_ENTRY = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
const EVAL_CONFIG = "vitest.eval.config.ts";
const POLL_INTERVAL_MS = 1_000;
const LOG_TAIL_LINES = 200;

export class EvalRunInProgressError extends Error {
  constructor() {
    super("An eval run is already in progress; wait for it to finish or cancel it first.");
    this.name = "EvalRunInProgressError";
  }
}

export interface StartEvalRunOptions {
  label: string;
  source: EvalRunSource;
  // Scenario numbers to run, or null for the full suite. Validated against
  // evals/scenarios/ here; the HTTP layer validates shape only.
  scenarioNumbers: number[] | null;
  // Environment overrides applied on top of process.env for the child. For
  // UI runs this is the full provider set (OPENAI_API_KEY, OPENAI_BASE_URL,
  // PRIMARY_MODEL, FALLBACK_MODEL, JUDGE_*); for CLI runs it is empty and
  // the child inherits the terminal's env exactly as before.
  envOverrides: Record<string, string>;
  // What goes into the run record's provider block (never a key).
  provider: EvalRunProvider;
  // "inherit": vitest's reporter prints straight to the terminal (CLI).
  // "pipe": output is captured into logTail for the UI.
  stdio: "inherit" | "pipe";
  // Also rewrite evals/results.json + evals/RESULTS.md (the regression-gate
  // snapshot). Only `npm run eval` sets this.
  writeLegacy: boolean;
}

export interface EvalRunHandle {
  // Mutated in place as artifacts land, so a poller sees partial progress.
  readonly run: EvalRun;
  readonly logTail: string[];
  readonly expectedScenarioCount: number;
  cancel(): void;
  done: Promise<EvalRun>;
}

let current: EvalRunHandle | null = null;
let exitHooksInstalled = false;

export function getCurrentRun(): EvalRunHandle | null {
  return current && current.run.status === "running" ? current : null;
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

function pushLogLines(target: string[], chunk: string): void {
  for (const rawLine of chunk.split(/\r?\n/)) {
    const line = rawLine.replace(ANSI_PATTERN, "").trimEnd();
    if (line.length === 0) continue;
    target.push(line);
    if (target.length > LOG_TAIL_LINES) target.splice(0, target.length - LOG_TAIL_LINES);
  }
}

// POSIX: the child is its own process group so vitest AND its forked test
// workers die together on cancel (killing only the parent can leave a fork
// mid-scenario, still making billed model calls). Windows has no process
// groups in that sense; child.kill() is the best available there.
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Group already gone or not a leader; fall through to a plain kill.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited between the check above and here.
  }
}

// If the server itself goes down mid-run (Ctrl+C, tsx watch restart), take
// the child with it rather than leaving a detached vitest spending credit
// against a run nobody will record. Installed lazily on the first run so an
// idle server keeps Node's default signal behaviour.
function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  const killCurrent = () => {
    const handle = getCurrentRun();
    if (handle) handle.cancel();
  };
  process.on("exit", killCurrent);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      killCurrent();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

function resolveScenarioFiles(scenarioNumbers: number[] | null): string[] {
  if (scenarioNumbers === null) return [];
  const catalogue = listScenarioFiles();
  const files: string[] = [];
  for (const number of scenarioNumbers) {
    const match = catalogue.find((s) => s.number === number);
    if (!match) throw new Error(`Unknown eval scenario number ${number}.`);
    files.push(join("evals", "scenarios", match.file));
  }
  return files;
}

export function startEvalRun(options: StartEvalRunOptions): EvalRunHandle {
  if (getCurrentRun()) throw new EvalRunInProgressError();
  if (!existsSync(VITEST_ENTRY)) {
    throw new Error(`vitest entry not found at ${VITEST_ENTRY}; run npm install first.`);
  }
  const scenarioFiles = resolveScenarioFiles(options.scenarioNumbers);
  const expectedScenarioCount =
    options.scenarioNumbers === null ? listScenarioFiles().length : options.scenarioNumbers.length;

  // Stale artifacts from a previous run would be grouped into this one.
  rmSync(ARTIFACTS_DIR, { recursive: true, force: true });
  mkdirSync(ARTIFACTS_DIR, { recursive: true });

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const run: EvalRun = {
    schemaVersion: 1,
    runId: buildRunId(startedAt, options.label),
    label: options.label,
    source: options.source,
    status: "running",
    startedAt,
    finishedAt: null,
    durationMs: null,
    exitCode: null,
    failureReason: null,
    provider: options.provider,
    scenarioFilter: options.scenarioNumbers,
    gitCommit: gitCommit(),
    promptSha256: promptSha256(),
    fixturesSha256: fixturesSha256(),
    judgeStates: { scored: 0, unscored: 0, notApplicable: 0 },
    scenarios: [],
    pricing: null,
  };
  const logTail: string[] = [];

  // Price snapshot for the cost column (plan 008): fetched in the background
  // while vitest runs, stamped on the record as soon as it resolves so the UI
  // poller sees cost fill in, and awaited before the record is written so a
  // fast-failing run still gets its price. Never rejects; a listing outage
  // means pricing stays null (cost n/a) and the run itself is unaffected.
  const pricingReady = lookupModelPricing(options.provider.primaryModel, options.provider.baseUrl)
    .then((pricing) => {
      run.pricing = pricing;
    })
    .catch((err: unknown) => {
      // lookupModelPricing already catches its own network errors; this is
      // the belt for anything else, so the record write below can never be
      // skipped because of a pricing problem.
      const message = err instanceof Error ? err.message : String(err);
      pushLogLines(logTail, `pricing lookup failed: ${message}; cost will be n/a`);
      console.error(`eval runner: pricing lookup failed (${message})`);
    });

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...options.envOverrides })) {
    if (value !== undefined) env[key] = value;
  }
  // The child's own env.ts / setupEnv.ts call process.loadEnvFile(), which
  // never overrides a variable that is already set, so the overrides above
  // win over .env inside the child exactly as they do here.
  env.EVAL_RUN_ID = run.runId;

  const child = spawn(process.execPath, [VITEST_ENTRY, "run", "--config", EVAL_CONFIG, ...scenarioFiles], {
    cwd: REPO_ROOT,
    env,
    stdio: options.stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  let cancelRequested = false;
  let settled = false;
  let resolveDone: (run: EvalRun) => void = () => {};
  const done = new Promise<EvalRun>((resolve) => {
    resolveDone = resolve;
  });

  const refresh = () => {
    run.scenarios = groupByScenario(loadArtifacts());
    run.judgeStates = countJudgeStates(run.scenarios);
  };
  const poll = setInterval(refresh, POLL_INTERVAL_MS);

  child.stdout?.on("data", (chunk: Buffer) => pushLogLines(logTail, chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => pushLogLines(logTail, chunk.toString()));

  const settle = (exitCode: number | null, spawnError: Error | null) => {
    if (settled) return;
    settled = true;
    clearInterval(poll);
    refresh();
    const finishedAtMs = Date.now();
    run.finishedAt = new Date(finishedAtMs).toISOString();
    run.durationMs = finishedAtMs - startedAtMs;
    run.exitCode = exitCode;
    if (cancelRequested) {
      run.status = "cancelled";
    } else if (spawnError) {
      run.status = "failed";
      run.failureReason = `Could not start vitest: ${spawnError.message}`;
    } else if (run.scenarios.length === 0) {
      // vitest exited without a single scenario artifact: a crash before any
      // test ran (bad config, missing env), not a suite result.
      run.status = "failed";
      run.failureReason =
        logTail.length > 0
          ? `vitest exited with code ${exitCode ?? "null"} before any scenario recorded a result. Last output: ${logTail.slice(-8).join(" | ")}`
          : `vitest exited with code ${exitCode ?? "null"} before any scenario recorded a result.`;
    } else {
      run.status = "completed";
    }
    void pricingReady.then(() => {
      try {
        writeRun(run);
        if (options.writeLegacy && run.status === "completed") writeLegacyResults(run);
      } catch (err) {
        // A record that cannot be written is still reported to the caller; the
        // failure is logged (not swallowed) and the run stays in memory.
        const message = err instanceof Error ? err.message : String(err);
        pushLogLines(logTail, `run record could not be written: ${message}`);
        console.error(`eval runner: run record could not be written (${message})`);
      }
      resolveDone(run);
    });
  };

  child.on("error", (err) => settle(null, err));
  // "close" rather than "exit": it fires once the stdio pipes have drained,
  // so the last reporter lines make it into logTail before the record is
  // written. For an inherited stdio it fires at the same point as "exit".
  child.on("close", (code, signal) => settle(code ?? (signal ? 1 : null), null));

  const handle: EvalRunHandle = {
    run,
    logTail,
    expectedScenarioCount,
    cancel() {
      if (settled) return;
      cancelRequested = true;
      pushLogLines(logTail, "cancel requested, stopping vitest");
      killTree(child, "SIGTERM");
    },
    done,
  };
  current = handle;
  installExitHooks();
  return handle;
}
