import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTurn } from "../../server/src/agent/runTurn.js";
import { listEventsForThread } from "../../server/src/events/emitter.js";
import { clearAllFaults } from "../../server/src/faults/registry.js";
import { createScenario, summarizeLlmCalls, withScenarioResult } from "../harness.js";
import { judgeReply } from "../judge.js";

// PLAN Section 10, scenario 3: cancellation within window, confirmed.
describe("Scenario 3: cancellation within window", () => {
  beforeEach(() => clearAllFaults());
  afterEach(() => clearAllFaults());

  it("refunds cust_003's cancelled ord_003 at INR 480", async () => {
    await withScenarioResult({ number: 3, name: "cancellation-refund" }, async () => {
      const { db, graph } = createScenario();
      const threadId = "eval_scenario_03";

      const result = await runTurn({
        db,
        graph,
        threadId,
        customerId: "cust_003",
        userMessage: "I cancelled my desk lamp order ord_003. Can I get a refund for it?",
      });

      expect(result.status).toBe("resolved");
      expect(result.reply).toBeTruthy();

      const ledgerRows = db
        .prepare(`SELECT status, amount, action_type, order_id FROM actions_ledger WHERE thread_id = ?`)
        .all(threadId) as Array<{ status: string; amount: number; action_type: string; order_id: string | null }>;
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]?.status).toBe("succeeded");
      expect(ledgerRows[0]?.amount).toBe(480);
      expect(ledgerRows[0]?.action_type).toBe("refund");
      expect(ledgerRows[0]?.order_id).toBe("ord_003");

      const refundPayments = db
        .prepare(`SELECT amount FROM payments WHERE order_id = 'ord_003' AND type = 'refund'`)
        .all() as Array<{ amount: number }>;
      expect(refundPayments).toHaveLength(1);
      expect(refundPayments[0]?.amount).toBe(480);

      const events = listEventsForThread(db, threadId);
      const judge = await judgeReply(result.reply ?? "", {
        scenario: "cancellation within window",
        expectation: "The agent should confirm a refund of INR 480 was issued for the cancelled order ord_003.",
      });

      const { latencyMs, tokensIn, tokensOut } = summarizeLlmCalls(events);
      return {
        note: "Cancelled order ord_003 refunded at INR 480, ledger succeeded.",
        judge,
        latencyMs,
        tokensIn,
        tokensOut,
      };
    });
  });
});
