import { describe, expect, it } from "vitest";
import { parseOpenRouterModels, resolveModelPricing, resolveOpenRouterModel, toModelPricing, type OpenRouterModel } from "./pricing.js";

// A slice of the real listing shape as of 2026-08-19: ids, canonical slugs
// with compact snapshot dates, ":batch" and ":free" variants, and per-token
// price strings.
const MODELS: OpenRouterModel[] = [
  { id: "openai/gpt-5.4-mini", canonical_slug: "openai/gpt-5.4-mini-20260317", pricing: { prompt: "0.00000075", completion: "0.0000045" } },
  { id: "openai/gpt-5.4-mini:batch", canonical_slug: "openai/gpt-5.4-mini-20260317", pricing: { prompt: "0.000000375", completion: "0.00000225" } },
  { id: "openai/gpt-5.4", canonical_slug: "openai/gpt-5.4-20260305", pricing: { prompt: "0.0000025", completion: "0.000015" } },
  { id: "deepseek/deepseek-v4-flash-0731", canonical_slug: "deepseek/deepseek-v4-flash-0731", pricing: { prompt: "0.00000014", completion: "0.00000028" } },
  { id: "nvidia/nemotron-3-ultra-550b-a55b:free", canonical_slug: "nvidia/nemotron-3-ultra-550b-a55b", pricing: { prompt: "0", completion: "0" } },
  { id: "nvidia/nemotron-3-ultra-550b-a55b", canonical_slug: "nvidia/nemotron-3-ultra-550b-a55b", pricing: { prompt: "0.0000006", completion: "0.0000018" } },
  { id: "meta-llama/llama-4-scout", canonical_slug: "meta-llama/llama-4-scout", pricing: { prompt: "0.0000001", completion: "0.0000003" } },
  { id: "groq/llama-4-scout", canonical_slug: "groq/llama-4-scout", pricing: { prompt: "0.00000011", completion: "0.00000034" } },
  { id: "mistralai/mistral-small-4", canonical_slug: "mistralai/mistral-small-4-2604", pricing: { prompt: "0.0000001", completion: "0.0000003" } },
];

const OPENROUTER = "https://openrouter.ai/api/v1";
const OPENAI = "https://api.openai.com/v1";

describe("resolveOpenRouterModel", () => {
  it("matches an OpenRouter id verbatim, variant suffix included", () => {
    expect(resolveOpenRouterModel(MODELS, "deepseek/deepseek-v4-flash-0731", OPENROUTER)?.id).toBe("deepseek/deepseek-v4-flash-0731");
    expect(resolveOpenRouterModel(MODELS, "nvidia/nemotron-3-ultra-550b-a55b:free", OPENROUTER)?.id).toBe("nvidia/nemotron-3-ultra-550b-a55b:free");
    expect(resolveOpenRouterModel(MODELS, "nvidia/nemotron-3-ultra-550b-a55b", OPENROUTER)?.id).toBe("nvidia/nemotron-3-ultra-550b-a55b");
  });

  it("prefixes a direct vendor endpoint's model id and drops a snapshot date when needed", () => {
    expect(resolveOpenRouterModel(MODELS, "gpt-5.4", OPENAI)?.id).toBe("openai/gpt-5.4");
    expect(resolveOpenRouterModel(MODELS, "gpt-5.4-mini", OPENAI)?.id).toBe("openai/gpt-5.4-mini");
    expect(resolveOpenRouterModel(MODELS, "gpt-5.4-mini-2026-03-17", OPENAI)?.id).toBe("openai/gpt-5.4-mini");
  });

  it("matches a dated snapshot against the canonical slug and never lands on a :batch variant", () => {
    // Without the undated id in the listing, only the canonical slug can
    // place the snapshot; the :batch entry shares that slug and must lose.
    const dated = MODELS.filter((m) => m.id !== "openai/gpt-5.4-mini");
    expect(resolveOpenRouterModel(dated, "gpt-5.4-mini-2026-03-17", OPENAI)?.id).toBeUndefined();
    const withSnapshot: OpenRouterModel[] = [
      ...dated,
      { id: "openai/gpt-5.4-mini-20260317", canonical_slug: "openai/gpt-5.4-mini-20260317", pricing: { prompt: "0.00000075", completion: "0.0000045" } },
    ];
    expect(resolveOpenRouterModel(withSnapshot, "gpt-5.4-mini-2026-03-17", OPENAI)?.id).toBe("openai/gpt-5.4-mini-20260317");
  });

  it("falls back to a unique suffix match for an unknown host and refuses an ambiguous one", () => {
    const unknownHost = "https://llm.example.com/v1";
    expect(resolveOpenRouterModel(MODELS, "mistral-small-4", unknownHost)?.id).toBe("mistralai/mistral-small-4");
    expect(resolveOpenRouterModel(MODELS, "llama-4-scout", unknownHost)).toBeNull();
    expect(resolveOpenRouterModel(MODELS, "gpt-5.4-mini", unknownHost)?.id).toBe("openai/gpt-5.4-mini");
  });

  it("returns null for an unset, blank, or unlisted model", () => {
    expect(resolveOpenRouterModel(MODELS, null, OPENAI)).toBeNull();
    expect(resolveOpenRouterModel(MODELS, "  ", OPENAI)).toBeNull();
    expect(resolveOpenRouterModel(MODELS, "qwen/qwen3-reranker-8b", OPENROUTER)).toBeNull();
  });
});

describe("toModelPricing / resolveModelPricing", () => {
  it("converts per-token price strings to USD per million tokens", () => {
    const pricing = resolveModelPricing(MODELS, "gpt-5.4-mini", OPENAI, "2026-08-19T00:00:00.000Z");
    expect(pricing).toEqual({
      source: "openrouter",
      openrouterModelId: "openai/gpt-5.4-mini",
      promptUsdPerMillion: 0.75,
      completionUsdPerMillion: 4.5,
      fetchedAt: "2026-08-19T00:00:00.000Z",
    });
    expect(resolveModelPricing(MODELS, "nvidia/nemotron-3-ultra-550b-a55b:free", OPENROUTER, "t")?.promptUsdPerMillion).toBe(0);
  });

  it("refuses a malformed price rather than recording NaN", () => {
    expect(toModelPricing({ id: "x/y", canonical_slug: null, pricing: { prompt: "free", completion: "0" } }, "t")).toBeNull();
    expect(toModelPricing({ id: "x/y", canonical_slug: null, pricing: { prompt: "-1", completion: "0" } }, "t")).toBeNull();
  });
});

describe("parseOpenRouterModels", () => {
  it("keeps well-formed entries and drops malformed ones instead of failing the whole listing", () => {
    const models = parseOpenRouterModels({
      data: [
        { id: "a/b", canonical_slug: "a/b", pricing: { prompt: "0.1", completion: "0.2" }, extra: "ignored" },
        { id: "c/d", pricing: { prompt: 0.1, completion: "0.2" } },
        { id: "e/f" },
        { id: "g/h", canonical_slug: null, pricing: { prompt: "0", completion: "0", image: "0.01" } },
      ],
    });
    expect(models.map((m) => m.id)).toEqual(["a/b", "g/h"]);
    expect(() => parseOpenRouterModels({ models: [] })).toThrow();
  });
});
