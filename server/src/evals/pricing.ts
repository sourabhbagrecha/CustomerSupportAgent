import { z } from "zod";
import type { EvalRunPricing } from "./runRecord.js";

// Per-run dollar cost for the eval archive (plan 008). Prices come from
// OpenRouter's public, unauthenticated model listing
// (GET https://openrouter.ai/api/v1/models, the data behind
// https://openrouter.ai/models), which quotes `pricing.prompt` and
// `pricing.completion` in USD per token for every model it routes, OpenAI's
// own included under `openai/...` ids. Nothing here is hardcoded provider
// data: the listing is fetched, the resolved rates are snapshotted into the
// run record at run time, and a later price change never rewrites history.
//
// Two halves: a cached fetch (network, never throws to the caller) and a pure
// resolver from (model id, base URL) to an OpenRouter id, which is the part
// worth unit-testing. A wrong match would put a confident, wrong dollar figure
// next to a run, so every ambiguous case resolves to null and the UI shows n/a.

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 60 * 60 * 1_000;
const FAILURE_TTL_MS = 5 * 60 * 1_000;

// Only the fields the resolver needs; everything else in the listing is
// stripped. Prices are decimal strings in the API ("0.00000075").
export const OpenRouterModelSchema = z.object({
  id: z.string(),
  canonical_slug: z.string().nullish(),
  pricing: z.object({
    prompt: z.string(),
    completion: z.string(),
  }),
});
const OpenRouterModelsResponseSchema = z.object({ data: z.array(z.unknown()) });

export type OpenRouterModel = z.infer<typeof OpenRouterModelSchema>;

// What ends up on the run record: EvalRunPricingSchema in runRecord.ts is
// the source of truth (web/src/types.ts mirrors it by hand). Rates are USD
// per million tokens, the unit the OpenRouter page and everyone else quotes.
export type ModelPricing = EvalRunPricing;

// ---------------------------------------------------------------------------
// Resolution (pure)
// ---------------------------------------------------------------------------

// Direct vendor endpoints and the OpenRouter vendor prefix their model ids
// live under. A host not listed here still gets the exact-id and unique-suffix
// passes below; this table only sharpens the common cases.
const HOST_VENDOR_PREFIX: Record<string, string> = {
  "api.openai.com": "openai",
  "api.deepseek.com": "deepseek",
  "api.anthropic.com": "anthropic",
  "api.mistral.ai": "mistralai",
  "api.x.ai": "x-ai",
  "generativelanguage.googleapis.com": "google",
};

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    return "";
  }
}

// OpenAI dates its snapshots "-2026-03-17"; OpenRouter's canonical_slug for
// the same snapshot is "...-20260317". Both forms are derived here.
const DATE_SUFFIX = /-(\d{4})-(\d{2})-(\d{2})$/;
function stripDateSuffix(id: string): string {
  return id.replace(DATE_SUFFIX, "");
}
function compactDateSuffix(id: string): string {
  return id.replace(DATE_SUFFIX, "-$1$2$3");
}

// "openai/gpt-5.4-mini:batch" is a different price for the same model; a
// variant must only ever match when the run's id names that variant itself.
function isVariant(id: string): boolean {
  return id.includes(":");
}

function perMillion(perToken: string): number | null {
  const n = Number.parseFloat(perToken);
  if (!Number.isFinite(n) || n < 0) return null;
  // 12 significant digits: enough for any listed price, and it keeps
  // 0.00000014 * 1e6 from landing in the record as 0.13999999999999999.
  return Number((n * 1_000_000).toPrecision(12));
}

export function toModelPricing(model: OpenRouterModel, fetchedAt: string): ModelPricing | null {
  const prompt = perMillion(model.pricing.prompt);
  const completion = perMillion(model.pricing.completion);
  if (prompt === null || completion === null) return null;
  return { source: "openrouter", openrouterModelId: model.id, promptUsdPerMillion: prompt, completionUsdPerMillion: completion, fetchedAt };
}

export function resolveOpenRouterModel(models: OpenRouterModel[], modelId: string | null, baseUrl: string): OpenRouterModel | null {
  if (!modelId) return null;
  const id = modelId.trim();
  if (id.length === 0) return null;
  const byId = new Map(models.map((m) => [m.id, m] as const));

  // 1. A run routed through OpenRouter (or one that spelled out the full
  //    vendor/model id anywhere) carries the listing id verbatim, variant
  //    suffix included.
  const exact = byId.get(id);
  if (exact) return exact;

  const plain = models.filter((m) => !isVariant(m.id));

  // 2. Direct vendor endpoint: prefix with the vendor and try the id as
  //    written, then without its snapshot date, then against the canonical
  //    slug's compact date form.
  const vendor = HOST_VENDOR_PREFIX[hostOf(baseUrl)];
  if (vendor) {
    const candidates = [`${vendor}/${id}`, `${vendor}/${stripDateSuffix(id)}`];
    for (const candidate of candidates) {
      const hit = byId.get(candidate);
      if (hit && !isVariant(hit.id)) return hit;
    }
    const compact = `${vendor}/${compactDateSuffix(id)}`;
    const slugHits = plain.filter((m) => m.canonical_slug === compact);
    if (slugHits.length === 1) return slugHits[0]!;
  }

  // 3. Unknown host: the id's tail after any vendor prefix must match
  //    exactly one listed model. Two vendors shipping the same model name
  //    (common for open-weight models) is an ambiguity, not a guess.
  const tail = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  const tailBare = stripDateSuffix(tail);
  const suffixHits = plain.filter((m) => {
    const mTail = m.id.slice(m.id.indexOf("/") + 1);
    return mTail === tail || mTail === tailBare;
  });
  if (suffixHits.length === 1) return suffixHits[0]!;
  return null;
}

export function resolveModelPricing(
  models: OpenRouterModel[],
  modelId: string | null,
  baseUrl: string,
  fetchedAt: string,
): ModelPricing | null {
  const model = resolveOpenRouterModel(models, modelId, baseUrl);
  return model ? toModelPricing(model, fetchedAt) : null;
}

// ---------------------------------------------------------------------------
// Fetch (cached, never throws)
// ---------------------------------------------------------------------------

export interface OpenRouterListing {
  models: OpenRouterModel[];
  fetchedAt: string;
}

let cached: { listing: OpenRouterListing; expiresAt: number } | null = null;
let failedUntil = 0;
let inFlight: Promise<OpenRouterListing | null> | null = null;

export function parseOpenRouterModels(raw: unknown): OpenRouterModel[] {
  const envelope = OpenRouterModelsResponseSchema.parse(raw);
  const out: OpenRouterModel[] = [];
  for (const entry of envelope.data) {
    // One malformed entry in a 400-model listing must not lose the others.
    const parsed = OpenRouterModelSchema.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

async function fetchListing(): Promise<OpenRouterListing | null> {
  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const models = parseOpenRouterModels(await response.json());
    if (models.length === 0) throw new Error("empty model list");
    return { models, fetchedAt: new Date().toISOString() };
  } catch (err) {
    // Logged, not swallowed: the caller gets null and records n/a. Pricing is
    // advisory, so a listing outage must never fail or delay an eval run
    // beyond the fetch timeout.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`eval pricing: could not fetch ${OPENROUTER_MODELS_URL} (${message}); cost will be n/a`);
    return null;
  }
}

export async function fetchOpenRouterModels(now: number = Date.now()): Promise<OpenRouterListing | null> {
  if (cached && cached.expiresAt > now) return cached.listing;
  if (failedUntil > now) return null;
  if (!inFlight) {
    inFlight = fetchListing().then((listing) => {
      inFlight = null;
      if (listing) {
        cached = { listing, expiresAt: Date.now() + CACHE_TTL_MS };
      } else {
        failedUntil = Date.now() + FAILURE_TTL_MS;
      }
      return listing;
    });
  }
  return inFlight;
}

// The one call sites use: from a run's provider block to the pricing block
// on its record, or null when the listing is unavailable or the model is not
// priced there.
export async function lookupModelPricing(modelId: string | null, baseUrl: string): Promise<ModelPricing | null> {
  const listing = await fetchOpenRouterModels();
  if (!listing) return null;
  return resolveModelPricing(listing.models, modelId, baseUrl, listing.fetchedAt);
}

// Test seam.
export function resetPricingCacheForTests(): void {
  cached = null;
  failedUntil = 0;
  inFlight = null;
}
