import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runGoldenSetCalibration } from "../../../evals/judge.js";
import type { ScenarioRecord } from "../../../evals/types.js";
import {
  ARTIFACTS_DIR,
  REPO_ROOT,
  archivePromptSnapshot,
  buildRunId,
  countJudgeStates,
  fixturesSha256,
  gitCommit,
  groupByScenario,
  listScenarioFiles,
  loadArtifacts,
  mergeRepeatGroups,
  promptSha256,
  reconcileExpectedScenarios,
  writeLegacyResults,
  writeRun,
  type EvalRun,
  type EvalRunProvider,
  type EvalRunSource,
  type EvalScenario,
} from "./runRecord.js";
import { lookupModelPricing } from "./pricing.js";

// Runs the eval suite as a child process and turns its artifacts into a run
// record (plan 007). Used by `npm run eval` (scripts/run-eval.ts, terminal
// inherited, legacy results.json/RESULTS.md also written), by
// `npm run evals:gate` (scripts/evals-gate.ts, terminal inherited, run
// record only), and by the POST /api/evals/runs route (output captured, run
// record only).
//
// Each repeat spawns the exact vitest invocation `npm run eval` has always
// made: `vitest run --config vitest.eval.config.ts [scenario files]`. Every
// child lives for the duration of one suite pass and is gone afterwards; it
// is not a second service (CLAUDE.md invariant 3). One run at a time,
// process-wide: the artifacts directory is shared, so two concurrent suites
// (or two repeats of the same suite) would interleave their records, which
// is exactly why repeats run sequentially, one child at a time, rather than
// in parallel.

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
  // snapshot). Only `npm run eval` sets this; a gate run (npm run
  // evals:gate) and every UI/subset run leave it false so a broken run can
  // never silently become the new baseline.
  writeLegacy: boolean;
  // How many times to run each selected scenario (task P1-6 "repeats").
  // Defaults to 1: plain `npm run eval` costs and behaves exactly as before
  // unless a caller opts in. >1 spawns the same vitest invocation that many
  // times sequentially (never in parallel: see the artifacts-directory note
  // above), tagging each pass via EVAL_REPEAT_INDEX so the per-scenario
  // pass/fail across repeats can be reported instead of a single run's
  // outcome standing in for all of them.
  repeats?: number;
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
  const repeats = Math.max(1, Math.floor(options.repeats ?? 1));
  const scenarioFiles = resolveScenarioFiles(options.scenarioNumbers);
  const expectedScenarios =
    options.scenarioNumbers === null
      ? listScenarioFiles()
      : listScenarioFiles().filter((f) => options.scenarioNumbers!.includes(f.number));
  const expectedScenarioCount = expectedScenarios.length * repeats;

  // Stale artifacts from a previous run would be grouped into this one.
  // Cleared once, before the first repeat: every repeat after that writes
  // into the same directory (see EVAL_REPEAT_INDEX in evals/harness.ts,
  // which keeps each repeat's filenames distinct), so a later repeat never
  // wipes an earlier one's results.
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
    incompleteScenarios: [],
    judgeCalibration: null,
  };
  const logTail: string[] = [];

  // Prompt snapshot archive (plan 012): content-addressed copy of prompt.ts
  // for the promptSha256 this record carries, so the version is inspectable
  // later. Never fatal: a run must not fail because a snapshot could not be
  // written, but the failure is logged, not swallowed.
  try {
    archivePromptSnapshot();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pushLogLines(logTail, `prompt snapshot could not be written: ${message}`);
    console.error(`eval runner: prompt snapshot could not be written (${message})`);
  }

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

  // Judge calibration (task P1-6): only for a full-suite run (never a
  // subset), so the extra dozen short judge calls ride along with the runs
  // that matter most (the gate snapshot, a UI "run everything", and
  // evals:gate) without adding cost to every cheap subset spot-check. Uses
  // the same merged env as the child (`env` above), so a UI run with a
  // judge override is calibrated against that same judge, not the server
  // process's default one. Fire-and-forget alongside pricingReady; never
  // rejects, and a calibration problem can never block or fail the run.
  const calibrationReady =
    options.scenarioNumbers === null
      ? runGoldenSetCalibration(env)
          .then((calibration) => {
            run.judgeCalibration = calibration;
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            pushLogLines(logTail, `judge calibration failed: ${message}; calibration will be n/a`);
            console.error(`eval runner: judge calibration failed (${message})`);
          })
      : Promise.resolve();

  let cancelRequested = false;
  let settled = false;
  let resolveDone: (run: EvalRun) => void = () => {};
  const done = new Promise<EvalRun>((resolve) => {
    resolveDone = resolve;
  });

  // Live progress only: a naive grouping across whatever artifacts exist so
  // far. During a multi-repeat run this can blend more than one repeat's
  // records into the same scenario number mid-poll; that is a cosmetic
  // quirk of the progress view only. The accurate, reconciled-and-merged
  // final view is computed once in finalizeScenarios below, after every
  // repeat has actually finished, and that is what gets written to disk.
  const refresh = () => {
    run.scenarios = groupByScenario(loadArtifacts());
    run.judgeStates = countJudgeStates(run.scenarios);
  };
  const poll = setInterval(refresh, POLL_INTERVAL_MS);

  let currentChild: ChildProcess | null = null;
  const exitCodes: Array<number | null> = [];
  let spawnError: Error | null = null;

  function spawnOneRepeat(index: number): Promise<void> {
    return new Promise((resolve) => {
      const repeatEnv: Record<string, string> = { ...env };
      if (repeats > 1) {
        repeatEnv.EVAL_REPEAT_INDEX = String(index);
        pushLogLines(logTail, `--- repeat ${index}/${repeats} ---`);
      }
      const child = spawn(process.execPath, [VITEST_ENTRY, "run", "--config", EVAL_CONFIG, ...scenarioFiles], {
        cwd: REPO_ROOT,
        env: repeatEnv,
        stdio: options.stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      currentChild = child;
      child.stdout?.on("data", (chunk: Buffer) => pushLogLines(logTail, chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => pushLogLines(logTail, chunk.toString()));
      child.on("error", (err) => {
        spawnError = err;
        currentChild = null;
        resolve();
      });
      // "close" rather than "exit": it fires once the stdio pipes have
      // drained, so the last reporter lines make it into logTail before the
      // next repeat starts (or the record is written). For an inherited
      // stdio it fires at the same point as "exit".
      child.on("close", (code, signal) => {
        currentChild = null;
        exitCodes.push(code ?? (signal ? 1 : null));
        resolve();
      });
    });
  }

  // Denominator discipline (task P1-6): groups each repeat's own artifacts,
  // reconciles each against the full expected set (so a crashed/skipped
  // scenario in ANY repeat is a synthetic fail, never a silently smaller
  // denominator), then merges the repeats together. Returns crashed: true
  // only when literally nothing was ever recorded, which is the one case
  // that must still mean "the suite never ran", not "every scenario failed".
  function finalizeScenarios(): { scenarios: EvalScenario[]; crashed: boolean; incompleteScenarios: number[] } {
    const rawRecords = loadArtifacts();
    if (rawRecords.length === 0) {
      return { scenarios: [], crashed: true, incompleteScenarios: [] };
    }
    const byRepeat = new Map<number, ScenarioRecord[]>();
    for (const record of rawRecords) {
      const idx = record.repeatIndex ?? 1;
      const arr = byRepeat.get(idx) ?? [];
      arr.push(record);
      byRepeat.set(idx, arr);
    }
    const missing = new Set<number>();
    const perRepeat: EvalScenario[][] = [];
    for (let i = 1; i <= repeats; i += 1) {
      const raw = groupByScenario(byRepeat.get(i) ?? []);
      const { scenarios, missingNumbers } = reconcileExpectedScenarios(raw, expectedScenarios);
      for (const n of missingNumbers) missing.add(n);
      perRepeat.push(scenarios);
    }
    return {
      scenarios: mergeRepeatGroups(perRepeat),
      crashed: false,
      incompleteScenarios: [...missing].sort((a, b) => a - b),
    };
  }

  function worstExitCode(): number | null {
    if (exitCodes.length === 0) return null;
    const nonZero = exitCodes.find((c) => c !== 0);
    return nonZero !== undefined ? nonZero : 0;
  }

  const finalize = () => {
    if (settled) return;
    settled = true;
    clearInterval(poll);
    const finishedAtMs = Date.now();
    run.finishedAt = new Date(finishedAtMs).toISOString();
    run.durationMs = finishedAtMs - startedAtMs;
    run.exitCode = worstExitCode();

    if (cancelRequested) {
      run.status = "cancelled";
      refresh();
    } else if (spawnError) {
      run.status = "failed";
      run.failureReason = `Could not start vitest: ${(spawnError as Error).message}`;
      refresh();
    } else {
      const { scenarios, crashed, incompleteScenarios } = finalizeScenarios();
      if (crashed) {
        // vitest exited without a single scenario artifact from any repeat:
        // a crash before any test ran (bad config, missing env), not a
        // suite result.
        run.status = "failed";
        run.failureReason =
          logTail.length > 0
            ? `vitest exited with code ${run.exitCode ?? "null"} before any scenario recorded a result. Last output: ${logTail.slice(-8).join(" | ")}`
            : `vitest exited with code ${run.exitCode ?? "null"} before any scenario recorded a result.`;
      } else {
        run.scenarios = scenarios;
        run.judgeStates = countJudgeStates(scenarios);
        run.incompleteScenarios = incompleteScenarios;
        run.status = "completed";
      }
    }

    void Promise.all([pricingReady, calibrationReady]).then(() => {
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

  void (async () => {
    for (let i = 1; i <= repeats; i += 1) {
      if (cancelRequested) break;
      await spawnOneRepeat(i);
      if (spawnError || cancelRequested) break;
    }
    finalize();
  })();

  const handle: EvalRunHandle = {
    run,
    logTail,
    expectedScenarioCount,
    cancel() {
      if (settled) return;
      cancelRequested = true;
      pushLogLines(logTail, "cancel requested, stopping vitest");
      if (currentChild) killTree(currentChild, "SIGTERM");
    },
    done,
  };
  current = handle;
  installExitHooks();
  return handle;
}
