import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTurn } from "../../server/src/agent/runTurn.js";
import { listEventsForThread } from "../../server/src/events/emitter.js";
import { clearAllFaults } from "../../server/src/faults/registry.js";
import { createScenario, summarizeLlmCalls, withScenarioResult } from "../harness.js";

// PLAN Section 10, scenario 5: vague compensation request with no order or
// issue specified, one targeted clarifying question, no action.
describe("Scenario 5: vague compensation request", () => {
  beforeEach(() => clearAllFaults());
  afterEach(() => clearAllFaults());

  it("asks a clarifying question and issues zero ledger actions for a vague complaint", async () => {
    await withScenarioResult({ number: 5, name: "vague-compensation-clarification" }, async () => {
      const { db, graph } = createScenario();
      const threadId = "eval_scenario_05";

      const result = await runTurn({
        db,
        graph,
        threadId,
        customerId: "cust_001",
        userMessage: "I'm not happy, can you do something for me?",
      });

      expect(result.reply).toBeTruthy();

      const events = listEventsForThread(db, threadId);
      const moneyToolCalls = events.filter(
        (e) =>
          e.type === "tool_call" &&
          ["issue_refund", "issue_credit"].includes((e.payload as { tool?: string }).tool ?? ""),
      );
      expect(moneyToolCalls).toHaveLength(0);

      const ledgerCount = db.prepare(`SELECT COUNT(*) AS n FROM actions_ledger WHERE thread_id = ?`).get(threadId) as {
        n: number;
      };
      expect(ledgerCount.n).toBe(0);

      const reply = result.reply ?? "";
      expect(reply.includes("?")).toBe(true);

      const { latencyMs, tokensIn, tokensOut } = summarizeLlmCalls(events);
      return {
        note: "Agent asked a targeted clarifying question for a vague compensation request; zero ledger actions.",
        latencyMs,
        tokensIn,
        tokensOut,
      };
    });
  });
});
