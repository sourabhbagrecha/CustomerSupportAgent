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
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    resolvedAt: null,
    resolvedBy: null,
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
      remark: null,
    });
    expect(text).toContain("approved and processed");
    expect(text).toContain("₹1,500");
    expect(text).not.toContain("Reviewer note");
  });

  it("describes an escalation exception being granted, distinctly from a plain approval", () => {
    const text = buildDecisionNotice({
      approval: approval({ kind: "escalation", denialReason: "outside the 30-day refund window" }),
      decision: "approve",
      moneyResult: succeeded(3200),
      remark: "One-time exception given the delivery delay was on our end.",
    });
    expect(text).toContain("making an exception");
    expect(text).toContain("Reviewer note: One-time exception given the delivery delay was on our end.");
  });

  it("describes a denial being upheld", () => {
    const text = buildDecisionNotice({
      approval: approval({ kind: "escalation" }),
      decision: "reject",
      moneyResult: denied(3200),
      remark: "Order was never delivered per our records.",
    });
    expect(text).toContain("earlier decision stands");
    expect(text).toContain("Reviewer note: Order was never delivered per our records.");
  });

  it("handles an escalation with no related money action", () => {
    const text = buildDecisionNotice({
      approval: approval({ kind: "escalation", ledgerId: null, actionType: null, amount: null }),
      decision: "approve",
      moneyResult: null,
      remark: "Followed up by phone.",
    });
    expect(text).toContain("has been resolved");
    expect(text).toContain("Reviewer note: Followed up by phone.");
  });

  it("omits the reviewer note line entirely when there is no remark", () => {
    const text = buildDecisionNotice({
      approval: approval(),
      decision: "approve",
      moneyResult: succeeded(1500),
      remark: null,
    });
    expect(text).not.toContain("Reviewer note");
  });
});
