import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";

// Plan 011: request layout tuned for provider-side prefix caching. The static
// system prompt goes first (byte-identical on every call), and the volatile
// retrieved-context block is injected as a separate system message immediately
// BEFORE the latest human message rather than concatenated onto the prompt:
//
//   [ system prompt (static)
//   , ...history up to the latest HumanMessage
//   , retrieved context (volatile, rebuilt per turn)
//   , latest HumanMessage
//   , ...current-turn AI/tool messages ]
//
// Within a turn the agent/tools loop only appends after this point, so every
// later call keeps the full cached prefix. Across turns the request diverges
// only where the previous turn's context block sat, so the cached prefix
// covers the static prompt plus all earlier history, instead of ending at the
// static prompt the way a prompt+context concatenation does.
//
// The context message is built here at call time and never persisted into the
// checkpointer, so history stays pure conversation and old turns are never
// rewritten (rewrites would invalidate the cached prefix).
//
// Inserting before the latest HumanMessage can never split an AIMessage/
// ToolMessage pair: the message preceding the latest human turn is always a
// prior turn's final AI reply (or a decision-notice AIMessage from notify.ts).
export function assembleMessages(
  systemPrompt: string,
  retrievedContextBlock: string,
  history: BaseMessage[],
): BaseMessage[] {
  const systemMessage = new SystemMessage(systemPrompt);
  const contextMessage = new SystemMessage(retrievedContextBlock);

  let lastHumanIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i] instanceof HumanMessage) {
      lastHumanIndex = i;
      break;
    }
  }
  // No human message in state should not happen (runTurn always appends one),
  // but degrade to appending the context at the end rather than dropping it.
  if (lastHumanIndex === -1) {
    return [systemMessage, ...history, contextMessage];
  }
  return [
    systemMessage,
    ...history.slice(0, lastHumanIndex),
    contextMessage,
    ...history.slice(lastHumanIndex),
  ];
}
