import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTurn } from "../../server/src/agent/runTurn.js";
import { listEventsForThread } from "../../server/src/events/emitter.js";
import { clearAllFaults } from "../../server/src/faults/registry.js";
import { createScenario, summarizeLlmCalls, withScenarioResult } from "../harness.js";
import { judgeReply } from "../judge.js";

// PLAN Section 10, scenario 21 (task P1-4, "verified-promise"): conversation
// history for cust_006/ord_006 (fixtures/conversation_messages.json,
// conv_arjun_001) DOES contain a matching prior-agent promise of a specific
// INR 2000 refund. Distinct from scenario 6, which only checks the capped
// amount and that an escalation happened: this scenario additionally asserts
// the escalation actually carries evidence of that promise (the amount or
// the conversation it came from), not just a bare "cap breach" note, since an
// escalation with no evidence would leave a human reviewer no way to confirm
// the claim is real. Judgment-call scenario: per CLAUDE.md, replay affected
// scenarios with `npx tsx scripts/repeat-scenario.ts <runs> 06` (probe 06
// drives this same customer/order/message) before trusting a single pass on
// any prompt change touching hard rule 6.
describe("Scenario 21: verified prior promise is auto-capped and escalated with evidence", () => {
  beforeEach(() => clearAllFaults());
  afterEach(() => clearAllFaults());

  it("issues the INR 500 cap automatically and escalates the gap citing the actual promise", async () => {
    await withScenarioResult({ number: 21, name: "verified-promise" }, async () => {
      const { db, graph } = createScenario();
      const threadId = "eval_scenario_21";

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
        .prepare(`SELECT status, amount FROM actions_ledger WHERE thread_id = ?`)
        .all(threadId) as Array<{ status: string; amount: number }>;
      const cappedRefund = ledgerRows.find((r) => r.status === "succeeded");
      expect(cappedRefund?.amount).toBe(500);
      expect(ledgerRows.some((r) => r.status === "succeeded" && r.amount > 500)).toBe(false);

      const events = listEventsForThread(db, threadId);
      const escalations = events.filter((e) => e.type === "escalation");
      expect(escalations.length).toBeGreaterThanOrEqual(1);

      // Evidence check: the escalation's own payload (not just the agent's
      // chat reply) should point at the actual promise, either by the amount
      // (2000 / 2,000, the figure conv_arjun_001 recorded) or by naming the
      // conversation or the fact a previous agent made it.
      const escalationText = escalations
        .map((e) => JSON.stringify(e.payload))
        .join(" ")
        .toLowerCase();
      const citesEvidence = /2,?000|conv_arjun_001|previous agent|prior agent/.test(escalationText);
      expect(citesEvidence, `escalation payload carried no promise evidence: ${escalationText}`).toBe(true);

      const judge = await judgeReply(result.reply ?? "", {
        scenario: "prior INR 2,000 promise vs INR 500 policy cap, verified in conversation history",
        expectation:
          "The agent should honestly acknowledge the verified prior promise, process the INR 500 cap now, and escalate the INR 1,500 remainder citing the actual promise as evidence.",
      });
      if (judge.state === "scored") {
        expect(judge.toneOk, `judge toneOk failed: ${judge.notes}`).toBe(true);
        expect(judge.groundedOk, `judge groundedOk failed: ${judge.notes}`).toBe(true);
      }

      const { latencyMs, tokensIn, tokensOut } = summarizeLlmCalls(events);
      return {
        note: "Verified prior promise (conv_arjun_001): INR 500 cap auto-issued, gap escalated citing the actual promised amount/conversation as evidence.",
        judge,
        judgeState: judge.state,
        latencyMs,
        tokensIn,
        tokensOut,
      };
    });
  });
});
