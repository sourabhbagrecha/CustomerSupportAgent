import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import type Database from "better-sqlite3";
import { getPendingApprovalForThread } from "../ledger/approvals.js";
import type { AgentGraph } from "./graph.js";
import { DEGRADED_REPLY_TEXT, recordDegradedEscalation } from "./degradedReply.js";
import { ModelsUnavailable } from "./errors.js";
import type { AgentState, ResolutionStatus } from "./state.js";

export interface RunTurnResult {
  reply: string | null;
  status: ResolutionStatus;
  degraded: boolean;
}

function extractResult(db: Database.Database, threadId: string, state: AgentState): RunTurnResult {
  const lastAi = [...state.messages].reverse().find((m): m is AIMessage => m instanceof AIMessage);
  const content = lastAi?.content;
  const text = typeof content === "string" ? content : content ? JSON.stringify(content) : "";
  if (getPendingApprovalForThread(db, threadId)) {
    // A requires_approval interrupt() pauses mid-turn, so the last AI message
    // is the empty-content tool-call message: text is "" and the pending
    // status is the only thing to show. An escalation completes its turn normally
    // first, so the agent's own reply text (e.g. "I've escalated this...")
    // is real and belongs in the transcript alongside the pending-decision status.
    return { reply: text || null, status: "awaiting_approval", degraded: false };
  }
  return { reply: text, status: state.resolutionStatus, degraded: false };
}

function config(threadId: string, db: Database.Database) {
  return { configurable: { thread_id: threadId, db } };
}

// Runs one customer turn end to end, including the LLM-free degradation
// path (CLAUDE.md invariant 6): if both models are unavailable, this never
// touches the graph's model client again, it only writes a deterministic
// escalation and returns a fixed message.
export async function runTurn(params: {
  db: Database.Database;
  graph: AgentGraph;
  threadId: string;
  customerId: string;
  userMessage: string;
}): Promise<RunTurnResult> {
  const input = {
    messages: [new HumanMessage(params.userMessage)],
    threadId: params.threadId,
    customerId: params.customerId,
  };
  try {
    const state = (await params.graph.invoke(input, config(params.threadId, params.db))) as AgentState;
    return extractResult(params.db, params.threadId, state);
  } catch (err) {
    if (err instanceof ModelsUnavailable) {
      recordDegradedEscalation(params.db, {
        threadId: params.threadId,
        customerId: params.customerId,
        detail: err.message,
      });
      return { reply: DEGRADED_REPLY_TEXT, status: "escalated", degraded: true };
    }
    throw err;
  }
}

// Resumes a thread paused at an issue_refund/issue_credit interrupt() with a
// human approve/reject decision from the approval panel.
export async function resumeApprovalTurn(params: {
  db: Database.Database;
  graph: AgentGraph;
  threadId: string;
  customerId: string;
  decision: "approve" | "reject";
  remark?: string | null;
}): Promise<RunTurnResult> {
  try {
    const state = (await params.graph.invoke(
      new Command({ resume: { decision: params.decision, remark: params.remark ?? null } }),
      config(params.threadId, params.db),
    )) as AgentState;
    return extractResult(params.db, params.threadId, state);
  } catch (err) {
    if (err instanceof ModelsUnavailable) {
      recordDegradedEscalation(params.db, {
        threadId: params.threadId,
        customerId: params.customerId,
        detail: err.message,
      });
      return { reply: DEGRADED_REPLY_TEXT, status: "escalated", degraded: true };
    }
    throw err;
  }
}
