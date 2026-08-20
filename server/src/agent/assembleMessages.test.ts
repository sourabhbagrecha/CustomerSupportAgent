import { describe, expect, it } from "vitest";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { assembleMessages } from "./assembleMessages.js";

const PROMPT = "static system prompt";
const CONTEXT = "retrieved context block";

describe("assembleMessages", () => {
  it("puts the static prompt first and the context immediately before the latest human message", () => {
    const history = [
      new HumanMessage("turn 1 question"),
      new AIMessage("turn 1 answer"),
      new HumanMessage("turn 2 question"),
    ];
    const out = assembleMessages(PROMPT, CONTEXT, history);
    expect(out.map((m) => m.content)).toEqual([
      PROMPT,
      "turn 1 question",
      "turn 1 answer",
      CONTEXT,
      "turn 2 question",
    ]);
    expect(out[0]).toBeInstanceOf(SystemMessage);
    expect(out[3]).toBeInstanceOf(SystemMessage);
  });

  it("keeps the insertion point fixed while the current turn appends AI and tool messages", () => {
    // Cache-friendliness invariant: within one turn, later model calls must be
    // pure appends of the earlier request, so the shared prefix stays cached.
    const base = [new HumanMessage("q1"), new AIMessage("a1"), new HumanMessage("q2")];
    const firstCall = assembleMessages(PROMPT, CONTEXT, base);
    const toolCall = new AIMessage({ content: "", tool_calls: [{ name: "get_orders", args: {}, id: "call_1" }] });
    const toolResult = new ToolMessage({ content: "[]", tool_call_id: "call_1" });
    const secondCall = assembleMessages(PROMPT, CONTEXT, [...base, toolCall, toolResult]);
    expect(secondCall.slice(0, firstCall.length).map((m) => m.content)).toEqual(firstCall.map((m) => m.content));
    expect(secondCall.length).toBe(firstCall.length + 2);
  });

  it("never splits an AI tool-call message from its tool results", () => {
    const toolCall = new AIMessage({ content: "", tool_calls: [{ name: "get_payments", args: {}, id: "call_9" }] });
    const toolResult = new ToolMessage({ content: "[]", tool_call_id: "call_9" });
    const history = [new HumanMessage("q1"), toolCall, toolResult, new AIMessage("a1"), new HumanMessage("q2")];
    const out = assembleMessages(PROMPT, CONTEXT, history);
    const callIndex = out.indexOf(toolCall);
    expect(out[callIndex + 1]).toBe(toolResult);
  });

  it("appends the context at the end when no human message exists", () => {
    const history = [new AIMessage("decision notice")];
    const out = assembleMessages(PROMPT, CONTEXT, history);
    expect(out.map((m) => m.content)).toEqual([PROMPT, "decision notice", CONTEXT]);
  });

  it("does not mutate the history array it is given", () => {
    const history = [new HumanMessage("q1")];
    const snapshot = [...history];
    assembleMessages(PROMPT, CONTEXT, history);
    expect(history).toEqual(snapshot);
  });
});
