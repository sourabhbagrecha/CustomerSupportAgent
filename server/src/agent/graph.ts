import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { SystemMessage, ToolMessage, type AIMessage } from "@langchain/core/messages";
import type Database from "better-sqlite3";
import { emitEvent } from "../events/emitter.js";
import { hasTerminalLedgerRowForThread } from "../ledger/store.js";
import { AGENT_TOOLS } from "../tools/agentTools.js";
import { callModelWithFailover } from "./modelClient.js";
import { loadContext } from "./loadContext.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { AgentStateAnnotation, type AgentState, type ResolutionStatus } from "./state.js";

const rawToolNode = new ToolNode(AGENT_TOOLS);

function lastMessage(state: AgentState) {
  return state.messages[state.messages.length - 1];
}

function hasToolCalls(message: unknown): message is AIMessage {
  return (
    !!message &&
    typeof message === "object" &&
    "tool_calls" in message &&
    Array.isArray((message as AIMessage).tool_calls) &&
    (message as AIMessage).tool_calls!.length > 0
  );
}

// Builds a graph bound to one db instance. Production binds this to the
// singleton app db; the eval harness calls this once per scenario with an
// isolated temp db, so checkpoints and app data never leak across scenarios.
export function buildAgentGraph(db: Database.Database) {
  const checkpointer = new SqliteSaver(db);

  async function loadContextNode(state: AgentState) {
    const { retrievedContextBlock } = await loadContext(db, state);
    emitEvent(db, { threadId: state.threadId, type: "step", payload: { step: "loadContext", customerId: state.customerId } });
    return { retrievedContextBlock };
  }

  // Status rule: a thread only reaches "resolved" after a concrete ledger
  // outcome. A reply with no tool calls just means the agent asked
  // something or is waiting on the customer, not that anything was
  // decided, so it moves to "waiting_for_customer" and only flips to
  // "resolved" once a terminal ledger row (succeeded, reconciled, denied,
  // or failed_unknown) exists for this thread. Both "open" and
  // "waiting_for_customer" have to trigger this check, not just "open":
  // resolutionStatus is checkpointed and persists across turns, and
  // nothing else resets it, so gating on "open" alone would strand a
  // thread in "waiting_for_customer" forever once it first landed there.
  // Other statuses (escalated, awaiting_approval, resolved) pass through
  // unchanged. Known limitation, accepted for the demo: this only checks
  // whether a terminal ledger row exists on the thread at all, not whether
  // it is recent, so a later, unrelated follow-up question on an
  // already-resolved thread still reads "resolved" as soon as the agent
  // replies without a new tool call.
  function nextResolutionStatus(state: AgentState, aiMessage: unknown): ResolutionStatus {
    const canTransition = state.resolutionStatus === "open" || state.resolutionStatus === "waiting_for_customer";
    if (!canTransition || hasToolCalls(aiMessage)) return state.resolutionStatus;
    return hasTerminalLedgerRowForThread(db, state.threadId) ? "resolved" : "waiting_for_customer";
  }

  async function agentNode(state: AgentState) {
    const systemMessage = new SystemMessage(`${SYSTEM_PROMPT}\n\n${state.retrievedContextBlock}`);
    const aiMessage = await callModelWithFailover(db, state.threadId, [systemMessage, ...state.messages], AGENT_TOOLS);
    const resolutionStatus = nextResolutionStatus(state, aiMessage);
    return { messages: [aiMessage], resolutionStatus };
  }

  async function toolsNode(state: AgentState, config: unknown) {
    const result = (await rawToolNode.invoke(state, config as never)) as { messages: ToolMessage[] };
    // escalate_to_human now always creates a pending row in the admin decision
    // queue (see agentTools.ts), so the thread is waiting on a human decision,
    // not terminally "escalated" with nothing left to do. appendDecisionNotice
    // moves it to "resolved" once that decision is made (see notify.ts).
    const escalated = result.messages.some(
      (m) => typeof m.content === "string" && m.content.includes('"status":"escalated"'),
    );
    return { ...result, resolutionStatus: escalated ? ("awaiting_approval" as const) : state.resolutionStatus };
  }

  function routeAfterAgent(state: AgentState): "tools" | typeof END {
    return hasToolCalls(lastMessage(state)) ? "tools" : END;
  }

  const graph = new StateGraph(AgentStateAnnotation)
    .addNode("loadContext", loadContextNode)
    .addNode("agent", agentNode)
    .addNode("tools", toolsNode)
    .addEdge(START, "loadContext")
    .addEdge("loadContext", "agent")
    .addConditionalEdges("agent", routeAfterAgent, ["tools", END])
    .addEdge("tools", "agent")
    .compile({ checkpointer });

  return graph;
}

export type AgentGraph = ReturnType<typeof buildAgentGraph>;
