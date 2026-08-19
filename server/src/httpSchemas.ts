import { z } from "zod";
import { FaultNameSchema } from "./faults/types.js";
import { LedgerStatusSchema } from "./ledger/store.js";

export const ChatRequestSchema = z.object({
  threadId: z.string().min(1),
  customerId: z.string().min(1),
  message: z.string().min(1),
});

// A remark is how the customer learns why a request was refused (see
// server/src/agent/notify.ts), so rejecting or upholding a denial requires
// one; approving is free to go through without an explanation.
export const ApprovalResolveRequestSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    remark: z.string().trim().max(500).optional(),
  })
  .refine((data) => data.decision !== "reject" || (data.remark && data.remark.length > 0), {
    message: "A remark is required when rejecting or upholding a denial.",
    path: ["remark"],
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
