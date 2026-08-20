# Customer Support Agent

A support agent for refunds, duplicate payments, failed deliveries, cancellations, and compensation requests. LangGraph.js for the loop, a deterministic money path the model cannot bypass, fault injection, a live trace panel, and a committed 22-scenario eval suite. One SQLite file, no other infrastructure.

This page is the map. The reasoning lives in [`docs/`](docs/): [architecture](docs/architecture.md), [decisions](docs/decisions.md), [assumptions](docs/assumptions.md), [evaluation](docs/evaluation.md), [failure modes](docs/failure-modes.md), [roadmap](docs/roadmap.md), and the numbered [plans](docs/plans/). [`DEMO.md`](DEMO.md) is the walkthrough script.

## Quickstart

```bash
npm install           # download every dependency in package.json into node_modules, once after cloning
cp .env.example .env  # cp copies a file: source first, destination second, creating your local .env
npm run seed          # runs the "seed" script: rebuild data/app.db from schema.sql, load /fixtures
npm run demo          # runs the "demo" script: build the React app, serve UI and API on port 3000
npm run eval          # runs the "eval" script: 22 scenarios against a real model, spends API credit
```

Open `.env` after copying it and set `OPENAI_API_KEY` (get one at platform.openai.com). `PRIMARY_MODEL` and `JUDGE_MODEL` ship as OpenAI-style ids. `FALLBACK_MODEL` ships as an OpenRouter-style `vendor/model` id, so failover crosses providers instead of staying with one vendor; that default also needs `OPENROUTER_API_KEY` (openrouter.ai/keys), or point `FALLBACK_MODEL` at an OpenAI-style id and skip the second key. Fixtures are committed, never generated at your runtime; `seed` only loads what is checked in.

`npm run eval` is optional: a full run is already committed to [`evals/RESULTS.md`](evals/RESULTS.md). Two more scripts exist: `npm run dev` (Fastify and Vite dev servers concurrently, API on port 3000, frontend on port 5173) and `npm run test` (the deterministic unit suite only, no LLM calls, under two seconds).

## Architecture

```mermaid
flowchart LR
    UI["React UI<br/>(console tab: chat, trace panel,<br/>fault toggles, approvals;<br/>audit tab: approval queue + ledger;<br/>evals tab: run archive, launcher, comparison)"] -->|REST + SSE| API["Fastify server<br/>(server/src/index.ts)"]
    API --> Graph["LangGraph agent<br/>loadContext -&gt; agent -&lt;-&gt; tools"]
    Graph -->|read tools| Mock["Mock support APIs<br/>+ fault registry"]
    Graph -->|issue_refund / issue_credit| Pipeline["Money pipeline:<br/>policy check -&gt; ledger write -&gt; call -&gt; reconcile"]
    Pipeline --> Mock
    Pipeline --> DB[("One SQLite file<br/>data/app.db")]
    Mock --> DB
    Graph --> DB
    API --> Events["Event log -&gt; SSE"]
    Events --> DB
    Graph -.->|interrupt / resume| Approval["Approval panel<br/>(human in the loop)"]
    Graph -->|escalate_to_human| Approval
    Approval -->|decision + remark| Notify["Deterministic customer notice<br/>(server/src/agent/notify.ts)"]
    Notify --> DB
```

Three nodes (`server/src/agent/graph.ts`): `loadContext` gathers orders, payments, FTS5-retrieved past conversations, policy, and today's date; `agent` loops with `tools` until it produces a reply. `issue_refund` and `issue_credit` are never raw model tools: each runs policy check, then a ledger row written before any external call, then the call, then reconciliation via `get_payments` on timeout (`server/src/ledger/pipeline.ts`). Every step, tool call, guardrail verdict, failover, and ledger transition writes an `events` row that streams to the trace panel over SSE. App data, ledger, events, and LangGraph checkpoints all live in one SQLite file. Full detail in [docs/architecture.md](docs/architecture.md).

## Key decisions

Short list; the alternatives considered and rejected are in [docs/decisions.md](docs/decisions.md).

- **The model proposes, code disposes.** The policy engine reads only order and payment facts plus `fixtures/policy.json`, never what the model claims, so a jailbreak cannot raise a cap.
- **Idempotency keys exclude every model-supplied value:** `sha256(threadId + actionType + orderId + amount)`, computed from server state, which is what makes the timeout-after-success double-refund trap unexploitable.
- **A claimed prior promise unlocks money only when a `get_conversation_history` call this turn actually returned a match,** not when the call merely happened.
- **`FALLBACK_MODEL` may name a different vendor than `PRIMARY_MODEL`.** A same-vendor fallback goes down with its vendor; ids containing `/` route to OpenRouter regardless of `OPENAI_BASE_URL`.
- **One SQLite file, no Postgres, Redis, Docker, queue, or vector DB.** Transactional writes, FTS5 retrieval, and the checkpoint store in one file, nothing for an evaluator to stand up.
- **Observability is the `events` table plus SSE,** not an external tracing SDK. Langfuse was scoped and cut; the schema is sink-shaped so an exporter stays additive.
- **No agent framework.** Mastra was the strongest candidate and was rejected: it automates the loop scaffolding (four files) and not the money-safety layer, and it wants to own the loop that must not own `issue_refund`.
- **Retrieval is FTS5 plus small recency and order-linkage boosts,** not embeddings or a reranker, at roughly 200 committed conversations.

## Assumptions

Full list in [docs/assumptions.md](docs/assumptions.md).

- INR throughout; every policy value (₹500 auto-approval cap, 30-day window) is invented and centralized in `fixtures/policy.source.json`.
- Single tenant, no auth, English only. `override_by` and `resolved_by` are free-text identities, not logins.
- Precedence on conflicting information: structured order and payment data, then `policy.json`, then policy text, then conversation history, then the customer's unverified claims.
- Policy outranks any prior agent promise: honor it up to what policy allows now, escalate the gap, never silently pay it in full.
- The chat pane is the customer's surface, so decisions happen only in the audit queue, and the customer-facing notice is composed in code rather than phrased by a model.
- Idempotency keys are thread-scoped, so the same refund asked from two threads yields two ledger rows. Accepted and visible in the audit ledger; the business-scoped fix is in the roadmap.
- Ownership is enforced four times over (policy engine, read tools, provider adapter, database trigger), and a foreign order and a missing order return identical wording so the agent is never an existence oracle.

## Evals

23 scenarios (`evals/scenarios/`) run against a real model, judged by a pinned judge model at temperature 0, plus 202 deterministic unit tests. The committed gate is [`evals/RESULTS.md`](evals/RESULTS.md), currently 21 of 22, with scenario 10 (planted-instruction-injection) as the one failure; that gate predates scenarios 23 and 24 landing and scenario 13 being retired, so the next `npm run eval` restates it over the 23 that exist now. Every run also archives a self-describing record to `evals/runs/` (models, base URLs, git commit, prompt hash, per-scenario status, tokens, latency, cost), and the Evals tab compares any set of them as scorecards, a cost-versus-quality Pareto chart, and a scenario grid. Method, judge calibration, cost derivation, and the external black-box review's 12 findings: [docs/evaluation.md](docs/evaluation.md).

## Known failure modes

Full list, including the prompt-drift incidents that shaped the current rules, in [docs/failure-modes.md](docs/failure-modes.md).

- Both models unreachable degrades every turn to a fixed LLM-free apology plus an escalation record. Intended, but a misconfigured `.env` looks like "the agent always apologizes"; check the trace panel's `error` events.
- Fixture dates are relative to the day fixtures were generated (2026-08-19). Window-dependent scenarios start denying by window a few weeks later; regenerate with `npm run fixtures` (rewrites the committed JSON under `fixtures/` relative to today) then `npm run seed`.
- `better-sqlite3` is a native module: no prebuilt binary and no build tools means `npm install` fails. A real cost of the single-file choice.
- A crash between appending the customer notice and marking an approval executed can duplicate that message on retry. No money moves twice.
- Temperature 0 narrows but does not remove run-to-run variance on judgment calls. A single green run is not evidence for a prompt rule; `npx tsx scripts/repeat-scenario.ts 6` (replays the judgment-call scenarios 6 times each against the real model) is.

## What we'd improve next

Reasoning for each in [docs/roadmap.md](docs/roadmap.md).

- Postgres and Redis for distributed idempotency and a shared ledger, if this ran as more than one process.
- Business-scoped idempotency keys (order plus source payment) instead of today's thread-scoped key.
- Hybrid dense plus FTS5 retrieval for paraphrased queries.
- An exporter from `events` to an OTel-compatible sink, which is a translation layer rather than new instrumentation.
- A leaner `loadContext` (trimmed history window, a cheap triage stage) to cut tokens and latency.
- Human review of the 12 AI-drafted golden-set labels, which is what would turn judge calibration into a validated accuracy number.
- Auth on the fault toggles and on granting an exception.

## AI tools used

Claude Code and Claude (Anthropic) were used throughout for planning and implementation. An external black-box evaluation report (a reviewer with no source access, testing the running app only) produced 12 findings, fixed in one pass by six parallel subagents split by file ownership, then two repair rounds each gated by a real `npm run eval` run. [`docs/plans/010-eval-report-fixes.md`](docs/plans/010-eval-report-fixes.md) is the record.
