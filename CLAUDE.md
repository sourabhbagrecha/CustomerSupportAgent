## Context

A take-home assignment: a production-grade customer support agent (refunds, duplicate payments, failed deliveries, cancellations, compensation). The evaluator is a CTO who will clone the repo and run it on their own machine with their own OpenAI key. Judgment, reliability, evals, and observability are scored more than feature count. 24-hour timebox.

## Non-negotiable invariants

1. The LLM proposes, code disposes. `issue_refund` and `issue_credit` are never raw model tools; they always pass through the policy engine and action ledger described in PLAN.md Section 7. No code path may move money without a ledger row written first.
2. Exactly-once money semantics: one idempotency key per logical action, derived deterministically; timeouts trigger reconciliation via `get_payments` before any retry; a retry always reuses the same key.
3. Zero infrastructure: one SQLite file, Node, npm. Never add Redis, Postgres, Mongo, Docker, vector databases, queues, or any second process. If something seems to need them, it belongs in the README "improve next" section instead.
4. The system must run fully without Langfuse env vars. Langfuse is optional instrumentation, never a dependency of correctness or of the UI.
5. Fixtures are committed, never generated at the evaluator's runtime. If you need new synthetic data, run the generator locally once and commit the output.
6. The LLM-free degradation path (all models down: deterministic apology + escalation record) must never import or invoke any model client.
7. Temperature 0 on all model calls, including the eval judge.

## Style and documentation rules

- Never use em dashes in any file: not in code comments, not in the README, not in UI copy, not in commit messages. Use commas, colons, parentheses, or hyphens instead.
- Every CLI command written in any documentation must have each command and flag briefly explained next to it (see PLAN.md Section 13 for the required format).
- TypeScript strict mode everywhere. No `any` except at true JSON boundaries, immediately narrowed by a Zod schema.
- Zod schemas are the single source of truth for tool inputs/outputs; derive TypeScript types from them (`z.infer`). Evals import the same schemas.
- Raw SQL through better-sqlite3 prepared statements. No ORM. Schema lives in `server/src/db/schema.sql`.
- Errors are typed and structured. Never swallow an error silently; every catch either handles meaningfully, retries per policy, or emits an `error` event and surfaces a safe user-facing message.
- Keep the LangGraph graph small (PLAN.md Section 6). Do not add nodes, subgraphs, or agents beyond the plan without asking.
- Do not hardcode OpenAI model IDs from memory. Read them from `PRIMARY_MODEL` and `FALLBACK_MODEL` env vars; put currently valid IDs (verified against OpenAI docs at build time) only in `.env.example`.

## Workflow

- Use graphify for any codebase query (architecture, file relationships, "where is X", impact of a change). Keep graphify-out/ updated as code changes, not stale.
- Follow the milestone order in PLAN.md Section 12. Finish a milestone's acceptance criteria before starting the next. Do not gold-plate early milestones.
- After M2, run the three smoke scenarios (1, 9, 12) after every meaningful agent change.
- After M4, `npm run eval` is the regression gate: run it before declaring any task done, and commit the regenerated `evals/RESULTS.md` alongside code changes so diffs show quality movement.
- Write unit tests only where logic is deterministic and load-bearing: policy engine verdicts, idempotency key derivation, ledger state transitions, reconciliation, retrieval ranking, policy.md/policy.json consistency. Do not unit-test the LLM; that is what the eval suite is for.
- Every agent step, tool call, guardrail verdict, failover, and ledger transition must emit an event (PLAN.md Section 4 schema) at the moment the code is written, not retrofitted later. The trace panel and Langfuse both consume this stream.
- When the assignment is ambiguous, choose the safer interpretation, implement it, and append the assumption to the README assumptions list in the same commit.
- Frontend work: after any UI change, look at it with the playwright-cli skill (or `npx playwright`) against the running dev server before calling the change done. Check layout, console errors, and the actual flow being touched, not just that it builds. Keep iterating against the real render until it looks right, not just once.

## Commands (define these in root package.json)

- `npm run seed` : create data/app.db from schema.sql and load /fixtures.
- `npm run dev` : run Fastify with tsx watch and the Vite dev server concurrently for development.
- `npm run demo` : build the web app, then start Fastify serving the API and the built static frontend on port 3000.
- `npm run eval` : execute the Vitest eval suite and regenerate evals/RESULTS.md.
- `npm run test` : execute deterministic unit tests only (excludes the eval suite).
- `npm run fixtures` : regenerate synthetic fixtures locally (developer-only; output is committed).

## Definition of done

All 15 eval scenarios pass or have a documented, intentional red with explanation in RESULTS.md. A fresh clone on a clean machine reaches a working demo with exactly the five quickstart commands in the README. The evaluator can, without guidance: pick the 200-conversation persona and get a relevant answer; toggle the refund-timeout fault and watch reconciliation prevent a double refund in the trace panel; trigger an above-cap request and approve it via the approval panel; kill both models via the fault toggle and still receive a graceful escalation. README is complete per PLAN.md Section 13, including the walkthrough video link.


