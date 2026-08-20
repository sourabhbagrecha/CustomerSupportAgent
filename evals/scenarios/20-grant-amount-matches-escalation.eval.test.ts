import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTurn } from "../../server/src/agent/runTurn.js";
import { listEventsForThread } from "../../server/src/events/emitter.js";
import { clearAllFaults } from "../../server/src/faults/registry.js";
import { getPendingApprovalForThread, insertApproval, resolveApprovalWithDecisionEvent } from "../../server/src/ledger/approvals.js";
import { deriveIdempotencyKey } from "../../server/src/ledger/idempotency.js";
import { resolveApprovedAction } from "../../server/src/ledger/pipeline.js";
import { getLedgerById, insertLedgerRow } from "../../server/src/ledger/store.js";
import { createScenario, withScenarioResult } from "../harness.js";

// PLAN Section 10, scenario 20 (task P0-1, "grant-amount-matches-escalation"):
// drives the same prior-promise-vs-cap conflict as scenario 6 (cust_006 /
// ord_006: history shows a INR 2,000 promise, cap is INR 500), then grants
// the escalated gap the way a human reviewer would through the approval API.
//
// Why the grant half is simulated rather than driven end to end by the
// model: hard rule 6 (server/src/agent/prompt.ts) deliberately keeps the
// model from calling issue_refund for the gap itself, only escalate_to_human,
// specifically so an above-cap interrupt() never pauses the turn before
// escalate_to_human gets to run. That means the escalation approval
// escalate_to_human creates in a normal turn carries no ledgerId (there was
// nothing denied this turn for findLatestRefusalForThread in
// server/src/ledger/store.ts to point at), so there is nothing yet to
// "grant" money against. This scenario simulates that missing link exactly
// the way it would need to be wired for a real exception grant: it inserts
// the INR 1,500 gap as a denied ledger row (what issue_refund(1500) would
// have produced had it been called and come back over the INR 500 cap) and a
// fresh escalation approval row pointing at it, using the same
// insertApproval/insertLedgerRow functions the real code paths use, then
// grants that approval through the exact same resolveApprovalWithDecisionEvent
// + resolveApprovedAction pair server/src/index.ts's
// POST /api/threads/:id/approvals/:id/resolve route calls for kind
// "escalation". This is "simulate/drive granting the escalated pending
// action via the approval API" per the task brief: real grant mechanics, a
// stand-in only for the one piece today's prompt design never produces on
// its own.
describe("Scenario 20: granting an escalated exception matches the escalated delta", () => {
  beforeEach(() => clearAllFaults());
  afterEach(() => clearAllFaults());

  it("grants exactly INR 1500 on the gap ledger row and leaves the capped INR 500 row untouched", async () => {
    await withScenarioResult({ number: 20, name: "grant-amount-matches-escalation" }, async () => {
      const { db, graph } = createScenario();
      const threadId = "eval_scenario_20";

      const result = await runTurn({
        db,
        graph,
        threadId,
        customerId: "cust_006",
        userMessage:
          "Following up on my AC repair kit order ord_006. I was told by a previous agent I'd get a 2000 rupee refund for the defect. Can you process that now?",
      });
      expect(result.reply).toBeTruthy();

      // The real, model-driven half of the flow: the capped INR 500 refund
      // succeeded, nothing above it ever auto-succeeded, and at least one
      // escalation fired (same invariants scenario 6 checks).
      const cappedBefore = db
        .prepare(`SELECT id, status, amount, reason FROM actions_ledger WHERE thread_id = ? AND status = 'succeeded'`)
        .all(threadId) as Array<{ id: number; status: string; amount: number; reason: string }>;
      expect(cappedBefore).toHaveLength(1);
      const { id: cappedRowId, ...cappedBeforeRest } = cappedBefore[0]!;
      expect(cappedBeforeRest.amount).toBe(500);

      const events = listEventsForThread(db, threadId);
      expect(events.filter((e) => e.type === "escalation").length).toBeGreaterThanOrEqual(1);
      const pendingEscalation = getPendingApprovalForThread(db, threadId);
      expect(pendingEscalation?.kind).toBe("escalation");

      // Simulated half: the gap this escalation is actually about, wired the
      // way a real denied-then-escalated flow would have wired it, using the
      // same functions the real ledger/approval code paths use.
      const gapAmount = 1500;
      const gapKey = deriveIdempotencyKey(threadId, "refund", "ord_006", gapAmount);
      const gapRow = insertLedgerRow(db, {
        idempotencyKey: gapKey,
        threadId,
        actionType: "refund",
        customerId: "cust_006",
        orderId: "ord_006",
        amount: gapAmount,
        currency: "INR",
        status: "denied",
        reason: `Requested amount ${gapAmount} exceeds the auto-refund cap of 500 INR and requires human approval; prior agent promise on ord_006 escalated for exception review.`,
      });
      const exceptionApproval = insertApproval(db, {
        kind: "escalation",
        ledgerId: gapRow.id,
        threadId,
        actionType: "refund",
        customerId: "cust_006",
        orderId: "ord_006",
        amount: gapAmount,
        policyReason: gapRow.reason,
        denialReason: gapRow.reason,
        category: "cap_breach",
        context:
          "Prior agent promised INR 2000 on ord_006 (conv_arjun_001); INR 500 cap portion already paid, INR 1500 gap escalated for exception review.",
      });
      expect(exceptionApproval.status).toBe("pending");

      // Grant it, exactly the way the approval-resolve route does for kind
      // "escalation" (server/src/index.ts executeApprovalDecision): resolve
      // the decision first, then run the same pipeline path a policy "allow"
      // would have taken, reusing the row's existing idempotency key.
      const resolved = resolveApprovalWithDecisionEvent(db, {
        approvalId: exceptionApproval.id,
        status: "approved",
        remark: null,
        threadId,
        kind: "escalation",
        decision: "approve",
      });
      expect(resolved?.status).toBe("approved");
      const granted = await resolveApprovedAction(db, gapRow, null, "Exception granted by human reviewer");
      expect(granted.status).toBe("succeeded");
      expect(granted.amount).toBe(gapAmount);

      const grantedRow = getLedgerById(db, gapRow.id);
      expect(grantedRow?.status).toBe("succeeded");
      expect(grantedRow?.amount).toBe(gapAmount);

      // The original capped row is untouched: same status, amount, and
      // reason as immediately after the model-driven turn, before the grant.
      const cappedAfter = db
        .prepare(`SELECT status, amount, reason FROM actions_ledger WHERE id = ?`)
        .get(cappedRowId) as { status: string; amount: number; reason: string };
      expect(cappedAfter).toEqual(cappedBeforeRest);

      const refundPayments = db
        .prepare(`SELECT amount FROM payments WHERE order_id = 'ord_006' AND type = 'refund' ORDER BY amount`)
        .all() as Array<{ amount: number }>;
      expect(refundPayments.map((p) => p.amount)).toEqual([500, 1500]);

      return {
        note: "Capped INR 500 auto-refund from the model-driven turn stayed untouched; granting the (simulated) escalated exception produced a second ledger row at exactly the INR 1500 delta, with both refund payments present.",
      };
    });
  });
});
