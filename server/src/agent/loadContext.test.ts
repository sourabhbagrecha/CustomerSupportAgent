import { HumanMessage } from "@langchain/core/messages";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFixturesInto } from "../../../scripts/seedFixtures.js";
import { applySchema, openDb } from "../db/client.js";
import { listEventsForThread } from "../events/emitter.js";
import { clearAllFaults, setFault } from "../faults/registry.js";
import { loadContext } from "./loadContext.js";

// docs/plans/005 Phase 5B: loadContext calls the same mock APIs the model's
// tools call (getCustomer/getOrders/getPayments/getConversationHistory/
// searchPolicy, server/src/tools/mockApi.ts), before the model or any
// AGENT_TOOLS call gets a turn. Each of those goes through simulateCall(),
// where the tool_500 fault fires. Previously that error propagated straight
// out of loadContext and killed the whole graph turn: a transient support-API
// hiccup during context loading should degrade gracefully instead, the same
// way a mid-turn tool_500 does. This test proves loadContext now catches a
// transient fault per source, substitutes a labelled placeholder block for
// that source, and emits an `error` event (stage "load_context") rather than
// throwing, then recovers fully once the fault is consumed.

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
  applySchema(db);
  loadFixturesInto(db);
  clearAllFaults();
});

afterEach(() => clearAllFaults());

describe("loadContext degrades per-source on a transient tool fault instead of throwing", () => {
  it("substitutes placeholders and emits a load_context error event on tool_500, then returns a full block once the fault is consumed", async () => {
    const threadId = "test_load_context_tool_500";
    const customerId = "cust_001";
    const messages = [new HumanMessage("Can I get a refund for ord_001?")];

    // uses: 1, so it fires exactly once, on whichever mock API call reaches
    // simulateCall first. customer+orders is the first fetch loadContext
    // makes, so it is deterministically the one that absorbs it.
    setFault("tool_500", true, 1);

    const first = await loadContext(db, { threadId, customerId, messages });

    // customer+orders is one combined source (Promise.all loses which of the
    // two rejected), so both degrade together; payments cascades unavailable
    // too since there are no orders to iterate for it.
    expect(first.retrievedContextBlock).toContain(
      "[customer_profile unavailable: support API error; use the get_customer tool to retry]",
    );
    expect(first.retrievedContextBlock).toContain(
      "[orders unavailable: support API error; use the get_orders tool to retry]",
    );
    expect(first.retrievedContextBlock).toContain(
      "[payments unavailable: support API error; use the get_payments tool to retry]",
    );

    const events = listEventsForThread(db, threadId);
    const errorEvent = events.find(
      (e) => e.type === "error" && (e.payload as { stage?: string }).stage === "load_context",
    );
    expect(errorEvent, "expected an error event with stage load_context").toBeDefined();
    expect((errorEvent!.payload as { source?: string }).source).toBe("customer_orders");
    expect((errorEvent!.payload as { message?: string }).message).toMatch(/tool_500/);

    // The fault was consumed by the first call; a second call resolves fully,
    // no placeholder text anywhere in the block.
    const second = await loadContext(db, { threadId, customerId, messages });
    expect(second.retrievedContextBlock).not.toContain("unavailable: support API error");
    expect(second.retrievedContextBlock).toContain("cust_001");
    expect(second.retrievedContextBlock).toContain("ord_001");
    // Deterministic current_date block (server/src/agent/loadContext.ts):
    // today's date must be present so the model can do refund-window
    // arithmetic instead of guessing.
    expect(second.retrievedContextBlock).toContain(new Date().toISOString().slice(0, 10));

    const eventsAfterSecondCall = listEventsForThread(db, threadId);
    const errorEventsAfterSecondCall = eventsAfterSecondCall.filter((e) => e.type === "error");
    expect(errorEventsAfterSecondCall).toHaveLength(1);
  });

  it("does not catch or degrade a non-transient error", async () => {
    const threadId = "test_load_context_bad_customer";
    const messages = [new HumanMessage("hello")];

    await expect(
      loadContext(db, { threadId, customerId: "cust_does_not_exist", messages }),
    ).rejects.toThrow(/No customer found/);

    const events = listEventsForThread(db, threadId);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});
