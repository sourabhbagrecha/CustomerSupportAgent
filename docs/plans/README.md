# Plans

One file per plan, numbered in the order the work was started. Each file is the spec as it stood
before that work began, kept afterwards as a record of what was decided and why.

| Plan | Scope | Status |
| --- | --- | --- |
| [001-initial-build.md](001-initial-build.md) | The original agent: money path, guardrails, retrieval, evals, observability, UI | Delivered |
| [002-audit-view.md](002-audit-view.md) | Audit tab: cross-thread pending approvals queue and the action ledger | Delivered, partly superseded by 003 and 004 |
| [003-human-decision-queue.md](003-human-decision-queue.md) | Escalations become explicit admin decisions: grant an exception or uphold a denial, with a remark and a customer chat notification | Delivered |
| [004-decisions-leave-the-customer-chat.md](004-decisions-leave-the-customer-chat.md) | The chat pane stops being a decision surface: approve/reject lives only in the audit queue, the chat shows a read-only status strip | Delivered |
| [005-hardening-ownership-atomicity-evals.md](005-hardening-ownership-atomicity-evals.md) | Ownership enforcement, approval atomicity, runtime output validation, the resolved-status fix, eval hardening, and light polish, from a claim-by-claim verified external review | Planned |

## Conventions

- A new capability gets a new numbered file. Never rewrite a delivered plan in place: the value of
  these documents is that they show the reasoning at the time, and an edited plan can no longer be
  trusted as that record.
- If a delivered plan turns out to be wrong or gets superseded, leave the text alone and note it in
  the status banner at the top of that file, pointing at the plan that replaced it.
- A plan is not the current-state document. `README.md` at the repository root is authoritative for
  how the system works today, and `CLAUDE.md` is authoritative for the invariants and workflow rules
  that any change must respect.
- Keep plans out of the loop for day-to-day work. Read one when you need the reasoning behind an
  existing design decision, not to find out what to build next.
