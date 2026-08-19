# 002: Audit view (cross-thread approvals queue plus action ledger)

Status: planned, then delivered in the same commit as this file.

## Why

Human-in-the-loop approval was delivered in 001 and works end to end: the policy engine returns
`requires_approval` above the cap, the money pipeline writes an `awaiting_approval` ledger row plus
a `pending` approvals row, the money tool calls LangGraph `interrupt()`, and
`POST /api/threads/:threadId/approvals/:approvalId/resolve` records the decision and resumes the
graph. Two things were left invisible.

1. An approval is only visible inside the thread that happens to be open. The banner lives in
   `web/src/components/Chat.tsx`. Cross-thread, a human operator has to already know the
   `threadId`. `listPendingApprovals` in `server/src/ledger/approvals.ts` was written for a queue
   that was never wired up: it had zero callers, and `idx_approvals_status` in
   `server/src/db/schema.sql` already existed to serve it.
2. `actions_ledger` was exposed by zero routes and zero UI. The invariant that no money moves
   without a ledger row written first was only provable by reading source or opening the SQLite
   file.

Both are observability gaps rather than missing capability, which is why this is a read-only view
plus the pre-existing approve and reject action.

## Scope and non-scope

In scope: one Audit tab holding a cross-thread pending approvals queue (resolvable in place) and a
filterable, paginated table over `actions_ledger`.

Explicitly not in scope, because 001 section 15 cut admin CRUD and the README assumes a single
tenant with no auth: creating, editing, or deleting any row from the UI; any notion of an operator
identity beyond the existing hardcoded `resolved_by = "human_agent"`; an escalations lifecycle
(`escalate_to_human` remains fire and forget into `events`, with no table, assignee, or close).

Also out of scope: changing the money write path, the LangGraph graph, the policy engine, or the
resolve route's semantics. This change adds read-only SQL and read-only routes, and calls the
existing resolve route with unchanged arguments.

## Decisions

- **Two queries, not a join.** The `approvals` row is already denormalized with `actionType`,
  `customerId`, `orderId`, `amount`, and `policyReason`, and for a pending approval the matching
  ledger status is always `awaiting_approval`. A join would add a second SQL row shape and mapper
  for one redundant column.
- **Resource-shaped route names** (`/api/approvals/pending`, `/api/ledger`) rather than
  `/api/audit/*`. Audit is the name of a UI tab, not a resource, and the existing routes are all
  resource-shaped.
- **No schema change and no new index.** A `status` filter would want `idx_ledger_status`, but
  there is no migration runner: the only way to apply a schema edit is `npm run seed`, which
  deletes `data/app.db`. Not worth destroying the existing audit data to speed up a scan of a
  handful of rows.
- **Poll, do not stream.** The SSE channel is per `threadId` by design and replays that thread's
  stored history on connect. A cross-thread queue has no thread to subscribe to, and a global
  channel would fork the SSE code path into a live-only variant while still ending in a refetch.
  The queue refreshes on mount, on tab focus, and on a 10 second interval, and it displays its own
  last-refreshed time rather than pretending to be live.
- **Tab state in `useState`, no router.** Consistent with the zero-new-dependency constraint. The
  cost, stated rather than hidden: the Audit tab is not deep-linkable and does not survive a reload.
- **The console unmounts on tab switch rather than hiding.** Safe because the SSE route replays
  stored events on reconnect, so the trace panel rebuilds losslessly, and chat messages live in
  `App.tsx` and survive regardless. Only the live typing cursor resets.
- **The audit tab discards the resolve route's `reply` text.** That route returns a
  `ChatResponse` because it resumes the customer's turn, but the actor here may not have that
  thread selected. The queue shows a short confirmation instead, and `App.tsx` appends the reply to
  the transcript only when the resolved thread is the one currently selected.

## Known limitation surfaced, not fixed

`server/src/index.ts` commits `resolveApproval` before `resumeApprovalTurn` runs, deliberately, so
the human's decision is recorded independently of the money outcome. If the resume then throws, the
approvals row is resolved while the ledger row is still `awaiting_approval` and the graph is still
interrupted. This view is the first thing in the product that makes such an orphan visible. The
ordering is a money-path decision and is left alone here; the failure mode is documented in the
README instead.

## Regression gate

`npm run eval` is not required for this change. CLAUDE.md gates eval on agent, prompt, policy,
tool, or ledger changes, and the ledger trigger is about the money path. This change adds read-only
`SELECT` helpers and read-only routes, touches no write path, and calls `resolveApproval` and
`resumeApprovalTurn` only through the unchanged existing route. `npm run test` and
`npm run typecheck` are required and stay green. If any later work changes `resolveApproval`'s
signature or the resolve route's semantics, this flips and eval becomes required.
