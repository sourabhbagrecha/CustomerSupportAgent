import { formatTime } from "../../format";
import type { EvalRun } from "../../types";
import { describePricing, formatRates, formatSeconds, formatTokens, formatUsd, providerHost, shortHash, summarizeRun } from "./evalMath";

interface RunsTableProps {
  runs: EvalRun[];
  loading: boolean;
  error: string | null;
  selectedIds: Set<string>;
  onToggleSelect: (runId: string) => void;
  onRefresh: () => void;
  // Confirmation lives here (next to the button the operator clicked); the
  // actual delete + archive refetch + selection cleanup lives in EvalsPanel,
  // which owns that state.
  onDelete: (runId: string) => void;
}

function statusLabel(status: EvalRun["status"]): string {
  return status.replace(/_/g, " ");
}

function passCountClass(pass: number, fail: number, total: number): string {
  if (total === 0) return "";
  if (pass === total) return "eval-run-passcount-good";
  if (fail > 0) return "eval-run-passcount-bad";
  return "eval-run-passcount-mixed";
}

export function RunsTable({ runs, loading, error, selectedIds, onToggleSelect, onRefresh, onDelete }: RunsTableProps) {
  function handleDelete(run: EvalRun) {
    if (window.confirm(`Delete the archived run "${run.label}"? This cannot be undone.`)) {
      onDelete(run.runId);
    }
  }

  return (
    <section className="panel evals-runs-panel">
      <div className="evals-panel-head">
        <h2>Archived runs</h2>
        <button type="button" className="secondary-button audit-refresh" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      {error && <div className="inline-error">{error}</div>}
      {loading && runs.length === 0 && <p className="audit-empty">Loading...</p>}
      {!loading && !error && runs.length === 0 && (
        <p className="audit-empty">
          No runs yet. Run the suite from the launcher above or with <code>npm run eval</code>.
        </p>
      )}
      {runs.length > 0 && (
        <div className="ledger-table-wrap">
          <table className="ledger-table evals-runs-table">
            <thead>
              <tr>
                <th>Compare</th>
                <th>Label</th>
                <th>Model (provider, judge)</th>
                <th>Source</th>
                <th>Status</th>
                <th>Date</th>
                <th>Pass / total</th>
                <th>Latency</th>
                <th>Tokens (in/out)</th>
                <th>Cost</th>
                <th>Commit</th>
                <th>Scenarios</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const summary = summarizeRun(run);
                const fallbackDiffers =
                  run.provider.fallbackModel !== null && run.provider.fallbackModel !== run.provider.primaryModel;
                return (
                  <tr key={run.runId} className={selectedIds.has(run.runId) ? "evals-run-row-selected" : undefined}>
                    <td className="ledger-nowrap">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(run.runId)}
                        onChange={() => onToggleSelect(run.runId)}
                        aria-label={`Compare run ${run.label}`}
                      />
                    </td>
                    <td className="ledger-nowrap eval-run-label">{run.label}</td>
                    {/* Provider host and judge ride under the model as one
                        sub-line rather than two more columns, to keep the
                        table narrow; it fits a 1440px viewport whole and
                        scrolls inside its wrapper at 1280px since the cost
                        column was added. The comparison header repeats them. */}
                    <td className="ledger-nowrap">
                      {run.provider.primaryModel ?? "unset"}
                      {fallbackDiffers && <div className="eval-run-submeta">fallback: {run.provider.fallbackModel}</div>}
                      <div className="eval-run-submeta">
                        via {providerHost(run.provider.baseUrl)}, judge {run.provider.judgeModel ?? "unset"}
                      </div>
                    </td>
                    <td>
                      <span className={`eval-source-badge eval-source-badge-${run.source}`}>{run.source}</span>
                    </td>
                    <td title={run.status === "failed" && run.failureReason ? run.failureReason : undefined}>
                      <span className={`eval-status-badge eval-status-badge-${run.status}`}>{statusLabel(run.status)}</span>
                      {run.status === "failed" && run.failureReason && (
                        <div className="eval-run-submeta eval-run-failure-note">{run.failureReason}</div>
                      )}
                    </td>
                    <td className="ledger-nowrap">{formatTime(run.startedAt)}</td>
                    <td className={`ledger-nowrap ${passCountClass(summary.pass, summary.fail, summary.total)}`}>
                      {summary.pass}/{summary.total}
                    </td>
                    <td className="ledger-nowrap">{formatSeconds(summary.totalLatencyMs)}</td>
                    <td className="ledger-nowrap">
                      {summary.tokensIn === null && summary.tokensOut === null
                        ? "n/a"
                        : `${formatTokens(summary.tokensIn)} / ${formatTokens(summary.tokensOut)}`}
                    </td>
                    <td className="ledger-nowrap" title={describePricing(run.pricing)}>
                      {formatUsd(summary.costUsd)}
                      {run.pricing && <div className="eval-run-submeta">{formatRates(run.pricing)}</div>}
                    </td>
                    <td className="ledger-nowrap" title={run.gitCommit ?? undefined}>
                      {shortHash(run.gitCommit)}
                    </td>
                    <td className="ledger-nowrap">
                      {run.scenarioFilter === null ? (
                        <span className="eval-run-submeta">full suite</span>
                      ) : (
                        <span className="eval-run-submeta">subset: {run.scenarioFilter.join(", ")}</span>
                      )}
                    </td>
                    <td className="ledger-nowrap">
                      <button type="button" className="secondary-button" onClick={() => handleDelete(run)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
