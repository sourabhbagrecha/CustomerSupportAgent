import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTurn } from "../../server/src/agent/runTurn.js";
import { listEventsForThread } from "../../server/src/events/emitter.js";
import { clearAllFaults, getSnapshot, setFault } from "../../server/src/faults/registry.js";
import { createScenario, summarizeLlmCalls, withScenarioResult } from "../harness.js";

// docs/plans/005 Phase 5B, scenario 19: fault-injection coverage for
// tool_slow. Reuses scenario 01's persona and request (cust_001, ord_001,
// failed-delivery refund), same as scenario 18, so the only variable under
// test is the injected latency, not a different eligibility question.
//
// What this proves: unlike tool_500, tool_slow does not throw. It only
// sleeps 2000 + random*2000 ms once inside whichever mock API call it hits
// (server/src/tools/mockApi.ts's simulateCall), then that call proceeds and
// succeeds normally. There is no failure to locate in the event stream
// here, only a latency floor to confirm the eval harness actually
// tolerates: this scenario is a completion/timeout-budget check, not a
// repair-loop check like 15 and 18. What it deliberately does not assert:
// which specific tool absorbed the delay, or anything about event ordering,
// since nothing goes wrong for the turn to recover from.
//
// Timeout decision: vitest.eval.config.ts sets a global testTimeout of
// 60_000ms, already sized ("a multi-tool-call turn can take tens of
// seconds") for real multi-call model turns. tool_slow is set with
// `uses: 1`, so it adds at most one extra ~2000-4000ms sleep to the whole
// turn on top of a normal turn's few-second baseline, comfortably inside
// that 60s budget. This file does not override the global testTimeout.
describe("Scenario 19: tool_slow completes within the eval timeout budget", () => {
  beforeEach(() => clearAllFaults());
  afterEach(() => clearAllFaults());

  it("completes cust_001's ord_001 refund turn after one injected slow call", async () => {
    await withScenarioResult({ number: 19, name: "tool-slow-latency" }, async () => {
      const { db, graph } = createScenario();
      const threadId = "eval_scenario_19";

      setFault("tool_slow", true, 1);

      const result = await runTurn({
        db,
        graph,
        threadId,
        customerId: "cust_001",
        userMessage:
          "My wireless earbuds order ord_001 never arrived, the delivery failed. Can I get a refund?",
      });

      const snapshot = getSnapshot();
      expect(snapshot.tool_slow).toBeUndefined();

      expect(["resolved", "waiting_for_customer", "escalated", "awaiting_approval"]).toContain(result.status);
      expect(result.reply).toBeTruthy();

      const stuckPending = db
        .prepare(`SELECT COUNT(*) AS n FROM actions_ledger WHERE thread_id = ? AND status = 'pending'`)
        .get(threadId) as { n: number };
      expect(stuckPending.n).toBe(0);

      const succeededLedgerRows = db
        .prepare(
          `SELECT id FROM actions_ledger WHERE thread_id = ? AND order_id = 'ord_001' AND status IN ('succeeded', 'reconciled')`,
        )
        .all(threadId) as Array<{ id: number }>;
      expect(succeededLedgerRows.length).toBeLessThanOrEqual(1);

      const events = listEventsForThread(db, threadId);
      const { latencyMs, tokensIn, tokensOut } = summarizeLlmCalls(events);
      return {
        note: `Fault consumed once; turn completed within the eval timeout budget in status "${result.status}" with no ledger row stuck pending and at most one succeeded/reconciled ledger row on ord_001.`,
        latencyMs,
        tokensIn,
        tokensOut,
      };
    });
  });
});
