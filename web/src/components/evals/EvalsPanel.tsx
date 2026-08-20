import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, deleteEvalRun, getEvalConfig, getEvalRuns } from "../../api";
import type { EvalConfig, EvalRun } from "../../types";
import { RunComparison } from "./RunComparison";
import { RunLauncher } from "./RunLauncher";
import { RunsTable } from "./RunsTable";

// Container for the "compare eval runs" workbench (plan 007): owns config and
// archive loading, the run-launcher's open/closed state, and which runs are
// selected for comparison. RunLauncher, RunsTable, and RunComparison are
// otherwise presentational, driven entirely by props from here.
export function EvalsPanel() {
  const [config, setConfig] = useState<EvalConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [runsError, setRunsError] = useState<string | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [baselineId, setBaselineId] = useState<string | null>(null);
  const [launcherOpen, setLauncherOpen] = useState(false);

  // Both of these are "decide once, from data" defaults: every archived run
  // starts checked so the comparison opens on the full picture, and the
  // launcher starts expanded only when the archive is empty. Guarded by refs
  // so a later, deliberate user action (unchecking runs, collapsing the
  // launcher) is never silently overridden by the next archive refresh.
  const defaultSelectionSet = useRef(false);
  const defaultLauncherOpenSet = useRef(false);

  const loadConfig = useCallback(() => {
    setConfigError(null);
    getEvalConfig()
      .then(setConfig)
      .catch((err: unknown) => setConfigError(err instanceof ApiError ? err.message : "Failed to load eval config."));
  }, []);

  const refreshRuns = useCallback(async () => {
    setRunsLoading(true);
    setRunsError(null);
    try {
      const res = await getEvalRuns();
      setRuns(res.runs);

      if (!defaultLauncherOpenSet.current) {
        defaultLauncherOpenSet.current = true;
        if (res.runs.length === 0) setLauncherOpen(true);
      }
      if (!defaultSelectionSet.current && res.runs.length > 0) {
        defaultSelectionSet.current = true;
        setSelectedIds(new Set(res.runs.map((r) => r.runId)));
      } else {
        // Drop ids for runs that no longer exist (deleted since the last
        // load) so a stale selection can't quietly grow forever.
        const stillPresent = new Set(res.runs.map((r) => r.runId));
        setSelectedIds((prev) => new Set([...prev].filter((id) => stillPresent.has(id))));
      }
      return res.runs;
    } catch (err) {
      setRunsError(err instanceof ApiError ? err.message : "Failed to load the eval run archive.");
      return null;
    } finally {
      setRunsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
    void refreshRuns();
    // Runs once on mount; loadConfig/refreshRuns are stable (useCallback, []).
  }, []);

  const selectedRuns = runs.filter((r) => selectedIds.has(r.runId));

  // Baseline defaults to the newest selected run and follows the selection:
  // if the current baseline is deselected or deleted, fall back rather than
  // pointing at nothing.
  useEffect(() => {
    if (selectedRuns.length === 0) {
      if (baselineId !== null) setBaselineId(null);
      return;
    }
    if (!selectedRuns.some((r) => r.runId === baselineId)) {
      const next = selectedRuns[0];
      if (next) setBaselineId(next.runId);
    }
    // selectedRuns is recomputed every render from `runs`/`selectedIds`;
    // comparing its derived ids (via the join) avoids re-running this effect
    // on every unrelated render.
  }, [selectedRuns.map((r) => r.runId).join(","), baselineId]);

  function toggleSelect(runId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }

  async function handleDelete(runId: string) {
    try {
      await deleteEvalRun(runId);
      await refreshRuns();
    } catch (err) {
      setRunsError(err instanceof ApiError ? err.message : "Failed to delete the run.");
    }
  }

  return (
    <div className="evals-page">
      <RunLauncher
        config={config}
        configError={configError}
        open={launcherOpen}
        onToggleOpen={setLauncherOpen}
        onRunSettled={() => void refreshRuns()}
      />
      <RunsTable
        runs={runs}
        loading={runsLoading}
        error={runsError}
        selectedIds={selectedIds}
        onToggleSelect={toggleSelect}
        onRefresh={() => void refreshRuns()}
        onDelete={(runId) => void handleDelete(runId)}
      />
      {selectedRuns.length > 0 && (
        <RunComparison selectedRuns={selectedRuns} baselineId={baselineId} onSetBaseline={setBaselineId} />
      )}
    </div>
  );
}
