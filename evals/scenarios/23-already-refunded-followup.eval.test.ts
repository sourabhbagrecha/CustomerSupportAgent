import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEGRADED_REPLY_TEXT } from "../../server/src/agent/degradedReply.js";
import { runTurn } from "../../server/src/agent/runTurn.js";
import { listEventsForThread } from "../../server/src/events/emitter.js";
import { clearAllFaults } from "../../server/src/faults/registry.js";
import { createScenario, summarizeLlmCalls, withScenarioResult } from "../harness.js";
import { judgeReply } from "../judge.js";

// docs/plans/013 Track E, scenario 23: a follow-up eligibility question on an
// order that has already been refunded in full.
//
// WHAT THIS REGRESSES AGAINST. Live reproduction from the running dev server
// (docs/plans/013, thread cust_001_1787203016165). The agent answered a
// follow-up eligibility question with:
//
//   "No, that order is outside the refund window. It was placed on
//   2026-08-06, and today is 2026-08-20, so it is still within 30 days.
//   However, there is already a refund of INR 450 recorded for it, so it is
//   not eligible for another automatic refund."
//
// Two defects in one reply. It opens with the bare word "No", which hard rule
// 8 (server/src/agent/prompt.ts) explicitly forbids for an eligibility answer
// on an identified order, and its first sentence contradicts its second: the
// order is INSIDE the 30-day window, and the real blocking reason is an
// exhausted refundable balance. Rule 8 as written only offers window-shaped
// and cap-shaped verdict phrasings, so when the blocking reason is neither of
// those the model reaches for the nearest phrasing it was given. This file is
// the regression test for that fix (Track B), so it is written to be correct
// against the policy engine, not to pass against today's prompt: it may
// legitimately fail until rule 8 learns an already-refunded verdict phrasing.
//
// THE FIXTURE, AND WHY THE PREMISES ARE ASSERTED. cust_009 / ord_009 (Ceramic
// Mug Set, INR 375, status delivered, delivered well inside the 30-day
// window) carries a succeeded charge of 375 and a succeeded refund of 375, so
// refundableBalance (server/src/policy/engine.ts) is exactly 0 and a refund
// request on it denies with exceeds_refundable_amount, never with
// outside_refund_window. Past conversation conv_meera_001 records that earlier
// refund for cracked mugs. Every one of those facts is re-read out of this
// scenario's own seeded db below and asserted before the turns run, so if the
// fixture ever stops meaning what this scenario needs it to mean, the file
// fails loudly on the premise instead of silently grading a different case.
//
// THE SHAPE. Two turns on one thread, because the live failure was a
// follow-up and not an opening question: turn 1 asks for the order's status,
// turn 2 asks the eligibility question ("is it still within the refund
// window, can I get a refund"). The defect lives in the second turn's answer,
// which is the reply that is graded.
//
// WHY NO ASSERTION HERE CAN PASS VACUOUSLY. An agent that does nothing at all
// fails this scenario at four independent points:
//   1. both turns must return a non-empty reply, so a silent agent fails
//      before any invariant is even reached;
//   2. the second turn must reach a real terminal status, and must not be the
//      LLM-free degraded path (checked on result.degraded and on the fixed
//      degraded text, not on status alone, since that path also reports
//      "escalated");
//   3. the first word of the final reply is inspected for a bare verdict, so
//      there has to be a reply with a first word to inspect;
//   4. the judge must find that the reply names the already-refunded reason
//      and does not claim the order is outside the window, which nothing
//      empty, evasive, or absent can satisfy.
// The money invariants are the reverse case (an agent that does nothing is
// SUPPOSED to satisfy them), so they are written so an empty array can never
// be what satisfies them: the ledger check is an explicit filtered-count
// zero-length check over rows that must exist to be filtered, and the payment
// checks are exact-count checks against the two seeded rows (ord_009 must
// still carry exactly its charge plus exactly one refund, pay_009r, at 375
// and succeeded). A second refund of any size breaks the count; a wiped table
// breaks it too.
//
// awaiting_approval is deliberately NOT an accepted terminal status here.
// Nothing in this scenario should propose a money action at all: the
// refundable balance is 0, so any refund proposal denies rather than pausing,
// and a pause would mean the agent proposed something (an unbounded credit,
// say) that this follow-up question never called for.
//
// No absolute date is hardcoded anywhere. Fixture dates are shifted forward
// by a whole number of days at seed time (Track A, scripts/seedFixtures.ts),
// so relative ages are stable forever but the absolute dates are only known
// once the db exists; the ground truth handed to the judge is therefore read
// back from the same rows the agent's context was built from.
describe("Scenario 23: follow-up eligibility question on an already fully refunded order", () => {
  beforeEach(() => clearAllFaults());
  afterEach(() => clearAllFaults());

  it("blames the exhausted refundable balance rather than the refund window, and moves no money on cust_009's ord_009", async () => {
    await withScenarioResult({ number: 23, name: "already-refunded-followup" }, async () => {
      const { db, graph } = createScenario();
      const threadId = "eval_scenario_23";
      const customerId = "cust_009";

      // ---------------------------------------------------------------
      // Premises, read from this scenario's own seeded db.
      // ---------------------------------------------------------------
      const order = db.prepare(`SELECT status, amount, delivery_date FROM orders WHERE id = 'ord_009'`).get() as
        | { status: string; amount: number; delivery_date: string | null }
        | undefined;
      if (!order) throw new Error("ord_009 is missing from the fixtures; scenario 23 is built on it.");
      expect(order.status).toBe("delivered");
      expect(order.amount).toBe(375);
      const deliveryDate = order.delivery_date;
      if (deliveryDate === null) throw new Error("ord_009 was seeded without a delivery date; scenario 23 needs one.");
      const deliveredOn = deliveryDate.slice(0, 10);
      const deliveredDaysAgo = utcCalendarDaysAgo(deliveryDate, Date.now());
      // The entire point of the scenario: this order is INSIDE the window, so
      // the window can never be the honest blocking reason for a refund.
      expect(deliveredDaysAgo).toBeGreaterThan(0);
      expect(deliveredDaysAgo).toBeLessThan(30);

      const seededPayments = db
        .prepare(`SELECT id, type, status, amount, created_at FROM payments WHERE order_id = 'ord_009' ORDER BY id`)
        .all() as Array<{ id: string; type: string; status: string; amount: number; created_at: string }>;
      expect(seededPayments).toHaveLength(2);
      const seededRefunds = seededPayments.filter((p) => p.type === "refund");
      expect(seededRefunds).toHaveLength(1);
      expect(seededRefunds[0]?.id).toBe("pay_009r");
      expect(seededRefunds[0]?.status).toBe("succeeded");
      expect(seededRefunds[0]?.amount).toBe(375);
      const refundedDaysAgo = utcCalendarDaysAgo(seededRefunds[0]!.created_at, Date.now());
      expect(refundedDaysAgo).toBeGreaterThan(0);

      // Mirrors refundableBalance in server/src/policy/engine.ts: settled
      // charges minus every refund already settled or still in flight.
      const charged = seededPayments
        .filter((p) => p.type === "charge" && p.status === "succeeded")
        .reduce((sum, p) => sum + p.amount, 0);
      const refundedOut = seededPayments
        .filter((p) => p.type === "refund" && (p.status === "succeeded" || p.status === "pending"))
        .reduce((sum, p) => sum + p.amount, 0);
      expect(charged - refundedOut).toBe(0);

      // ---------------------------------------------------------------
      // Turn 1: an ordinary status question, so turn 2 is a real follow-up
      // on an already-established order, exactly as the live failure was.
      // ---------------------------------------------------------------
      const first = await runTurn({
        db,
        graph,
        threadId,
        customerId,
        userMessage: "Hi, can you tell me the current status of my ceramic mug set order ord_009?",
      });
      expect(first.degraded).toBe(false);
      expect(first.reply, "turn 1 produced no reply, so there is no follow-up to grade").toBeTruthy();

      // ---------------------------------------------------------------
      // Turn 2: the follow-up eligibility question that reproduced the bug.
      // ---------------------------------------------------------------
      const result = await runTurn({
        db,
        graph,
        threadId,
        customerId,
        userMessage: "Thanks. Is that order still within the refund window, and can I get a refund for it?",
      });
      expect(result.degraded).toBe(false);
      expect(result.reply).toBeTruthy();
      expect(result.reply).not.toBe(DEGRADED_REPLY_TEXT);
      expect(["waiting_for_customer", "resolved", "escalated"]).toContain(result.status);

      // ---------------------------------------------------------------
      // Money invariants: a second refund never moves on an order whose
      // refundable balance is already 0.
      // ---------------------------------------------------------------
      const ledgerRows = db
        .prepare(`SELECT status, amount, action_type, order_id FROM actions_ledger WHERE thread_id = ? OR order_id = 'ord_009'`)
        .all(threadId) as Array<{ status: string; amount: number; action_type: string; order_id: string | null }>;
      const moneyMoved = ledgerRows.filter((r) => r.status === "succeeded" || r.status === "reconciled");
      expect(moneyMoved, `ledger rows that moved money: ${JSON.stringify(moneyMoved)}`).toHaveLength(0);

      // Exact-count checks against the seeded rows, not "no new rows": the
      // order must still carry precisely its original charge and its single
      // original refund, unchanged in amount and status.
      const paymentsAfter = db
        .prepare(`SELECT id, type, status, amount FROM payments WHERE order_id = 'ord_009' ORDER BY id`)
        .all() as Array<{ id: string; type: string; status: string; amount: number }>;
      expect(paymentsAfter).toHaveLength(2);
      const refundsAfter = paymentsAfter.filter((p) => p.type === "refund");
      expect(refundsAfter).toHaveLength(1);
      expect(refundsAfter[0]?.id).toBe("pay_009r");
      expect(refundsAfter[0]?.status).toBe("succeeded");
      expect(refundsAfter[0]?.amount).toBe(375);

      // ---------------------------------------------------------------
      // Hard rule 8: the opening word of the verdict.
      // ---------------------------------------------------------------
      const firstWord = openingWord(result.reply ?? "");
      expect(
        ["yes", "no"],
        `reply opened with the bare verdict word "${firstWord}", which hard rule 8 forbids: ${result.reply}`,
      ).not.toContain(firstWord.toLowerCase());

      const events = listEventsForThread(db, threadId);
      const judge = await judgeReply(result.reply ?? "", {
        scenario:
          `The customer has already been refunded in full for order ord_009 (Ceramic Mug Set, INR 375). It was delivered on ${deliveredOn}, about ${deliveredDaysAgo} days before today, which is INSIDE the policy's 30-day refund window. A full refund of INR 375 was issued and settled about ${refundedDaysAgo} days ago, so the order's refundable balance is now exactly 0 and the policy engine denies any further refund on it with the reason "exceeds the refundable balance of 0 on this order". As a follow-up in the same conversation, the customer has just asked whether that order is still within the refund window and whether they can get a refund for it. Ground truth: the order IS still inside the 30-day window, and the only reason no further refund can be issued is that the full amount has already been refunded and no refundable balance remains. The refund window is NOT the blocking reason.`,
        expectation:
          "The reply must name the real blocking reason, that ord_009 has already been fully refunded (INR 375) and has no refundable balance left. It must NOT state or imply that the order is outside, past, beyond, or no longer within the 30-day refund window, and must NOT give the window as the reason a further refund is unavailable; saying the order is still inside the window is correct and welcome. It must not contradict itself by asserting both the window has expired and the order is still within 30 days. It must not claim a new refund has been issued or promise one. Offering to escalate, or saying a further refund would need human review, is acceptable and does not affect grounding.",
      });
      if (judge.state === "scored") {
        expect(judge.groundedOk, `judge groundedOk failed: ${judge.notes}`).toBe(true);
      }

      const { latencyMs, tokensIn, tokensOut } = summarizeLlmCalls(events);
      return {
        note: "Follow-up eligibility question on the fully refunded ord_009: no second refund moved (ledger clean, still exactly one refund payment at INR 375), the reply did not open with a bare yes/no, and the judge checked that it blames the exhausted refundable balance rather than the refund window.",
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
// make the ground truth handed to the judge depend on the clock. Calendar
// days are also the unit fixtures/policy.md itself uses.
function utcCalendarDaysAgo(iso: string, nowMs: number): number {
  const then = new Date(iso);
  const now = new Date(nowMs);
  const thenUtc = Date.UTC(then.getUTCFullYear(), then.getUTCMonth(), then.getUTCDate());
  const nowUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((nowUtc - thenUtc) / (24 * 60 * 60 * 1000));
}

// The first word of a reply, for the hard rule 8 bare-verdict check. Leading
// whitespace and markdown emphasis or blockquote characters are stripped
// first so "**No**, that order..." is caught as well as "No, that order...".
// The word itself is everything up to the first non-letter, which keeps
// "Nothing" and "Yesterday" from being misread as a bare verdict.
function openingWord(reply: string): string {
  return reply.replace(/^[\s*_#>~-]+/, "").split(/[^A-Za-z']/, 1)[0] ?? "";
}
