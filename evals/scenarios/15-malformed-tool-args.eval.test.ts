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
// ("safe failure or escalation"). We assert only what is actually
// guaranteed: the fault is consumed, the turn resolves without throwing, and
// no ledger row is left stuck pending.
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

      expect(["resolved", "escalated", "awaiting_approval"]).toContain(result.status);

      const stuckPending = db
        .prepare(`SELECT COUNT(*) AS n FROM actions_ledger WHERE thread_id = ? AND status = 'pending'`)
        .get(threadId) as { n: number };
      expect(stuckPending.n).toBe(0);

      const events = listEventsForThread(db, threadId);
      const { latencyMs, tokensIn, tokensOut } = summarizeLlmCalls(events);
      return {
        note: `Fault consumed once; turn ended in status "${result.status}" with no ledger row stuck pending.`,
        latencyMs,
        tokensIn,
        tokensOut,
      };
    });
  });
});
