import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTurn } from "../../server/src/agent/runTurn.js";
import { listEventsForThread } from "../../server/src/events/emitter.js";
import { clearAllFaults, setFault } from "../../server/src/faults/registry.js";
import { createScenario, summarizeLlmCalls, withScenarioResult } from "../harness.js";

// PLAN Section 10, scenario 12: refund_timeout_after_success. issue_refund
// commits the refund then the call throws a timeout to the caller.
// Reconciliation (get_payments) must detect the already-completed refund and
// mark the ledger row reconciled rather than retrying with a new action, per
// CLAUDE.md invariant 2 (exactly-once money semantics).
describe("Scenario 12: refund_timeout_after_success reconciles, never double-refunds", () => {
  beforeEach(() => clearAllFaults());
  afterEach(() => clearAllFaults());

  it("reconciles cust_002's duplicate-charge refund on ord_002 to exactly one payment", async () => {
    await withScenarioResult({ number: 12, name: "refund-timeout-reconciliation" }, async () => {
      const { db, graph } = createScenario();
      const threadId = "eval_scenario_12";

      setFault("refund_timeout_after_success", true, 1);

      const result = await runTurn({
        db,
        graph,
        threadId,
        customerId: "cust_002",
        userMessage:
          "I noticed I was charged twice for my phone case, order ord_002. Please refund the duplicate charge.",
      });

      expect(result.reply).toBeTruthy();
      // The customer must be told it succeeded, never that it failed, and
      // the message must read as plain success: no internal reconciliation
      // jargon ("duplicate", "reconciled") leaking into customer-facing text,
      // even though that is exactly what happened under the hood (task P1-7).
      const reply = (result.reply ?? "").toLowerCase();
      expect(reply.includes("fail")).toBe(false);
      expect(reply.includes("duplicate")).toBe(false);
      expect(reply.includes("reconciled")).toBe(false);

      const ledgerRow = db
        .prepare(`SELECT status, amount FROM actions_ledger WHERE thread_id = ? AND order_id = 'ord_002'`)
        .get(threadId) as { status: string; amount: number } | undefined;
      expect(ledgerRow?.status).toBe("reconciled");
      expect(ledgerRow?.amount).toBe(350);

      const refundPayments = db
        .prepare(`SELECT amount FROM payments WHERE order_id = 'ord_002' AND type = 'refund'`)
        .all() as Array<{ amount: number }>;
      expect(refundPayments).toHaveLength(1);
      expect(refundPayments[0]?.amount).toBe(350);

      const events = listEventsForThread(db, threadId);
      const { latencyMs, tokensIn, tokensOut } = summarizeLlmCalls(events);
      return {
        note: "refund_timeout_after_success reconciled to exactly one INR 350 refund payment; customer told it succeeded.",
        latencyMs,
        tokensIn,
        tokensOut,
      };
    });
  });
});
