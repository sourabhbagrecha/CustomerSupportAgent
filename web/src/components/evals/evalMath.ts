// Pure helpers for the evals workbench: summarizing a run into totals/means,
// formatting seconds/tokens/hashes for display, and computing a delta between
// a run and the baseline (value, direction, and a formatted label). Kept
// dependency-free (no React, no fetch) so RunComparison and RunsTable can
// share one source of truth for numbers that must agree between the summary
// block and the scenario matrix.
import type { EvalJudgeStates, EvalRun, EvalRunJudgeCalibration, EvalRunPricing, EvalScenario } from "../../types";

export interface RunSummary {
  total: number;
  pass: number;
  fail: number;
  documentedRed: number;
  // 0..1; 0 when there are no scenarios rather than NaN, so a fresh/subset
  // run still renders a bar instead of breaking the row.
  passRate: number;
  totalLatencyMs: number | null;
  meanLatencyMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  // Agent-model tokens at the run's recorded OpenRouter list price; null when
  // the run has no pricing or no scenario recorded tokens.
  costUsd: number | null;
  judgeScored: number;
  judgeUnscored: number;
}

// Mirrors server/src/evals/runRecord.ts costUsd/runCostUsd: tokens x rate per
// million for whatever counts are present, never a fabricated 0 when neither
// count was recorded.
export function scenarioCostUsd(scenario: Pick<EvalScenario, "tokensIn" | "tokensOut">, pricing: EvalRunPricing | null): number | null {
  if (!pricing) return null;
  if (scenario.tokensIn === null && scenario.tokensOut === null) return null;
  return ((scenario.tokensIn ?? 0) * pricing.promptUsdPerMillion + (scenario.tokensOut ?? 0) * pricing.completionUsdPerMillion) / 1_000_000;
}

export function runCostUsd(run: Pick<EvalRun, "scenarios" | "pricing">): number | null {
  return sumOrNull(run.scenarios.map((s) => scenarioCostUsd(s, run.pricing)));
}

function sumOrNull(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length > 0 ? present.reduce((a, b) => a + b, 0) : null;
}

// A retired scenario (its file deleted from evals/scenarios/) stays recorded
// in every run archived before the deletion. The workbench reads as "how the
// current suite scores", so those rows are dropped from the runs before any
// view sees them: filtering once, here, is what keeps the scorecard totals,
// the chart, and the scenario grid quoting the same denominator. The archived
// records themselves are never rewritten, so the history stays intact on disk.
//
// `liveNumbers` is null when the scenario catalogue could not be loaded; then
// nothing is filtered, since showing a stale row beats blanking the workbench.
export function hideRetiredScenarios(run: EvalRun, liveNumbers: ReadonlySet<number> | null): EvalRun {
  if (!liveNumbers) return run;
  const scenarios = run.scenarios.filter((s) => liveNumbers.has(s.number));
  if (scenarios.length === run.scenarios.length) return run;
  return {
    ...run,
    scenarios,
    // Recounted rather than carried over: judgeStates on the record describes
    // the scenarios as they ran, and a retired scenario that had been judged
    // would otherwise leave the scorecard's judge counts above the number of
    // rows the grid can show.
    judgeStates: countJudgeStates(scenarios),
    scenarioFilter: run.scenarioFilter === null ? null : run.scenarioFilter.filter((n) => liveNumbers.has(n)),
    incompleteScenarios: run.incompleteScenarios.filter((n) => liveNumbers.has(n)),
  };
}

// Mirrors server/src/evals/runRecord.ts countJudgeStates.
function countJudgeStates(scenarios: EvalScenario[]): EvalJudgeStates {
  return {
    scored: scenarios.filter((s) => s.judgeState === "scored").length,
    unscored: scenarios.filter((s) => s.judgeState === "unscored").length,
    notApplicable: scenarios.filter((s) => s.judgeState === null).length,
  };
}

export function summarizeRun(run: EvalRun): RunSummary {
  const scenarios = run.scenarios;
  const total = scenarios.length;
  const pass = scenarios.filter((s) => s.status === "pass").length;
  const fail = scenarios.filter((s) => s.status === "fail").length;
  const documentedRed = scenarios.filter((s) => s.status === "documented_red").length;
  const latencies = scenarios.map((s) => s.latencyMs).filter((v): v is number => v !== null);
  return {
    total,
    pass,
    fail,
    documentedRed,
    passRate: total > 0 ? pass / total : 0,
    totalLatencyMs: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) : null,
    meanLatencyMs: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
    tokensIn: sumOrNull(scenarios.map((s) => s.tokensIn)),
    tokensOut: sumOrNull(scenarios.map((s) => s.tokensOut)),
    costUsd: runCostUsd(run),
    judgeScored: run.judgeStates.scored,
    judgeUnscored: run.judgeStates.unscored,
  };
}

// "https://openrouter.ai/api/v1" -> "openrouter.ai", for display only. Mirrors
// server/src/agent/providerConfig.ts providerHost, kept small enough that a
// second copy here is simpler than importing server code into the web build.
export function providerHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export function formatSeconds(ms: number | null): string {
  if (ms === null) return "n/a";
  return `${(ms / 1000).toFixed(1)} s`;
}

// Thousands-compact for token counts: "186.9k" past 1000, plain digits below.
export function formatTokens(n: number | null): string {
  if (n === null) return "n/a";
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// Four decimals: a whole 19-scenario run on a small model is cents, and a
// per-scenario cell is fractions of a cent, so two decimals would read "$0.00"
// almost everywhere.
export function formatUsd(amount: number | null): string {
  if (amount === null) return "n/a";
  return `$${amount.toFixed(4)}`;
}

// A per-million rate the way the OpenRouter page prints it: "$0.75", "$4.50",
// and the odd sub-cent rate ("$0.028") left as written rather than rounded
// to "$0.03".
export function formatRate(usdPerMillion: number): string {
  if (usdPerMillion > 0 && usdPerMillion < 0.01) return `$${usdPerMillion}`;
  return `$${usdPerMillion.toFixed(2)}`;
}

// "$0.75 / $4.50 per 1M" for the rate sub-line under a cost cell or column.
export function formatRates(pricing: EvalRunPricing): string {
  return `${formatRate(pricing.promptUsdPerMillion)} / ${formatRate(pricing.completionUsdPerMillion)} per 1M`;
}

// Tooltip for a cost cell: which listing the rate came from and what it does
// and does not include, so the number is never read as a bill.
export function describePricing(pricing: EvalRunPricing | null): string {
  if (!pricing) return "No OpenRouter price recorded for this run's primary model; cost is not available.";
  return (
    `${pricing.openrouterModelId}: ${formatRate(pricing.promptUsdPerMillion)} in / ${formatRate(pricing.completionUsdPerMillion)} out per 1M tokens, ` +
    `OpenRouter list price as of ${pricing.fetchedAt.slice(0, 10)}. Agent tokens only, judge calls not counted, no cache discount.`
  );
}

// sha256 hex strings and full commit SHAs are only worth eyeballing as a
// prefix; the caller puts the full value in a title attribute.
export function shortHash(hash: string | null): string {
  return hash ? hash.slice(0, 10) : "n/a";
}

// Prompt version identity (plan 012). The short form matches the snapshot
// filenames under evals/prompts/ (first 12 chars of promptSha256); the hue
// is derived from the hash so every run of the same prompt version wears the
// same color and a prompt change is visible at a glance across the archive.
export const PROMPT_VERSION_CHARS = 12;

export function promptVersionShort(promptSha256: string): string {
  return promptSha256.length > 0 ? promptSha256.slice(0, PROMPT_VERSION_CHARS) : "n/a";
}

export function promptVersionHue(promptSha256: string): number | null {
  if (promptSha256.length < 6) return null;
  const parsed = Number.parseInt(promptSha256.slice(0, 6), 16);
  return Number.isNaN(parsed) ? null : parsed % 360;
}

// Judge calibration one-liner (task P1-6): rounded agreement percentage
// against the hand-labeled golden set, or "not computed" when this run
// never ran a full suite (calibration is skipped for subset runs) or
// predates the feature. The longer disclaimer (drafted labels, pending
// human review) lives in the title attribute, not the visible text, so the
// table row stays short.
export function describeCalibration(cal: EvalRunJudgeCalibration | null): string {
  if (!cal) return "calibration: n/a";
  return `calibration: ${cal.agreeing}/${cal.total} (${Math.round(cal.agreementPct)}%)`;
}

export function calibrationTitle(cal: EvalRunJudgeCalibration | null): string | undefined {
  if (!cal) return undefined;
  return (
    `${cal.agreeing}/${cal.total} agreement with evals/goldenSet.ts (${cal.goldenSetVersion}). ` +
    `Golden-set labels are drafted/ASSUMED, pending human review, not ground truth. ` +
    `Computed ${cal.computedAt.slice(0, 10)} against judge ${cal.judgeModel ?? "unset"}.`
  );
}

export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

// "0:07", "1:32", "12:05" for the progress strip's elapsed-time readout. Whole
// seconds only: the strip re-renders on each 2s poll tick, so fractional
// seconds would just look like jitter rather than a live clock.
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// Scaled to the max value across the compared runs (never a fixed constant),
// so the bar is meaningful whether the slowest run takes 4 seconds or 40.
// Floored at 2% so a non-zero value never renders as an invisible sliver.
export function barPercent(value: number | null, max: number): number {
  if (value === null || max <= 0) return 0;
  return Math.max(2, Math.round((value / max) * 100));
}

export function maxAcross(values: Array<number | null>): number {
  const present = values.filter((v): v is number => v !== null);
  return present.length > 0 ? Math.max(...present) : 0;
}

export type DeltaDirection = "better" | "worse" | "neutral";
export type DeltaKind = "seconds_ms" | "tokens" | "fraction_pts" | "count" | "usd";

export interface Delta {
  raw: number;
  direction: DeltaDirection;
  label: string;
}

function formatDeltaMagnitude(abs: number, kind: DeltaKind): string {
  switch (kind) {
    case "seconds_ms":
      return `${(abs / 1000).toFixed(1)} s`;
    case "tokens":
      return formatTokens(abs);
    case "fraction_pts":
      return `${(abs * 100).toFixed(1)} pts`;
    case "count":
      return String(abs);
    case "usd":
      return formatUsd(abs);
  }
}

// value/baseline in the row's native unit (ms, tokens, a 0..1 fraction, or a
// plain count); lowerIsBetter flips which sign renders green vs red (lower
// latency and tokens are better, higher pass rate is better). Pass null for
// lowerIsBetter when the metric has no clear direction (documented-red count
// is a description, not a regression) so the delta still shows a signed
// magnitude but never claims a color it can't justify. Returns null when
// either side is unavailable (a subset run missing a scenario, a metric with
// no data) so the caller can render "n/a" instead of a bogus "+0".
export function computeDelta(
  value: number | null,
  baseline: number | null,
  kind: DeltaKind,
  lowerIsBetter: boolean | null,
): Delta | null {
  if (value === null || baseline === null) return null;
  const raw = value - baseline;
  const direction: DeltaDirection =
    raw === 0 || lowerIsBetter === null ? "neutral" : (raw < 0) === lowerIsBetter ? "better" : "worse";
  const sign = raw > 0 ? "+" : raw < 0 ? "-" : "±";
  return { raw, direction, label: `${sign}${formatDeltaMagnitude(Math.abs(raw), kind)}` };
}

// --- Plan 009: what the comparison chart and the heatmap filter need ---

// Which metric sits on the chart's x axis. Cost is the default because it is
// the axis the model choice usually turns on, but a run with no pricing has no
// cost, so latency and tokens exist as fallbacks that every run can be placed
// on.
export type ChartMetric = "cost" | "latency" | "tokens";

export interface ChartMetricDef {
  key: ChartMetric;
  label: string;
  axisLabel: string;
  // null when this run has no value for the metric, which means it cannot be
  // placed on the axis and is named as excluded under the chart.
  getValue: (summary: RunSummary) => number | null;
  format: (value: number) => string;
  // Axis ticks are read as a scale, not as a measurement: four decimals of a
  // dollar on every tick is noise, so ticks get their own coarser format.
  formatTick: (value: number) => string;
}

export const CHART_METRICS: ChartMetricDef[] = [
  {
    key: "cost",
    label: "Cost",
    axisLabel: "Cost for the run (USD)",
    getValue: (s) => s.costUsd,
    format: (v) => formatUsd(v),
    formatTick: (v) => `$${v.toFixed(2)}`,
  },
  {
    key: "latency",
    label: "Latency",
    axisLabel: "Mean latency per scenario",
    getValue: (s) => s.meanLatencyMs,
    format: (v) => formatSeconds(v),
    formatTick: (v) => `${Math.round(v / 1000)} s`,
  },
  {
    key: "tokens",
    label: "Tokens",
    axisLabel: "Total tokens (in + out)",
    getValue: (s) => (s.tokensIn === null && s.tokensOut === null ? null : (s.tokensIn ?? 0) + (s.tokensOut ?? 0)),
    format: (v) => formatTokens(v),
    formatTick: (v) => formatTokens(v),
  },
];

export interface ParetoPoint {
  id: string;
  // Lower is better (cost, latency, tokens).
  x: number;
  // Higher is better (pass rate).
  y: number;
}

// The non-dominated set: a point is on the frontier unless some other point is
// at least as good on both axes and strictly better on one. Two runs on the
// exact same point never dominate each other, so both stay on the frontier
// (neither is strictly better anywhere); a run that is tied on quality but
// costs more is dominated and drops off. Returned as a Set of ids so the
// caller can ask about one point without a second scan.
export function paretoFrontier(points: ParetoPoint[]): Set<string> {
  const frontier = new Set<string>();
  for (const candidate of points) {
    const dominated = points.some(
      (other) =>
        other.id !== candidate.id &&
        other.x <= candidate.x &&
        other.y >= candidate.y &&
        (other.x < candidate.x || other.y > candidate.y),
    );
    if (!dominated) frontier.add(candidate.id);
  }
  return frontier;
}

// A scenario "disagrees" when the selected runs do not all end in the same
// state on it. A run that never ran the scenario (a subset run) counts as its
// own state rather than being ignored, because "this run has no answer here"
// is exactly the kind of gap the disagreement filter should keep visible.
// Fewer than two runs can never disagree.
export function scenarioDisagrees(statuses: Array<EvalScenario["status"] | null>): boolean {
  if (statuses.length < 2) return false;
  const first = statuses[0];
  return statuses.some((s) => s !== first);
}

// Both hover readouts are centred on their mark and capped at 260px wide, so a
// mark near either edge of the panel would push half the tooltip outside it.
// Half a tooltip plus a little air is kept inside; a panel too narrow to hold
// one centres it instead.
const TOOLTIP_HALF = 136;

export function clampTooltip(left: number, panelWidth: number): number {
  if (panelWidth < TOOLTIP_HALF * 2) return panelWidth / 2;
  return Math.min(panelWidth - TOOLTIP_HALF, Math.max(TOOLTIP_HALF, left));
}
