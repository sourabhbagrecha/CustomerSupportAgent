import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEGRADED_REPLY_TEXT } from "../../server/src/agent/degradedReply.js";
import { runTurn } from "../../server/src/agent/runTurn.js";
import { listEventsForThread } from "../../server/src/events/emitter.js";
import { clearAllFaults, setFault } from "../../server/src/faults/registry.js";
import { createScenario, withScenarioResult } from "../harness.js";

// PLAN Section 10, scenario 14: model_down_all. The LLM-free degradation path
// (CLAUDE.md invariant 6) must return a fixed apology, create an escalation,
// and never throw, since it must never touch a model client at all.
describe("Scenario 14: all models down triggers the LLM-free degraded reply", () => {
  beforeEach(() => clearAllFaults());
  afterEach(() => clearAllFaults());

  it("resolves gracefully with the fixed degraded reply and an escalation record", async () => {
    await withScenarioResult({ number: 14, name: "all-models-down-degraded" }, async () => {
      const { db, graph } = createScenario();
      const threadId = "eval_scenario_14";

      setFault("model_down_all", true);

      const result = await runTurn({
        db,
        graph,
        threadId,
        customerId: "cust_001",
        userMessage: "My wireless earbuds order ord_001 never arrived, can I get a refund?",
      });

      clearAllFaults();

      expect(result.degraded).toBe(true);
      expect(result.status).toBe("escalated");
      expect(result.reply).toBe(DEGRADED_REPLY_TEXT);

      const events = listEventsForThread(db, threadId);
      const escalationEvents = events.filter((e) => e.type === "escalation");
      expect(escalationEvents.length).toBeGreaterThanOrEqual(1);

      return {
        note: "model_down_all produced the fixed degraded reply, status escalated, and an escalation event, with no crash.",
      };
    });
  });
});
