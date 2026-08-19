# Plans

One file per plan, numbered in the order the work was started. Each file is the spec as it stood
before that work began, kept afterwards as a record of what was decided and why.

| Plan | Scope | Status |
| --- | --- | --- |
| [001-initial-build.md](001-initial-build.md) | The original agent: money path, guardrails, retrieval, evals, observability, UI | Delivered |
| [002-audit-view.md](002-audit-view.md) | Audit tab: cross-thread pending approvals queue and the action ledger | Delivered |

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
