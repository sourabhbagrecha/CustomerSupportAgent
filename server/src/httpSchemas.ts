import { z } from "zod";
import { FaultNameSchema } from "./faults/types.js";

export const ChatRequestSchema = z.object({
  threadId: z.string().min(1),
  customerId: z.string().min(1),
  message: z.string().min(1),
});

export const ApprovalResolveRequestSchema = z.object({
  decision: z.enum(["approve", "reject"]),
});

export const FaultRequestSchema = z.object({
  name: FaultNameSchema,
  enabled: z.boolean(),
  uses: z.number().int().positive().optional(),
});
