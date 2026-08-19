import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTurn } from "../../server/src/agent/runTurn.js";
import { listEventsForThread } from "../../server/src/events/emitter.js";
import type { AgentEvent } from "../../server/src/events/types.js";
import { clearAllFaults, getSnapshot, setFault } from "../../server/src/faults/registry.js";
import { createScenario, summarizeLlmCalls, withScenarioResult } from "../harness.js";

// docs/plans/005 Phase 5B, scenario 18: fault-injection coverage for
// tool_500. Reuses scenario 01's persona and request (cust_001, ord_001,
// failed-delivery refund) so the only variable under test is the injected
// server error, not a different eligibility question.
//
// What this proves: tool_500 (server/src/tools/mockApi.ts's simulateCall)
// throws ToolServerError from inside whichever mock API call it hits.
// loadContext (server/src/agent/loadContext.ts) always runs first, before
// the model or any AGENT_TOOLS call gets a turn, and it calls the same mock
// APIs (getCustomer/getOrders/getPayments/getConversationHistory/
// searchPolicy), each going through simulateCall. With `uses: 1`, the fault
// fires on whichever of those calls reaches simulateCall first, i.e. almost
// always inside loadContext, before any model-issued tool_call event exists
// to be orphaned. loadContext now catches that per-source (customer+orders,
// payments, history, policy) and emits an `error` event with stage
// "load_context" instead of letting it propagate and kill the turn (see
// loadContext.ts and its unit test), substituting a labelled placeholder
// block for that source so the model still gets a coherent turn and can
// retry via the tool. This is the opposite ordering from
// malformed_tool_args (scenario 15), whose fault fires before any tool_call
// event is written at all, and different again from the tool_call-then-500
// case this test originally assumed: if the fault is instead consumed by a
// model-issued tool call (e.g. because a prior turn's context is cached, or
// future retrieval changes shift which call goes first), agentTools.ts logs
// "tool_call" before invoking the mock API, so that call's tool_call event
// is left unpaired with no tool_result, the same deterministic fingerprint
// as before. findMarkerEvent below accepts either fingerprint: an orphaned
// tool_call (findOrphanedToolCall, pairing each tool_call with the next
// tool_result for the same tool name FIFO per tool) or a load_context error
// event, whichever the fault actually produced this run. Either way it
// proves the fault fired for real (not merely "consumed" per getSnapshot,
// which could in principle also mean an explicit clear), and gives a
// concrete point in the trace to assert recovery evidence comes after: a
// later tool_result or escalation event.
//
// What this test deliberately does NOT assert: which specific tool or
// context source absorbed the 500, or that the model recovers via a retry
// of the same tool specifically rather than a different tool or an
// escalation. All are treated as safe per CLAUDE.md's "safe failure or
// escalation" standard, same as scenario 15. If the fault happens to hit a
// read tool first and the model goes on to complete the refund normally,
// the "no duplicate" check below still holds regardless of which path was
// taken.
describe("Scenario 18: tool_500 recovers without duplicating money movement", () => {
  beforeEach(() => clearAllFaults());
  afterEach(() => clearAllFaults());

  it("recovers cust_001's ord_001 refund turn after one injected 500", async () => {
    await withScenarioResult({ number: 18, name: "tool-500-recovery" }, async () => {
      const { db, graph } = createScenario();
      const threadId = "eval_scenario_18";

      setFault("tool_500", true, 1);

      const result = await runTurn({
        db,
        graph,
        threadId,
        customerId: "cust_001",
        userMessage:
          "My wireless earbuds order ord_001 never arrived, the delivery failed. Can I get a refund?",
      });

      const snapshot = getSnapshot();
      expect(snapshot.tool_500).toBeUndefined();

      expect(["resolved", "waiting_for_customer", "escalated", "awaiting_approval"]).toContain(result.status);
      expect(result.reply).toBeTruthy();

      const stuckPending = db
        .prepare(`SELECT COUNT(*) AS n FROM actions_ledger WHERE thread_id = ? AND status = 'pending'`)
        .get(threadId) as { n: number };
      expect(stuckPending.n).toBe(0);

      // No duplicate money movement, whether or not the fault happened to
      // hit a read tool first and the model went on to complete the refund.
      const refundPayments = db
        .prepare(`SELECT amount FROM payments WHERE order_id = 'ord_001' AND type = 'refund'`)
        .all() as Array<{ amount: number }>;
      expect(refundPayments.length).toBeLessThanOrEqual(1);

      const events = listEventsForThread(db, threadId);
      const marker = findMarkerEvent(events);
      expect(
        marker,
        "expected either an orphaned tool_call event or a load_context error event as the injected tool_500's fingerprint",
      ).toBeDefined();

      const recoveryEvent = events.find(
        (e) => (e.id ?? 0) > (marker!.id ?? 0) && (e.type === "tool_result" || e.type === "escalation"),
      );
      expect(
        recoveryEvent,
        "expected a successful tool_result or an escalation event after the 500 marker",
      ).toBeDefined();

      const { latencyMs, tokensIn, tokensOut } = summarizeLlmCalls(events);
      return {
        note: `Fault consumed once; the "${marker?.type}" marker it produced was followed by a "${recoveryEvent?.type}" event; turn ended in status "${result.status}" with no ledger row stuck pending and at most one refund payment on ord_001.`,
        latencyMs,
        tokensIn,
        tokensOut,
      };
    });
  });
});

// Pairs each tool_call event with the next tool_result event carrying the
// same tool name (FIFO per tool), and returns the first tool_call left
// unpaired: the call whose underlying mock API invocation threw before
// agentTools.ts ever reached its tool_result emission. This is deterministic
// under tool_500 specifically because the tool_call event is always emitted
// before the mock API call runs (see every tool definition in
// agentTools.ts), so a thrown ToolServerError always leaves its tool_call
// stranded. escalate_to_human is immune: it never calls the mock API's
// simulateCall, so tool_500 cannot touch it.
function findOrphanedToolCall(events: AgentEvent[]): AgentEvent | undefined {
  const pending = new Map<string, AgentEvent[]>();
  for (const e of events) {
    const tool = (e.payload as { tool?: string }).tool;
    if (!tool) continue;
    if (e.type === "tool_call") {
      const queue = pending.get(tool) ?? [];
      queue.push(e);
      pending.set(tool, queue);
    } else if (e.type === "tool_result") {
      pending.get(tool)?.shift();
    }
  }
  const orphans = [...pending.values()].flat();
  orphans.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  return orphans[0];
}

// The injected tool_500's fingerprint can land in either of two places
// (see the header comment): an orphaned tool_call, if a model-issued
// AGENT_TOOLS call absorbed it, or a load_context error event, if
// loadContext's own mock API calls absorbed it first (the common case,
// since loadContext always runs before the model gets a turn). Whichever
// happened this run, return the earliest one so recovery evidence can be
// asserted after it.
function findMarkerEvent(events: AgentEvent[]): AgentEvent | undefined {
  const orphanCall = findOrphanedToolCall(events);
  const loadContextError = events.find(
    (e) => e.type === "error" && (e.payload as { stage?: string }).stage === "load_context",
  );
  const candidates = [orphanCall, loadContextError].filter((e): e is AgentEvent => e !== undefined);
  candidates.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  return candidates[0];
}
