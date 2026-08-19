import { z } from "zod";
import { OrderStatusSchema } from "../tools/schemas.js";

// Machine-enforced limits. Generated from the same source as policy.md by
// scripts/generate-fixtures.ts; a unit test asserts the two never drift.
export const PolicyDocumentSchema = z.object({
  maxAutoRefundINR: z.number().positive(),
  maxAutoCreditINR: z.number().positive(),
  refundWindowDays: z.number().int().positive(),
  eligibleOrderStatusesForRefund: z.array(OrderStatusSchema),
});
export type PolicyDocument = z.infer<typeof PolicyDocumentSchema>;

export const PolicyDenyReasonSchema = z.enum([
  "order_not_found",
  "order_not_owned_by_customer",
  "order_not_eligible_status",
  "outside_refund_window",
  "exceeds_refundable_amount",
  "invalid_amount",
]);
export type PolicyDenyReason = z.infer<typeof PolicyDenyReasonSchema>;

const PolicyVerdictBase = {
  reason: z.string(),
};

export const PolicyVerdictSchema = z.discriminatedUnion("verdict", [
  z.object({ verdict: z.literal("allow"), ...PolicyVerdictBase }),
  z.object({ verdict: z.literal("requires_approval"), ...PolicyVerdictBase }),
  z.object({ verdict: z.literal("deny"), ...PolicyVerdictBase, denyReason: PolicyDenyReasonSchema }),
]);
export type PolicyVerdict = z.infer<typeof PolicyVerdictSchema>;
