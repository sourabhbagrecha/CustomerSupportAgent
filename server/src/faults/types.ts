import { z } from "zod";

export const FaultNameSchema = z.enum([
  "refund_timeout_after_success",
  "model_rate_limit_primary",
  "model_down_all",
  "tool_500",
  "tool_slow",
  "malformed_tool_args",
]);
export type FaultName = z.infer<typeof FaultNameSchema>;

export const FAULT_NAMES: FaultName[] = FaultNameSchema.options;

// Faults are either a plain on/off switch, or carry a remaining-uses counter
// (e.g. "rate limit the next N calls"). `enabled: true` with no `remaining`
// means "stays on until explicitly cleared".
export const FaultStateSchema = z.object({
  enabled: z.boolean(),
  remaining: z.number().int().nonnegative().optional(),
});
export type FaultState = z.infer<typeof FaultStateSchema>;

export const FaultRegistrySnapshotSchema = z.record(FaultNameSchema, FaultStateSchema);
export type FaultRegistrySnapshot = z.infer<typeof FaultRegistrySnapshotSchema>;
