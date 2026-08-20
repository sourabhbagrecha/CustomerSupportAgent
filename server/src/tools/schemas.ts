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

export const GetCustomerInputSchema = z.object({});
export const GetOrdersInputSchema = z.object({});
export const GetPaymentsInputSchema = z.object({ orderId: z.string() });
export const GetConversationHistoryInputSchema = z.object({
  query: z.string().optional(),
});
export const SearchPolicyInputSchema = z.object({ query: z.string() });

// Moved above EscalateToHumanInputSchema (which references it via
// pendingAction) so both the runtime const-initialization order and the
// z.infer type below stay valid; ActionTypeSchema was previously declared
// further down, right before MoneyActionResultSchema, where it still logically
// belongs and is still used.
export const ActionTypeSchema = z.enum(["refund", "credit"]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

// customerId and threadId are NEVER model-suppliable for ANY tool: they come
// from graph state (runtimeState(runtime).customerId), not from tool input.
// idempotencyKey is NEVER model-suppliable either: it is derived
// deterministically by the ledger. get_payments still takes an orderId
// because the model has to say which order it means, but the tool
// implementation verifies that order belongs to the calling customer before
// answering. This is what makes both the money path and the read path
// jailbreak-proof regardless of what the model claims.
// citesPriorPromise (P1-4 hardening): the model must set this true whenever
// this call's justification rests on the customer's claim that a past agent
// already promised this outcome (prompt.ts hard rule 6/9). The ledger
// pipeline (server/src/ledger/pipeline.ts, runMoneyAction) treats this as a
// deterministic gate: true without an actual get_conversation_history call
// earlier in the same turn blocks all automatic money on this claim, capped
// portion included, and denies with a machine-checkable reason instead of
// trusting the model's unverified paraphrase.
export const IssueRefundInputSchema = z.object({
  orderId: z.string(),
  amount: z.number().positive(),
  reason: z.string(),
  citesPriorPromise: z.boolean().optional(),
});
export type IssueRefundInput = z.infer<typeof IssueRefundInputSchema>;

export const IssueCreditInputSchema = z.object({
  orderId: z.string().optional(),
  amount: z.number().positive(),
  reason: z.string(),
  citesPriorPromise: z.boolean().optional(),
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

// pendingAction (P0-1 hardening): set this when the escalation is about a
// specific money amount a human still needs to decide on (most commonly the
// above-cap remainder after a policy-capped portion already auto-issued,
// prompt.ts hard rule 6). When present, escalate_to_human creates a NEW,
// dedicated ledger row for exactly this amount (never reusing or pointing at
// an already-settled row), so the audit card and the eventual grant/uphold
// decision both act on the right amount. Omit it for escalations with no
// money action attached (distress, legal threat, a repeated override
// attempt with nothing new to authorize).
export const EscalateToHumanInputSchema = z.object({
  reason: z.string(),
  category: EscalationCategorySchema,
  context: z.string(),
  relatedLedgerId: z.number().int().optional(),
  pendingAction: z
    .object({
      actionType: ActionTypeSchema,
      orderId: z.string().nullable(),
      amount: z.number().positive(),
    })
    .optional(),
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

// ---------------------------------------------------------------------------
// Raw mock-provider result (Phase 3 runtime output validation). This is the
// single source of truth for the shape issueMoneyMovement (mockApi.ts)
// returns; that file derives its MoneyCallResult type from this schema
// instead of declaring a parallel interface. The ledger pipeline parses the
// raw provider result against this schema before trusting it (see
// callRawMockApi in ledger/pipeline.ts): a malformed response is treated as
// an uncertain outcome, exactly like a timeout, never as data to coerce and
// move on from.
// ---------------------------------------------------------------------------

export const RawPaymentResultSchema = z.object({
  paymentId: z.string().min(1),
  providerReference: z.string(),
});
export type RawPaymentResult = z.infer<typeof RawPaymentResultSchema>;
