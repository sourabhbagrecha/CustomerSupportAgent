import { z } from "zod";

// Single source of truth for domain entities and the eight assignment tool
// APIs. TypeScript types are derived (z.infer) everywhere; evals import
// these same schemas rather than redeclaring shapes.

// ---------------------------------------------------------------------------
// Domain entities
// ---------------------------------------------------------------------------

export const CustomerSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  createdAt: z.string(),
});
export type Customer = z.infer<typeof CustomerSchema>;

export const OrderStatusSchema = z.enum([
  "placed",
  "delivered",
  "failed_delivery",
  "cancelled",
  "refunded",
  "partially_refunded",
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const OrderSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  itemName: z.string(),
  amount: z.number().positive(),
  currency: z.literal("INR"),
  status: OrderStatusSchema,
  orderDate: z.string(),
  deliveryDate: z.string().nullable(),
});
export type Order = z.infer<typeof OrderSchema>;

export const PaymentTypeSchema = z.enum(["charge", "refund", "credit"]);
export type PaymentType = z.infer<typeof PaymentTypeSchema>;

export const PaymentSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  customerId: z.string(),
  amount: z.number().positive(),
  currency: z.literal("INR"),
  type: PaymentTypeSchema,
  status: z.enum(["succeeded", "failed", "pending"]),
  idempotencyKey: z.string().nullable(),
  providerReference: z.string().nullable(),
  createdAt: z.string(),
});
export type Payment = z.infer<typeof PaymentSchema>;

export const ConversationSummaryHitSchema = z.object({
  conversationId: z.string(),
  date: z.string(),
  orderId: z.string().nullable(),
  topicTags: z.array(z.string()),
  outcome: z.string().nullable(),
  summaryText: z.string(),
  score: z.number(),
  transcript: z
    .array(z.object({ role: z.enum(["customer", "agent"]), content: z.string(), ts: z.string() }))
    .optional(),
});
export type ConversationSummaryHit = z.infer<typeof ConversationSummaryHitSchema>;

export const PolicyChunkHitSchema = z.object({
  heading: z.string(),
  text: z.string(),
  score: z.number(),
});
export type PolicyChunkHit = z.infer<typeof PolicyChunkHitSchema>;

// ---------------------------------------------------------------------------
// Tool inputs (what the model is allowed to supply)
// ---------------------------------------------------------------------------

export const GetCustomerInputSchema = z.object({ customerId: z.string() });
export const GetOrdersInputSchema = z.object({ customerId: z.string() });
export const GetPaymentsInputSchema = z.object({ orderId: z.string() });
export const GetConversationHistoryInputSchema = z.object({
  customerId: z.string(),
  query: z.string().optional(),
});
export const SearchPolicyInputSchema = z.object({ query: z.string() });

// customerId and threadId are NOT model-suppliable: they come from graph
// state. idempotencyKey is NEVER model-suppliable: it is derived
// deterministically by the ledger. This is what makes the money path
// jailbreak-proof regardless of what the model claims.
export const IssueRefundInputSchema = z.object({
  orderId: z.string(),
  amount: z.number().positive(),
  reason: z.string(),
});
export type IssueRefundInput = z.infer<typeof IssueRefundInputSchema>;

export const IssueCreditInputSchema = z.object({
  orderId: z.string().optional(),
  amount: z.number().positive(),
  reason: z.string(),
});
export type IssueCreditInput = z.infer<typeof IssueCreditInputSchema>;

export const EscalationCategorySchema = z.enum([
  "policy_conflict",
  "cap_breach",
  "distress",
  "repeated_override_attempt",
  "legal_threat",
  "unknown_failure",
  "other",
]);
export type EscalationCategory = z.infer<typeof EscalationCategorySchema>;

export const EscalateToHumanInputSchema = z.object({
  reason: z.string(),
  category: EscalationCategorySchema,
  context: z.string(),
  relatedLedgerId: z.number().int().optional(),
});
export type EscalateToHumanInput = z.infer<typeof EscalateToHumanInputSchema>;

// ---------------------------------------------------------------------------
// Tool outputs
// ---------------------------------------------------------------------------

export const GetConversationHistoryOutputSchema = z.object({
  hits: z.array(ConversationSummaryHitSchema),
});

export const SearchPolicyOutputSchema = z.object({
  chunks: z.array(PolicyChunkHitSchema),
});

export const ActionTypeSchema = z.enum(["refund", "credit"]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

const MoneyActionResultBase = {
  ledgerId: z.number().int(),
  actionType: ActionTypeSchema,
  amount: z.number().positive(),
  currency: z.literal("INR"),
  orderId: z.string().nullable(),
};

export const MoneyActionResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("succeeded"),
    ...MoneyActionResultBase,
    receipt: z.object({ paymentId: z.string(), providerReference: z.string().nullable() }),
  }),
  z.object({
    status: z.literal("reconciled"),
    ...MoneyActionResultBase,
    receipt: z.object({ paymentId: z.string(), providerReference: z.string().nullable() }),
    note: z.string(),
  }),
  z.object({
    status: z.literal("awaiting_approval"),
    ...MoneyActionResultBase,
    policyReason: z.string(),
  }),
  z.object({
    status: z.literal("denied"),
    ...MoneyActionResultBase,
    policyReason: z.string(),
  }),
  z.object({
    status: z.literal("failed_unknown"),
    ...MoneyActionResultBase,
    policyReason: z.string(),
  }),
]);
export type MoneyActionResult = z.infer<typeof MoneyActionResultSchema>;

export const EscalateToHumanOutputSchema = z.object({
  escalationEventId: z.number().int(),
  approvalId: z.number().int(),
  status: z.literal("escalated"),
  summary: z.string(),
});
export type EscalateToHumanOutput = z.infer<typeof EscalateToHumanOutputSchema>;
