# What we would improve next

Work deliberately left undone, with the reason it was scoped out. The root [README](../README.md#what-wed-improve-next) carries the short list.


- Postgres + Redis for distributed idempotency and a shared action ledger, if this needed to run as more than one process.
- Embedding-based hybrid retrieval (dense + FTS5) instead of keyword search with heuristic boosts, for better recall on paraphrased customer queries.
- Real payment-provider idempotency semantics (e.g. actually integrating Stripe's idempotency-key header contract) instead of a hand-rolled equivalent.
- Streaming, token-level guardrails (checking model output as it streams, not only at the tool-call boundary) for tighter injection defense.
- Cost dashboards: per-conversation token cost is already captured per LLM-call event, but there's no aggregate view yet, and no dollar figure, since that would mean hardcoding provider pricing that changes independently of this codebase.
- An exporter from the existing `events` table to an external sink (Langfuse, or any OTel-compatible collector), so traces survive past the local SQLite file and can be aggregated across runs. The event rows already carry model, latency, and token counts per span, so this is a translation layer, not new instrumentation.
- Context and cost loader optimization: `loadContext` fetches eagerly today (full order/payment history, a fixed top-k of past conversations); trimming that to what a given turn actually needs, shrinking the top-k history window, and adding a cheap routing/triage stage ahead of the full agent loop would all cut tokens and latency without touching correctness.
- A richer trace panel: retrieval scores and which chunks were actually selected are computed during `loadContext` but not surfaced to the trace, and per-turn cost (not just per-call tokens) would make the observability story easier to read at a glance.
- Business-scoped idempotency (order plus source payment, independent of thread) instead of today's thread-scoped key, closing the cross-thread duplicate-refund risk documented in [assumptions.md](assumptions.md).
- Persisting an in-flight eval run across a server restart (a `running` marker on disk that the server re-adopts on boot) and wiring the `--repeats N` flag (already supported at the CLI: `npx tsx scripts/run-eval.ts --repeats 3`) into the run-launcher UI, so the run-to-run variance check that `scripts/repeat-scenario.ts` does today could be done from the comparison view. Also a user-supplied price override for models OpenRouter does not list, so those runs could show a cost instead of `n/a`.
- Fault-toggle gating behind auth: the fault toggles are unauthenticated in this single-tenant demo (see the Persona panel's own caption); a real deployment would put them behind an operator role rather than exposing them to anyone who can reach the UI. The same applies to granting an escalation exception: `override_by` records a free-text approver identity today, with no real reviewer login behind it.
- Human review of the judge-calibration golden set (`evals/goldenSet.ts`): all 12 labels are currently AI-drafted and marked ASSUMED in the file's own header; a human reading and correcting them is what would turn the calibration percentage into a validated judge-accuracy number rather than a mechanism check.
