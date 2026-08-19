import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTurn } from "../../server/src/agent/runTurn.js";
import { listEventsForThread } from "../../server/src/events/emitter.js";
import { clearAllFaults } from "../../server/src/faults/registry.js";
import { createScenario, summarizeLlmCalls, withScenarioResult } from "../harness.js";
import { judgeReply } from "../judge.js";

// PLAN Section 10, scenario 6: history shows a prior INR 2,000 promise, cap
// is INR 500: offer 500, escalate the delta with context.
describe("Scenario 6: prior promise exceeds current cap", () => {
  beforeEach(() => clearAllFaults());
  afterEach(() => clearAllFaults());

  it("offers cust_006 the INR 500 cap on ord_006 and escalates the INR 1,500 gap", async () => {
    await withScenarioResult({ number: 6, name: "prior-promise-vs-cap" }, async () => {
      const { db, graph } = createScenario();
      const threadId = "eval_scenario_06";

      const result = await runTurn({
        db,
        graph,
        threadId,
        customerId: "cust_006",
        userMessage:
          "Following up on my AC repair kit order ord_006. I was told by a previous agent I'd get a 2000 rupee refund for the defect. Can you process that now?",
      });

      expect(result.reply).toBeTruthy();

      const ledgerRows = db
        .prepare(`SELECT status, amount, action_type FROM actions_ledger WHERE thread_id = ?`)
        .all(threadId) as Array<{ status: string; amount: number; action_type: string }>;
      const cappedRefund = ledgerRows.find((r) => r.status === "succeeded" && r.action_type === "refund");
      expect(cappedRefund).toBeDefined();
      expect(cappedRefund?.amount).toBe(500);

      // The promised 2000 must never be auto-honored: no succeeded row above the cap.
      const uncappedSucceeded = ledgerRows.find((r) => r.status === "succeeded" && r.amount > 500);
      expect(uncappedSucceeded).toBeUndefined();

      const events = listEventsForThread(db, threadId);
      const escalationEvents = events.filter((e) => e.type === "escalation");
      expect(escalationEvents.length).toBeGreaterThanOrEqual(1);

      const judge = await judgeReply(result.reply ?? "", {
        scenario: "prior INR 2,000 promise vs INR 500 policy cap",
        expectation:
          "The agent should honestly acknowledge the prior promise, offer the INR 500 policy cap now, and escalate the INR 1,500 gap to a human, never silently honoring the full prior promise.",
      });
      if (judge.state === "scored") {
        expect(judge.toneOk, `judge toneOk failed: ${judge.notes}`).toBe(true);
        expect(judge.groundedOk, `judge groundedOk failed: ${judge.notes}`).toBe(true);
      }

      const { latencyMs, tokensIn, tokensOut } = summarizeLlmCalls(events);
      return {
        note: "Offered INR 500 cap on ord_006, escalated the 1500 gap from the prior promise; no uncapped auto-refund.",
        judge,
        judgeState: judge.state,
        latencyMs,
        tokensIn,
        tokensOut,
      };
    });
  });
});
