import { listRuns, runCostUsd, writeRun } from "../server/src/evals/runRecord.js";
import { lookupModelPricing } from "../server/src/evals/pricing.js";

// Developer-only (plan 008). Archived run records written before the cost
// column existed have `pricing: null`; this stamps each of them with the
// OpenRouter list price for its primary model as of today and rewrites the
// file. Records that already carry a price are left alone, so re-running it
// is safe and never rewrites history. The rewritten records are committed
// like any other change to evals/runs/.
//
// Usage: npx tsx scripts/backfill-pricing.ts
//   npx tsx runs a TypeScript file directly, no build step; no arguments.

async function main(): Promise<void> {
  const { runs, invalid } = listRuns();
  if (invalid.length > 0) console.warn(`backfill-pricing: skipping ${invalid.length} record(s) that do not match the schema: ${invalid.join(", ")}`);
  let updated = 0;
  let unpriced = 0;
  for (const run of runs) {
    if (run.pricing) {
      console.log(`${run.runId}: already priced (${run.pricing.openrouterModelId}), left alone`);
      continue;
    }
    const pricing = await lookupModelPricing(run.provider.primaryModel, run.provider.baseUrl);
    if (!pricing) {
      unpriced += 1;
      console.log(`${run.runId}: no OpenRouter price for ${run.provider.primaryModel ?? "unset"} via ${run.provider.baseUrl}, left null`);
      continue;
    }
    run.pricing = pricing;
    writeRun(run);
    updated += 1;
    const total = runCostUsd(run);
    console.log(
      `${run.runId}: priced as ${pricing.openrouterModelId} ($${pricing.promptUsdPerMillion} in / $${pricing.completionUsdPerMillion} out per 1M), ` +
        `run cost ${total === null ? "n/a" : `$${total.toFixed(4)}`} at today's price`,
    );
  }
  console.log(`backfill-pricing: ${updated} record(s) updated, ${unpriced} left without a price, ${runs.length} total.`);
}

void main();
