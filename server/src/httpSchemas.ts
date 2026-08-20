import { z } from "zod";
import { isHttpUrl } from "./agent/providerConfig.js";
import { FaultNameSchema } from "./faults/types.js";
import { LedgerStatusSchema } from "./ledger/store.js";

export const ChatRequestSchema = z.object({
  threadId: z.string().min(1),
  customerId: z.string().min(1),
  message: z.string().min(1),
});

// P0-3 hardening: the reviewer remark is split into two independent fields.
// `internalNote` is audit-only (AuditPanel.tsx alone renders it; it is never
// sent to the customer). `customerNote` is the only field notify.ts ever
// relays to the customer (behind a profanity backstop), which is how the
// customer learns why a request was refused, so rejecting or upholding a
// denial requires a customerNote; approving is free to go through without
// one. internalNote is always optional on both paths.
export const ApprovalResolveRequestSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    internalNote: z.string().trim().max(500).optional(),
    customerNote: z.string().trim().max(500).optional(),
  })
  .refine((data) => data.decision !== "reject" || (data.customerNote && data.customerNote.length > 0), {
    message: "A customer-facing explanation is required when rejecting or upholding a denial.",
    path: ["customerNote"],
  });

export const FaultRequestSchema = z.object({
  name: FaultNameSchema,
  enabled: z.boolean(),
  uses: z.number().int().positive().optional(),
});

// Query string for GET /api/ledger. Values arrive as strings, hence z.coerce.
// The limit is capped rather than clamped so a bad request 400s like every
// other route here; the cap itself matters because getDb() is one shared
// synchronous connection and an unbounded SELECT would block the event loop.
export const LedgerQuerySchema = z.object({
  status: LedgerStatusSchema.optional(),
  threadId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

// Body for POST /api/evals/runs (plan 007). Keys are referenced by the NAME
// of an environment variable, never by value: the server resolves it from
// its own process.env, so no secret crosses the wire in either direction.
// Base URL shape is checked here; the trailing "/chat/completions" trim and
// the judge defaults are applied by providerConfig in the route.
const envVarName = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]*_API_KEY$/, "Key variable names must look like SOMETHING_API_KEY.");

const httpUrl = z.string().trim().max(300).refine(isHttpUrl, "Base URL must be an absolute http(s) URL.");

export const EvalRunRequestSchema = z.object({
  label: z.string().trim().max(80).optional(),
  baseUrl: httpUrl,
  primaryModel: z.string().trim().min(1).max(120),
  fallbackModel: z.string().trim().min(1).max(120).optional(),
  apiKeyEnv: envVarName.default("OPENAI_API_KEY"),
  judgeModel: z.string().trim().min(1).max(120).optional(),
  judgeBaseUrl: httpUrl.optional(),
  judgeApiKeyEnv: envVarName.optional(),
  // Scenario numbers as listed in evals/scenarios/. Omitted = full suite;
  // an empty list is a request to run nothing and is rejected.
  scenarios: z.array(z.number().int().positive()).min(1).max(100).optional(),
});

export type EvalRunRequest = z.infer<typeof EvalRunRequestSchema>;
