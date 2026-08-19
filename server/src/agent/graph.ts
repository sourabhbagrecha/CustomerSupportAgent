import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { SystemMessage, ToolMessage, type AIMessage } from "@langchain/core/messages";
import type Database from "better-sqlite3";
import { emitEvent } from "../events/emitter.js";
import { AGENT_TOOLS } from "../tools/agentTools.js";
import { callModelWithFailover } from "./modelClient.js";
import { loadContext } from "./loadContext.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { AgentStateAnnotation, type AgentState } from "./state.js";

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

  async function agentNode(state: AgentState) {
    const systemMessage = new SystemMessage(`${SYSTEM_PROMPT}\n\n${state.retrievedContextBlock}`);
    const aiMessage = await callModelWithFailover(db, state.threadId, [systemMessage, ...state.messages], AGENT_TOOLS);
    const resolutionStatus =
      state.resolutionStatus === "open" && !hasToolCalls(aiMessage) ? "resolved" : state.resolutionStatus;
    return { messages: [aiMessage], resolutionStatus };
  }

  async function toolsNode(state: AgentState, config: unknown) {
    const result = (await rawToolNode.invoke(state, config as never)) as { messages: ToolMessage[] };
    const escalated = result.messages.some(
      (m) => typeof m.content === "string" && m.content.includes('"status":"escalated"'),
    );
    return { ...result, resolutionStatus: escalated ? ("escalated" as const) : state.resolutionStatus };
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
