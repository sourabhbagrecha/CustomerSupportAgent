import type Database from "better-sqlite3";
import { emitEvent } from "../events/emitter.js";

export const DEGRADED_REPLY_TEXT =
  "I'm sorry, our support systems are temporarily unavailable and I'm not able to process your request right now. " +
  "I've created an escalation so a member of our team can follow up with you as soon as possible. Thank you for your patience.";

// CLAUDE.md invariant 6: this path must never import or invoke any model
// client. It only writes a deterministic escalation event and returns a
// fixed message; no LLM call happens anywhere in this function or its
// dependencies.
export function recordDegradedEscalation(
  db: Database.Database,
  params: { threadId: string; customerId: string; detail: string },
): number {
  const event = emitEvent(db, {
    threadId: params.threadId,
    type: "escalation",
    payload: {
      customerId: params.customerId,
      reason: "Both primary and fallback models were unavailable.",
      category: "unknown_failure",
      context: params.detail,
      relatedLedgerId: null,
      degraded: true,
    },
  });
  return event.id!;
}
