import { createHash } from "node:crypto";
import type { ActionType } from "../tools/schemas.js";

// Deterministic per PLAN Section 7 step 2: sha256(threadId + actionType +
// orderId + amount). Same logical action always derives the same key, so a
// retry (same thread, same action, same order, same amount) collides on the
// same actions_ledger row instead of creating a new one. amount is
// normalized to 2 decimal places so 500 and 500.00 derive the same key.
export function deriveIdempotencyKey(
  threadId: string,
  actionType: ActionType,
  orderId: string | null,
  amount: number,
): string {
  const normalizedAmount = amount.toFixed(2);
  const input = `${threadId}:${actionType}:${orderId ?? "none"}:${normalizedAmount}`;
  return createHash("sha256").update(input).digest("hex");
}
