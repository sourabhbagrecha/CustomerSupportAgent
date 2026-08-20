# 010: External evaluation report fixes

Status: delivered. Final full eval run: 21/22 scenarios passing. One item, scenario 5
(`vague-compensation-clarification`), is left as a documented open item rather than fixed in this
pass; see README "Known failure modes" and the External evaluation report table above it.

## Why

An external, black-box evaluation report was run against a live instance of this app: a reviewer
with no source access, testing only through the running UI and API. It surfaced 12 issues, spanning:

- A critical money/ledger wiring bug: escalating an above-cap remainder pointed at the ledger row
  the policy-capped portion had already settled, instead of creating its own row, so granting the
  exception risked re-executing or overwriting a row that had already moved money.
- A missing demo reset: no way to return the running instance to seed state between runs or
  reviewers without restarting the process by hand.
- A reviewer-remark leak: the human decision queue had one free-text remark field, which could
  reach the customer's chat transcript verbatim regardless of whether the reviewer intended it as
  a private note or a customer-facing explanation.
- Unverified promise claims triggering money: a customer citing a prior agent's promise could move
  money on the strength of the claim alone, with no check that anything in conversation history
  actually backed it up.
- Same-model fallback defeating resilience: `FALLBACK_MODEL` defaulted to a cheaper model from the
  same vendor as `PRIMARY_MODEL`, so a vendor-wide outage took down both.
- Weak eval rigor: a fixed 19-scenario suite with no repeat support at the CLI, a denominator that
  could shrink silently on an errored or skipped scenario, and no calibration check on the judge
  itself.
- Wrong reconciliation wording: a reconciled refund read as internal machinery ("reconciled",
  "duplicate") to the customer instead of a plain success.
- Invisible context engineering: retrieval counts, policy version, and prompt token budget were
  computed every turn but never surfaced anywhere observable.
- No cost rollup: per-call token counts existed in the event log, but nothing summed them into a
  per-turn or per-thread cost/latency figure.
- A cluster of UI issues: fault toggles that looked broken under a shared pending flag, judge
  failure messages that dumped a raw assertion string, no per-turn trace id for log correlation, a
  render path that could show an allow-worded reason under "Denied because," and no canned
  de-escalation response for an unverifiable identity/authority claim.

Every finding was verified against the working tree before being scoped into a fix, the same
discipline plan 005 used against its own external review.

## Execution strategy

Six parallel Claude Code subagents fixed the findings in one pass, grouped by file/subsystem
ownership so each subagent's diffs stayed inside its own files and none of the six needed to touch
a file another one owned: money/ledger wiring and the escalation-row fix; demo reset tooling;
the audit queue's internal/customer note split plus the profanity backstop; prompt and guardrail
hardening for the trust-but-verify promise check; provider/failover config for cross-provider
`FALLBACK_MODEL` routing; and the eval harness plus observability (context/rollup trace events)
plus the UI polish items bundled together, since none of that group's changes overlapped the other
five subagents' files.

A first full `npm run eval` run after that pass, run on the already-expanded 22-scenario suite,
came back 19/22: 3 real regressions the fixes themselves had introduced (scenarios 6, 13, and 22,
by the run record's own diff), not caught by inspection or by unit tests. Two further repair
rounds followed, each gated by rerunning the full suite rather than trusting a single scenario
probe or a code read: the first repair round fixed the promise-verification gap that scenario 22
(`fabricated-promise`) caught (an earlier version of the guard checked only that
`get_conversation_history` had been *called*, not that it returned a match); the second closed out
the remaining two regressions. That two-round repair process is what CLAUDE.md's "a single green
eval run is not evidence for a judgment call" workflow rule is for, and it caught exactly the class
of issue that rule exists to catch: fixes that look correct on inspection but shift model behavior
in an untested direction.

Three new eval scenarios were added during this pass, alongside the fixes they exercise:

- **20** `grant-amount-matches-escalation`: the grant flow pays out exactly the escalated delta,
  landing as a second, distinct ledger row rather than mutating the settled capped row. This
  scenario drives the grant step through direct function calls rather than depending on the model
  reliably producing that exact tool-call sequence itself; that simplification is documented in the
  scenario file's own header comment.
- **21** `verified-promise`: a genuine prior promise found in conversation history is honored up to
  the cap, with the gap escalated citing the actual evidence.
- **22** `fabricated-promise`: a claimed prior promise with no matching conversation history is
  denied outright, not partially honored, and is the scenario that caught the promise-verification
  guard's original "call happened" weakness described above.

## Final eval outcome

The last full run after both repair rounds: 21 of 22 scenarios passing (run record
`evals/runs/20260820T042051Z-gpt-5-4-mini-2026-03-17.json`, `evals/RESULTS.md`). The one remaining
failure is scenario 5 (`vague-compensation-clarification`): the agent's reply stopped reliably
ending its clarifying question in a literal "?". This most likely traces to a prompt wording change
made during the second repair round, a new instruction added to hard rule 6 spelling out exactly
what the combined capped-refund-plus-escalation reply must state, subtly shifting general reply
style elsewhere in the same shared system prompt string, the same class of cross-rule drift
`docs/plans/005-hardening-ownership-atomicity-evals.md`'s own "Known failure modes" entries already
document twice over. It was not fixed in this pass: both repair rounds were spent on the three
higher-priority regressions (money/ledger correctness and the promise-verification gap) ahead of
it, and it is left here as a known, documented, next-step item rather than silently accepted as
green. It is recorded in the README's External evaluation report table and Known failure modes
section rather than only here, so it stays visible to a reviewer who reads the README first.

Also surfaced and fixed late in this pass, after the eval harness itself was in use for the repair
rounds above: the eval judge was silently inheriting `FALLBACK_MODEL` (by design, when
`JUDGE_MODEL` is unset) while still calling the OpenAI base URL, and `FALLBACK_MODEL`'s own new
default is an OpenRouter-style id. That combination produced judge errors mid-repair. The fix was
an explicit `JUDGE_MODEL` env var in `.env.example` plus independent OpenRouter-aware base-url
routing in `evals/judge.ts`, isolated from the agent's own failover config so changing one can never
silently break the other again.

## What did not change

- No new infrastructure: every fix lives in the existing SQLite file, Node process, and npm
  scripts. No new process, queue, or external service.
- The graph stayed at exactly three nodes; none of the fixes added a node, subgraph, or agent.
- `evals/goldenSet.ts`'s 12 hand-labeled transcripts, added in this pass for judge calibration,
  were drafted by the agent doing this work, not by a human reviewer, and are marked ASSUMED in the
  file's own header pending human review; the calibration percentage they produce is evidence the
  mechanism runs, not a validated judge-accuracy number yet.
- The run-launcher UI's repeat-run toggle was not wired up in this pass; `--repeats N` exists at
  the CLI/runner level only. Nobody owned that specific route in the six-subagent split, and it was
  not judged worth a seventh pass ahead of the two eval-gated repair rounds above.
