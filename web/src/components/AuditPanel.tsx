import { useState } from "react";
import { ApiError, resolveApproval } from "../api";
import { formatAmount, formatClock, formatTime } from "../format";
import { LEDGER_STATUSES, type ChatResponse, type LedgerStatus, type PendingApprovalSummary } from "../types";
import { useAudit } from "../useAudit";
import { LedgerTable } from "./LedgerTable";

interface AuditPanelProps {
  onResolved: (threadId: string, result: ChatResponse) => void;
}

export function AuditPanel({ onResolved }: AuditPanelProps) {
  const [statusFilter, setStatusFilter] = useState<LedgerStatus | "">("");
  const [resolvingId, setResolvingId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const { approvals, ledger, loading, error, lastUpdated, refresh } = useAudit(statusFilter, resolvingId !== null);

  async function handleResolve(approval: PendingApprovalSummary, decision: "approve" | "reject") {
    setResolvingId(approval.id);
    setNotice(null);
    setResolveError(null);
    const verb = decision === "approve" ? "Approved" : "Rejected";
    try {
      const result = await resolveApproval(approval.threadId, approval.id, decision);
      // The route returns the resumed customer turn, but the operator here may
      // not have that thread open, so the reply text goes back to App rather
      // than being rendered in the queue.
      setNotice(
        result.reply === null
          ? `${verb}. Thread ${approval.threadId} is now ${result.status.replace(/_/g, " ")}.`
          : `${verb}. The agent replied on thread ${approval.threadId}.`,
      );
      onResolved(approval.threadId, result);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Someone resolved it from the chat banner or another window. Not an
        // error worth alarming about, and the refetch below clears the row.
        setNotice("That approval was already resolved elsewhere.");
      } else if (err instanceof ApiError && err.status === 500) {
        // resolveApproval commits before resumeApprovalTurn runs, so the
        // decision is durable even when the follow-up turn fails.
        setResolveError(
          `The decision was recorded, but the follow-up turn failed. Check the trace for thread ${approval.threadId}.`,
        );
      } else {
        setResolveError(err instanceof ApiError ? err.message : "Failed to resolve approval.");
      }
    } finally {
      setResolvingId(null);
      await refresh();
    }
  }

  return (
    <div className="audit-layout">
      <section className="panel audit-queue-panel">
        <h2>Pending approvals: all threads</h2>
        <div className="audit-meta">
          <span>{lastUpdated ? `Last updated ${formatClock(lastUpdated)}` : "Loading..."}</span>
          <button type="button" className="secondary-button audit-refresh" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
        {error && <div className="inline-error">{error}</div>}
        {notice && <div className="audit-notice">{notice}</div>}
        {resolveError && <div className="inline-error">{resolveError}</div>}

        <div className="audit-queue">
          {loading && approvals.length === 0 && <p className="audit-empty">Loading...</p>}
          {!loading && !error && approvals.length === 0 && <p className="audit-empty">No approvals waiting.</p>}
          {approvals.map((approval) => (
            <article key={approval.id} className="audit-queue-item">
              <header className="audit-queue-head">
                <span className="audit-queue-name">{approval.personaName ?? approval.customerId}</span>
                <span className="audit-queue-amount">{formatAmount(approval.amount)}</span>
              </header>
              <dl>
                <dt>Action</dt>
                <dd>{approval.actionType}</dd>
                <dt>Order</dt>
                <dd>{approval.orderId ?? "N/A"}</dd>
                <dt>Policy reason</dt>
                <dd>{approval.policyReason}</dd>
                <dt>Waiting since</dt>
                <dd>{formatTime(approval.createdAt)}</dd>
              </dl>
              <p className="audit-queue-thread">{approval.threadId}</p>
              <div className="approval-actions">
                <button
                  type="button"
                  className="primary-button"
                  disabled={resolvingId !== null}
                  onClick={() => void handleResolve(approval, "approve")}
                >
                  {resolvingId === approval.id ? "Working..." : "Approve"}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={resolvingId !== null}
                  onClick={() => void handleResolve(approval, "reject")}
                >
                  Reject
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="panel audit-ledger-panel">
        <h2>Action ledger: every money action</h2>
        <div className="audit-meta">
          <label className="audit-filter">
            Status
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as LedgerStatus | "")}>
              <option value="">all</option>
              {LEDGER_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
          <span className="audit-count">{ledger ? `${ledger.total} rows` : ""}</span>
        </div>
        {loading && !ledger && <p className="audit-empty">Loading...</p>}
        {!loading && !error && ledger && ledger.rows.length === 0 && (
          <p className="audit-empty">
            {statusFilter ? `No ${statusFilter.replace(/_/g, " ")} actions recorded.` : "No money actions recorded yet."}
          </p>
        )}
        {ledger && ledger.rows.length > 0 && <LedgerTable rows={ledger.rows} total={ledger.total} />}
      </section>
    </div>
  );
}
