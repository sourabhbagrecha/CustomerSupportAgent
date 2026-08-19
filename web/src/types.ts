// Shared frontend types mirroring the backend's Zod-validated shapes
// (server/src/httpSchemas.ts, server/src/faults/types.ts, server/src/personas.ts,
// server/src/ledger/approvals.ts, server/src/events/types.ts). Kept as plain
// TypeScript here since the frontend only reads these shapes over fetch/SSE;
// it does not need its own Zod validation layer for a demo app.

export interface Persona {
  customerId: string;
  name: string;
  label: string;
}

// Fixed list from server/src/faults/types.ts. Hardcoded per the task spec
// rather than fetched from a schema endpoint.
export const FAULT_NAMES = [
  "refund_timeout_after_success",
  "model_rate_limit_primary",
  "model_down_all",
  "tool_500",
  "tool_slow",
  "malformed_tool_args",
] as const;
export type FaultName = (typeof FAULT_NAMES)[number];

export interface FaultState {
  enabled: boolean;
  remaining?: number;
}

export type FaultsSnapshot = Partial<Record<FaultName, FaultState>>;

export type ActionType = "refund" | "credit";

export interface ApprovalRow {
  id: number;
  ledgerId: number;
  threadId: string;
  actionType: ActionType;
  customerId: string;
  orderId: string | null;
  amount: number;
  policyReason: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export type ResolutionStatus = "open" | "resolved" | "escalated" | "awaiting_approval";

export interface ChatResponse {
  reply: string | null;
  status: ResolutionStatus;
  degraded: boolean;
}

export interface ChatMessage {
  role: "customer" | "agent";
  content: string;
}

export interface ThreadState {
  threadId: string;
  resolutionStatus: ResolutionStatus;
  messages: ChatMessage[];
  pendingApproval: ApprovalRow | null;
}

export interface ThreadSummary {
  threadId: string;
  customerId: string | null;
  personaName: string | null;
  personaLabel: string | null;
  startedAt: string;
  lastActivity: string;
  resolutionStatus: ResolutionStatus;
  messageCount: number;
  preview: string;
}

export type AgentEventType =
  | "step"
  | "llm_call"
  | "tool_call"
  | "tool_result"
  | "guardrail"
  | "fault"
  | "failover"
  | "escalation"
  | "error";

export interface AgentEvent {
  id: number;
  threadId: string;
  ts: string;
  type: AgentEventType;
  payload: Record<string, unknown>;
  latencyMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  model: string | null;
}

// Named "token" SSE events on the same connection (server/src/events/types.ts
// AgentStreamEvent). Ephemeral chat-streaming sugar, not part of the durable
// AgentEvent trace above.
export type AgentStreamEvent = { type: "start" } | { type: "delta"; text: string } | { type: "end" };
