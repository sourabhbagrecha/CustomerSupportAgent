// Shared frontend types mirroring the backend's Zod-validated shapes
// (server/src/httpSchemas.ts, server/src/faults/types.ts, server/src/personas.ts,
// server/src/ledger/approvals.ts, server/src/ledger/store.ts,
// server/src/events/types.ts). Kept as plain
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
export type ApprovalKind = "policy_approval" | "escalation";

export interface ApprovalRow {
  id: number;
  kind: ApprovalKind;
  ledgerId: number | null;
  threadId: string;
  actionType: ActionType | null;
  customerId: string;
  orderId: string | null;
  amount: number | null;
  policyReason: string;
  denialReason: string | null;
  category: string | null;
  context: string | null;
  remark: string | null;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  executedAt: string | null;
}

// GET /api/approvals/pending: an ApprovalRow plus the persona lookup the server
// does from DEMO_PERSONAS, so the queue can name a customer without a second call.
export interface PendingApprovalSummary extends ApprovalRow {
  personaName: string | null;
  personaLabel: string | null;
}

// Mirrors LedgerStatusSchema in server/src/ledger/store.ts.
export const LEDGER_STATUSES = [
  "pending",
  "succeeded",
  "failed",
  "failed_unknown",
  "reconciled",
  "denied",
  "awaiting_approval",
] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

export interface LedgerRow {
  id: number;
  idempotencyKey: string;
  threadId: string;
  actionType: ActionType;
  customerId: string;
  orderId: string | null;
  amount: number;
  currency: string;
  status: LedgerStatus;
  reason: string;
  createdAt: string;
  resolvedAt: string | null;
  rawResponse: string | null;
}

export interface LedgerPage {
  rows: LedgerRow[];
  total: number;
  limit: number;
  offset: number;
}

export type ResolutionStatus =
  | "open"
  | "waiting_for_customer"
  | "resolved"
  | "escalated"
  | "awaiting_approval";

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

// Mirrors server/src/evals/runRecord.ts (EvalScenarioSchema, EvalRunSchema)
// and server/src/httpSchemas.ts (EvalRunRequestSchema) by hand: the web
// tsconfig cannot import server code, so these are kept in lockstep manually
// (plan 007). One eval run = one archived record under evals/runs/; this
// replaces the single-snapshot evals/results.json shape the earlier draft
// used, since GET /api/evals no longer exists.
export type EvalScenarioStatus = "pass" | "fail" | "documented_red";
export type EvalJudgeState = "scored" | "unscored" | null;

export interface EvalScenario {
  number: number;
  name: string;
  status: EvalScenarioStatus;
  latencyMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  notes: string[];
  judgeNotes: string[];
  judgeState: EvalJudgeState;
}

export type EvalRunSource = "cli" | "ui";
export type EvalRunStatus = "running" | "completed" | "failed" | "cancelled";

// No key field anywhere on purpose: keys live in the server's environment and
// never reach a run record or the browser (see api.ts startEvalRun).
export interface EvalRunProvider {
  baseUrl: string;
  primaryModel: string | null;
  fallbackModel: string | null;
  judgeModel: string | null;
  judgeBaseUrl: string;
}

export interface EvalJudgeStates {
  scored: number;
  unscored: number;
  notApplicable: number;
}

// Price snapshot taken when the run started (plan 008), from OpenRouter's
// public model listing: USD per million tokens for the primary model. null
// when the listing was unreachable or does not price that model, in which
// case the cost column shows n/a rather than a guess.
export interface EvalRunPricing {
  source: "openrouter";
  openrouterModelId: string;
  promptUsdPerMillion: number;
  completionUsdPerMillion: number;
  fetchedAt: string;
}

export interface EvalRun {
  schemaVersion: 1;
  runId: string;
  label: string;
  source: EvalRunSource;
  status: EvalRunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  // Set only when status is "failed" (the runner itself did not produce a
  // suite result); null otherwise. Scenario-level failures live on the rows.
  failureReason: string | null;
  provider: EvalRunProvider;
  // null = the full suite; otherwise the scenario numbers that were run.
  scenarioFilter: number[] | null;
  gitCommit: string | null;
  promptSha256: string;
  fixturesSha256: string;
  judgeStates: EvalJudgeStates;
  scenarios: EvalScenario[];
  pricing: EvalRunPricing | null;
}

// GET /api/evals/config response.
export interface EvalConfigDefaults {
  baseUrl: string;
  primaryModel: string;
  fallbackModel: string;
  apiKeyEnv: string;
  judgeModel: string;
  judgeBaseUrl: string;
  judgeApiKeyEnv: string;
}

export interface EvalBaseUrlPreset {
  label: string;
  baseUrl: string;
}

export interface EvalScenarioListing {
  number: number;
  name: string;
}

export interface EvalConfig {
  defaults: EvalConfigDefaults;
  apiKeyEnvs: string[];
  presets: EvalBaseUrlPreset[];
  scenarios: EvalScenarioListing[];
}

// Body for POST /api/evals/runs, mirroring EvalRunRequestSchema. Every
// optional field left out means "use the server's default resolution."
export interface EvalRunRequest {
  label?: string;
  baseUrl: string;
  primaryModel: string;
  fallbackModel?: string;
  apiKeyEnv?: string;
  judgeModel?: string;
  judgeBaseUrl?: string;
  judgeApiKeyEnv?: string;
  scenarios?: number[];
}

// GET /api/evals/current (and the 202 body POST /api/evals/runs returns): the
// in-progress run's partial state plus the runner's log tail, or the route
// returns { current: null } once nothing is running.
export interface EvalCurrentRun {
  run: EvalRun;
  logTail: string[];
  expectedScenarioCount: number;
}
