import { useState, type FormEvent } from "react";
import type { ApprovalRow, ChatMessage } from "../types";

interface ChatProps {
  personaLabel: string | null;
  messages: ChatMessage[];
  pendingApproval: ApprovalRow | null;
  sending: boolean;
  resolvingApproval: boolean;
  streamingReply: string;
  error: string | null;
  onSend: (text: string) => void;
  onApprovalDecision: (decision: "approve" | "reject") => void;
}

export function Chat({
  personaLabel,
  messages,
  pendingApproval,
  sending,
  resolvingApproval,
  streamingReply,
  error,
  onSend,
  onApprovalDecision,
}: ChatProps) {
  const [draft, setDraft] = useState("");
  const inputDisabled = !personaLabel || sending || pendingApproval !== null;
  const inFlight = sending || resolvingApproval;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || inputDisabled) return;
    setDraft("");
    onSend(text);
  }

  return (
    <main className="panel chat-panel">
      <h2>{personaLabel ? `Chat: ${personaLabel}` : "Select a persona to start"}</h2>
      <div className="chat-messages">
        {messages.map((message, index) => (
          <div key={index} className={`chat-bubble chat-bubble-${message.role}`}>
            <span className="chat-bubble-role">{message.role === "customer" ? "Customer" : "Agent"}</span>
            <p>{message.content}</p>
          </div>
        ))}
        {inFlight && streamingReply && (
          <div className="chat-bubble chat-bubble-agent chat-bubble-streaming">
            <span className="chat-bubble-role">Agent</span>
            <p>{streamingReply}</p>
          </div>
        )}
        {inFlight && !streamingReply && <div className="chat-loading">Agent is working...</div>}

        {pendingApproval && (
          <div className="approval-banner">
            <h3>Approval required</h3>
            <dl>
              <dt>Action</dt>
              <dd>{pendingApproval.actionType}</dd>
              <dt>Order</dt>
              <dd>{pendingApproval.orderId ?? "N/A"}</dd>
              <dt>Amount</dt>
              <dd>Rs. {pendingApproval.amount}</dd>
              <dt>Policy reason</dt>
              <dd>{pendingApproval.policyReason}</dd>
            </dl>
            <div className="approval-actions">
              <button
                type="button"
                className="primary-button"
                disabled={resolvingApproval}
                onClick={() => onApprovalDecision("approve")}
              >
                Approve
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={resolvingApproval}
                onClick={() => onApprovalDecision("reject")}
              >
                Reject
              </button>
            </div>
          </div>
        )}
      </div>

      {error && <div className="inline-error">{error}</div>}

      <form className="chat-input-row" onSubmit={handleSubmit}>
        <input
          type="text"
          value={draft}
          placeholder={pendingApproval ? "Resolve the pending approval to continue..." : "Type a message..."}
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
