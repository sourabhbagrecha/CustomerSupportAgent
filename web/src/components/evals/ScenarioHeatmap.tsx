import { Fragment, useRef, useState, type FocusEvent, type MouseEvent } from "react";
import type { EvalRun, EvalScenario } from "../../types";
import { clampTooltip, formatSeconds, formatTokens, formatUsd, scenarioCostUsd, scenarioDisagrees } from "./evalMath";

// The 19-by-N grid as one block (plan 009). Emphasis is asymmetric on purpose:
// the reader is hunting failures, so a fail is a solid red cell and a pass is a
// pale one, which makes a column of passes recede and a single failure pop.
// Status colour never carries the meaning alone: every cell has a glyph, an
// aria-label, a legend, a hover/focus tooltip, and the same value in the table
// view under the comparison.

interface ScenarioHeatmapProps {
  runs: EvalRun[];
  baselineId: string;
}

type Filter = "all" | "disagree" | "failures";

const GLYPH: Record<EvalScenario["status"], string> = {
  pass: "✓",
  fail: "✕",
  documented_red: "!",
};

interface Tooltip {
  scenarioNumber: number;
  runId: string;
  left: number;
  top: number;
}

export function ScenarioHeatmap({ runs, baselineId }: ScenarioHeatmapProps) {
  // The tooltip is anchored to the panel, not to the scrolling frame: a frame
  // with overflow-x also clips vertically, which cropped the readout above the
  // first row of cells.
  const panelRef = useRef<HTMLElement>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);

  const allNumbers = Array.from(new Set(runs.flatMap((r) => r.scenarios.map((s) => s.number)))).sort((a, b) => a - b);

  function scenarioFor(run: EvalRun, number: number): EvalScenario | null {
    return run.scenarios.find((s) => s.number === number) ?? null;
  }

  function scenarioName(number: number): string {
    for (const run of runs) {
      const found = run.scenarios.find((s) => s.number === number);
      if (found) return found.name;
    }
    return `scenario ${number}`;
  }

  const disagreeNumbers = allNumbers.filter((n) => scenarioDisagrees(runs.map((run) => scenarioFor(run, n)?.status ?? null)));
  const failureNumbers = allNumbers.filter((n) => runs.some((run) => scenarioFor(run, n)?.status === "fail"));
  const visible = filter === "disagree" ? disagreeNumbers : filter === "failures" ? failureNumbers : allNumbers;

  const FILTERS: Array<{ key: Filter; label: string; count: number }> = [
    { key: "all", label: "All scenarios", count: allNumbers.length },
    { key: "disagree", label: "Runs disagree", count: disagreeNumbers.length },
    { key: "failures", label: "Any failure", count: failureNumbers.length },
  ];

  function toggleExpanded(number: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(number)) next.delete(number);
      else next.add(number);
      return next;
    });
  }

  // Coordinates come from the hovered cell's own box against the panel's, so
  // the readout follows the grid when it is scrolled sideways without any
  // scroll arithmetic of its own.
  function showTooltip(event: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>, scenarioNumber: number, runId: string) {
    const panel = panelRef.current;
    if (!panel) return;
    const cell = event.currentTarget.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    setTooltip({
      scenarioNumber,
      runId,
      left: clampTooltip(cell.left - box.left + cell.width / 2, box.width),
      top: cell.top - box.top,
    });
  }

  const tooltipRun = tooltip ? (runs.find((r) => r.runId === tooltip.runId) ?? null) : null;
  const tooltipScenario = tooltip && tooltipRun ? scenarioFor(tooltipRun, tooltip.scenarioNumber) : null;
  const tooltipCost = tooltipScenario && tooltipRun ? scenarioCostUsd(tooltipScenario, tooltipRun.pricing) : null;

  return (
    <section className="panel evals-heatmap-panel" ref={panelRef}>
      <div className="evals-panel-head">
        <h2>Scenario grid</h2>
        <div className="evals-metric-switch" role="group" aria-label="Which scenarios to show">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={f.key === filter ? "evals-metric-switch-active" : undefined}
              aria-pressed={f.key === filter}
              onClick={() => setFilter(f.key)}
            >
              {f.label} ({f.count})
            </button>
          ))}
        </div>
      </div>

      <div className="evals-heatmap-frame">
        <table className="evals-heatmap-table">
          <thead>
            <tr>
              <th scope="col" className="evals-heatmap-corner">
                Scenario
              </th>
              {runs.map((run) => (
                <th key={run.runId} scope="col" className={run.runId === baselineId ? "evals-heatmap-col-baseline" : undefined}>
                  {run.label}
                  {run.runId === baselineId && <span className="evals-heatmap-col-tag">baseline</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((number) => {
              const isExpanded = expanded.has(number);
              const hasNotes = runs.some((run) => {
                const s = scenarioFor(run, number);
                return s !== null && (s.notes.length > 0 || s.judgeNotes.length > 0);
              });
              return (
                <Fragment key={number}>
                  <tr className={isExpanded ? "evals-heatmap-row-open" : undefined}>
                    <th scope="row" className="evals-heatmap-name">
                      <button
                        type="button"
                        className="evals-heatmap-name-button"
                        aria-expanded={isExpanded}
                        title={hasNotes ? "Show the per-run detail and notes for this scenario" : "Show the per-run detail for this scenario"}
                        onClick={() => toggleExpanded(number)}
                      >
                        <span className={`evals-heatmap-caret${isExpanded ? " evals-heatmap-caret-open" : ""}`} aria-hidden="true">
                          ▸
                        </span>
                        <span className="evals-heatmap-number">{number}</span>
                        {scenarioName(number)}
                      </button>
                    </th>
                    {runs.map((run) => {
                      const scenario = scenarioFor(run, number);
                      const status = scenario?.status ?? null;
                      const label = status === null ? "not run" : status.replace(/_/g, " ");
                      return (
                        <td key={run.runId} className="evals-heatmap-cell-wrap">
                          <button
                            type="button"
                            className={`evals-heatmap-cell evals-heatmap-cell-${status ?? "missing"}`}
                            aria-label={`${run.label}, scenario ${number} ${scenarioName(number)}: ${label}`}
                            onMouseEnter={(e) => showTooltip(e, number, run.runId)}
                            onMouseLeave={() => setTooltip(null)}
                            onFocus={(e) => showTooltip(e, number, run.runId)}
                            onBlur={() => setTooltip(null)}
                            onClick={() => toggleExpanded(number)}
                          >
                            <span aria-hidden="true">{status === null ? "–" : GLYPH[status]}</span>
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                  {isExpanded && (
                    <tr className="evals-heatmap-detail-row">
                      <td colSpan={runs.length + 1}>
                        <div className="evals-matrix-notes">
                          {runs.map((run) => {
                            const scenario = scenarioFor(run, number);
                            if (!scenario) return null;
                            const cost = scenarioCostUsd(scenario, run.pricing);
                            return (
                              <div key={run.runId} className="evals-matrix-notes-run">
                                <strong>{run.label}</strong>
                                <div className="eval-run-submeta">
                                  {scenario.status.replace(/_/g, " ")}, {formatSeconds(scenario.latencyMs)},{" "}
                                  {formatTokens(scenario.tokensIn)} / {formatTokens(scenario.tokensOut)} tokens
                                  {cost !== null && <>, {formatUsd(cost)}</>}
                                </div>
                                {(scenario.notes.length > 0 || scenario.judgeNotes.length > 0) && (
                                  <ul className="eval-notes-list">
                                    {scenario.notes.map((note, i) => (
                                      <li key={`note-${i}`}>{note}</li>
                                    ))}
                                    {scenario.judgeNotes.map((note, i) => (
                                      <li key={`judge-${i}`} className="eval-judge-note">
                                        Judge: {note}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>

      </div>

      {tooltip && tooltipRun && (
        <div className="evals-heatmap-tooltip" style={{ left: `${tooltip.left}px`, top: `${tooltip.top}px` }}>
          <div className="evals-chart-tooltip-value">
            {tooltipScenario ? tooltipScenario.status.replace(/_/g, " ") : "not run in this run"}
          </div>
          <div className="evals-chart-tooltip-label">
            {tooltip.scenarioNumber}. {scenarioName(tooltip.scenarioNumber)}, {tooltipRun.label}
          </div>
          {tooltipScenario && (
            <dl className="evals-chart-tooltip-rows">
              <div>
                <dt>Latency</dt>
                <dd>{formatSeconds(tooltipScenario.latencyMs)}</dd>
              </div>
              <div>
                <dt>Tokens</dt>
                <dd>
                  {formatTokens(tooltipScenario.tokensIn)} / {formatTokens(tooltipScenario.tokensOut)}
                </dd>
              </div>
              <div>
                <dt>Cost</dt>
                <dd>{formatUsd(tooltipCost)}</dd>
              </div>
              <div>
                <dt>Judge</dt>
                <dd>{(tooltipScenario.judgeState ?? "not applicable").replace(/_/g, " ")}</dd>
              </div>
            </dl>
          )}
          {tooltipScenario && (tooltipScenario.notes.length > 0 || tooltipScenario.judgeNotes.length > 0) && (
            <div className="evals-chart-tooltip-tag">Click for notes</div>
          )}
        </div>
      )}

      <div className="evals-heatmap-legend">
        <span className="evals-chart-key">
          <span className="evals-heatmap-cell evals-heatmap-cell-pass" aria-hidden="true">
            ✓
          </span>
          pass
        </span>
        <span className="evals-chart-key">
          <span className="evals-heatmap-cell evals-heatmap-cell-fail" aria-hidden="true">
            ✕
          </span>
          fail
        </span>
        <span className="evals-chart-key">
          <span className="evals-heatmap-cell evals-heatmap-cell-documented_red" aria-hidden="true">
            !
          </span>
          documented red
        </span>
        <span className="evals-chart-key">
          <span className="evals-heatmap-cell evals-heatmap-cell-missing" aria-hidden="true">
            –
          </span>
          not run
        </span>
      </div>

      {visible.length === 0 && (
        <p className="audit-empty">
          {filter === "disagree"
            ? "Every selected run reached the same status on every scenario."
            : "No selected run failed a scenario."}
        </p>
      )}
    </section>
  );
}
