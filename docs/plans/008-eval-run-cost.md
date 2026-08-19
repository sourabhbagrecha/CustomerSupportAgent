# 008: Dollar cost per eval run, priced from OpenRouter's public model list

Status: planned, then delivered in the same body of work as this file.

## Why

Plan 007 left dollar cost out of the comparison on purpose: a price table would have been
hardcoded provider data that drifts, and token counts were recorded so a cost could be derived
later. With four archived runs across three providers the question the archive exists to answer
("is the cheaper model good enough, and how much cheaper is it?") is only half answered by tokens:
137.8k input tokens on DeepSeek and 153.8k on gpt-5.4-mini look similar, and are not, because the
per-token prices differ by an order of magnitude. The comparison needs a cost figure next to the
token columns.

OpenRouter publishes per-model prices through an unauthenticated endpoint
(`GET https://openrouter.ai/api/v1/models`, the same data as https://openrouter.ai/models), with
`pricing.prompt` and `pricing.completion` in USD per token for every model it routes, including
OpenAI's own models under `openai/...` ids. That removes the objection from plan 007: nothing is
hardcoded, the price comes from the provider's own listing, and it can be snapshotted into the
run record at the time of the run so a later price change does not rewrite history.

## What changes

### Pricing lookup (`server/src/evals/pricing.ts`)

- `fetchOpenRouterModels()`: one `fetch` of the models endpoint, no key, 8 second timeout,
  response narrowed by a Zod schema to `{ id, canonical_slug, pricing: { prompt, completion } }`.
  Cached in memory for an hour so the CLI runner, the UI runner, and a backfill do not re-fetch
  per call. A failed fetch is cached for five minutes and never throws out of the caller: the
  result is `null` pricing on the record, and the UI shows `n/a`.
- `resolveModelPricing(models, modelId, baseUrl)`: pure and unit-tested. Maps the run's
  `primaryModel` plus `baseUrl` onto an OpenRouter model id:
  1. exact id match (a run that went through OpenRouter already carries the OpenRouter id,
     including `:free` variants, which list at 0 and are priced at 0);
  2. for a direct vendor endpoint (`api.openai.com` is `openai/`, `api.deepseek.com` is
     `deepseek/`, a small host-to-vendor table), `vendor/<id>`, then `vendor/<id minus a trailing
     -YYYY-MM-DD>`, then a `canonical_slug` match (`openai/gpt-5.4-mini-20260317` for
     `gpt-5.4-mini-2026-03-17`), always skipping `:batch`-style variants of another model;
  3. otherwise a unique suffix match across vendors (`<anything>/<id>`), and `null` when nothing
     or more than one thing matches. A wrong guess is worse than `n/a`.
- The resolved rates are stored as USD per million tokens (the unit people quote and the one
  the OpenRouter page shows), converted from the per-token strings.

### Run record (`server/src/evals/runRecord.ts`, `web/src/types.ts`)

- `EvalRunSchema` gains `pricing`, nullable: `{ source: "openrouter", openrouterModelId,
  promptUsdPerMillion, completionUsdPerMillion, fetchedAt }`. Defaults to `null` on parse, so the
  four existing records (and any hand-edited one) still validate; `schemaVersion` stays 1 because
  nothing existing is reinterpreted. Rates are stored, not a total, so the cost can be recomputed
  per scenario and per run from the token columns already in the record, and a subset run's cost
  is naturally the cost of the scenarios it ran.
- The runner resolves pricing when a run starts (the fetch runs in the background while vitest
  does its minutes of work) and the record is written only once that lookup has settled, so a
  record never lands without its price when one was obtainable. `npm run eval` and UI runs both go
  through the runner, so both archive the price.
- `scripts/backfill-pricing.ts` (developer-only, `npx tsx scripts/backfill-pricing.ts`) fills
  `pricing` on archived records that have `null`, at today's price, and says so on the console. It
  is how the four existing runs get a price; the records it rewrites are committed like any other
  change to the archive. It never touches a record that already has a price.
- `evals/RESULTS.md` gains one metadata line: the priced model id, the two rates, and the run's
  total cost, so the regression-gate diff shows cost movement alongside pass/fail. The scenario
  table's columns are unchanged.

### UI (`web/src/components/evals/`)

- `evalMath.ts`: `scenarioCostUsd(scenario, pricing)` and `runCostUsd(run)` (tokens in times the
  prompt rate plus tokens out times the completion rate, per million; `null` when the run has no
  pricing or no token counts), `formatUsd` (four decimals, the amounts are cents), and a
  `describePricing` tooltip string ("openai/gpt-5.4-mini, $0.75 in / $4.50 out per 1M tokens,
  OpenRouter price as of 19 Aug 2026").
- Runs table: a Cost column after Tokens, `n/a` with a "no OpenRouter price recorded for this
  model" tooltip when unpriced.
- Comparison: a "Cost (USD)" summary row with the usual bar and delta (lower is better), and the
  per-scenario cost appended to each matrix cell's latency/tokens line with its own delta.
- The caption under the summary block says what the cost is and is not: agent-model tokens at
  OpenRouter list price, no cache discounts, judge calls not included.

### What the cost is, and is not

- It prices the agent's tokens only. The judge's calls are not token-counted by the harness and
  are the same model for every run by design (plan 007), so they would add a constant, not a
  difference.
- It applies the list `prompt` and `completion` rates. OpenRouter also lists cached-input rates
  and, for some models, tiered overrides above a prompt-size threshold; the harness does not record
  cache hits, and no scenario approaches those thresholds, so both are ignored. The figure is an
  upper bound on what the run's agent calls cost.
- For a run that used a direct vendor endpoint (api.openai.com), the figure is OpenRouter's
  listing for that vendor's model, which mirrors the vendor's own list price; a vendor discount or
  a batch tier is not reflected.

### Tests

`resolveModelPricing` across the cases above (exact id, `:free`, vendor prefix with and without a
date suffix, canonical-slug date match, the `:batch` variant being skipped, ambiguous suffix
returning `null`), the per-token to per-million conversion, and the schema default for records
without a `pricing` key. `runCostUsd` is the one-line product of two stored numbers and is
exercised through the record test's sample rather than tested on its own.

## Non-scope

- A user-supplied price override for models OpenRouter does not list. `n/a` is the honest answer
  there; an override table is the "hardcoded data that drifts" plan 007 declined.
- Cost on the console's live trace panel (per-turn cost in the observability story). Same
  pricing module would serve it; separate body of work.
- Any change to what the suite measures or how tokens are counted.
