import type { AgentEvent } from "../types";

interface TracePanelProps {
  events: AgentEvent[];
}

function field(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function num(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" ? value : null;
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

// P2-8/P2-9: the `context` and `rollup` events are both written as `step`
// events with a discriminating payload.step (see loadContext.ts and
// events/emitter.ts's emitTurnRollup), not as new event `type` values, since
// the events table's CHECK constraint (server/src/db/schema.sql, not owned
// by this fix) fixes the allowed type list. Same pattern the codebase
// already uses for "step: loadContext" / "step: user_message".
function summarizeStep(p: Record<string, unknown>): string {
  const stepName = field(p, "step") ?? "unknown";
  if (stepName === "context") {
    const retrieved = num(p, "conversationsRetrieved") ?? 0;
    const total = num(p, "conversationsTotal") ?? 0;
    const orders = num(p, "ordersCount") ?? 0;
    const payments = num(p, "paymentsCount") ?? 0;
    const budget = num(p, "promptTokenBudget") ?? 0;
    const policy = field(p, "policyVersion") ?? "unknown";
    return `policy ${policy}, ${retrieved}/${total} conversations retrieved, ${plural(orders, "order")}, ${plural(payments, "payment")}, ${budget.toLocaleString()} token budget`;
  }
  if (stepName === "rollup") {
    const llmCalls = num(p, "llmCalls") ?? 0;
    const tokensIn = num(p, "tokensIn") ?? 0;
    const tokensOut = num(p, "tokensOut") ?? 0;
    const wall = num(p, "wallTimeMs") ?? 0;
    // tokensCachedIn is null when no call in the turn reported caching
    // (older events, or a provider that omits the field); only a real
    // reported number earns a "(N cached)" note.
    const cached = num(p, "tokensCachedIn");
    const cachedNote = cached != null ? ` (${cached.toLocaleString()} cached)` : "";
    return `turn done: ${plural(llmCalls, "LLM call")}, ${tokensIn.toLocaleString()} in${cachedNote} / ${tokensOut.toLocaleString()} out tokens, ${formatCost(num(p, "costUsd"))}, ${formatWallTime(wall)} wall time`;
  }
  return `step: ${stepName}`;
}

// Each event type carries a different, loosely-typed payload (server/src
// emits Record<string, unknown>). Pull out the fields that matter for a
// human reading the trace; anything else stays visible in the raw <details>
// block below so no information is lost.
function summarize(event: AgentEvent): string {
  const p = event.payload;
  switch (event.type) {
    case "step":
      return summarizeStep(p);
    case "llm_call": {
      const cached = num(p, "cacheReadTokens");
      const cachedNote = cached != null ? ` (${cached.toLocaleString()} cached)` : "";
      return `${field(p, "role") ?? "model"} call (${event.model ?? field(p, "model") ?? "unknown model"}), attempt ${field(p, "attempt") ?? "0"}, ${event.tokensIn ?? "?"} in${cachedNote} / ${event.tokensOut ?? "?"} out tokens`;
    }
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
        {events.map((event) => {
          const stepKind = event.type === "step" ? field(event.payload, "step") : null;
          const traceId = field(event.payload, "traceId");
          return (
            <details
              key={event.id}
              className={`trace-entry trace-entry-${event.type}${stepKind ? ` trace-entry-step-${stepKind}` : ""}`}
            >
              <summary>
                <span className="trace-type">{event.type}</span>
                <span className="trace-summary">{summarize(event)}</span>
                {traceId && (
                  <span className="trace-id" title={`Trace id for this turn: ${traceId} (see server logs)`}>
                    {traceId.slice(0, 8)}
                  </span>
                )}
                {event.latencyMs !== null && <span className="trace-latency">{event.latencyMs} ms</span>}
              </summary>
              <pre className="trace-raw">{JSON.stringify(event, null, 2)}</pre>
            </details>
          );
        })}
      </div>
    </aside>
  );
}
