import { z } from "zod";

export const EventTypeSchema = z.enum([
  "step",
  "llm_call",
  "tool_call",
  "tool_result",
  "guardrail",
  "fault",
  "failover",
  "escalation",
  "error",
]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const AgentEventSchema = z.object({
  id: z.number().int().optional(),
  threadId: z.string(),
  ts: z.string(),
  type: EventTypeSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
  latencyMs: z.number().int().nonnegative().nullable().optional(),
  tokensIn: z.number().int().nonnegative().nullable().optional(),
  tokensOut: z.number().int().nonnegative().nullable().optional(),
  model: z.string().nullable().optional(),
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export type NewAgentEvent = Omit<AgentEvent, "id" | "ts">;

// Ephemeral token-stream events for live chat rendering. These are transport
// sugar for an in-flight llm_call, not part of the durable trace taxonomy
// above: never written to the events table, never read by the eval harness.
// The durable "llm_call" AgentEvent is still emitted once per call, unchanged.
export type AgentStreamEvent = { type: "start" } | { type: "delta"; text: string } | { type: "end" };
