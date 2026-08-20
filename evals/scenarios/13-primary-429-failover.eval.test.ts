import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTurn } from "../../server/src/agent/runTurn.js";
import { listEventsForThread } from "../../server/src/events/emitter.js";
import { clearAllFaults, setFault } from "../../server/src/faults/registry.js";
import { createScenario, summarizeLlmCalls, withScenarioResult } from "../harness.js";

// PLAN Section 10, scenario 13: primary model 429s, wrapper fails over to
// FALLBACK_MODEL, a `failover` event is emitted, the turn still completes.
//
// Known nuance (see task brief): the model client retries the SAME model up
// to 2 times before failing over. A small `uses` count can let the internal
// retry on primary succeed before failover ever triggers. Setting the fault
// with no uses (stays active until explicitly cleared) reliably forces
// failover on every primary attempt for this turn.
describe("Scenario 13: primary 429 fails over to the fallback model", () => {
  beforeEach(() => clearAllFaults());
  afterEach(() => clearAllFaults());

  it("completes cust_001's refund via the fallback model after primary rate-limits", async () => {
    await withScenarioResult({ number: 13, name: "primary-429-failover" }, async () => {
      const { db, graph } = createScenario();
      const threadId = "eval_scenario_13";

      setFault("model_rate_limit_primary", true);

      const result = await runTurn({
        db,
        graph,
        threadId,
        customerId: "cust_001",
        userMessage:
          "My wireless earbuds order ord_001 never arrived, the delivery failed. Can I get a refund?",
      });

      clearAllFaults();

      expect(result.degraded).toBe(false);
      expect(result.reply).toBeTruthy();

      const events = listEventsForThread(db, threadId);
      const failoverEvents = events.filter((e) => e.type === "failover");
      expect(failoverEvents.length).toBeGreaterThanOrEqual(1);

      // The trace must show an actual model swap, not just a same-model
      // retry relabeled as a failover (task P1-5): the fallback id recorded
      // in the failover event must differ from the primary id it fell back
      // from.
      const failoverPayload = failoverEvents[0]!.payload as { from?: unknown; to?: unknown };
      expect(typeof failoverPayload.from).toBe("string");
      expect(typeof failoverPayload.to).toBe("string");
      expect(failoverPayload.from).not.toBe(failoverPayload.to);

      const { latencyMs, tokensIn, tokensOut } = summarizeLlmCalls(events);
      return {
        note: "Primary 429 triggered at least one failover event; fallback model completed the turn without degrading.",
        latencyMs,
        tokensIn,
        tokensOut,
      };
    });
  });
});
