# 006: Credits are bounded by the order they are tied to

Status: planned, then delivered in the same commit as this file.

## Why

A live conversation (customer cust_001, order ord_001, a ₹450 failed-delivery order) ended with
₹950 leaving the company on a ₹450 order:

1. The agent refunded the ₹450 correctly (policy engine verdict `allow`, ledger row 4).
2. The customer then claimed, with no supporting record anywhere in retrieved history, that a
   previous agent had promised ₹2,000. The model treated that unverified claim as if hard rule 6
   (a prior promise found in retrieved history) applied, issued the ₹500 cap as a credit
   immediately, and escalated the ₹1,500 gap. Rule 6 says in so many words that it applies only
   when retrieved history shows the promise; with no such record the correct move was to call
   `issue_credit` for the full ₹2,000 and let `requires_approval` pause it.
3. The policy engine let that ₹500 credit through as `allow` (ledger row 5). The engine's
   status, window, and refundable-balance checks all sit inside `if (actionType === "refund")`;
   a credit only gets the ownership check and the ₹500 auto-credit cap. Nothing deterministic
   notices that the order had already been refunded in full, or that ₹500 exceeds the ₹450 the
   customer ever paid on it.

Layer 2 is the one this plan fixes. Layer 1 is a model judgment problem and stays a prompt
question (see "Non-scope"); the point of the engine is that it still holds when the model gets it
wrong, and here it did not.

## What changes

Policy engine (`server/src/policy/engine.ts`):

- A credit tied to an order is checked against that order's creditable balance: succeeded
  charges minus succeeded refunds minus succeeded credits already issued on that order. A credit
  above that balance returns `requires_approval` (not `deny`), with a reason that states the
  requested amount, the balance, and how it is computed. It is `requires_approval` rather than
  `deny` because a goodwill credit above an order's value is a legitimate thing for a human to
  grant, and `requires_approval` puts the case in front of a human deterministically (the graph
  interrupts), whereas a denial only reaches a human if the model also remembers to escalate.
  Refunds keep their existing `exceeds_refundable_amount` denial: a refund beyond what was
  charged is not a judgment call, it is impossible against the original payment method.
- A credit not tied to any order returns `requires_approval`. Without an order there is nothing
  to bound it by, and leaving it auto-allowed would make the per-order bound trivially
  bypassable by omitting `orderId`. Ownership, cap, and the existing deny reasons are unchanged.

Policy text (`fixtures/policy.source.json`, regenerated into `policy.md` and
`policy_chunks.json`): the Credits section states the bound and the orderless rule, so the
prose the agent retrieves and the code the engine runs say the same thing.

Tests (`server/src/policy/engine.test.ts`): allow within balance; approval on a fully refunded
order; approval above order value; prior credits count toward the balance; orderless credit is
approval; refund behaviour unchanged.

README: one assumption entry describing the bound and why it is approval rather than denial.

## Non-scope

- Hard rule 6 wording in `server/src/agent/prompt.ts`. Tightening it (an explicit negative
  example: the customer saying a prior agent promised something, with nothing in history, is not
  this rule) is a separate change that needs `repeat-scenario.ts` replays, not one eval pass.
- Any per-customer or cross-order credit budget. One order is the unit the data supports.
- `policy.json` keys: the bound is structural, not a new numeric limit, so the machine-readable
  document does not change and the policy.md/policy.json consistency test is unaffected.
