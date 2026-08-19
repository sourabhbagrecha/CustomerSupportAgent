# 004: Decisions leave the customer chat

Status: planned, then delivered in the same commit as this file.

## Why

The console chat renders the full human-decision UI (the proposed action, the policy denial reason,
a remark box, and the grant/uphold buttons) inline in the customer transcript, in
`web/src/components/Chat.tsx`. Plan 001 put it there on purpose: at that point there was no other
surface, and section 15 of that plan wanted the evaluator to be able to play the human agent
without leaving the single-pane console. Plan 002 then built the real operator surface, the
cross-thread pending-approvals queue in `web/src/components/AuditPanel.tsx`, but explicitly scoped
itself to read-only additions plus "the pre-existing approve and reject action", so the chat banner
was left in place. Plan 003 added the escalation kind to the same queue and inherited the same
duplication.

Both surfaces now call the same route with the same arguments, so this is not a capability gap. It
is a role-boundary bug in what the chat pane claims to be:

1. The chat pane is the customer's side of the conversation. Everything else in the console tab
   (persona picker, fault toggles, trace) is visibly operator chrome sitting around it; the banner
   is the only operator control rendered *inside* the transcript, so it reads as something the
   customer is being shown.
2. It leaks internal reasoning verbatim. `denialReason` and `policyReason` are engine strings
   ("Within policy: amount 500 <= cap 500 INR"), written for an operator deciding a case, not for
   the person whose refund was denied.
3. It lets whoever is in the chat decide their own case. There is no auth and no operator identity
   (`resolved_by` is the hardcoded `"human_agent"`, per 002), so the separation has to come from
   which surface exposes the action, and today neither does.
4. `inputDisabled` in `Chat.tsx` includes `pendingApproval !== null`, which locks the customer out
   of typing for *both* kinds of pending row, including an escalation where nothing is paused and
   the customer may well want to add context while they wait.

## Scope and non-scope

In scope: the chat pane stops being a decision surface and becomes a status surface. The Audit tab
is the only place a human decision is made. The chat input stays usable while an escalation is
pending.

Explicitly not in scope: auth, roles, or an operator identity (still out, same reasoning as 002 and
003: single tenant, no auth). No server change at all: the resolve route, the money pipeline, the
policy engine, the graph, and `notify.ts` are untouched. This is a web-only change, so per the
`CLAUDE.md` workflow rule it does not need an eval run, and `evals/RESULTS.md` is not regenerated.

## Decisions

- **Delete the decision UI from the chat, rather than gating it behind a role prop.** A
  `viewerRole` prop would be inventing an access-control concept that nothing enforces: with no
  auth, anyone who can open the console can flip the prop's source. One surface owning the action
  is the honest version of the same boundary, and it removes a second code path that calls the
  resolve route.
- **The chat strip carries no policy internals.** It says a human is reviewing and that the
  decision will arrive in this chat, and nothing else. The outcome and the reviewer's remark still
  reach the customer, through the existing code-composed notice from 003
  (`server/src/agent/notify.ts`), which is the channel that was designed for it.
- **The chat input stays enabled for an escalation and stays disabled for a `policy_approval`.**
  This is a mechanical distinction, not a UX preference: a `policy_approval` row means the graph is
  parked mid-turn on `interrupt()` inside the money tool, and the only defined way to continue that
  thread is `Command({ resume })` from the resolve route. Posting a fresh turn into a thread parked
  on an interrupt is not a path this code has ever exercised, so the safer interpretation
  (`CLAUDE.md`) is to keep that one blocked and say why in the placeholder. An escalation's turn
  finished normally, nothing is parked, so the customer can keep typing.
- **One muted operator line stays under the strip** ("Resolve this in the Audit tab"), styled as
  console chrome rather than as part of the transcript. The console is a demo surface with a
  persona dropdown and fault toggles in it; leaving the evaluator to guess where the queue lives
  would be worse than one clearly-not-customer-copy line.

## Changes

- `web/src/components/Chat.tsx`: drop the `onApprovalDecision` and `resolvingApproval` props, the
  remark state, and the `approvalActionLabels` import. Render a read-only `.approval-status` strip
  when `pendingApproval` is set. `inputDisabled` keys on `kind === "policy_approval"` instead of on
  the presence of any pending row.
- `web/src/App.tsx`: drop `handleApprovalDecision`, the `resolvingApproval` state, and the now
  unused `resolveApproval` import. `pendingApproval` state stays: it still feeds the strip, is
  still hydrated on thread load and on the `interrupt` guardrail event, and is still cleared by
  `handleAuditResolved` when the resolved thread is the open one.
- `web/src/index.css`: replace the `.approval-banner` rules with `.approval-status`, add
  `.approval-status-hint`. `.approval-remark` and `.approval-actions` stay: the audit queue uses
  them.
- `README.md`: correct the audit-view paragraph (it currently says the queue uses "the same route
  the chat banner uses") and add the assumption.

## How this is verified

`npm run test` and `npm run typecheck`, plus a Playwright pass over the running dev server against
a thread that is actually parked on a pending row: the strip renders, no buttons appear in the
transcript, and the Audit tab still resolves that same row and the decision notice lands in the
chat.
