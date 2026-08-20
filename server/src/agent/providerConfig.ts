// Where model calls go. The agent (server/src/agent/modelClient.ts) and the
// eval judge (evals/judge.ts) both resolve their endpoint, key, and model
// here so that switching providers is an environment change, never a code
// change, and so the judge can be pinned to one provider while the agent
// under test moves to another (plan 007). Nothing in this file names a model
// ID; those come from PRIMARY_MODEL / FALLBACK_MODEL / JUDGE_MODEL.

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface BaseUrlPreset {
  label: string;
  baseUrl: string;
}

export const BASE_URL_PRESETS: BaseUrlPreset[] = [
  { label: "OpenAI", baseUrl: DEFAULT_OPENAI_BASE_URL },
  { label: "OpenRouter", baseUrl: OPENROUTER_BASE_URL },
];

export interface AgentProviderConfig {
  apiKey: string | undefined;
  baseUrl: string;
  primaryModel: string | undefined;
  fallbackModel: string | undefined;
  openRouterApiKey: string | undefined;
}

export interface JudgeProviderConfig {
  apiKey: string | undefined;
  baseUrl: string;
  model: string | undefined;
}

type Env = Record<string, string | undefined>;

// The OpenAI SDK appends "/chat/completions" itself, so a base URL pasted
// with that suffix (the natural thing to copy from a provider's docs) would
// produce ".../chat/completions/chat/completions". Trim it, plus trailing
// slashes and whitespace, rather than failing the first call with a 404.
export function normalizeBaseUrl(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return DEFAULT_OPENAI_BASE_URL;
  return trimmed.replace(/\/+$/, "").replace(/\/chat\/completions$/, "").replace(/\/+$/, "");
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function resolveAgentProvider(env: Env = process.env): AgentProviderConfig {
  return {
    apiKey: env.OPENAI_API_KEY,
    baseUrl: normalizeBaseUrl(env.OPENAI_BASE_URL),
    primaryModel: env.PRIMARY_MODEL,
    fallbackModel: env.FALLBACK_MODEL,
    openRouterApiKey: env.OPENROUTER_API_KEY,
  };
}

// OpenRouter names models "vendor/model" (e.g. "google/gemini-3.7-flash");
// an OpenAI-style id (e.g. "gpt-5.4-mini") never contains "/". This is what
// lets FALLBACK_MODEL name a genuinely different provider/family than
// PRIMARY_MODEL for real failover (see .env.example), not just a cheaper
// model from the same vendor that goes down with it.
export function isOpenRouterModelId(modelId: string): boolean {
  return modelId.includes("/");
}

export interface ModelEndpoint {
  apiKey: string | undefined;
  baseUrl: string;
}

// Per-call routing: an OpenRouter-style model id always goes to
// OPENROUTER_BASE_URL with OPENROUTER_API_KEY, regardless of OPENAI_BASE_URL;
// every other id keeps using the agent's own configured endpoint and key
// exactly as before. Called once per model (primary, then fallback if it
// differs), so PRIMARY_MODEL and FALLBACK_MODEL can each be routed to a
// different provider without a second OPENAI_BASE_URL to configure, and
// without adding a queue, proxy, or any second process.
export function resolveModelEndpoint(provider: AgentProviderConfig, modelId: string): ModelEndpoint {
  if (isOpenRouterModelId(modelId) && provider.baseUrl !== OPENROUTER_BASE_URL) {
    return { apiKey: provider.openRouterApiKey, baseUrl: OPENROUTER_BASE_URL };
  }
  return { apiKey: provider.apiKey, baseUrl: provider.baseUrl };
}

// JUDGE_* overrides fall back to the agent's own settings, which is exactly
// the pre-plan-007 behaviour (judge = FALLBACK_MODEL on the same key and
// endpoint) when none of them are set.
export function resolveJudgeProvider(env: Env = process.env): JudgeProviderConfig {
  const agent = resolveAgentProvider(env);
  return {
    apiKey: env.JUDGE_API_KEY ?? agent.apiKey,
    baseUrl: env.JUDGE_BASE_URL ? normalizeBaseUrl(env.JUDGE_BASE_URL) : agent.baseUrl,
    model: env.JUDGE_MODEL ?? agent.fallbackModel,
  };
}

// Names (never values) of the environment variables that look like API keys,
// so the UI can offer "which key should this run use" without a secret ever
// crossing the wire. OPENAI_API_KEY is listed first when present.
export function listApiKeyEnvNames(env: Env = process.env): string[] {
  const names = Object.keys(env)
    .filter((name) => /_API_KEY$/.test(name) && (env[name] ?? "").trim().length > 0)
    .sort();
  const idx = names.indexOf("OPENAI_API_KEY");
  if (idx > 0) {
    names.splice(idx, 1);
    names.unshift("OPENAI_API_KEY");
  }
  return names;
}

// "https://openrouter.ai/api/v1" -> "openrouter.ai"; used for display only.
export function providerHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
