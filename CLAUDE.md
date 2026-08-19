## Context

A production-grade customer support agent (refunds, duplicate payments, failed deliveries, cancellations, compensation), built as a take-home for a CTO evaluator who clones the repo and runs it with their own OpenAI key. Judgment, reliability, evals, and observability are scored above feature count.

The build is complete: all 15 eval scenarios pass, history is six milestone commits, and the demo runs from a fresh clone. Treat incoming work as changes to a finished system, not as remaining scope; the README records the current architecture, decisions, and assumptions.

## Non-negotiable invariants

1. The LLM proposes, code disposes. `issue_refund` and `issue_credit` are never raw model tools; they always pass through the policy engine (`server/src/policy`) and action ledger (`server/src/ledger`). No code path may move money without a ledger row written first.
2. Exactly-once money semantics: one idempotency key per logical action, derived deterministically from server-side state only; timeouts trigger reconciliation via `get_payments` before any retry; a retry always reuses the same key.
3. Zero infrastructure: one SQLite file, Node, npm. Never add Redis, Postgres, Mongo, Docker, vector databases, queues, or any second process. If something seems to need them, it belongs in the README "improve next" section instead.
4. Observability is the SQLite `events` table plus the SSE stream, with no external tracing SDK. Langfuse and OTel exporters were deliberately cut and live in README "improve next"; do not reintroduce one without asking.
5. Fixtures are committed, never generated at the evaluator's runtime. If you need new synthetic data, run `npm run fixtures` locally once and commit the output.
6. The LLM-free degradation path (all models down: deterministic apology plus escalation record) must never import or invoke any model client.
7. Temperature 0 on all model calls, including the eval judge.

## Style and documentation rules

- Never use em dashes in any file: not in code comments, not in the README, not in UI copy, not in commit messages. Use commas, colons, parentheses, or hyphens instead.
- Every CLI command written in any documentation must have each command and flag briefly explained next to it (see the README quickstart for the required format).
- TypeScript strict mode everywhere. No `any` except at true JSON boundaries, immediately narrowed by a Zod schema.
- Zod schemas are the single source of truth for tool inputs/outputs; derive TypeScript types from them (`z.infer`). Evals import the same schemas.
- Raw SQL through better-sqlite3 prepared statements. No ORM. Schema lives in `server/src/db/schema.sql`.
- Errors are typed and structured. Never swallow an error silently; every catch either handles meaningfully, retries per policy, or emits an `error` event and surfaces a safe user-facing message.
- Keep the LangGraph graph small: three nodes (`loadContext`, `agent`, `tools`) in `server/src/agent/graph.ts`. Do not add nodes, subgraphs, or agents without asking.
- Do not hardcode OpenAI model IDs from memory. Read them from `PRIMARY_MODEL` and `FALLBACK_MODEL`; put currently valid IDs only in `.env.example`.

## Workflow

- `npm run eval` is the regression gate for any agent, prompt, policy, tool, or ledger change: run it before declaring the task done, and commit the regenerated `evals/RESULTS.md` alongside the code so the diff shows quality movement. Documentation-only or UI-only changes do not need it; say so rather than skipping silently.
- `npm run test` and `npm run typecheck` must stay green on every change, including documentation-only ones.
- A single green eval run is not evidence for a judgment call the model makes. When changing a prompt rule, replay the affected scenarios with `npx tsx scripts/repeat-scenario.ts <runs>` before trusting one pass.
- Write unit tests only where logic is deterministic and load-bearing: policy engine verdicts, idempotency key derivation, ledger state transitions, reconciliation, retrieval ranking, policy.md/policy.json consistency. Do not unit-test the LLM; that is what the eval suite is for.
- Every agent step, tool call, guardrail verdict, failover, and ledger transition emits an event (the `events` table in `server/src/db/schema.sql`) at the moment the code is written, never retrofitted. The trace panel consumes this stream.
- When a requirement is ambiguous, choose the safer interpretation, implement it, and append the assumption to the README assumptions list in the same commit.
- The dev servers are already running and stay running: the Fastify API on `http://localhost:3000` and the Vite frontend on `http://localhost:5173`. Use those; never start `npm run dev`, `npm run demo`, or any other server process yourself. If a port looks dead, say so and ask the user to restart it rather than launching one.
- Frontend work: after any UI change, look at it with the playwright-cli skill (or `npx playwright`) against `http://localhost:5173` (the already-running dev server) before calling the change done. Check layout, console errors, and the actual flow being touched, not just that it builds. Keep iterating against the real render until it looks right.
- Never commit `.env`, `data/*.db`, `dist/`, or `evals/.artifacts/`. All are gitignored; confirm with `git status --porcelain` before committing.

## Commands

The long-running ones (`npm run dev`, `npm run demo`) are already up on ports 3000 (API) and 5173 (frontend); do not run them.

- `npm run seed` : create `data/app.db` from `schema.sql` and load `/fixtures`.
- `npm run dev` : Fastify under tsx watch plus the Vite dev server, concurrently (API on port 3000, frontend on port 5173). Already running; do not launch it.
- `npm run demo` : build the web app, then serve API and static frontend from Fastify on port 3000. Already covered by the running servers; do not launch it.
- `npm run eval` : run the Vitest eval suite and regenerate `evals/RESULTS.md` (real OpenAI calls, costs credit).
- `npm run test` : deterministic unit tests only, no LLM calls.
- `npm run typecheck` : `tsc --noEmit` over the server and web tsconfigs.
- `npm run fixtures` : regenerate synthetic fixtures locally (developer-only; output is committed).
- `npx tsx scripts/repeat-scenario.ts <runs> [probeId] [-v]` : replay the judgment-call scenarios N times each against the real model to expose run-to-run variance.
