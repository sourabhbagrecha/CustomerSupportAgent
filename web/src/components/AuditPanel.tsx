import { useState } from "react";
import { ApiError, resolveApproval } from "../api";
import { approvalActionLabels, formatAmount, formatClock, formatTime } from "../format";
import { LEDGER_STATUSES, type ChatResponse, type LedgerStatus, type PendingApprovalSummary } from "../types";
import { useAudit } from "../useAudit";
import { LedgerTable } from "./LedgerTable";

interface AuditPanelProps {
  onResolved: (threadId: string, result: ChatResponse) => void;
}

// P0-1 / P2-12 defense in depth: a policy-engine `allow` verdict always
// reads "Within policy: amount <= cap ...". The real fix is upstream
// (agentTools.ts's escalateToHumanTool only ever populates denialReason from
// a row whose status is actually `denied`), but this is a second, cheap
// guard directly at render time so an allow- or pending-worded string can
// never render under "Denied because" even if some future code path regresses.
function looksLikeDenial(reason: string): boolean {
  const normalized = reason.trim().toLowerCase();
  return !normalized.startsWith("within policy");
}

export function AuditPanel({ onResolved }: AuditPanelProps) {
  const [statusFilter, setStatusFilter] = useState<LedgerStatus | "">("");
  const [resolvingId, setResolvingId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  // P0-3: two independent drafts per pending approval. internalNotes is
  // audit-only and never leaves this panel except into the ledger's audit
  // trail; customerNotes is the only text that ever reaches the customer
  // (via server/src/agent/notify.ts), behind a profanity backstop.
  const [internalNotes, setInternalNotes] = useState<Record<number, string>>({});
  const [customerNotes, setCustomerNotes] = useState<Record<number, string>>({});
  const { approvals, ledger, loading, error, lastUpdated, refresh } = useAudit(statusFilter, resolvingId !== null);

  async function handleResolve(approval: PendingApprovalSummary, decision: "approve" | "reject") {
    setResolvingId(approval.id);
    setNotice(null);
    setResolveError(null);
    const internalNote = (internalNotes[approval.id] ?? "").trim();
    const customerNote = (customerNotes[approval.id] ?? "").trim();
    const labels = approvalActionLabels(approval);
    const verb = decision === "approve" ? labels.approve : labels.reject;
    try {
      const result = await resolveApproval(
        approval.threadId,
        approval.id,
        decision,
        customerNote || undefined,
        internalNote || undefined,
      );
      // The route returns the resumed customer turn (or the notice text for
      // an escalation), but the operator here may not have that thread open,
      // so App re-hydrates that thread's transcript from state rather than
      // this response being rendered directly in the queue.
      setNotice(`${verb}. Thread ${approval.threadId} is now ${result.status.replace(/_/g, " ")}.`);
      setInternalNotes((prev) => {
        const next = { ...prev };
        delete next[approval.id];
        return next;
      });
      setCustomerNotes((prev) => {
        const next = { ...prev };
        delete next[approval.id];
        return next;
      });
      onResolved(approval.threadId, result);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Someone resolved it from another window. Not an
        // error worth alarming about, and the refetch below clears the row.
        setNotice("That approval was already resolved elsewhere.");
      } else if (err instanceof ApiError && err.status === 500) {
        // resolveApproval commits before the follow-up action runs, so the
        // decision is durable even when that follow-up fails.
        setResolveError(
          `The decision was recorded, but the follow-up action failed. Check the trace for thread ${approval.threadId}.`,
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
          {approvals.map((approval) => {
            const labels = approvalActionLabels(approval);
            const internalNoteValue = internalNotes[approval.id] ?? "";
            const customerNoteValue = customerNotes[approval.id] ?? "";
            const customerNoteNeeded = customerNoteValue.trim().length === 0;
            return (
              <article key={approval.id} className="audit-queue-item">
                <header className="audit-queue-head">
                  <span className="audit-queue-name">{approval.personaName ?? approval.customerId}</span>
                  <span className={`audit-queue-kind audit-queue-kind-${approval.kind}`}>
                    {approval.kind === "escalation" ? "Escalation" : "Approval"}
                  </span>
                  {approval.amount !== null && <span className="audit-queue-amount">{formatAmount(approval.amount)}</span>}
                </header>
                <dl>
                  {approval.actionType && (
                    <>
                      <dt>Action</dt>
                      <dd>{approval.actionType}</dd>
                    </>
                  )}
                  {approval.orderId && (
                    <>
                      <dt>Order</dt>
                      <dd>{approval.orderId}</dd>
                    </>
                  )}
                  {approval.denialReason && looksLikeDenial(approval.denialReason) && (
                    <>
                      <dt>Denied because</dt>
                      <dd>{approval.denialReason}</dd>
                    </>
                  )}
                  <dt>{approval.kind === "escalation" ? "Escalation reason" : "Policy reason"}</dt>
                  <dd>{approval.policyReason}</dd>
                  {approval.context && (
                    <>
                      <dt>Context</dt>
                      <dd>{approval.context}</dd>
                    </>
                  )}
                  <dt>Waiting since</dt>
                  <dd>{formatTime(approval.createdAt)}</dd>
                </dl>
                <p className="audit-queue-thread">{approval.threadId}</p>
                <label className="approval-remark">
                  Internal note (staff only, never sent to the customer)
                  <textarea
                    value={internalNoteValue}
                    onChange={(event) => setInternalNotes((prev) => ({ ...prev, [approval.id]: event.target.value }))}
                    placeholder="Private reasoning for the audit trail..."
                    rows={2}
                    disabled={resolvingId !== null}
                  />
                </label>
                <label className="approval-remark">
                  Customer-facing explanation{" "}
                  {approval.kind === "escalation" ? "(required to uphold)" : "(required to reject)"}
                  <textarea
                    value={customerNoteValue}
                    onChange={(event) => setCustomerNotes((prev) => ({ ...prev, [approval.id]: event.target.value }))}
                    placeholder="Explain the decision to the customer, in the customer's own terms..."
                    rows={2}
                    disabled={resolvingId !== null}
                  />
                </label>
                <div className="approval-actions">
                  <button
                    type="button"
                    className="primary-button"
                    disabled={resolvingId !== null}
                    onClick={() => void handleResolve(approval, "approve")}
                  >
                    {resolvingId === approval.id ? "Working..." : labels.approve}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={resolvingId !== null || customerNoteNeeded}
                    onClick={() => void handleResolve(approval, "reject")}
                  >
                    {labels.reject}
                  </button>
                </div>
              </article>
            );
          })}
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
