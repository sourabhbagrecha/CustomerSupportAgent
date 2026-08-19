// Shared display formatting. Extracted so the ledger table and the chat
// approval banner render an amount identically.

// The INR branch is byte-identical to the string the approval banner rendered
// before this was extracted (no locale grouping, no forced decimals), so the
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
