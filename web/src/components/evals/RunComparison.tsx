import { Fragment, useState } from "react";
import type { EvalRun, EvalScenario } from "../../types";
import { ComparisonChart } from "./ComparisonChart";
import { RunScorecards } from "./RunScorecards";
import { ScenarioHeatmap } from "./ScenarioHeatmap";
import {
  barPercent,
  computeDelta,
  describePricing,
  formatPercent,
  formatRates,
  formatSeconds,
  formatTokens,
  formatUsd,
  maxAcross,
  providerHost,
  scenarioCostUsd,
  summarizeRun,
  type ChartMetric,
  type Delta,
  type DeltaKind,
  type RunSummary,
} from "./evalMath";

interface RunComparisonProps {
  // Newest-first, the same order as the runs table (plan 007: "selection
  // order = order of the runs list").
  selectedRuns: EvalRun[];
  baselineId: string | null;
  onSetBaseline: (runId: string) => void;
}

// Plan 009 reorders this view: scorecards, then the cost/quality chart, then
// the scenario grid are the read, and the two tables that used to be the whole
// comparison are kept underneath, collapsed, as the table view every number
// stays reachable through without hovering.

// One row of the metric table: how to pull a comparable number out of a
// RunSummary, how to render it, which delta unit applies, and which
// direction counts as "better" (null = no claimed direction, e.g.
// documented-red is a description of the suite, not a regression).
interface SummaryRowDef {
  key: string;
  label: string;
  getValue: (s: RunSummary) => number | null;
  format: (s: RunSummary) => string;
  deltaKind: DeltaKind;
  lowerIsBetter: boolean | null;
}

const SUMMARY_ROWS: SummaryRowDef[] = [
  {
    key: "pass_rate",
    label: "Pass rate",
    getValue: (s) => s.passRate,
    format: (s) => `${s.pass}/${s.total} (${formatPercent(s.passRate)})`,
    deltaKind: "fraction_pts",
    lowerIsBetter: false,
  },
  {
    key: "failing",
    label: "Failing",
    getValue: (s) => s.fail,
    format: (s) => String(s.fail),
    deltaKind: "count",
    lowerIsBetter: true,
  },
  {
    key: "documented_red",
    label: "Documented red",
    getValue: (s) => s.documentedRed,
    format: (s) => String(s.documentedRed),
    deltaKind: "count",
    lowerIsBetter: null,
  },
  {
    key: "total_latency",
    label: "Total latency",
    getValue: (s) => s.totalLatencyMs,
    format: (s) => formatSeconds(s.totalLatencyMs),
    deltaKind: "seconds_ms",
    lowerIsBetter: true,
  },
  {
    key: "mean_latency",
    label: "Mean latency / scenario",
    getValue: (s) => s.meanLatencyMs,
    format: (s) => formatSeconds(s.meanLatencyMs),
    deltaKind: "seconds_ms",
    lowerIsBetter: true,
  },
  {
    key: "tokens_in",
    label: "Tokens in",
    getValue: (s) => s.tokensIn,
    format: (s) => formatTokens(s.tokensIn),
    deltaKind: "tokens",
    lowerIsBetter: true,
  },
  {
    key: "tokens_out",
    label: "Tokens out",
    getValue: (s) => s.tokensOut,
    format: (s) => formatTokens(s.tokensOut),
    deltaKind: "tokens",
    lowerIsBetter: true,
  },
  {
    key: "cost",
    label: "Cost (USD)",
    getValue: (s) => s.costUsd,
    format: (s) => formatUsd(s.costUsd),
    deltaKind: "usd",
    lowerIsBetter: true,
  },
  {
    key: "judge",
    label: "Judge scored / unscored",
    getValue: (s) => s.judgeScored,
    format: (s) => `${s.judgeScored} scored / ${s.judgeUnscored} unscored`,
    deltaKind: "count",
    lowerIsBetter: false,
  },
];

// A delta that cannot be computed renders as nothing at all: a column of
// "n/a" chips is noise, and the value cell above already says "n/a".
function DeltaChip({ delta }: { delta: Delta | null }) {
  if (!delta) return null;
  return <span className={`eval-delta eval-delta-${delta.direction}`}>{delta.label}</span>;
}

const NOTE_VALUE_MAX_CHARS = 80;

function truncateNoteValue(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > NOTE_VALUE_MAX_CHARS ? `${trimmed.slice(0, NOTE_VALUE_MAX_CHARS - 1)}…` : trimmed;
}

// Vitest quotes string values in single quotes and escapes any apostrophe
// inside them as \'; unwrap that back to plain text so the UI shows "I'll
// process..." rather than "'I\'ll process...'". Bare tokens (undefined,
// null, true, an object literal dump) pass through unchanged.
function unwrapNoteValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/\\'/g, "'");
  }
  return trimmed;
}

interface ParsedAssertionNote {
  assertion: string | null;
  expected: string;
  actual: string;
}

// Failure notes (from a failing scenario assertion) and judge notes (from a
// failing judge rubric check) both end up holding a raw Vitest message like
// "[approve] expected 'I can see order ord_005 for the Air P…' to be null".
// That reads as a stack-trace dump: "expected" here names the value the
// code actually received, not what the test wanted, and the // Object.is
// equality suffix is implementation noise. Pull the two sides apart and
// re-present them as plain "expected:"/"actual:" lines under whatever
// prefix names the assertion (an "[approve]"/"[reject]" branch tag, or a
// custom assertion message). Anything that is not a recognizable
// "expected X to be Y" tail (a plain prose note) is left as-is.
const ASSERTION_TAIL_RE = /expected\s+(.+?)\s+to\s+be\s+(.+?)(?:\s*\/\/.*)?$/;

function parseAssertionNote(note: string): ParsedAssertionNote | null {
  const match = ASSERTION_TAIL_RE.exec(note);
  if (!match) return null;
  const receivedRaw = match[1] ?? "";
  const expectedRaw = match[2] ?? "";
  const prefix = note.slice(0, match.index).trim().replace(/:\s*$/, "");
  const bracketMatch = /^\[([^\]]+)\]$/.exec(prefix);
  const assertion = bracketMatch ? bracketMatch[1] : prefix.length > 0 ? prefix : null;
  return {
    assertion: assertion ? truncateNoteValue(assertion) : null,
    expected: truncateNoteValue(unwrapNoteValue(expectedRaw)),
    actual: truncateNoteValue(unwrapNoteValue(receivedRaw)),
  };
}

// Renders one note (scenario failure note or judge note) as plain words
// instead of the raw assertion string, falling back to the raw text for
// notes that are not an "expected X to be Y" assertion (plain prose).
function FailureNote({ note, source }: { note: string; source: "judge" | null }) {
  const parsed = parseAssertionNote(note);
  const isJudge = source === "judge";
  if (!parsed) {
    return <li className={isJudge ? "eval-judge-note" : undefined}>{isJudge ? `Judge: ${note}` : note}</li>;
  }
  const heading = isJudge ? `Judge${parsed.assertion ? `: ${parsed.assertion}` : ""}` : parsed.assertion;
  return (
    <li className={isJudge ? "eval-judge-note" : undefined}>
      {heading && <div>{heading}</div>}
      <div>expected: {parsed.expected}</div>
      <div>actual: {parsed.actual}</div>
    </li>
  );
}

function RunColumnHeader({
  run,
  isBaseline,
  onSetBaseline,
}: {
  run: EvalRun;
  isBaseline: boolean;
  onSetBaseline: () => void;
}) {
  return (
    <div className="evals-column-header">
      <div className="evals-column-header-label">{run.label}</div>
      <div className="evals-column-header-meta">{run.provider.primaryModel ?? "unset"}</div>
      <div className="evals-column-header-meta evals-column-header-host">{providerHost(run.provider.baseUrl)}</div>
      <div className="evals-column-header-meta" title={describePricing(run.pricing)}>
        {run.pricing ? formatRates(run.pricing) : "unpriced"}
      </div>
      {isBaseline ? (
        <span className="evals-baseline-tag">baseline</span>
      ) : (
        <button type="button" className="evals-baseline-button" onClick={onSetBaseline}>
          Set as baseline
        </button>
      )}
    </div>
  );
}

// Left-border marker for a matrix cell whose status differs from the
// baseline's: red when the baseline passed and this run did not (a
// regression), green the other way round (an improvement), amber for any
// other kind of change (e.g. fail vs documented_red, neither a pass).
function statusMarkerClass(current: EvalScenario | null, baseline: EvalScenario | null): string {
  if (!current || !baseline || current.status === baseline.status) return "";
  if (baseline.status === "pass" && current.status !== "pass") return "eval-matrix-regressed";
  if (baseline.status !== "pass" && current.status === "pass") return "eval-matrix-improved";
  return "eval-matrix-differs";
}

export function RunComparison({ selectedRuns, baselineId, onSetBaseline }: RunComparisonProps) {
  const [chartMetric, setChartMetric] = useState<ChartMetric>("cost");

  const first = selectedRuns[0];
  if (!first) return null;
  const baseline = selectedRuns.find((r) => r.runId === baselineId) ?? first;

  const rows = selectedRuns.map((run) => ({ run, summary: summarizeRun(run) }));
  const baselineRow = rows.find((r) => r.run.runId === baseline.runId) ?? rows[0];
  if (!baselineRow) return null;

  const allScenarioNumbers = Array.from(new Set(selectedRuns.flatMap((r) => r.scenarios.map((s) => s.number)))).sort(
    (a, b) => a - b,
  );

  function scenarioName(number: number): string {
    for (const run of selectedRuns) {
      const found = run.scenarios.find((s) => s.number === number);
      if (found) return found.name;
    }
    return `scenario ${number}`;
  }

  function scenarioFor(run: EvalRun, number: number): EvalScenario | null {
    return run.scenarios.find((s) => s.number === number) ?? null;
  }

  function hasNotes(number: number): boolean {
    return selectedRuns.some((run) => {
      const s = scenarioFor(run, number);
      return s !== null && (s.notes.length > 0 || s.judgeNotes.length > 0);
    });
  }

  return (
    <>
      <RunScorecards rows={rows} baselineId={baseline.runId} onSetBaseline={onSetBaseline} />
      <ComparisonChart rows={rows} baselineId={baseline.runId} metric={chartMetric} onMetricChange={setChartMetric} />
      <ScenarioHeatmap runs={selectedRuns} baselineId={baseline.runId} />

      <section className="panel evals-comparison-panel">
        <div className="evals-panel-head">
          <h2>Table view</h2>
          <span className="evals-panel-hint">Every number above, without hovering.</span>
        </div>

        <details className="evals-table-details">
          <summary>All metrics, with deltas against the baseline</summary>
          <div className="ledger-table-wrap">
            <table className="evals-summary-table">
              <thead>
                <tr>
                  <th className="evals-summary-row-label" />
                  {rows.map(({ run }) => (
                    <th key={run.runId}>
                      <RunColumnHeader
                        run={run}
                        isBaseline={run.runId === baseline.runId}
                        onSetBaseline={() => onSetBaseline(run.runId)}
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {SUMMARY_ROWS.map((rowDef) => {
                  const values = rows.map(({ summary }) => rowDef.getValue(summary));
                  const max = maxAcross(values);
                  // A bar is a comparison, so it is only drawn when there is
                  // something to compare: two or more runs with a value, and a
                  // non-zero maximum to scale against.
                  const comparable = values.filter((v) => v !== null).length >= 2 && max > 0;
                  const baselineValue = rowDef.getValue(baselineRow.summary);
                  return (
                    <tr key={rowDef.key}>
                      <th scope="row" className="evals-summary-row-label">
                        {rowDef.label}
                      </th>
                      {rows.map(({ run, summary }) => {
                        const value = rowDef.getValue(summary);
                        const isBaselineCol = run.runId === baseline.runId;
                        const delta = isBaselineCol
                          ? null
                          : computeDelta(value, baselineValue, rowDef.deltaKind, rowDef.lowerIsBetter);
                        return (
                          <td key={run.runId} className="evals-summary-cell">
                            <div className="evals-summary-value">{rowDef.format(summary)}</div>
                            {comparable && (
                              <div className="eval-bar-track">
                                <div className="eval-bar-fill" style={{ width: `${barPercent(value, max)}%` }} />
                              </div>
                            )}
                            {/* The baseline column is already tagged once, in the
                                header; repeating it on every row would just be
                                noise, so a baseline cell shows the bar alone. */}
                            {!isBaselineCol && <DeltaChip delta={delta} />}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="evals-matrix-caption">
            Deltas are against the baseline column. Lower latency, tokens, and cost are better. Cost is the agent model's tokens at
            the OpenRouter list price recorded when the run started (in / out per 1M tokens, shown under each column); judge calls
            are not counted and cache discounts are ignored, so it is an upper bound on the agent's spend.
          </p>
        </details>

        <details className="evals-table-details">
          <summary>Every scenario, run by run</summary>
          <div className="ledger-table-wrap">
            <table className="ledger-table evals-matrix-table">
              <thead>
                <tr>
                  <th>#, scenario</th>
                  {rows.map(({ run }) => (
                    <th key={run.runId}>
                      <RunColumnHeader
                        run={run}
                        isBaseline={run.runId === baseline.runId}
                        onSetBaseline={() => onSetBaseline(run.runId)}
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {allScenarioNumbers.map((number) => {
                  const baselineScenario = scenarioFor(baseline, number);
                  return (
                    <Fragment key={number}>
                      <tr>
                        <td className="evals-matrix-name">
                          {number}. {scenarioName(number)}
                        </td>
                        {rows.map(({ run }) => {
                          const scenario = scenarioFor(run, number);
                          const isBaselineCol = run.runId === baseline.runId;
                          const markerClass = isBaselineCol ? "" : statusMarkerClass(scenario, baselineScenario);
                          const latencyDelta = !isBaselineCol
                            ? computeDelta(scenario?.latencyMs ?? null, baselineScenario?.latencyMs ?? null, "seconds_ms", true)
                            : null;
                          const tokensDelta = !isBaselineCol
                            ? computeDelta(scenario?.tokensIn ?? null, baselineScenario?.tokensIn ?? null, "tokens", true)
                            : null;
                          const cost = scenario ? scenarioCostUsd(scenario, run.pricing) : null;
                          const costDelta = !isBaselineCol
                            ? computeDelta(
                                cost,
                                baselineScenario ? scenarioCostUsd(baselineScenario, baseline.pricing) : null,
                                "usd",
                                true,
                              )
                            : null;
                          return (
                            <td key={run.runId} className={`evals-matrix-cell ${markerClass}`}>
                              {!scenario ? (
                                <span className="eval-status-badge eval-status-badge-missing">missing</span>
                              ) : (
                                <>
                                  <span className={`eval-status-badge eval-status-badge-${scenario.status}`}>
                                    {scenario.status.replace(/_/g, " ")}
                                  </span>
                                  <div className="eval-run-submeta">
                                    {formatSeconds(scenario.latencyMs)} · {formatTokens(scenario.tokensIn)} /{" "}
                                    {formatTokens(scenario.tokensOut)}
                                    {cost !== null && <> · {formatUsd(cost)}</>}
                                  </div>
                                  {(latencyDelta || tokensDelta || costDelta) && (
                                    <div className="evals-matrix-delta">
                                      {latencyDelta && <DeltaChip delta={latencyDelta} />}
                                      {tokensDelta && <DeltaChip delta={tokensDelta} />}
                                      {costDelta && <DeltaChip delta={costDelta} />}
                                    </div>
                                  )}
                                </>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                      {hasNotes(number) && (
                        <tr className="ledger-detail-row">
                          <td colSpan={rows.length + 1}>
                            <details>
                              <summary>Notes</summary>
                              <div className="evals-matrix-notes">
                                {rows.map(({ run }) => {
                                  const scenario = scenarioFor(run, number);
                                  if (!scenario || (scenario.notes.length === 0 && scenario.judgeNotes.length === 0)) return null;
                                  return (
                                    <div key={run.runId} className="evals-matrix-notes-run">
                                      <strong>{run.label}</strong>
                                      <ul className="eval-notes-list">
                                        {scenario.notes.map((note, i) => (
                                          <FailureNote key={`note-${i}`} note={note} source={null} />
                                        ))}
                                        {scenario.judgeNotes.map((note, i) => (
                                          <FailureNote key={`judge-${i}`} note={note} source="judge" />
                                        ))}
                                      </ul>
                                    </div>
                                  );
                                })}
                              </div>
                            </details>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      </section>
    </>
  );
}
