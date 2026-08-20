import { describe, expect, it } from "vitest";
import type { ApprovalRow } from "../ledger/approvals.js";
import type { MoneyActionResult } from "../tools/schemas.js";
import { buildDecisionNotice } from "./notify.js";

function approval(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: 1,
    kind: "policy_approval",
    ledgerId: 10,
    threadId: "t1",
    actionType: "refund",
    customerId: "c1",
    orderId: "ord_a",
    amount: 1500,
    policyReason: "Requested amount 1500 exceeds the auto-refund cap of 500 INR and requires human approval.",
    denialReason: null,
    category: null,
    context: null,
    remark: null,
    customerNote: null,
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    resolvedAt: null,
    resolvedBy: null,
    executedAt: null,
    ...overrides,
  };
}

function succeeded(amount: number): MoneyActionResult {
  return {
    ledgerId: 10,
    actionType: "refund",
    amount,
    currency: "INR",
    orderId: "ord_a",
    status: "succeeded",
    receipt: { paymentId: "pay_1", providerReference: null },
  };
}

function denied(amount: number): MoneyActionResult {
  return {
    ledgerId: 10,
    actionType: "refund",
    amount,
    currency: "INR",
    orderId: "ord_a",
    status: "denied",
    policyReason: "Order is 90 days past delivery, outside the 30-day refund window.",
  };
}

describe("buildDecisionNotice", () => {
  it("describes a plain approval being processed", () => {
    const text = buildDecisionNotice({
      approval: approval(),
      decision: "approve",
      moneyResult: succeeded(1500),
      customerNote: null,
    });
    expect(text).toContain("approved and processed");
    expect(text).toContain("₹1,500");
    expect(text).not.toContain("Note:");
  });

  it("describes an escalation exception being granted, distinctly from a plain approval", () => {
    const text = buildDecisionNotice({
      approval: approval({ kind: "escalation", denialReason: "outside the 30-day refund window" }),
      decision: "approve",
      moneyResult: succeeded(3200),
      customerNote: "One-time exception given the delivery delay was on our end.",
    });
    expect(text).toContain("making an exception");
    expect(text).toContain("Note: One-time exception given the delivery delay was on our end.");
  });

  it("describes a denial being upheld", () => {
    const text = buildDecisionNotice({
      approval: approval({ kind: "escalation" }),
      decision: "reject",
      moneyResult: denied(3200),
      customerNote: "Order was never delivered per our records.",
    });
    expect(text).toContain("earlier decision stands");
    expect(text).toContain("Note: Order was never delivered per our records.");
  });

  it("handles an escalation with no related money action", () => {
    const text = buildDecisionNotice({
      approval: approval({ kind: "escalation", ledgerId: null, actionType: null, amount: null }),
      decision: "approve",
      moneyResult: null,
      customerNote: "Followed up by phone.",
    });
    expect(text).toContain("has been resolved");
    expect(text).toContain("Note: Followed up by phone.");
  });

  it("omits the note line entirely when there is no customer-facing note", () => {
    const text = buildDecisionNotice({
      approval: approval(),
      decision: "approve",
      moneyResult: succeeded(1500),
      customerNote: null,
    });
    expect(text).not.toContain("Note:");
  });

  // P0-3: an internal reviewer remark (ApprovalRow.remark) is never even
  // accepted by this function's parameters, so there is no code path by
  // which it could leak into the customer transcript; only customerNote can.
  it("never renders the internal remark field, even if a caller mistakenly reuses it as the customer note", () => {
    const text = buildDecisionNotice({
      approval: approval({ remark: "Reviewer note: internal-only text that must never reach the customer." }),
      decision: "reject",
      moneyResult: denied(3200),
      customerNote: "We were unable to verify the order was delivered as described.",
    });
    expect(text).not.toContain("internal-only");
    expect(text).toContain("We were unable to verify the order was delivered as described.");
  });

  // P0-3 backstop: profanity in the customer-facing field is redacted, never
  // blocked outright, so the customer still gets the substance.
  it("redacts profanity in the customer-facing note as a backstop, without dropping the rest of the message", () => {
    const text = buildDecisionNotice({
      approval: approval({ kind: "escalation" }),
      decision: "reject",
      moneyResult: denied(3200),
      customerNote: "This is fucking ridiculous but here goes: order was never delivered.",
    });
    expect(text.toLowerCase()).not.toContain("fuck");
    expect(text).toContain("[redacted]");
    expect(text).toContain("order was never delivered.");
  });

  it("redacts profanity case-insensitively and for multiple matches", () => {
    const text = buildDecisionNotice({
      approval: approval({ kind: "escalation" }),
      decision: "reject",
      moneyResult: denied(3200),
      customerNote: "This is BULLSHIT and you are an Asshole.",
    });
    expect(text).not.toMatch(/bullshit/i);
    expect(text).not.toMatch(/asshole/i);
    expect(text).toContain("[redacted]");
  });
});
