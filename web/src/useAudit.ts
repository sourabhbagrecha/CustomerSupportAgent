import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getLedger, getPendingApprovals } from "./api";
import type { LedgerPage, LedgerStatus, PendingApprovalSummary } from "./types";

const POLL_MS = 10_000;
const PAGE_SIZE = 100;

interface UseAuditResult {
  approvals: PendingApprovalSummary[];
  ledger: LedgerPage | null;
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  refresh: () => Promise<void>;
}

// The SSE stream is per threadId by design and replays that thread's stored
// history on connect, so a cross-thread queue has nothing to subscribe to. This
// polls instead, and the panel shows its own last-refreshed time rather than
// implying it is live. `paused` is set while a resolve is in flight so a
// scheduled refetch cannot yank a row out from under its spinner.
export function useAudit(statusFilter: LedgerStatus | "", paused: boolean): UseAuditResult {
  const [approvals, setApprovals] = useState<PendingApprovalSummary[]>([]);
  const [ledger, setLedger] = useState<LedgerPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Read inside the interval callback so the timer never needs to be torn down
  // and rebuilt just because a resolve started or finished.
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const refresh = useCallback(async () => {
    try {
      const [pending, page] = await Promise.all([
        getPendingApprovals(),
        getLedger(statusFilter ? { status: statusFilter, limit: PAGE_SIZE } : { limit: PAGE_SIZE }),
      ]);
      setApprovals(pending.approvals);
      setLedger(page);
      setLastUpdated(new Date());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load audit data.");
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled || pausedRef.current || document.hidden) return;
      void refresh();
    };

    setLoading(true);
    void refresh();
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);

  return { approvals, ledger, loading, error, lastUpdated, refresh };
}
