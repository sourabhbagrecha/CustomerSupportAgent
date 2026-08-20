import { useState, type FormEvent } from "react";
import type { AgentEvent, ApprovalRow, ChatMessage } from "../types";

interface ChatProps {
  personaLabel: string | null;
  messages: ChatMessage[];
  pendingApproval: ApprovalRow | null;
  sending: boolean;
  streamingReply: string;
  error: string | null;
  events: AgentEvent[];
  onSend: (text: string) => void;
}

interface ThreadTotals {
  turns: number;
  costUsd: number | null;
  wallTimeMs: number;
}

// P2-9: sums every rollup event in the thread (one per completed turn, see
// server/src/agent/graph.ts and server/src/events/emitter.ts's
// emitTurnRollup), so this is a running total across the whole conversation,
// not just the latest reply. `events` already carries full thread history:
// useEvents replays every stored event for the thread on (re)connect.
// costUsd stays null only when every turn's own cost was unresolvable; a
// thread with at least one priced turn still reports the sum of what could
// be priced, same "n/a rather than a silent guess" rule as the eval suite.
function threadTotals(events: AgentEvent[]): ThreadTotals {
  let turns = 0;
  let costUsd: number | null = null;
  let wallTimeMs = 0;
  for (const event of events) {
    if (event.type !== "step" || event.payload.step !== "rollup") continue;
    turns += 1;
    const cost = event.payload.costUsd;
    if (typeof cost === "number") costUsd = (costUsd ?? 0) + cost;
    const wall = event.payload.wallTimeMs;
    if (typeof wall === "number") wallTimeMs += wall;
  }
  return { turns, costUsd, wallTimeMs };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function formatCost(costUsd: number | null): string {
  if (costUsd === null) return "cost n/a";
  return costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`;
}

function formatWallTime(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)}s`;
}

// Customer-facing copy only. The policy engine's own strings (denialReason,
// policyReason) are written for the operator deciding the case and stay in the
// Audit tab; what reaches the customer is the code-composed decision notice in
// server/src/agent/notify.ts, appended to this transcript when a human decides.
function statusCopy(kind: ApprovalRow["kind"]): string {
  return kind === "escalation"
    ? "A human reviewer is looking at this. They will reply here with their decision."
    : "This request needs a human review before it can go through. A reviewer will reply here with their decision.";
}

export function Chat({
  personaLabel,
  messages,
  pendingApproval,
  sending,
  streamingReply,
  error,
  events,
  onSend,
}: ChatProps) {
  const [draft, setDraft] = useState("");
  const totals = threadTotals(events);
  // A policy_approval row means the graph is parked mid-turn on interrupt()
  // inside the money tool, and the only defined way to continue that thread is
  // Command({ resume }) from the resolve route, so a fresh turn cannot be
  // posted until it is decided. An escalation's turn finished normally, so the
  // customer can keep typing while they wait (see docs/plans/004).
  const graphParked = pendingApproval?.kind === "policy_approval";
  const inputDisabled = !personaLabel || sending || graphParked;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || inputDisabled) return;
    setDraft("");
    onSend(text);
  }

  return (
    <main className="panel chat-panel">
      <div className="chat-panel-header">
        <h2>{personaLabel ? `Chat: ${personaLabel}` : "Select a persona to start"}</h2>
        {personaLabel && totals.turns > 0 && (
          <span
            className="chat-cost-badge"
            title={`Cumulative across ${plural(totals.turns, "turn")} in this thread`}
          >
            {formatCost(totals.costUsd)} &middot; {formatWallTime(totals.wallTimeMs)}
          </span>
        )}
      </div>
      <div className="chat-messages">
        {messages.map((message, index) => (
          <div key={index} className={`chat-bubble chat-bubble-${message.role}`}>
            <span className="chat-bubble-role">{message.role === "customer" ? "Customer" : "Agent"}</span>
            <p>{message.content}</p>
          </div>
        ))}
        {sending && streamingReply && (
          <div className="chat-bubble chat-bubble-agent chat-bubble-streaming">
            <span className="chat-bubble-role">Agent</span>
            <p>{streamingReply}</p>
          </div>
        )}
        {sending && !streamingReply && <div className="chat-loading">Agent is working...</div>}

        {pendingApproval && (
          <div className="approval-status">
            <h3>Waiting on a human reviewer</h3>
            <p>{statusCopy(pendingApproval.kind)}</p>
            {/* Console chrome, not customer copy: the decision itself is made
                in the Audit tab, which is the only surface that resolves a row. */}
            <p className="approval-status-hint">Operator: resolve this in the Audit tab.</p>
          </div>
        )}
      </div>

      {error && <div className="inline-error">{error}</div>}

      <form className="chat-input-row" onSubmit={handleSubmit}>
        <input
          type="text"
          value={draft}
          placeholder={graphParked ? "Waiting on the reviewer's decision..." : "Type a message..."}
          disabled={inputDisabled}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="primary-button" disabled={inputDisabled || !draft.trim()}>
          Send
        </button>
      </form>
    </main>
  );
}
