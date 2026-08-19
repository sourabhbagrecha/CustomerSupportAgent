import { AIMessage } from "@langchain/core/messages";
import type Database from "better-sqlite3";
import type { ApprovalRow } from "../ledger/approvals.js";
import type { MoneyActionResult } from "../tools/schemas.js";
import type { AgentGraph } from "./graph.js";

// The customer-facing text for a human decision on an escalation or a
// requires_approval pause. Deterministic and code-authored (CLAUDE.md "the
// LLM proposes, code disposes"): the reviewer's remark must reach the
// customer verbatim, never paraphrased, softened, or dropped by a model call.
export function buildDecisionNotice(params: {
  approval: ApprovalRow;
  decision: "approve" | "reject";
  moneyResult: MoneyActionResult | null;
  remark: string | null;
}): string {
  const { approval, decision, moneyResult, remark } = params;
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

  if (remark) {
    lines.push("");
    lines.push(`Reviewer note: ${remark}`);
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
