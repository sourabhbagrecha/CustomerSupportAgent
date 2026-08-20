# Plan 012: Prompt versioning in the eval archive and Evals UI

## Problem

Every run record already stores `promptSha256` (a hash of `server/src/agent/prompt.ts` at run time), so the raw data for "which prompt produced this run" exists. But nothing surfaces it: the Evals screen never shows it, two runs with different prompts look identical apart from their dates, and the prompt text behind an old hash is unrecoverable once prompt.ts moves on (the hash has no snapshot behind it). So "did prompt change X improve pass rate or cost" cannot be answered from the UI, which is exactly the question the archive exists for.

## Changes

### 1. Prompt snapshot archive (server)

- `runRecord.ts`: new `PROMPTS_DIR` (`evals/prompts/`) and `archivePromptSnapshot()`: writes a copy of prompt.ts to `evals/prompts/<first 12 chars of sha256>.txt` if that file does not already exist (content-addressed, so re-runs of the same prompt write nothing). Parameterized paths for unit testing.
- `runner.ts`: calls it once per run start, failure logged to the run's log tail, never fatal.
- Snapshots are committed like fixtures, so any hash in the archive can be read and diffed later (`git diff --no-index evals/prompts/a.txt evals/prompts/b.txt`).

### 2. Evals UI: prompt version as a first-class dimension

- `evalMath.ts`: `promptVersionHue()` derives a stable hue from the hash so every run of the same prompt version wears the same color.
- New `PromptVersionChip` component: short hash in a hue-tinted chip, full hash in the title tooltip.
- `RunsTable`: new "Prompt" column with the chip, so same-prompt runs group visually and a prompt change is visible at a glance in the archive list.
- `RunComparison` column headers and `RunScorecards` cards: the chip rides under the model name, so a side-by-side of two runs (same model, different prompt, or any other mix) always shows which prompt version each column represents. The existing comparison view (pass rate, latency, tokens, cost, per-scenario grid) then IS the prompt-version comparison; selection stays free-form.

No run-record schema change: `promptSha256` is already in every record and already mirrored in `web/src/types.ts`.

### 3. Runs to record (user-requested, after the UI lands)

Three full-suite runs, same pinned judge (`JUDGE_MODEL` from .env):

- `gpt-5.4-mini-2026-03-17` via `npm run eval` (CLI): also the regression gate for plan 011's prompt layout change, so RESULTS.md/results.json regenerate from this run.
- `gpt-4o-mini` (OpenAI) and `deepseek/deepseek-v4-flash` (OpenRouter, id verified against the live model listing): via POST /api/evals/runs, which is record-only by design, so neither touches the gate files.

## Testing

- Unit test for `archivePromptSnapshot` (temp dirs: writes once, idempotent, missing prompt tolerated).
- `npm run test`, `npm run typecheck`.
- Evals tab checked with playwright against the running dev servers.

## Not in scope

- A visual prompt diff viewer in the UI (snapshots + git diff cover it).
- Stamping the prompt version into chat trace events (the eval archive is where versions are compared; can ride along later if wanted).
