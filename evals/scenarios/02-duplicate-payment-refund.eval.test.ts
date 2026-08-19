import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTurn } from "../../server/src/agent/runTurn.js";
import { listEventsForThread } from "../../server/src/events/emitter.js";
import { clearAllFaults } from "../../server/src/faults/registry.js";
import { createScenario, summarizeLlmCalls, withScenarioResult } from "../harness.js";
import { judgeReply } from "../judge.js";

// PLAN Section 10, scenario 2: duplicate payment detected from payments data,
// duplicate charge refunded.
describe("Scenario 2: duplicate payment detected", () => {
  beforeEach(() => clearAllFaults());
  afterEach(() => clearAllFaults());

  it("refunds the duplicate charge on cust_002's ord_002 exactly once at INR 350", async () => {
    await withScenarioResult({ number: 2, name: "duplicate-payment-refund" }, async () => {
      const { db, graph } = createScenario();
      const threadId = "eval_scenario_02";

      const result = await runTurn({
        db,
        graph,
        threadId,
        customerId: "cust_002",
        userMessage:
          "I think I was charged twice for my phone case order ord_002. Can you check and refund the duplicate charge?",
      });

      expect(result.status).toBe("resolved");
      expect(result.reply).toBeTruthy();

      const ledgerRows = db
        .prepare(`SELECT status, amount, action_type, order_id FROM actions_ledger WHERE thread_id = ?`)
        .all(threadId) as Array<{ status: string; amount: number; action_type: string; order_id: string | null }>;
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]?.status).toBe("succeeded");
      expect(ledgerRows[0]?.amount).toBe(350);
      expect(ledgerRows[0]?.action_type).toBe("refund");
      expect(ledgerRows[0]?.order_id).toBe("ord_002");

      const refundPayments = db
        .prepare(`SELECT amount FROM payments WHERE order_id = 'ord_002' AND type = 'refund'`)
        .all() as Array<{ amount: number }>;
      expect(refundPayments).toHaveLength(1);
      expect(refundPayments[0]?.amount).toBe(350);

      const events = listEventsForThread(db, threadId);
      const judge = await judgeReply(result.reply ?? "", {
        scenario: "duplicate payment detected",
        expectation: "The agent should confirm the duplicate INR 350 charge on order ord_002 was refunded.",
      });
      if (judge.state === "scored") {
        expect(judge.toneOk, `judge toneOk failed: ${judge.notes}`).toBe(true);
        expect(judge.groundedOk, `judge groundedOk failed: ${judge.notes}`).toBe(true);
      }

      const { latencyMs, tokensIn, tokensOut } = summarizeLlmCalls(events);
      return {
        note: "Duplicate charge on ord_002 refunded exactly once at INR 350.",
        judge,
        judgeState: judge.state,
        latencyMs,
        tokensIn,
        tokensOut,
      };
    });
  });
});
