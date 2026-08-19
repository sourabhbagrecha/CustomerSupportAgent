import type { EvalRun } from "../../types";
import {
  computeDelta,
  describePricing,
  formatPercent,
  formatRates,
  formatSeconds,
  formatTokens,
  formatUsd,
  paretoFrontier,
  providerHost,
  type Delta,
  type ParetoPoint,
  type RunSummary,
} from "./evalMath";

// One card per selected run (plan 009): the headline read of the comparison,
// where the nine-row metric table used to be. Pass rate is the hero figure
// because it is the number that decides whether a model is usable at all;
// cost, latency, and tokens sit under it as the trade-offs, each with a delta
// against the baseline only when both sides actually have a value.

interface RunScorecardsProps {
  rows: Array<{ run: EvalRun; summary: RunSummary }>;
  baselineId: string;
  onSetBaseline: (runId: string) => void;
}

interface StatRow {
  label: string;
  value: string;
  delta: Delta | null;
  title?: string;
}

function DeltaChip({ delta }: { delta: Delta | null }) {
  if (!delta) return null;
  return <span className={`eval-delta eval-delta-${delta.direction}`}>{delta.label}</span>;
}

// "Best value" is the cheapest run among those tied at the highest pass rate:
// the one a reader would actually pick. It only exists when at least one
// selected run has a recorded cost, and a run that covers fewer scenarios than
// the widest one is never tagged, because its pass rate is not over the same
// suite and 16/16 must not out-rank 19/19.
function bestValueRunId(rows: Array<{ run: EvalRun; summary: RunSummary }>, maxTotal: number): string | null {
  const priced = rows.filter((row) => row.summary.costUsd !== null && row.summary.total === maxTotal);
  if (priced.length === 0) return null;
  const bestRate = Math.max(...priced.map((row) => row.summary.passRate));
  const best = priced
    .filter((row) => row.summary.passRate === bestRate)
    .sort((a, b) => (a.summary.costUsd ?? 0) - (b.summary.costUsd ?? 0))[0];
  return best?.run.runId ?? null;
}

export function RunScorecards({ rows, baselineId, onSetBaseline }: RunScorecardsProps) {
  const baselineRow = rows.find((row) => row.run.runId === baselineId) ?? rows[0];
  if (!baselineRow) return null;

  // The frontier tag uses cost, the axis the model choice usually turns on;
  // runs with no price cannot be on or off it, so they carry no tag.
  const frontier = paretoFrontier(
    rows
      .filter((row) => row.summary.costUsd !== null)
      .map<ParetoPoint>((row) => ({ id: row.run.runId, x: row.summary.costUsd ?? 0, y: row.summary.passRate })),
  );
  const maxTotal = Math.max(...rows.map((row) => row.summary.total), 0);
  const bestValue = bestValueRunId(rows, maxTotal);

  return (
    <section className="panel evals-scorecards-panel">
      <div className="evals-panel-head">
        <h2>Selected runs</h2>
        <span className="evals-panel-hint">Deltas are against the baseline card.</span>
      </div>
      <div className="evals-scorecards">
        {rows.map(({ run, summary }) => {
          const isBaseline = run.runId === baselineId;
          const totalTokens = summary.tokensIn === null && summary.tokensOut === null ? null : (summary.tokensIn ?? 0) + (summary.tokensOut ?? 0);
          const baselineTokens =
            baselineRow.summary.tokensIn === null && baselineRow.summary.tokensOut === null
              ? null
              : (baselineRow.summary.tokensIn ?? 0) + (baselineRow.summary.tokensOut ?? 0);
          const stats: StatRow[] = [
            {
              label: "Cost",
              value: formatUsd(summary.costUsd),
              delta: isBaseline ? null : computeDelta(summary.costUsd, baselineRow.summary.costUsd, "usd", true),
              title: describePricing(run.pricing),
            },
            {
              label: "Mean latency",
              value: formatSeconds(summary.meanLatencyMs),
              delta: isBaseline ? null : computeDelta(summary.meanLatencyMs, baselineRow.summary.meanLatencyMs, "seconds_ms", true),
            },
            {
              label: "Tokens",
              value: formatTokens(totalTokens),
              delta: isBaseline ? null : computeDelta(totalTokens, baselineTokens, "tokens", true),
            },
          ];
          const passShare = summary.total > 0 ? summary.pass / summary.total : 0;
          const redShare = summary.total > 0 ? summary.documentedRed / summary.total : 0;
          const failShare = summary.total > 0 ? summary.fail / summary.total : 0;
          return (
            <article key={run.runId} className={`evals-scorecard${isBaseline ? " evals-scorecard-baseline" : ""}`}>
              <header className="evals-scorecard-head">
                <div className="evals-scorecard-title">{run.label}</div>
                {isBaseline ? (
                  <span className="evals-scorecard-tag evals-scorecard-tag-baseline">baseline</span>
                ) : run.runId === bestValue ? (
                  <span className="evals-scorecard-tag evals-scorecard-tag-best">best value</span>
                ) : frontier.has(run.runId) ? (
                  <span className="evals-scorecard-tag">on frontier</span>
                ) : null}
              </header>
              <div className="evals-scorecard-model">{run.provider.primaryModel ?? "unset"}</div>
              <div className="evals-scorecard-meta">
                {providerHost(run.provider.baseUrl)}
                {run.pricing ? `, ${formatRates(run.pricing)}` : ", unpriced"}
              </div>

              <div className="evals-scorecard-hero">{formatPercent(summary.passRate)}</div>
              <div className="evals-scorecard-hero-sub">
                {summary.pass}/{summary.total} scenarios passing
                {!isBaseline && (
                  <DeltaChip delta={computeDelta(summary.passRate, baselineRow.summary.passRate, "fraction_pts", false)} />
                )}
              </div>
              {summary.total < maxTotal && (
                <div className="evals-scorecard-partial">
                  Covers {summary.total} of {maxTotal} scenarios, so this rate is not over the same suite
                </div>
              )}
              {/* A meter, not a comparison bar: it splits this run's own
                  scenarios into pass, documented red, and fail, with a surface
                  gap between segments rather than a border. */}
              <div
                className="evals-scorecard-meter"
                role="img"
                aria-label={`${summary.pass} passing, ${summary.documentedRed} documented red, ${summary.fail} failing`}
              >
                <span className="evals-meter-pass" style={{ width: `${passShare * 100}%` }} />
                <span className="evals-meter-red" style={{ width: `${redShare * 100}%` }} />
                <span className="evals-meter-fail" style={{ width: `${failShare * 100}%` }} />
              </div>

              <dl className="evals-scorecard-stats">
                {stats.map((stat) => (
                  <div key={stat.label} title={stat.title}>
                    <dt>{stat.label}</dt>
                    <dd>
                      <span className="evals-scorecard-stat-value">{stat.value}</span>
                      <DeltaChip delta={stat.delta} />
                    </dd>
                  </div>
                ))}
              </dl>

              {!isBaseline && (
                <button type="button" className="evals-baseline-button" onClick={() => onSetBaseline(run.runId)}>
                  Set as baseline
                </button>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
