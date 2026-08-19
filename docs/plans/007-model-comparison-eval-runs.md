# 007: Archived eval runs, configurable model provider, side-by-side comparison

Status: planned, then delivered in the same body of work as this file.

## Why

Every `npm run eval` pass costs real credit, and the suite currently only ever reflects one run:
`evals/results.json` and `evals/RESULTS.md` are overwritten in place, and the only record of a
previous run is git history. That is fine as a regression gate for one model, but it cannot answer
the question we now have: is a cheaper model (DeepSeek through OpenRouter, or anything else that
speaks the OpenAI chat-completions protocol) good enough on this suite, and what does it cost in
latency and tokens relative to the model we have been using? Answering that needs three things the
repository does not have today:

1. A place where each eval run is kept as its own record (model, base URL, commit, prompt hash,
   per-scenario status, latency, tokens, judge notes) rather than overwritten.
2. A way to point the agent at a different provider without editing code: the model IDs already
   come from env, but the base URL and key do not, and the judge is welded to the same key and
   `FALLBACK_MODEL` as the agent, which would make any cross-provider comparison judge itself with
   a different model.
3. A way to start a run with a chosen provider from the app and look at two or more runs next to
   each other, scenario by scenario.

The first step, before any new model is tried, is to capture the current gpt-5.4-mini results as
the baseline record in that folder, so later runs have something to be compared against.

## What changes

### Run records (`evals/runs/`, `server/src/evals/runRecord.ts`)

- New committed folder `evals/runs/`, one JSON file per eval run, named
  `<UTC timestamp>-<label slug>.json`. The record carries: `runId`, `label`, `source` (`cli` or
  `ui`), `status` (`running`, `completed`, `failed`, `cancelled`), start/finish times, the child
  process exit code, the provider block (`baseUrl`, `primaryModel`, `fallbackModel`, `judgeModel`,
  `judgeBaseUrl`; never a key), the scenario filter if the run was a subset, git commit, prompt and
  fixtures sha256, judge-state counts, and the per-scenario rows in the same shape
  `evals/results.json` already uses. A Zod schema is the single source of truth; the server and the
  web types derive from it.
- `completed` means the suite ran to the end, whether or not every scenario passed (scenario
  status carries pass/fail). `failed` means the runner itself did not produce a suite result (vitest
  could not start, or it exited without writing a single artifact). `cancelled` is a run the
  operator stopped; its partial scenario rows are kept.
- The current `evals/results.json` (gpt-5.4-mini, commit a21ce5f, 19/19) is converted once into the
  first run record, `evals/runs/20260819T151556Z-gpt-5-4-mini-baseline.json`, and committed. That is
  the "collect the current 5.4-mini data into a folder" step and it is done by hand from the
  existing file, not by re-running anything.
- `evals/results.json` and `evals/RESULTS.md` keep their current shape and meaning: the latest
  `npm run eval` gate run, committed alongside code changes so the diff shows quality movement.
  `npm run eval` now writes a run record as well. A run started from the UI writes only a run
  record and never touches `results.json`/`RESULTS.md`, because an experiment against another
  provider is not the regression gate for a code change.

### Provider configuration (`server/src/agent/providerConfig.ts`)

- `OPENAI_BASE_URL` (optional, default `https://api.openai.com/v1`) is read explicitly and passed
  to both the LangChain `ChatOpenAI` client and the raw `openai` judge client. Any OpenAI-compatible
  chat-completions endpoint works (OpenRouter is `https://openrouter.ai/api/v1`). A value that ends
  in `/chat/completions` is accepted and trimmed, since the SDK appends that path itself.
- `JUDGE_MODEL`, `JUDGE_BASE_URL`, `JUDGE_API_KEY` (all optional) let the judge stay on one fixed
  model and provider while the agent under test changes. They default to `FALLBACK_MODEL`,
  `OPENAI_BASE_URL`, and `OPENAI_API_KEY`, which is exactly today's behaviour when unset. Holding
  the judge constant is what makes tone/grounding verdicts comparable across runs.
- Model IDs stay env-driven (`PRIMARY_MODEL`, `FALLBACK_MODEL`). Nothing in code names a model.

### Runner (`server/src/evals/runner.ts`, `scripts/run-eval.ts`)

- One runner module clears `evals/.artifacts/`, spawns vitest with the eval config (and an optional
  list of scenario files), watches the artifacts directory as scenarios finish, and on exit groups
  the artifacts into a run record and writes it to `evals/runs/`. It holds at most one run at a
  time (a second start request gets a 409) and can cancel the child process.
- `npm run eval` becomes `tsx scripts/run-eval.ts`: the same runner, inheriting the terminal so
  vitest's own reporter still prints live, plus the legacy `results.json`/`RESULTS.md` export.
  `scripts/export-results.ts` stays as the artifacts-to-files step the runner calls; its grouping
  and markdown code moves into `server/src/evals/` so the server and the script share one
  implementation.
- The UI path spawns the same vitest invocation as a child process of the Fastify server with the
  chosen provider in its environment. This is the same process `npm run eval` would start from a
  terminal, run for the duration of the suite and gone afterwards; it is not a second service and
  it keeps CLAUDE.md's zero-infra rule in spirit (no Redis, no queue, no daemon). The trade-off is
  that the run is tied to the server process: if the server restarts mid-run (for example `tsx
  watch` reloading after a code edit), the in-flight run's progress is lost and the record is not
  written, though the artifacts on disk survive. Accepted for a developer tool.
- API keys never leave the server. The UI chooses the name of an environment variable
  (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, anything ending in `_API_KEY` that is set in the server's
  environment); the server maps that variable's value into the child's `OPENAI_API_KEY`. The judge
  key is resolved the same way and passed as `JUDGE_API_KEY`, so an OpenRouter run does not
  accidentally send judge calls to OpenRouter.

### HTTP (`server/src/index.ts`, `server/src/httpSchemas.ts`)

- `GET /api/evals/config`: defaults read from the server's env (base URL, models, judge), the
  list of key variable names that are set, the base-URL presets, and the scenario list (parsed from
  `evals/scenarios/*.eval.test.ts` filenames) for subset runs.
- `GET /api/evals/runs`, `DELETE /api/evals/runs/:runId`: the archive.
- `POST /api/evals/runs`: start a run (Zod-validated body, 409 while one is in progress).
- `GET /api/evals/current`: the in-progress run (partial scenarios plus a log tail), or null; the UI
  polls this every two seconds while a run is active. `POST /api/evals/current/cancel` stops it.
- The provisional `GET /api/evals` route from the uncommitted evals-tab draft is replaced by the
  routes above.

### UI (`web/src/components/evals/`)

The Evals tab becomes three sections, designed for "compare runs" rather than "show one file":

- Run launcher: label, base URL (preset select or custom), primary and fallback model, key
  variable, an optional scenario subset, and a judge block that shows the held-constant judge with
  an override disclosure. A visible cost caption and a single Run button. While a run is active the
  same card shows a progress bar, the scenario rows filling in, the last lines of runner output,
  and a Cancel button.
- Runs table: every archived run with its models, provider host, date, status, pass count, total
  latency, total tokens, and a checkbox to include it in the comparison (the two most recent are
  preselected). Delete with confirmation.
- Comparison: a summary block per selected run (pass rate, failing and documented-red counts, total
  and mean latency, tokens in/out, judge-scored count) with bars scaled to the max across the
  selection so the shape reads at a glance, then a scenario matrix with one row per scenario and
  one column per run; each cell shows status, latency, and tokens, with the delta against the first
  selected column and a regressed/improved marker when status differs. Notes and judge notes per
  run sit behind a disclosure on the row. The matrix is column-per-run, so it grows sideways as
  more models are tried later; the table wrapper scrolls horizontally.

The attached mockup (pass-rate tile, latency/tokens tiles, a model-vs-model bar pair, a scenario
table) is the inspiration; the differences are deliberate: no bar chart library, no dollar cost
(pricing would be hardcoded provider data that drifts), scenario names are the real suite, and the
comparison is a matrix rather than one model at a time behind a dropdown.

### Documentation and env

- `.env.example` gains the optional `OPENAI_BASE_URL`, `JUDGE_MODEL`, `JUDGE_BASE_URL`,
  `JUDGE_API_KEY`, and a commented `OPENROUTER_API_KEY` slot.
- README: the Evals view paragraph, the eval results section (run archive, UI-started runs do not
  update the gate files), assumptions (child process, keys stay server-side, judge held constant,
  run tied to the server process), and the quickstart line for `npm run eval`.

### Tests

Deterministic and load-bearing only: base URL normalisation and provider resolution precedence;
run-id slug derivation; grouping artifacts into scenario rows and combined status/judge state (the
logic that used to live only in `scripts/export-results.ts`); run-record schema round trip; the run
request schema (bad base URL, unknown key variable name, empty scenario subset). The runner's
process handling is smoke-tested by hand against scenario 14 only, which never calls a model
(`model_down_all` is active for the whole turn), so the check spends nothing.

## Non-scope

- Running the console chat against a different provider per conversation. The console keeps using
  `.env`; the provider picker is an eval-run concern.
- Dollar cost per run. Token counts are recorded; a price table would be hardcoded provider data.
- Repeating a run N times from the UI (`scripts/repeat-scenario.ts` remains the variance tool).
- Persisting the in-progress run across a server restart.
- Any change to scenario assertions, prompts, or the judge prompt. This plan does not change what
  the suite measures, only how runs are started, stored, and compared.
