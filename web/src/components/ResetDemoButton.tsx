import { useState } from "react";
import { ApiError, resetDemo } from "../api";

type ResetStatus = "idle" | "resetting" | "success" | "error";

// Header-level, visible from every tab (Console/Audit/Evals), matching the
// "demo-only" visual convention used by the fault toggles in PersonaPanel
// (see .fault-caption in index.css): a small muted italic caption next to
// the control, no RBAC or route gating, just a visual signal that this is
// not production behavior.
//
// Confirm step is a plain window.confirm(): the simplest option the task
// allows, and it blocks a single accidental click from wiping demo data
// without adding extra UI state to coordinate.
//
// The backend route (POST /api/demo/reset, contract: { ok: true }) and the
// actual reset logic (server/src/db/resetDemo.ts) are owned by another
// workstream; this component only calls it and reflects the result. On
// success the simplest correct refresh is a full page reload, since Console,
// Audit, and Evals each keep their own fetched state and this button must
// not reach into panels owned by other groups to force a refetch.
export function ResetDemoButton() {
  const [status, setStatus] = useState<ResetStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    const confirmed = window.confirm(
      "Reset demo data? This restores seed customers, orders, and payments, and clears the ledger, approvals, escalations, threads, and faults. This cannot be undone.",
    );
    if (!confirmed) return;

    setStatus("resetting");
    setError(null);
    try {
      const res = await resetDemo();
      if (res.ok) {
        setStatus("success");
        // Brief visible confirmation before the reload takes the whole page
        // (and this component) away.
        window.setTimeout(() => window.location.reload(), 500);
      }
    } catch (err) {
      setStatus("error");
      setError(err instanceof ApiError ? err.message : "Failed to reset demo data.");
    }
  }

  return (
    <div className="reset-demo">
      <button
        type="button"
        className="secondary-button reset-demo-button"
        onClick={handleClick}
        disabled={status === "resetting" || status === "success"}
      >
        {status === "resetting" ? "Resetting..." : status === "success" ? "Reset complete" : "Reset demo"}
      </button>
      <span className="reset-demo-caption">Demo-only: wipes live data back to seed state.</span>
      {status === "error" && error && <span className="inline-error reset-demo-error">{error}</span>}
    </div>
  );
}
