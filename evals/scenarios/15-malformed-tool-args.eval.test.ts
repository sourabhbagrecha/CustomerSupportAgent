import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTurn } from "../../server/src/agent/runTurn.js";
import { listEventsForThread } from "../../server/src/events/emitter.js";
import { clearAllFaults, getSnapshot, setFault } from "../../server/src/faults/registry.js";
import { createScenario, summarizeLlmCalls, withScenarioResult } from "../harness.js";

// PLAN Section 10, scenario 15: malformed_tool_args deterministically makes
// the very next tool call (whichever tool the model invokes first) throw a
// validation-shaped error once, then the fault clears itself.
//
// Known nuance (see task brief): real model behavior after this varies. It
// may retry the same tool and succeed, proceed via other tools and still
// complete the request, or escalate. All three are acceptable per PLAN
// ("safe failure or escalation"). We assert the fault is consumed, the turn
// resolves without throwing, no ledger row is left stuck pending, and (per
// docs/plans/005 Phase 5B) that repair actually happened, not just that
// nothing blew up.
//
// Repair-evidence marker: maybeInjectMalformedArgsFault (agentTools.ts)
// fires at the very top of every one of the eight tool wrappers, BEFORE
// that wrapper ever emits its own "tool_call" event. So the failed attempt
// itself writes zero rows to the events table: there is no tool_call,
// tool_result, or error event to point to as "the failure happened here"
// (contrast tool_500 in scenario 18, which fires inside the mock API call
// AFTER agentTools.ts has already logged tool_call, leaving a genuine
// orphaned tool_call). The fault firing is already proven deterministically
// below (getSnapshot shows it consumed, and it was set with exactly one
// remaining use, so "consumed" cannot mean "never used"). Given the failure
// is invisible in the log by construction, the anchor for "after the
// failure" is the turn's first recorded event (loadContext's step event,
// which always precedes any tool activity), and the repair evidence is any
// tool_result event (agentTools.ts only ever emits tool_result after its Zod
// output schema validates, on the success path; there is no such thing as a
// failed tool_result) or escalation event appearing after it.
describe("Scenario 15: malformed_tool_args exercises the repair loop", () => {
  beforeEach(() => clearAllFaults());
  afterEach(() => clearAllFaults());

  it("consumes the fault once and ends in a safe, non-stuck state", async () => {
    await withScenarioResult({ number: 15, name: "malformed-tool-args" }, async () => {
      const { db, graph } = createScenario();
      const threadId = "eval_scenario_15";

      setFault("malformed_tool_args", true, 1);

      const result = await runTurn({
        db,
        graph,
        threadId,
        customerId: "cust_001",
        userMessage:
          "My wireless earbuds order ord_001 never arrived, the delivery failed. Can I get a refund?",
      });

      const snapshot = getSnapshot();
      expect(snapshot.malformed_tool_args).toBeUndefined();

      expect(["resolved", "waiting_for_customer", "escalated", "awaiting_approval"]).toContain(result.status);

      const stuckPending = db
        .prepare(`SELECT COUNT(*) AS n FROM actions_ledger WHERE thread_id = ? AND status = 'pending'`)
        .get(threadId) as { n: number };
      expect(stuckPending.n).toBe(0);

      const events = listEventsForThread(db, threadId);

      const firstEventId = events[0]?.id ?? 0;
      const repairEvent = events.find(
        (e) => (e.id ?? 0) > firstEventId && (e.type === "tool_result" || e.type === "escalation"),
      );
      expect(
        repairEvent,
        "expected a successful tool_result or an escalation event after the turn began, evidencing recovery from the malformed_tool_args failure",
      ).toBeDefined();

      const { latencyMs, tokensIn, tokensOut } = summarizeLlmCalls(events);
      return {
        note: `Fault consumed once; turn ended in status "${result.status}" with no ledger row stuck pending and a "${repairEvent?.type}" event evidencing repair.`,
        latencyMs,
        tokensIn,
        tokensOut,
      };
    });
  });
});
