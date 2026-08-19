// Shared display formatting. Extracted so the ledger table and the audit
// queue render an amount identically.
import type { ApprovalRow } from "./types";

// The INR branch is byte-identical to the string the chat approval banner
// rendered before it was extracted (and before 004 removed that banner) (no locale grouping, no forced decimals), so the
// refactor is provably zero-diff. Every row is INR today, but actions_ledger
// carries a currency column and the audit table is where a non-INR row would
// first become visible.
export function formatAmount(amount: number, currency = "INR"): string {
  return currency === "INR" ? `Rs. ${amount}` : `${currency} ${amount}`;
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatClock(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Button copy for an audit queue item, kind-aware: a
// policy_approval is a pending above-cap request (plain approve/reject), an
// escalation tied to a denied ledger row is a policy exception being
// considered (grant/uphold), and an escalation with no money action attached
// is a follow-up-only review (nothing to grant, only to mark handled).
export function approvalActionLabels(approval: ApprovalRow): { approve: string; reject: string } {
  if (approval.kind === "policy_approval") {
    return { approve: "Approve", reject: "Reject" };
  }
  if (approval.ledgerId !== null) {
    return { approve: "Grant exception", reject: "Uphold denial" };
  }
  return { approve: "Mark resolved", reject: "Needs follow-up" };
}
