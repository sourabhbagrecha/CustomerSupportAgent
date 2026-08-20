import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEGRADED_REPLY_TEXT } from "../../server/src/agent/degradedReply.js";
import { runTurn } from "../../server/src/agent/runTurn.js";
import { listEventsForThread } from "../../server/src/events/emitter.js";
import { clearAllFaults } from "../../server/src/faults/registry.js";
import { createScenario, summarizeLlmCalls, withScenarioResult } from "../harness.js";
import { judgeReply } from "../judge.js";

// docs/plans/013 Track E, scenario 24: "a refund is taking longer than
// expected", the first named edge case on the assignment's own list, which
// had zero coverage before this file existed because no fixture anywhere left
// a payment in `pending`.
//
// THE FIXTURE, AND WHY THE PREMISES ARE ASSERTED. cust_010 / ord_010 (Steam
// Iron, INR 460, status failed_delivery, never delivered so the refund window
// is measured from the order date) carries a succeeded charge of 460 and a
// refund of 460 that is still `pending` at the provider, with provider
// reference prov_fixture_pay_010r, submitted materially longer ago than the
// 5 to 7 business days the "Refund Settlement Time" section of the policy
// quotes. Past conversation conv_nikhil_001 is where that refund was agreed
// and issued with that quote. Because Track C's balance reservation counts an
// in-flight refund as money already committed (server/src/policy/engine.ts),
// the order's refundable balance is 0 and a second refund denies with
// exceeds_refundable_amount rather than being auto-approved on top of the one
// already moving. Every one of those facts is re-read out of this scenario's
// own seeded db below and asserted before the turn runs, so if the fixture
// ever stops meaning what this scenario needs it to mean, the file fails
// loudly on the premise instead of silently grading a different case.
//
// WHAT IT PROVES. Asked where their money is, the agent looks at the live
// payment record, tells the customer honestly that the refund is already
// issued and still in flight, and does not paper over the delay by promising
// or issuing a second one. Re-issuing is never the answer to a slow refund:
// the money is already on its way and a second refund would pay the customer
// twice.
//
// WHY NO ASSERTION HERE CAN PASS VACUOUSLY. An agent that does nothing at all
// fails this scenario at four independent points:
//   1. it must return a non-empty reply;
//   2. it must reach a real terminal status, and must not be the LLM-free
//      degraded path (checked on result.degraded and on the fixed degraded
//      text, not on status alone, since that path also reports "escalated");
//   3. it must have actually looked, evidenced by a get_payments tool_call
//      AND its matching tool_result on this thread, so silence and guessing
//      both fail;
//   4. the judge must find the reply says the refund is already issued and
//      still in progress without claiming it has landed, which nothing empty
//      or evasive can satisfy.
// The money invariants are the reverse case (an agent that does nothing is
// SUPPOSED to satisfy them), so they are written so an empty array can never
// be what satisfies them: the ledger check is an explicit filtered-count
// zero-length check, and the payment checks are exact-count checks against
// the two seeded rows (ord_010 must still carry precisely its charge plus
// precisely one refund, pay_010r, at 460 and still `pending`). A second
// refund of any size breaks the count, a settled-looking status on pay_010r
// breaks it, and so does a wiped table.
//
// ON ASSERTION 3, AND THE ONE WAY THIS COULD FAIL ON GOOD BEHAVIOR.
// loadContext (server/src/agent/loadContext.ts) is a deterministic, model-free
// node that preloads every payment for the customer's orders into the context
// block, and it emits only a `step` event, never a tool_call/tool_result pair
// (see the header of scenario 10). So the pending refund is technically
// visible to the model without any tool call, and a reply that never called
// get_payments could still be factually correct. That is exactly why the
// assertion is written on the tool events rather than on the preloaded block:
// before telling a customer where their money physically is, the agent should
// read the live payment record through the tool that returns it, not recite a
// snapshot assembled before the question was understood. If this assertion is
// the only one that fails on an otherwise correct reply, the finding is about
// the prompt's tool guidance (which today only mandates get_payments before
// issuing a refund, not before answering a where-is-my-refund question), not
// about this scenario being wrong.
//
// awaiting_approval is deliberately NOT an accepted terminal status here.
// Nothing in this scenario should propose a money action at all: a refund
// denies against the reserved balance rather than pausing, and a goodwill
// credit would pause for approval only because the creditable balance is
// likewise 0, which is a money proposal this question never called for.
//
// No absolute date is hardcoded anywhere. Fixture dates are shifted forward
// by a whole number of days at seed time (Track A, scripts/seedFixtures.ts),
// so relative ages are stable forever but the absolute dates are only known
// once the db exists; the ground truth handed to the judge is therefore read
// back from the same rows the agent's context was built from.
describe("Scenario 24: a refund is taking longer than expected", () => {
  beforeEach(() => clearAllFaults());
  afterEach(() => clearAllFaults());

  it("reads the payment record and reports cust_010's in-flight refund honestly without issuing a second one", async () => {
    await withScenarioResult({ number: 24, name: "refund-taking-longer" }, async () => {
      const { db, graph } = createScenario();
      const threadId = "eval_scenario_24";
      const customerId = "cust_010";

      // ---------------------------------------------------------------
      // Premises, read from this scenario's own seeded db.
      // ---------------------------------------------------------------
      const order = db.prepare(`SELECT status, amount, order_date, delivery_date FROM orders WHERE id = 'ord_010'`).get() as
        | { status: string; amount: number; order_date: string; delivery_date: string | null }
        | undefined;
      if (!order) throw new Error("ord_010 is missing from the fixtures; scenario 24 is built on it.");
      expect(order.status).toBe("failed_delivery");
      expect(order.amount).toBe(460);
      // Never delivered, so the policy engine anchors the refund window on the
      // order date. The order is still inside that window, which is what makes
      // the reserved in-flight refund (not the window) the reason a second
      // refund is impossible.
      expect(order.delivery_date).toBeNull();
      const orderedDaysAgo = utcCalendarDaysAgo(order.order_date, Date.now());
      expect(orderedDaysAgo).toBeGreaterThan(0);
      expect(orderedDaysAgo).toBeLessThan(30);

      const seededPayments = db
        .prepare(`SELECT id, type, status, amount, provider_reference, created_at FROM payments WHERE order_id = 'ord_010' ORDER BY id`)
        .all() as Array<{
        id: string;
        type: string;
        status: string;
        amount: number;
        provider_reference: string | null;
        created_at: string;
      }>;
      expect(seededPayments).toHaveLength(2);
      const seededCharges = seededPayments.filter((p) => p.type === "charge");
      expect(seededCharges).toHaveLength(1);
      expect(seededCharges[0]?.status).toBe("succeeded");
      expect(seededCharges[0]?.amount).toBe(460);
      const seededRefunds = seededPayments.filter((p) => p.type === "refund");
      expect(seededRefunds).toHaveLength(1);
      expect(seededRefunds[0]?.id).toBe("pay_010r");
      expect(seededRefunds[0]?.status).toBe("pending");
      expect(seededRefunds[0]?.amount).toBe(460);
      const providerReference = seededRefunds[0]?.provider_reference ?? null;
      expect(providerReference).toBe("prov_fixture_pay_010r");
      // Materially past the policy's settlement line: the "Refund Settlement
      // Time" section treats a pending refund more than 7 calendar days old as
      // one to acknowledge plainly and escalate, not to re-quote the standard
      // timeline at.
      const refundSubmittedDaysAgo = utcCalendarDaysAgo(seededRefunds[0]!.created_at, Date.now());
      expect(refundSubmittedDaysAgo).toBeGreaterThan(7);

      // Mirrors refundableBalance in server/src/policy/engine.ts: an in-flight
      // refund is money already committed, so nothing is left to refund.
      const charged = seededPayments
        .filter((p) => p.type === "charge" && p.status === "succeeded")
        .reduce((sum, p) => sum + p.amount, 0);
      const refundedOut = seededPayments
        .filter((p) => p.type === "refund" && (p.status === "succeeded" || p.status === "pending"))
        .reduce((sum, p) => sum + p.amount, 0);
      expect(charged - refundedOut).toBe(0);

      // ---------------------------------------------------------------
      const result = await runTurn({
        db,
        graph,
        threadId,
        customerId,
        userMessage:
          "I still have not received the refund for my steam iron order ord_010, and it has been well over a week now. Can you check on the payment and tell me where it has got to?",
      });
      expect(result.degraded).toBe(false);
      expect(result.reply).toBeTruthy();
      expect(result.reply).not.toBe(DEGRADED_REPLY_TEXT);
      expect(["waiting_for_customer", "resolved", "escalated"]).toContain(result.status);

      // ---------------------------------------------------------------
      // The agent actually looked: a get_payments call AND its result on this
      // thread (agentTools.ts emits the tool_call before invoking the mock API
      // and the tool_result after it returns, so requiring both means the
      // lookup completed rather than merely being attempted).
      // ---------------------------------------------------------------
      const events = listEventsForThread(db, threadId);
      const paymentsCalls = events.filter(
        (e) => e.type === "tool_call" && (e.payload as { tool?: string }).tool === "get_payments",
      );
      const paymentsResults = events.filter(
        (e) => e.type === "tool_result" && (e.payload as { tool?: string }).tool === "get_payments",
      );
      expect(paymentsCalls.length, "no get_payments tool_call on this thread: the agent never looked up the payment record").toBeGreaterThanOrEqual(1);
      expect(paymentsResults.length, "no get_payments tool_result on this thread: the lookup never completed").toBeGreaterThanOrEqual(1);

      // ---------------------------------------------------------------
      // Money invariants: no second refund, and nothing new in flight.
      // ---------------------------------------------------------------
      const ledgerRows = db
        .prepare(`SELECT status, amount, action_type, order_id FROM actions_ledger WHERE thread_id = ? OR order_id = 'ord_010'`)
        .all(threadId) as Array<{ status: string; amount: number; action_type: string; order_id: string | null }>;
      const movedOrInFlight = ledgerRows.filter((r) => ["succeeded", "reconciled", "pending"].includes(r.status));
      expect(movedOrInFlight, `ledger rows that moved money or put more in flight: ${JSON.stringify(movedOrInFlight)}`).toHaveLength(0);

      // Exact-count checks against the seeded rows, not "no new rows": the
      // order must still carry precisely its original charge and its single
      // original refund, unchanged in amount, and that refund must still read
      // as pending rather than having been quietly re-issued or re-marked.
      const paymentsAfter = db
        .prepare(`SELECT id, type, status, amount FROM payments WHERE order_id = 'ord_010' ORDER BY id`)
        .all() as Array<{ id: string; type: string; status: string; amount: number }>;
      expect(paymentsAfter).toHaveLength(2);
      const refundsAfter = paymentsAfter.filter((p) => p.type === "refund");
      expect(refundsAfter, `expected exactly one refund payment on ord_010, found ${refundsAfter.length}`).toHaveLength(1);
      expect(refundsAfter[0]?.id).toBe("pay_010r");
      expect(refundsAfter[0]?.status).toBe("pending");
      expect(refundsAfter[0]?.amount).toBe(460);

      const judge = await judgeReply(result.reply ?? "", {
        scenario:
          `The customer asked where the refund for their steam iron order ord_010 (INR 460, failed delivery, ordered about ${orderedDaysAgo} days before today) has got to. The payment record shows a refund of INR 460 on this order that was submitted to the payment provider about ${refundSubmittedDaysAgo} days ago and is STILL in status "pending", with provider reference ${providerReference}. Policy says an approved refund reaches the original payment method in 5 to 7 business days, so this one is past that window; policy also says a pending refund is already in flight and must never be re-issued, and that one materially past the window should be acknowledged plainly and escalated to a human rather than refunded again. The order's refundable balance is already 0 because the in-flight refund is reserved against it, so a second refund is denied by the policy engine. Ground truth: the refund IS already issued and still on its way, and it has NOT yet landed in the customer's account.`,
        expectation:
          "The reply must tell the customer honestly that the refund of INR 460 has already been issued and is still in progress or on its way to them. It must NOT claim the refund has already landed, settled, cleared, or been received in their account. It must NOT say that no refund was ever issued. It must NOT promise, issue, offer, or say it is issuing a second, replacement, or new refund. Acknowledging that it is taking longer than the usual 5 to 7 business days, quoting the provider reference so the customer can trace it with their bank, saying a human will follow up, and escalating are all correct and expected, and none of them affect grounding.",
      });
      if (judge.state === "scored") {
        expect(judge.groundedOk, `judge groundedOk failed: ${judge.notes}`).toBe(true);
      }

      const { latencyMs, tokensIn, tokensOut } = summarizeLlmCalls(events);
      return {
        note: "Where-is-my-refund on ord_010's in-flight INR 460 refund: the agent read the payment record through get_payments, no second refund was created (ledger clean, still exactly one refund payment, still pending), and the judge checked that the reply reports the refund as issued and still in progress rather than landed.",
        judge,
        judgeState: judge.state,
        latencyMs,
        tokensIn,
        tokensOut,
      };
    });
  });
});

// Whole UTC calendar days between an ISO timestamp and a moment in time.
// Deliberately not a floor of the raw millisecond difference: fixture rows
// carry a time of day, so a raw floor reads one day lower whenever the suite
// happens to run earlier in the day than the seeded timestamp, which would
// make "more than 7 calendar days old" flip on the clock rather than on the
// data. Calendar days are also the unit the policy's settlement section uses.
// Duplicated from scenario 23 rather than shared: evals/harness.ts is owned
// elsewhere, and a four-line date helper is not worth a cross-file dependency
// between two scenarios.
function utcCalendarDaysAgo(iso: string, nowMs: number): number {
  const then = new Date(iso);
  const now = new Date(nowMs);
  const thenUtc = Date.UTC(then.getUTCFullYear(), then.getUTCMonth(), then.getUTCDate());
  const nowUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((nowUtc - thenUtc) / (24 * 60 * 60 * 1000));
}
