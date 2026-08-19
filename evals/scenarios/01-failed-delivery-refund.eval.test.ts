import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTurn } from "../../server/src/agent/runTurn.js";
import { listEventsForThread } from "../../server/src/events/emitter.js";
import { clearAllFaults } from "../../server/src/faults/registry.js";
import { createScenario, summarizeLlmCalls, withScenarioResult } from "../harness.js";
import { judgeReply } from "../judge.js";

// PLAN Section 10, scenario 1: failed-delivery refund within window, one
// matching order, refund issued exactly once at the correct amount.
describe("Scenario 1: failed-delivery refund within window", () => {
  beforeEach(() => clearAllFaults());
  afterEach(() => clearAllFaults());

  it("refunds cust_001's ord_001 exactly once at INR 450", async () => {
    await withScenarioResult({ number: 1, name: "failed-delivery-refund" }, async () => {
      const { db, graph } = createScenario();
      const threadId = "eval_scenario_01";

      const result = await runTurn({
        db,
        graph,
        threadId,
        customerId: "cust_001",
        userMessage:
          "My wireless earbuds order ord_001 never arrived, the delivery failed. Can I get a refund?",
      });

      expect(result.status).toBe("resolved");
      expect(result.reply).toBeTruthy();

      const ledgerRows = db
        .prepare(`SELECT status, amount, action_type, order_id FROM actions_ledger WHERE thread_id = ?`)
        .all(threadId) as Array<{ status: string; amount: number; action_type: string; order_id: string | null }>;
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]?.status).toBe("succeeded");
      expect(ledgerRows[0]?.amount).toBe(450);
      expect(ledgerRows[0]?.action_type).toBe("refund");
      expect(ledgerRows[0]?.order_id).toBe("ord_001");

      const refundPayments = db
        .prepare(`SELECT amount FROM payments WHERE order_id = 'ord_001' AND type = 'refund'`)
        .all() as Array<{ amount: number }>;
      expect(refundPayments).toHaveLength(1);
      expect(refundPayments[0]?.amount).toBe(450);

      const events = listEventsForThread(db, threadId);
      const judge = await judgeReply(result.reply ?? "", {
        scenario: "failed-delivery refund within window",
        expectation: "The agent should confirm a refund of INR 450 was issued for order ord_001, calmly and honestly.",
      });
      if (judge.state === "scored") {
        expect(judge.toneOk, `judge toneOk failed: ${judge.notes}`).toBe(true);
        expect(judge.groundedOk, `judge groundedOk failed: ${judge.notes}`).toBe(true);
      }

      const { latencyMs, tokensIn, tokensOut } = summarizeLlmCalls(events);
      return {
        note: "Refund of INR 450 issued exactly once for ord_001, ledger status succeeded.",
        judge,
        judgeState: judge.state,
        latencyMs,
        tokensIn,
        tokensOut,
      };
    });
  });
});
