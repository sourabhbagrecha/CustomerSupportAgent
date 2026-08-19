# 003: Human decision queue for escalations

Status: planned, then delivered in the same commit as this file.

## Why

An evaluator ran the Karan Bhatia stress-test persona (200-conversation history plus retrieval
stress test) against `main`, escalated an office-chair refund after a policy denial, and saw the
console badge the thread ESCALATED while the Audit tab showed the same refund terminally DENIED,
"not resolved". Two problems, both real:

1. The denial itself was correct: `evaluatePolicy` in `server/src/policy/engine.ts` checks the
   30-day refund window before the auto-approval cap, so an order 90 days past delivery is denied
   outright and never reaches `requires_approval`. Nothing to fix there.
2. `escalate_to_human` (`server/src/tools/agentTools.ts`) wrote one `escalation` event and returned
   `status: "escalated"`, which `graph.ts` latched onto the thread's `resolutionStatus`
   permanently. No human ever acted on it, and nothing reconciled that flag against the ledger's
   actual outcome. Plan 002 said as much explicitly: "`escalate_to_human` remains fire and forget
   into `events`, with no table, assignee, or close." This plan is what changes that.

The evaluator's ask, verbatim: an escalation should get an explicit human decision; the admin
should see why policy refused and be able to grant an exception; a remark explaining the decision
(especially a denial) should be required so the customer gets context; and the customer must be
told the outcome in the chat, not just in the audit trail.

## Scope and non-scope

In scope: `escalate_to_human` creates a row in the same admin decision queue a `requires_approval`
verdict already uses, an admin can grant an exception or uphold a denial with a mandatory-on-deny
remark, and the decision reaches the customer as a real chat message.

Explicitly not in scope: every policy denial does not enter the queue, only ones the agent actually
escalates (see decisions below). The LLM-free degradation path (`degradedReply.ts`, invariant 6)
is untouched: it has no ledger action to decide on and must never gain a code path that could
invoke a model. No new infrastructure, no migration runner (schema changes still mean
`npm run seed`, per 002's established precedent).

## Decisions

- **Escalations only enter the queue, not every denial.** Most denials are not escalated (rule 7's
  fabricated-amount case takes zero tool actions and escalates directly; an ordinary denial the
  agent explains and the customer accepts never calls `escalate_to_human` at all). Queueing every
  `deny` verdict would flood the admin with data-error denials (`order_not_found`,
  `invalid_amount`) nobody should act on. `escalate_to_human` is already the model's own signal
  that a human is needed; that signal is what creates the row.
- **One table, a `kind` discriminator.** `approvals` already modeled "one thing waiting on a human
  decision" for `requires_approval`. An escalation is the same shape (who, what, why, pending) with
  a different provenance (a tool call at the end of an already-completed turn rather than an
  `interrupt()` mid-turn) and no guaranteed money action. `ledger_id` / `action_type` / `amount`
  became nullable rather than duplicating the table, and `denial_reason` / `category` / `context` /
  `remark` were added for the same reason the interrupt path already had `policy_reason`: the admin
  needs the real refusal text, not the model's paraphrase of it.
- **Deterministic notice text, not an LLM reply.** `server/src/agent/notify.ts` composes the
  customer-facing message from the decision, the money outcome, and the remark in code, then
  appends it straight to the thread's checkpointed LangGraph state via `graph.updateState(...,
  asNode: "agent")`. This is the same "LLM proposes, code disposes" reasoning CLAUDE.md states for
  the money path, applied to the human's remark: it must reach the customer verbatim, never
  reworded, softened, or silently dropped by a model call, and it must not cost a model call per
  decision.
- **Reuse the exact same idempotency key to grant an exception.** A `denied` ledger row has never
  called the raw mock API (deny short-circuits before any external call, per invariant 1), so
  `resolveApprovedAction` on a denied row is the first real attempt either way, exactly like the
  existing `requires_approval` -> approve path. No new key is derived; exactly-once holds by
  construction, not by a new check.
- **Remark required to reject or uphold, optional to approve.** The customer most needs context
  when refused. `ApprovalResolveRequestSchema`'s `.refine()` enforces this at the HTTP boundary.
- **The frontend re-hydrates from `GET /api/threads/:id/state` after any decision, instead of
  trusting the resolve route's `reply` string as the one new chat bubble.** A decision can now
  produce two separate messages in state (the agent's own reply if the graph resumed, then the
  deterministic notice), so `App.tsx`'s `handleApprovalDecision` and `handleAuditResolved` refetch
  the authoritative transcript rather than growing a local array by guesswork.
- **Thread status stops overloading "escalated".** `graph.ts`'s tools node now sets
  `resolutionStatus` to `awaiting_approval` (not `escalated`) when `escalate_to_human` runs, since
  there is now always a real pending decision to point at. `notify.ts` moves it to `resolved` once
  that decision is made. The `escalated` status value still exists for the all-models-down
  degraded path in `degradedReply.ts`, which is a genuinely different, non-actionable case.

## Known limitation surfaced, not fixed

Same ordering tradeoff plan 002 already documented for the approve/reject route now applies to the
escalation branch too: `resolveApproval` commits before the downstream action (resuming the graph,
or calling `resolveApprovedAction`/`resolveRejectedAction`) runs. If that downstream step throws,
the approvals row reads resolved while the ledger row (if any) may still be `denied` and no notice
reached the customer. The route emits an `error` event and returns 500 in that case; the operator
sees it in the trace and can re-drive the outcome by hand. Left alone for the same reason 002 left
it alone: this is a money-path ordering decision, not a bug introduced by this change.

## Regression gate

`npm run eval` is required: `server/src/agent/prompt.ts` changed (the `escalate_to_human` bullet
now instructs the model to pass `relatedLedgerId` and to tell the customer a reviewer will follow
up in this chat). The first full run surfaced a real effect, not noise: scenario 5
(vague-compensation-clarification) started failing its "reply ends with a literal `?`" assertion.
A/B sampling (11 runs with the edited prompt vs. 5 with the original, same scenario) showed the
edit had shifted the model away from the "?"-terminated phrasing the unrelated act/clarify/escalate
rubric (hard rule, "When to act, clarify, or escalate" section) already required, purely from
token-position drift elsewhere in the same prompt, exactly the class of effect CLAUDE.md's "a
single green eval run is not evidence for a judgment call" guidance warns about. The fix was to
make that rubric line itself explicit about ending in "?" and not phrasing the question as an
imperative, rather than trying to shrink the unrelated `escalate_to_human` addition. Re-sampled 6/6
after the fix; the full suite and `npx tsx scripts/repeat-scenario.ts 5` (all five tracked
judgment-call probes, 5 runs each) both came back clean.
`npm run test` and `npm run typecheck` are required and stay green; new unit coverage lives in
`server/src/ledger/approvals.test.ts` (escalation kind, null ledger reference, remark
persistence), `server/src/ledger/pipeline.test.ts` (granting an exception reuses the idempotency
key; upholding a denial writes the remark and moves no money), `server/src/agent/notify.test.ts`
(pure `buildDecisionNotice`, no db, no model), and `server/src/httpSchemas.test.ts` (remark
required on reject, optional on approve, length bound).
