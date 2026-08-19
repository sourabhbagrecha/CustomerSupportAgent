import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENAI_BASE_URL,
  isHttpUrl,
  listApiKeyEnvNames,
  normalizeBaseUrl,
  providerHost,
  resolveAgentProvider,
  resolveJudgeProvider,
} from "./providerConfig.js";

describe("normalizeBaseUrl", () => {
  it("defaults to the OpenAI endpoint when unset or blank", () => {
    expect(normalizeBaseUrl(undefined)).toBe(DEFAULT_OPENAI_BASE_URL);
    expect(normalizeBaseUrl("")).toBe(DEFAULT_OPENAI_BASE_URL);
    expect(normalizeBaseUrl("   ")).toBe(DEFAULT_OPENAI_BASE_URL);
  });

  it("trims a pasted /chat/completions suffix and trailing slashes", () => {
    expect(normalizeBaseUrl("https://openrouter.ai/api/v1/chat/completions")).toBe("https://openrouter.ai/api/v1");
    expect(normalizeBaseUrl("https://openrouter.ai/api/v1/chat/completions/")).toBe("https://openrouter.ai/api/v1");
    expect(normalizeBaseUrl("https://openrouter.ai/api/v1/")).toBe("https://openrouter.ai/api/v1");
    expect(normalizeBaseUrl("  https://api.openai.com/v1  ")).toBe("https://api.openai.com/v1");
  });

  it("leaves an already-clean base URL alone", () => {
    expect(normalizeBaseUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
  });
});

describe("isHttpUrl", () => {
  it("accepts http and https absolute URLs only", () => {
    expect(isHttpUrl("https://openrouter.ai/api/v1")).toBe(true);
    expect(isHttpUrl("http://localhost:11434/v1")).toBe(true);
    expect(isHttpUrl("ftp://example.com")).toBe(false);
    expect(isHttpUrl("openrouter.ai/api/v1")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
  });
});

describe("resolveAgentProvider / resolveJudgeProvider", () => {
  const base = {
    OPENAI_API_KEY: "sk-agent",
    PRIMARY_MODEL: "primary-x",
    FALLBACK_MODEL: "fallback-y",
  };

  it("judge inherits the agent's key, endpoint, and fallback model when no JUDGE_* is set", () => {
    const agent = resolveAgentProvider(base);
    const judge = resolveJudgeProvider(base);
    expect(agent).toEqual({
      apiKey: "sk-agent",
      baseUrl: DEFAULT_OPENAI_BASE_URL,
      primaryModel: "primary-x",
      fallbackModel: "fallback-y",
    });
    expect(judge).toEqual({ apiKey: "sk-agent", baseUrl: DEFAULT_OPENAI_BASE_URL, model: "fallback-y" });
  });

  it("OPENAI_BASE_URL moves the agent and, by default, the judge", () => {
    const env = { ...base, OPENAI_BASE_URL: "https://openrouter.ai/api/v1/" };
    expect(resolveAgentProvider(env).baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(resolveJudgeProvider(env).baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("JUDGE_* pins the judge independently of the agent provider", () => {
    const env = {
      ...base,
      OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
      JUDGE_MODEL: "judge-z",
      JUDGE_BASE_URL: "https://api.openai.com/v1/chat/completions",
      JUDGE_API_KEY: "sk-judge",
    };
    expect(resolveJudgeProvider(env)).toEqual({
      apiKey: "sk-judge",
      baseUrl: "https://api.openai.com/v1",
      model: "judge-z",
    });
    expect(resolveAgentProvider(env).apiKey).toBe("sk-agent");
  });
});

describe("listApiKeyEnvNames", () => {
  it("returns only set *_API_KEY names, OPENAI_API_KEY first, never values", () => {
    const names = listApiKeyEnvNames({
      ZZZ_API_KEY: "z",
      OPENAI_API_KEY: "sk",
      EMPTY_API_KEY: "   ",
      OPENROUTER_API_KEY: "or",
      NOT_A_KEY: "x",
      PATH: "/usr/bin",
    });
    expect(names).toEqual(["OPENAI_API_KEY", "OPENROUTER_API_KEY", "ZZZ_API_KEY"]);
  });
});

describe("providerHost", () => {
  it("extracts the host for display and falls back to the raw string", () => {
    expect(providerHost("https://openrouter.ai/api/v1")).toBe("openrouter.ai");
    expect(providerHost("not a url")).toBe("not a url");
  });
});
