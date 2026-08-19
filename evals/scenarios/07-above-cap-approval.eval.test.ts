import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resumeApprovalTurn, runTurn } from "../../server/src/agent/runTurn.js";
import { clearAllFaults } from "../../server/src/faults/registry.js";
import { getPendingApprovalForThread, resolveApproval } from "../../server/src/ledger/approvals.js";
import { createScenario, withScenarioResult } from "../harness.js";

// PLAN Section 10, scenario 7: request above the INR 500 cap (cust_005/ord_005
// at INR 1500) triggers a requires_approval interrupt. Both the approve and
// reject resume paths are asserted, each against its own fresh in-memory db
// and thread so they cannot interfere with each other.
//
// The resume sequence mirrors server/src/index.ts's approval-resolve route:
// resolveApproval() is called BEFORE resumeApprovalTurn(), because that is
// what actually marks the approvals row resolved in the real system.
describe("Scenario 7: above-cap request requires human approval", () => {
  beforeEach(() => clearAllFaults());
  afterEach(() => clearAllFaults());

  it("pauses awaiting_approval, then approving completes the refund at INR 1500", async () => {
    await withScenarioResult({ number: 7, name: "above-cap-approval", suffix: "approve" }, async () => {
      const { db, graph } = createScenario();
      const threadId = "eval_scenario_07_approve";

      const first = await runTurn({
        db,
        graph,
        threadId,
        customerId: "cust_005",
        userMessage: "My air purifier order ord_005 arrived broken. I'd like a refund please, it cost 1500 rupees.",
      });
      expect(first.status).toBe("awaiting_approval");
      expect(first.reply).toBeNull();

      const pending = getPendingApprovalForThread(db, threadId);
      expect(pending).toBeDefined();
      expect(pending?.amount).toBe(1500);
      expect(pending?.orderId).toBe("ord_005");

      resolveApproval(db, pending!.id, "approved");
      const resumed = await resumeApprovalTurn({
        db,
        graph,
        threadId,
        customerId: "cust_005",
        decision: "approve",
      });

      expect(resumed.reply).toBeTruthy();
      const ledgerRow = db
        .prepare(`SELECT status, amount FROM actions_ledger WHERE thread_id = ? AND order_id = 'ord_005'`)
        .get(threadId) as { status: string; amount: number } | undefined;
      expect(ledgerRow?.status).toBe("succeeded");
      expect(ledgerRow?.amount).toBe(1500);

      const refundPayments = db
        .prepare(`SELECT amount FROM payments WHERE order_id = 'ord_005' AND type = 'refund'`)
        .all() as Array<{ amount: number }>;
      expect(refundPayments).toHaveLength(1);
      expect(refundPayments[0]?.amount).toBe(1500);

      return { note: "Approve resume path: approval granted, refund of INR 1500 completed." };
    });
  });

  it("pauses awaiting_approval, then rejecting denies the refund with no money movement", async () => {
    await withScenarioResult({ number: 7, name: "above-cap-approval", suffix: "reject" }, async () => {
      const { db, graph } = createScenario();
      const threadId = "eval_scenario_07_reject";

      const first = await runTurn({
        db,
        graph,
        threadId,
        customerId: "cust_005",
        userMessage: "My air purifier order ord_005 arrived broken. I'd like a refund please, it cost 1500 rupees.",
      });
      expect(first.status).toBe("awaiting_approval");
      expect(first.reply).toBeNull();

      const pending = getPendingApprovalForThread(db, threadId);
      expect(pending).toBeDefined();
      expect(pending?.amount).toBe(1500);

      resolveApproval(db, pending!.id, "rejected");
      const resumed = await resumeApprovalTurn({
        db,
        graph,
        threadId,
        customerId: "cust_005",
        decision: "reject",
      });

      expect(resumed.reply).toBeTruthy();
      const ledgerRow = db
        .prepare(`SELECT status, amount FROM actions_ledger WHERE thread_id = ? AND order_id = 'ord_005'`)
        .get(threadId) as { status: string; amount: number } | undefined;
      expect(ledgerRow?.status).toBe("denied");

      const refundPayments = db
        .prepare(`SELECT amount FROM payments WHERE order_id = 'ord_005' AND type = 'refund'`)
        .all() as Array<{ amount: number }>;
      expect(refundPayments).toHaveLength(0);

      return { note: "Reject resume path: approval denied, ledger status denied, zero money movement." };
    });
  });
});
