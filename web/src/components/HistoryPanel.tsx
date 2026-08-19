import type { ThreadSummary } from "../types";

interface HistoryPanelProps {
  threads: ThreadSummary[];
  selectedThreadId: string | null;
  onSelectThread: (thread: ThreadSummary) => void;
  loading: boolean;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusLabel(status: ThreadSummary["resolutionStatus"]): string {
  return status.replace(/_/g, " ");
}

export function HistoryPanel({ threads, selectedThreadId, onSelectThread, loading }: HistoryPanelProps) {
  return (
    <aside className="panel history-panel">
      <h2>History</h2>
      <div className="history-list">
        {loading && threads.length === 0 && <p className="history-empty">Loading...</p>}
        {!loading && threads.length === 0 && <p className="history-empty">No conversations yet.</p>}
        {threads.map((thread) => (
          <button
            key={thread.threadId}
            type="button"
            className={`history-item${thread.threadId === selectedThreadId ? " history-item-active" : ""}`}
            onClick={() => onSelectThread(thread)}
          >
            <div className="history-item-top">
              <span className="history-item-name">{thread.personaName ?? thread.customerId ?? "Unknown"}</span>
              <span className={`history-item-status history-item-status-${thread.resolutionStatus}`}>
                {statusLabel(thread.resolutionStatus)}
              </span>
            </div>
            {thread.personaLabel && <div className="history-item-label">{thread.personaLabel}</div>}
            <div className="history-item-preview">{thread.preview || "(no messages yet)"}</div>
            <div className="history-item-meta">
              <span>{formatTime(thread.lastActivity)}</span>
              <span>{thread.messageCount} msg</span>
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}
