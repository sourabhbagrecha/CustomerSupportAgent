import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { ApiError, cancelEvalRun, getCurrentEvalRun, getEvalRuns, startEvalRun } from "../../api";
import type { EvalConfig, EvalCurrentRun, EvalRunRequest } from "../../types";
import { formatElapsed, formatTokens, formatUsd, providerHost, scenarioCostUsd, summarizeRun } from "./evalMath";

const POLL_MS = 2000;
// Sentinel for "Base URL" select: anything other than one of config.presets'
// exact URLs, so a custom entry never collides with a real preset string.
const CUSTOM_BASE_URL = "__custom__";
const KEEP_DEFAULT_JUDGE_KEY = "";

interface RunLauncherProps {
  config: EvalConfig | null;
  configError: string | null;
  open: boolean;
  onToggleOpen: (open: boolean) => void;
  // Called once a run leaves the "running" state (completed/failed/cancelled)
  // so the archive table above can refetch and re-derive its selection.
  onRunSettled: () => void;
}

function scenarioLabel(count: number, total: number): string {
  return count === 0 ? `full suite (${total} scenarios)` : `${count} of ${total}`;
}

export function RunLauncher({ config, configError, open, onToggleOpen, onRunSettled }: RunLauncherProps) {
  // Form fields. Seeded from config once it loads (see the effect below);
  // left blank until then so nothing renders with a wrong default and then
  // jumps.
  const [initialized, setInitialized] = useState(false);
  const [label, setLabel] = useState("");
  const [baseUrlChoice, setBaseUrlChoice] = useState(CUSTOM_BASE_URL);
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [primaryModel, setPrimaryModel] = useState("");
  const [fallbackModel, setFallbackModel] = useState("");
  const [apiKeyEnv, setApiKeyEnv] = useState("");

  const [subsetOpen, setSubsetOpen] = useState(false);
  const [selectedScenarios, setSelectedScenarios] = useState<Set<number>>(new Set());

  const [judgeOpen, setJudgeOpen] = useState(false);
  const [judgeModelOverride, setJudgeModelOverride] = useState("");
  const [judgeBaseUrlOverride, setJudgeBaseUrlOverride] = useState("");
  const [judgeApiKeyEnvOverride, setJudgeApiKeyEnvOverride] = useState(KEEP_DEFAULT_JUDGE_KEY);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [current, setCurrent] = useState<EvalCurrentRun | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const logRef = useRef<HTMLPreElement | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const lastRunIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (initialized || !config) return;
    setBaseUrlChoice(config.presets.some((p) => p.baseUrl === config.defaults.baseUrl) ? config.defaults.baseUrl : CUSTOM_BASE_URL);
    setCustomBaseUrl(config.defaults.baseUrl);
    setPrimaryModel(config.defaults.primaryModel);
    setApiKeyEnv(config.defaults.apiKeyEnv);
    setInitialized(true);
  }, [config, initialized]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // Builds the "Run {label} finished: X/Y passing" notice from the freshly
  // archived record (GET /api/evals/current returns null the moment a run
  // settles, so the finished run's own status has to come from the archive).
  const announceSettled = useCallback(async (runId: string) => {
    try {
      const res = await getEvalRuns();
      const run = res.runs.find((r) => r.runId === runId);
      if (run) {
        const summary = summarizeRun(run);
        if (run.status === "completed") {
          setNotice(
            `Run "${run.label}" finished: ${summary.pass}/${summary.total} passing` +
              (summary.costUsd !== null ? `, ${formatUsd(summary.costUsd)} in agent tokens.` : "."),
          );
        } else if (run.status === "cancelled") {
          setNotice(`Run "${run.label}" was cancelled (${summary.pass}/${summary.total} passing before it stopped).`);
        } else if (run.status === "failed") {
          setNotice(`Run "${run.label}" failed${run.failureReason ? `: ${run.failureReason}` : "."}`);
        }
      }
    } catch {
      // Best-effort notice only; the archive table's own refresh (triggered
      // by onRunSettled below regardless) is what keeps the data correct.
    }
  }, []);

  // Read from a ref inside `poll` rather than closing over `onRunSettled`
  // directly, so a parent re-render that passes a new callback identity does
  // not force the polling interval to be torn down and rebuilt.
  const onRunSettledRef = useRef(onRunSettled);
  useEffect(() => {
    onRunSettledRef.current = onRunSettled;
  }, [onRunSettled]);

  const poll = useCallback(() => {
    getCurrentEvalRun()
      .then((res) => {
        setCurrent(res.current);
        if (res.current) {
          lastRunIdRef.current = res.current.run.runId;
        } else {
          stopPolling();
          const finishedId = lastRunIdRef.current;
          lastRunIdRef.current = null;
          if (finishedId) void announceSettled(finishedId);
          onRunSettledRef.current();
        }
      })
      .catch(() => {
        // Transient network hiccup; the next tick (while still polling) retries.
      });
  }, [announceSettled, stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollTimerRef.current = window.setInterval(poll, POLL_MS);
  }, [poll, stopPolling]);

  // Reattach to a run left in progress by a previous page load: check once on
  // mount, and only start the recurring 2s poll if one is actually active.
  useEffect(() => {
    getCurrentEvalRun()
      .then((res) => {
        setCurrent(res.current);
        if (res.current) {
          lastRunIdRef.current = res.current.run.runId;
          startPolling();
        }
      })
      .catch(() => {});
    return () => stopPolling();
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [current?.logTail]);

  const effectiveBaseUrl = baseUrlChoice === CUSTOM_BASE_URL ? customBaseUrl.trim() : baseUrlChoice;
  const canSubmit =
    !submitting &&
    !current &&
    effectiveBaseUrl.length > 0 &&
    primaryModel.trim().length > 0 &&
    apiKeyEnv.length > 0;

  function toggleScenario(number: number) {
    setSelectedScenarios((prev) => {
      const next = new Set(prev);
      if (next.has(number)) next.delete(number);
      else next.add(number);
      return next;
    });
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    setNotice(null);
    const body: EvalRunRequest = {
      label: label.trim() || undefined,
      baseUrl: effectiveBaseUrl,
      primaryModel: primaryModel.trim(),
      fallbackModel: fallbackModel.trim() || undefined,
      apiKeyEnv,
      judgeModel: judgeModelOverride.trim() || undefined,
      judgeBaseUrl: judgeBaseUrlOverride.trim() || undefined,
      judgeApiKeyEnv: judgeApiKeyEnvOverride || undefined,
      scenarios: selectedScenarios.size > 0 ? [...selectedScenarios].sort((a, b) => a - b) : undefined,
    };
    try {
      const res = await startEvalRun(body);
      setCurrent(res.current);
      lastRunIdRef.current = res.current.run.runId;
      startPolling();
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Failed to start the eval run.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancel() {
    if (!window.confirm("Cancel the running eval suite? Partial results are kept.")) return;
    setCancelling(true);
    try {
      await cancelEvalRun();
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Failed to cancel the run.");
    } finally {
      setCancelling(false);
    }
  }

  return (
    <section className="panel evals-launcher-panel">
      <div className="evals-panel-head">
        <h2>Run launcher</h2>
      </div>
      {configError && <div className="inline-error">{configError}</div>}
      <details className="evals-launcher-details" open={open} onToggle={(e) => onToggleOpen(e.currentTarget.open)}>
        <summary>Configure a run</summary>
        {!config ? (
          <p className="audit-empty">Loading configuration...</p>
        ) : (
          <form className="evals-launcher-form" onSubmit={(e) => void handleSubmit(e)}>
            <div className="evals-field-grid">
              <label className="evals-field">
                Label
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={primaryModel || config.defaults.primaryModel}
                  disabled={!!current}
                />
              </label>

              <label className="evals-field">
                Base URL
                <select value={baseUrlChoice} onChange={(e) => setBaseUrlChoice(e.target.value)} disabled={!!current}>
                  {config.presets.map((preset) => (
                    <option key={preset.baseUrl} value={preset.baseUrl}>
                      {preset.label} ({providerHost(preset.baseUrl)})
                    </option>
                  ))}
                  <option value={CUSTOM_BASE_URL}>Custom</option>
                </select>
              </label>

              {baseUrlChoice === CUSTOM_BASE_URL && (
                <label className="evals-field">
                  Custom base URL
                  <input
                    type="text"
                    value={customBaseUrl}
                    onChange={(e) => setCustomBaseUrl(e.target.value)}
                    placeholder="https://api.example.com/v1"
                    disabled={!!current}
                  />
                </label>
              )}

              <label className="evals-field">
                Primary model
                <input
                  type="text"
                  value={primaryModel}
                  onChange={(e) => setPrimaryModel(e.target.value)}
                  disabled={!!current}
                />
              </label>

              <label className="evals-field">
                Fallback model
                <input
                  type="text"
                  value={fallbackModel}
                  onChange={(e) => setFallbackModel(e.target.value)}
                  placeholder={primaryModel || "same as primary"}
                  disabled={!!current}
                />
                <span className="evals-field-hint">defaults to the primary model</span>
              </label>

              <label className="evals-field">
                API key variable
                <select value={apiKeyEnv} onChange={(e) => setApiKeyEnv(e.target.value)} disabled={!!current}>
                  {config.apiKeyEnvs.length === 0 && <option value="">no keys configured</option>}
                  {config.apiKeyEnvs.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <span className="evals-field-hint">keys stay in the server's .env; only the variable name is sent</span>
              </label>
            </div>

            <details
              className="evals-subset-details"
              open={subsetOpen}
              onToggle={(e) => setSubsetOpen(e.currentTarget.open)}
            >
              <summary>
                Run a subset <span className="evals-subset-caption">({scenarioLabel(selectedScenarios.size, config.scenarios.length)})</span>
              </summary>
              <div className="evals-scenario-grid">
                {config.scenarios.map((s) => (
                  <label key={s.number} className="evals-scenario-item">
                    <input
                      type="checkbox"
                      checked={selectedScenarios.has(s.number)}
                      onChange={() => toggleScenario(s.number)}
                      disabled={!!current}
                    />
                    <span>
                      {s.number}. {s.name}
                    </span>
                  </label>
                ))}
              </div>
            </details>

            <div className="evals-judge-block">
              <p className="evals-judge-line">
                Judge held constant: <strong>{config.defaults.judgeModel || "unset"}</strong> via{" "}
                {providerHost(config.defaults.judgeBaseUrl)}
              </p>
              <details className="evals-subset-details" open={judgeOpen} onToggle={(e) => setJudgeOpen(e.currentTarget.open)}>
                <summary>Override judge</summary>
                <div className="evals-field-grid">
                  <label className="evals-field">
                    Judge model
                    <input
                      type="text"
                      value={judgeModelOverride}
                      onChange={(e) => setJudgeModelOverride(e.target.value)}
                      placeholder={config.defaults.judgeModel || "keep default"}
                      disabled={!!current}
                    />
                  </label>
                  <label className="evals-field">
                    Judge base URL
                    <input
                      type="text"
                      value={judgeBaseUrlOverride}
                      onChange={(e) => setJudgeBaseUrlOverride(e.target.value)}
                      placeholder={config.defaults.judgeBaseUrl}
                      disabled={!!current}
                    />
                  </label>
                  <label className="evals-field">
                    Judge API key variable
                    <select
                      value={judgeApiKeyEnvOverride}
                      onChange={(e) => setJudgeApiKeyEnvOverride(e.target.value)}
                      disabled={!!current}
                    >
                      <option value={KEEP_DEFAULT_JUDGE_KEY}>keep default ({config.defaults.judgeApiKeyEnv})</option>
                      {config.apiKeyEnvs.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </details>
            </div>

            {submitError && <div className="inline-error">{submitError}</div>}

            <div className="evals-launcher-actions">
              <button type="submit" className="primary-button" disabled={!canSubmit}>
                {submitting ? "Starting..." : "Run"}
              </button>
              <p className="evals-launcher-caption">
                Runs the real suite as a child process of the API server; every run costs model credit.
              </p>
            </div>
          </form>
        )}
      </details>

      {current && (
        <ProgressStrip current={current} onCancel={() => void handleCancel()} cancelling={cancelling} logRef={logRef} />
      )}
      {!current && notice && <div className="evals-notice">{notice}</div>}
    </section>
  );
}

interface ProgressStripProps {
  current: EvalCurrentRun;
  onCancel: () => void;
  cancelling: boolean;
  logRef: RefObject<HTMLPreElement | null>;
}

function ProgressStrip({ current, onCancel, cancelling, logRef }: ProgressStripProps) {
  const done = current.run.scenarios.length;
  const total = current.expectedScenarioCount;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const elapsedMs = Date.now() - new Date(current.run.startedAt).getTime();

  return (
    <div className="evals-progress">
      <div className="evals-progress-head">
        <span className="evals-progress-count">
          {done} / {total} scenarios
        </span>
        <span className="evals-progress-elapsed">elapsed {formatElapsed(elapsedMs)}</span>
        <button type="button" className="secondary-button" onClick={onCancel} disabled={cancelling}>
          {cancelling ? "Cancelling..." : "Cancel"}
        </button>
      </div>
      <div className="evals-progress-bar-track">
        <div className="evals-progress-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      {current.run.scenarios.length > 0 && (
        <div className="ledger-table-wrap evals-progress-scenarios">
          <table className="ledger-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Scenario</th>
                <th>Status</th>
                <th>Latency</th>
                <th>Tokens</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {current.run.scenarios.map((s) => (
                <tr key={s.number}>
                  <td className="ledger-nowrap">{s.number}</td>
                  <td>{s.name}</td>
                  <td>
                    <span className={`eval-status-badge eval-status-badge-${s.status}`}>{s.status.replace(/_/g, " ")}</span>
                  </td>
                  <td className="ledger-nowrap">{s.latencyMs === null ? "n/a" : `${s.latencyMs} ms`}</td>
                  <td className="ledger-nowrap">
                    {s.tokensIn === null && s.tokensOut === null ? "n/a" : `${formatTokens(s.tokensIn)} / ${formatTokens(s.tokensOut)}`}
                  </td>
                  <td className="ledger-nowrap">{formatUsd(scenarioCostUsd(s, current.run.pricing))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <pre className="evals-log-tail" ref={logRef}>
        {current.logTail.length > 0 ? current.logTail.join("\n") : "Waiting for runner output..."}
      </pre>
    </div>
  );
}
