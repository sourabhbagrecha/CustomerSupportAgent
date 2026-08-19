# 009: Visualising the eval comparison

Status: planned, then delivered in the same body of work as this file.

## Why

Plan 007 gave the Evals tab a working comparison, and plan 008 added cost to it. What it renders
today is two wide tables: a nine-row metric block where every row carries a bar and a delta chip,
and a scenario matrix of 19 rows by one column per selected run, each cell holding a status badge,
a latency/token/cost sub-line and up to three delta chips. With six runs selected that is roughly
700 numbers on screen, and it does not answer the question the comparison exists to answer, which
is "which model should this agent run on". Concretely:

- Every metric row draws a bar scaled to the max across runs, including rows where a bar means
  nothing (tokens in, tokens out) and rows where most runs have no value, so the bar is decoration
  that competes with the number beside it.
- The bar is the same blue whether a longer bar is good (pass rate) or bad (failing count,
  latency, cost). Length reads as "more", which is the wrong direction on four of the nine rows.
- A metric with no comparable value renders an `n/a` chip in every cell, so a run that simply did
  not record tokens produces a column of grey noise rather than being quietly absent.
- Cost, quality, and latency are three separate rows, so the trade-off between them (the actual
  decision) has to be reconstructed in the reader's head from numbers in different places.
- The matrix cannot be scanned. 19 scenarios of four lines each is about 1300px of vertical
  scroll per screen of runs, and the one thing a reader wants from it (where do these models
  actually differ) is invisible because 12 of the 19 rows are identical across every run.

## What changes

Three new views in `web/src/components/evals/`, composed by `RunComparison.tsx`, with both of
today's tables kept underneath as the table view (collapsed, and de-noised).

### 1. Scorecards (`RunScorecards.tsx`)

One card per selected run, replacing the nine-row metric table as the default read: model label,
model id, provider host, the pass rate as the card's hero figure with a pass/fail meter under it,
and three stat rows (cost, mean latency per scenario, total tokens) each carrying a delta chip
against the baseline only when both sides have a value. Cards carry at most one tag: `baseline`,
`best value` (the cheapest run on the frontier, see below), or `on frontier`.

### 2. Cost/quality chart (`ComparisonChart.tsx`)

A scatter plot: pass rate on y (0 to 100%), a selectable x metric (cost in USD, mean latency per
scenario, or total tokens), marker area from mean latency, one dot per run, every dot directly
labelled with the run label. The Pareto frontier (runs that no other run beats on both axes) is
drawn as a stepped hairline and its dots are filled; dominated dots are hollow. This is the whole
decision in one picture: up and to the left is better, and the frontier is the shortlist.

Design decisions, following the `dataviz` skill:

- One series, so one hue (categorical slot 1, `#2a78d6`, validated against the `#ffffff` panel
  surface). Identity is carried by direct labels, never by hue, which also sidesteps the
  three-slot cap on all-pairs (scatter) colour separation.
- Linear x from 0, not log: a free model has cost 0, and the linear axis is what makes "one model
  is 17x the price of another for the same score" legible.
- A run with no value for the chosen metric (no pricing, or no recorded tokens) cannot be placed
  on x. It is named under the chart as excluded rather than dropped silently or parked at 0.
- Per-dot hover and keyboard focus with a tooltip; a 24px transparent hit area around each dot.

### 3. Scenario heatmap (`ScenarioHeatmap.tsx`)

The 19 by N grid as one dense block: one row per scenario, one cell per run, cell carries a status
glyph on a status fill. Emphasis is deliberately asymmetric because the reader is hunting
failures: `fail` is a solid red cell with a white glyph, `pass` is a pale green cell with a green
glyph, so a column of passes recedes and a failure pops. `documented_red` is amber, `missing` is
grey. Status colour never carries meaning alone (skill rule): every cell has a glyph, an
`aria-label`, a legend, a hover/focus tooltip, and the same value in the table view below.

Above the grid, one filter row: all scenarios / only scenarios where the selected runs disagree /
only scenarios with a failure, with counts. "Disagree" is the useful default view once more than
two runs are selected, because it collapses 19 rows to the handful that discriminate.

Clicking a row expands the notes and judge notes for that scenario across every selected run,
which is what the matrix's `<details>` row does today.

### 4. The two existing tables, kept and de-noised

Both move into collapsed `<details>` blocks under the new views, so every number stays reachable
without hovering (the skill's table-view rule) but stops being the first thing on screen.

- The metric table drops the bar on rows where fewer than two runs have a value, and renders
  nothing instead of an `n/a` chip when a delta cannot be computed.
- The scenario matrix keeps its per-cell numbers and notes unchanged; it is now the detail view
  the heatmap points at rather than the primary render.

### 5. Pure helpers and their tests (`evalMath.ts`, `evalMath.test.ts`)

`paretoFrontier` (non-dominated set over an x-lower-is-better, y-higher-is-better point set,
including the tie cases: two runs on the same point are both on the frontier, a run dominated on
one axis and tied on the other is not) and `scenarioDisagrees` (do the selected runs differ in
status on this scenario, treating a missing scenario as its own state) are deterministic and
load-bearing for what the chart and the filter claim, so they get unit tests. `vitest.unit.config.ts`
gains `web/src/**/*.test.ts` in its include list; it stays a node-environment, no-DOM, no-LLM suite
because these are pure functions over plain objects.

## What does not change

- No new dependency: the chart is hand-written SVG, the heatmap is an HTML table. No charting
  library, consistent with the zero-infra rule.
- No server change, no schema change, no new endpoint. Every number rendered here is already in
  the run records; this is a pure presentation change over `GET /api/evals/runs`.
- `npm run eval` is not re-run for this work: it touches the web bundle only, no agent, prompt,
  policy, tool, or ledger code, so the eval gate has nothing to say about it. `npm run test` and
  `npm run typecheck` still have to be green.
