import { AIMessage } from "@langchain/core/messages";
import type Database from "better-sqlite3";
import type { ApprovalRow } from "../ledger/approvals.js";
import type { MoneyActionResult } from "../tools/schemas.js";
import type { AgentGraph } from "./graph.js";

// P0-3 backstop: a small wordlist-based profanity filter applied ONLY to
// customer-facing text (never to the internal reviewer note, which stays
// verbatim in the audit trail). This is deliberately not the primary
// safeguard against a reviewer typing something inappropriate into the
// customer field (that's the UI's job, plus reviewer conduct); it exists so
// that even if something profane lands in the customer-facing field, it
// cannot reach the customer's chat transcript verbatim. Word-boundary,
// case-insensitive match; matched words are replaced, not the whole message,
// so the customer still gets the substance of the explanation.
const PROFANITY_WORDLIST = [
  "fuck",
  "shit",
  "bitch",
  "asshole",
  "bastard",
  "cunt",
  "dick",
  "piss",
  "crap",
];
// No leading/trailing \b: matching \w* on both sides of the bad substring
// redacts the WHOLE containing word (so "fucking" and "bullshit" both get
// fully redacted, not left partially intact). This is a known, accepted
// tradeoff for a "simple wordlist" backstop: it can over-redact an innocent
// word that merely contains one of these substrings (the classic
// "Scunthorpe problem"). That is the safer failure mode for a customer
// support transcript than under-redacting, so it is not treated as a bug.
const PROFANITY_PATTERN = new RegExp(`\\w*(${PROFANITY_WORDLIST.join("|")})\\w*`, "gi");

function sanitizeCustomerText(text: string): string {
  return text.replace(PROFANITY_PATTERN, "[redacted]");
}

// The customer-facing text for a human decision on an escalation or a
// requires_approval pause. Deterministic and code-authored (CLAUDE.md "the
// LLM proposes, code disposes"). `customerNote` is the reviewer's
// CUSTOMER-FACING explanation only (P0-3): the internal reviewer note is a
// separate field (ApprovalRow.remark) that AuditPanel.tsx alone renders and
// that never reaches this function, so it cannot leak into the transcript no
// matter what a reviewer typed there. customerNote is still run through
// sanitizeCustomerText as a backstop before it is ever appended.
export function buildDecisionNotice(params: {
  approval: ApprovalRow;
  decision: "approve" | "reject";
  moneyResult: MoneyActionResult | null;
  customerNote: string | null;
}): string {
  const { approval, decision, moneyResult, customerNote } = params;
  const lines: string[] = [];

  const actionLabel = approval.actionType === "credit" ? "credit" : "refund";
  const amountLabel =
    moneyResult && "amount" in moneyResult
      ? new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(
          moneyResult.amount,
        )
      : null;

  if (moneyResult) {
    if (moneyResult.status === "succeeded" || moneyResult.status === "reconciled") {
      lines.push(
        decision === "approve" && approval.kind === "escalation"
          ? `Update on your request: our team reviewed the earlier decision and is making an exception. Your ${actionLabel} of ${amountLabel} has been processed.`
          : `Update on your request: your ${actionLabel} of ${amountLabel} has been approved and processed.`,
      );
    } else if (moneyResult.status === "failed_unknown") {
      lines.push(
        `Update on your request: the ${actionLabel} was approved, but we could not confirm it completed. Our team is following up.`,
      );
    } else {
      lines.push(
        `Update on your request: after review, the earlier decision stands. We are not able to issue this ${actionLabel}.`,
      );
    }
  } else {
    lines.push(
      decision === "approve"
        ? "Update on your request: our team has reviewed this and it has been resolved."
        : "Update on your request: our team has reviewed this and the earlier decision stands.",
    );
  }

  if (customerNote) {
    lines.push("");
    lines.push(`Note: ${sanitizeCustomerText(customerNote)}`);
  }

  return lines.join("\n");
}

// Appends a deterministic notice to a thread's checkpointed conversation
// state, outside of a normal turn. Needed because an escalation review
// happens after the agent's turn already ended (no interrupt() is pending to
// resume), so this is the only way the decision reaches the customer's
// transcript: written straight to LangGraph state so it survives reload and
// shows up in GET /api/threads/:id/state exactly like any other AI message.
export async function appendDecisionNotice(
  db: Database.Database,
  graph: AgentGraph,
  threadId: string,
  text: string,
): Promise<void> {
  await graph.updateState(
    { configurable: { thread_id: threadId, db } },
    { messages: [new AIMessage(text)], resolutionStatus: "resolved" },
    "agent",
  );
}
