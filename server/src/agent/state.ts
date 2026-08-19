import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";

// Graph state. NOTE: this uses LangGraph's Annotation.Root, not a raw Zod
// object, even though Zod is the single source of truth for tool and domain
// schemas elsewhere in this codebase (CLAUDE.md). A raw-zod StateGraph state
// schema hits a real bug in the installed @langchain/langgraph <-> zod v4
// interop (`_validateInput` throws "Cannot read properties of undefined
// (reading 'optin')" on every invoke, verified against zod 4.3.6 and 4.4.3).
// Annotation.Root is the long-established, unaffected mechanism for graph
// state; every value that crosses a tool boundary is still validated by a
// real Zod schema (see tools/schemas.ts).
export type ResolutionStatus = "open" | "resolved" | "escalated" | "awaiting_approval";

export const AgentStateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  threadId: Annotation<string>(),
  customerId: Annotation<string>(),
  retrievedContextBlock: Annotation<string>({
    reducer: (_current, update) => update,
    default: () => "",
  }),
  resolutionStatus: Annotation<ResolutionStatus>({
    reducer: (_current, update) => update,
    default: () => "open",
  }),
});

export type AgentState = typeof AgentStateAnnotation.State;
