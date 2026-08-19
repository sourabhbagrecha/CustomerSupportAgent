import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTurn } from "../../server/src/agent/runTurn.js";
import { listEventsForThread } from "../../server/src/events/emitter.js";
import { clearAllFaults } from "../../server/src/faults/registry.js";
import { createScenario, summarizeLlmCalls, withScenarioResult } from "../harness.js";

// PLAN Section 10, scenario 4: "refund my order" with several recent orders
// (cust_004 has three), agent asks which one, takes no action.
describe("Scenario 4: ambiguous multi-order clarification", () => {
  beforeEach(() => clearAllFaults());
  afterEach(() => clearAllFaults());

  it("asks a clarifying question and issues zero refunds for cust_004's generic request", async () => {
    await withScenarioResult({ number: 4, name: "ambiguous-multi-order-clarification" }, async () => {
      const { db, graph } = createScenario();
      const threadId = "eval_scenario_04";

      const result = await runTurn({
        db,
        graph,
        threadId,
        customerId: "cust_004",
        userMessage: "I'd like a refund for my order.",
      });

      expect(result.reply).toBeTruthy();
      expect(result.status).toBe("waiting_for_customer");

      const events = listEventsForThread(db, threadId);
      const moneyToolCalls = events.filter(
        (e) => e.type === "tool_call" && (e.payload as { tool?: string }).tool === "issue_refund",
      );
      const creditToolCalls = events.filter(
        (e) => e.type === "tool_call" && (e.payload as { tool?: string }).tool === "issue_credit",
      );
      expect(moneyToolCalls).toHaveLength(0);
      expect(creditToolCalls).toHaveLength(0);

      const ledgerRows = db.prepare(`SELECT COUNT(*) AS n FROM actions_ledger WHERE thread_id = ?`).get(threadId) as {
        n: number;
      };
      expect(ledgerRows.n).toBe(0);

      const reply = result.reply ?? "";
      const mentionsMultipleOrders = ["ord_004a", "ord_004b", "ord_004c"].filter((id) => reply.includes(id)).length >= 2;
      // Heuristic per CLAUDE.md guidance: free text, keep this loose. The hard
      // assertion above (zero ledger actions, zero money tool calls) is what matters.
      expect(reply.includes("?") || mentionsMultipleOrders).toBe(true);

      const { latencyMs, tokensIn, tokensOut } = summarizeLlmCalls(events);
      return {
        note: "Agent asked a clarifying question instead of guessing among cust_004's three recent orders; zero ledger actions.",
        latencyMs,
        tokensIn,
        tokensOut,
      };
    });
  });
});
