import type { AgentEvent } from "../types";

interface TracePanelProps {
  events: AgentEvent[];
}

function field(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

// Each event type carries a different, loosely-typed payload (server/src
// emits Record<string, unknown>). Pull out the fields that matter for a
// human reading the trace; anything else stays visible in the raw <details>
// block below so no information is lost.
function summarize(event: AgentEvent): string {
  const p = event.payload;
  switch (event.type) {
    case "step":
      return `step: ${field(p, "step") ?? "unknown"}`;
    case "llm_call":
      return `${field(p, "role") ?? "model"} call (${event.model ?? field(p, "model") ?? "unknown model"}), attempt ${field(p, "attempt") ?? "0"}, ${event.tokensIn ?? "?"} in / ${event.tokensOut ?? "?"} out tokens`;
    case "tool_call":
      return `call ${field(p, "tool") ?? "tool"} with ${field(p, "input") ?? "{}"}`;
    case "tool_result": {
      const result = field(p, "result") ?? field(p, "count");
      const decision = field(p, "decision");
      return `${field(p, "tool") ?? "tool"} result${decision ? ` (decision: ${decision})` : ""}: ${result ?? "n/a"}`;
    }
    case "guardrail": {
      const stage = field(p, "stage") ?? "check";
      const verdict = field(p, "verdict") ?? field(p, "outcome");
      const reason = field(p, "reason");
      return `${stage}${verdict ? ` -> ${verdict}` : ""}${reason ? `: ${reason}` : ""}`;
    }
    case "fault":
      return `fault triggered: ${field(p, "fault") ?? "unknown"}${field(p, "message") ? ` (${field(p, "message")})` : ""}`;
    case "failover":
      return `failover ${field(p, "from") ?? "?"} -> ${field(p, "to") ?? "?"}: ${field(p, "reason") ?? ""}`;
    case "escalation":
      return `escalated (${field(p, "category") ?? "unknown"}): ${field(p, "reason") ?? ""}`;
    case "error":
      return `error at ${field(p, "stage") ?? "unknown stage"}: ${field(p, "message") ?? "no message"}`;
    default:
      return JSON.stringify(p);
  }
}

export function TracePanel({ events }: TracePanelProps) {
  return (
    <aside className="panel trace-panel">
      <h2>Live trace</h2>
      <div className="trace-list">
        {events.length === 0 && <p className="trace-empty">No events yet. Send a message to see the trace.</p>}
        {events.map((event) => (
          <details key={event.id} className={`trace-entry trace-entry-${event.type}`}>
            <summary>
              <span className="trace-type">{event.type}</span>
              <span className="trace-summary">{summarize(event)}</span>
              {event.latencyMs !== null && <span className="trace-latency">{event.latencyMs} ms</span>}
            </summary>
            <pre className="trace-raw">{JSON.stringify(event, null, 2)}</pre>
          </details>
        ))}
      </div>
    </aside>
  );
}
