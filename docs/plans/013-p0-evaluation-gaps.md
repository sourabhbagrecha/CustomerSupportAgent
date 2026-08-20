# Plan 012: P0 gaps from the self-assessment against the assignment brief

Written before the work started. Scores the repo against the assignment PDF's
own evaluation criteria surfaced three P0 issues; this plan fixes all three,
plus one correctness hole that fixing the third one exposes.

## Why these three

1. **Fixture dates expire.** Committed fixture dates are absolute and were
   generated on 2026-08-19. The policy engine computes the refund window
   against the real current date. `ord_006` (the prior-promise scenario) sits
   at 22 days of a 30-day window; `ord_001`, `ord_002`, `ord_003`,
   `ord_005` sit at 14, 7, 5 and 4 days. Roughly eight days from now the
   first eval scenario starts denying by window, and within three weeks most
   of the money-path suite is red. An evaluator who clones this repository a
   month after it was written runs `npm run eval` and sees failures that say
   nothing about the system. The README documents the drift and tells the
   reader to run `npm run fixtures`, but that puts the burden on the person
   we are asking to evaluate us, and the first impression is a red suite.

2. **Hard rule 8 makes the model pick a wrong verdict phrase.** Live
   reproduction from the running dev server, thread
   `cust_001_1787203016165`:

   > "No, that order is outside the refund window. It was placed on
   > 2026-08-06, and today is 2026-08-20, so it is still within 30 days.
   > However, there is already a refund of INR 450 recorded for it, so it is
   > not eligible for another automatic refund."

   Two defects in one reply. It opens with "No", which rule 8 explicitly
   forbids, and its first sentence contradicts its second. The real blocking
   reason is an exhausted refundable balance, not the window. Rule 8 offers
   the model only window-shaped and cap-shaped verdict phrasings, so when the
   blocking reason is neither, it reaches for the nearest one it was given.
   No eval scenario covers a follow-up eligibility question on an order that
   has already been refunded, so the gate is blind to this whole class.

3. **The assignment's first named edge case has zero coverage.** "A refund is
   taking longer than expected." Every one of the 22 committed payment
   fixtures is a succeeded charge. There is no pending refund anywhere in the
   data, no persona, no eval scenario, and no settlement-timeline section in
   `fixtures/policy.md`, so the agent has nothing to look up and nothing to
   tell the customer. It is the first bullet on the evaluator's own list.

## The correctness hole item 3 exposes

`refundableBalance` and `creditableBalance` in `server/src/policy/engine.ts`
sum only `status = 'succeeded'` refunds and credits. A refund that has been
submitted to the provider and is still `pending` therefore does not reduce
the refundable balance at all. Today that is invisible because no fixture and
no code path ever leaves a payment in `pending`. The moment an in-flight
refund exists in the data (item 3), a customer asking "where is my refund"
could have a second full refund auto-approved on top of the one already
moving, and the policy engine would call it `allow`. The idempotency key does
not save us here: a second request for the same amount on the same thread
collides on the key, but a different amount, or the same amount from a new
thread, does not.

An in-flight refund must be treated as money already committed. Both balance
functions reserve `pending` alongside `succeeded`.

## Work, and the file ownership that lets it run in parallel

Three independent tracks run first, then two that depend on them. Ownership is
disjoint per phase so parallel edits never touch the same file.

### Phase 1, run in parallel

**Track A, date stability.** Owns `fixtures/epoch.json` (new),
`scripts/seedFixtures.ts`, `scripts/seedFixtures.test.ts` (new),
`scripts/generate-fixtures.ts`, and the hardcoded judge date string in
`evals/scenarios/10-planted-instruction-injection.eval.test.ts`.

Approach: keep absolute dates in the committed fixtures (they stay readable
and diffable) and shift every date-bearing field by a whole number of days at
seed time. `fixtures/epoch.json` records the UTC date the fixtures were
generated; `loadFixturesInto` computes `shiftDays = max(0, todayUTC -
epoch)` and adds it to every date field on the way into the database. Every
relative age is preserved exactly and forever: `ord_006` is 22 days old on
the day it was generated and 22 days old a year later.

Rejected alternative: rewriting all seven fixture files to carry `daysAgo`
integers instead of dates. Same outcome, but it churns 585 message rows and
loses the human-readable timestamps for no additional guarantee.

This respects CLAUDE.md invariant 5. The fixtures stay committed and are not
generated at the evaluator's runtime; seeding resolves a committed offset
against a committed epoch, which is arithmetic on committed data, not
generation.

**Track B, hard rule 8.** Owns `server/src/agent/prompt.ts` and nothing else.
Rule 8 gains an explicit instruction that the opening verdict must name the
reason that actually blocks this request, with a phrasing offered for each
deny reason the policy engine can return (outside window, above cap,
ineligible status, already refunded / no refundable balance left), plus a
prohibition on stating a verdict the same reply then contradicts. The edit
stays inside rule 8. CLAUDE.md records four separate incidents of an edit to
one part of this prompt perturbing an unrelated rule, so the change is kept
as small as it can be while still fixing the observed failure.

**Track C, balance reservation.** Owns `server/src/policy/engine.ts` and
`server/src/policy/engine.test.ts`. Both balance functions count `pending`
refunds and credits as already committed. Tests cover: a pending refund
reduces the refundable balance; a pending refund equal to the charge leaves
zero and denies a second refund; a pending credit reduces the creditable
balance; failed payments are still ignored.

### Phase 2, after Tracks A and C land

**Track D, data and policy.** Owns `scripts/generate-fixtures.ts` (handed
over by Track A), all of `fixtures/`, and `server/src/personas.ts`. Adds:

- an order for the already-refunded follow-up case, with a succeeded charge
  and a matching succeeded full refund, so its refundable balance is zero;
- an order with a succeeded charge and a `pending` refund several days old,
  for the refund-taking-longer case;
- a "Refund Settlement Time" section in `fixtures/policy.source.json` stating
  that an approved refund reaches the original payment method in 5 to 7
  business days, and that a refund already showing as pending is in flight
  and must never be re-issued;
- two personas so both cases are reachable from the demo UI.

Fixtures are regenerated with `npm run fixtures` and committed, per CLAUDE.md
invariant 5.

### Phase 3, after Track D lands

**Track E, evals.** Owns two new scenario files. Scenario 23 asks a follow-up
eligibility question on the fully-refunded order and asserts the reply names
the real reason (no refundable balance) rather than the window, does not open
with a bare yes or no, and does not contradict itself; the judge gets the
ground truth. Scenario 24 asks where an in-flight refund is and asserts the
agent reads `get_payments`, reports the pending refund honestly with the
policy's settlement window, and creates zero new succeeded or pending ledger
rows on that order.

## Gate

`npm run typecheck` and `npm run test` after every phase. `npm run eval` is
the real gate for Tracks B and E and is run once at the end, with
`scripts/repeat-scenario.ts` on the judgment-call scenarios if rule 8's edit
shows any drift, per CLAUDE.md.

## Accepted for now

Thread-scoped idempotency keys are unchanged; the cross-thread duplicate risk
stays documented in the README rather than fixed here. It is a P1 in the
assessment and a separate body of work.
