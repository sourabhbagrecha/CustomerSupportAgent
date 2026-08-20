import OpenAI from "openai";
import { isOpenRouterModelId, OPENROUTER_BASE_URL, resolveJudgeProvider } from "../server/src/agent/providerConfig.js";
import { GOLDEN_SET, GOLDEN_SET_VERSION } from "./goldenSet.js";
import type { JudgeVerdict } from "./types.js";

// Lightweight LLM-as-judge (PLAN Section 10). Uses the raw openai package
// directly, temperature 0, against the judge provider resolved in
// server/src/agent/providerConfig.ts: JUDGE_MODEL / JUDGE_BASE_URL /
// JUDGE_API_KEY when set, else FALLBACK_MODEL on the agent's own endpoint and
// key. Pinning the judge (via JUDGE_MODEL, see .env.example) lets the agent
// under test move to another provider while every run is still graded by the
// same model. Set JUDGE_MODEL explicitly so the judge never silently
// inherits FALLBACK_MODEL, which by design (see providerConfig.ts) may
// legitimately be an OpenRouter-style "vendor/model" id for the agent's own
// failover, something the judge should never care about. As a safety net
// for whenever the resolved judge model *does* end up OpenRouter-style
// anyway (JUDGE_MODEL left unset and inherited from FALLBACK_MODEL, or
// JUDGE_MODEL deliberately set to one), resolveJudgeEndpoint below re-routes
// it to OpenRouter's own endpoint and key, mirroring the same slash-based
// routing resolveModelEndpoint already applies on the agent's path
// (server/src/agent/modelClient.ts), so an OpenRouter-style id is never sent
// to the OpenAI host. Judge outages (missing model, missing key, network
// error, empty response, unparseable JSON, or a parseable-but-malformed
// response missing the boolean keys) never fail the deterministic eval
// suite: per CLAUDE.md, a judge outage must never fail the suite. But it is
// no longer silently scored as a pass either. judgeReply returns a
// discriminated union, and an outage comes back as an explicit "unscored"
// state with a reason, so it stays visible in evals/RESULTS.md instead of
// being folded into a neutral true/true verdict.

export interface JudgeContext {
  scenario: string;
  expectation: string;
}

export type { JudgeVerdict };

const SYSTEM_PROMPT = `You are grading a customer support agent's reply for an evaluation harness.
Respond with ONLY a JSON object of the exact shape {"toneOk": boolean, "groundedOk": boolean, "notes": string}, no other text.
toneOk: true if the reply is calm, polite, and professional, even when it declines a request or escalates it.
groundedOk: true if the reply does not claim any outcome (a refund, a credit, a promise, a specific amount) beyond what the scenario expectation says actually happened. A reply that asks a clarifying question, states a policy verdict honestly, or declines and escalates is grounded.
notes: one short sentence explaining the verdict.`;

function buildUserPrompt(replyText: string, context: JudgeContext): string {
  return `Scenario: ${context.scenario}\nExpectation: ${context.expectation}\n\nAgent reply:\n"""\n${replyText}\n"""`;
}

// A response that parses as JSON but does not carry the two boolean keys is
// malformed, not a scored false: it means the judge failed to follow the
// contract, not that it graded the reply poorly.
function parseVerdict(raw: string): JudgeVerdict {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (typeof parsed.toneOk !== "boolean" || typeof parsed.groundedOk !== "boolean") {
    return {
      state: "unscored",
      notes: "judge unavailable: malformed response, missing toneOk/groundedOk boolean keys",
    };
  }
  return {
    state: "scored",
    toneOk: parsed.toneOk,
    groundedOk: parsed.groundedOk,
    notes: typeof parsed.notes === "string" ? parsed.notes : "",
  };
}

interface JudgeEndpoint {
  apiKey: string | undefined;
  baseUrl: string;
}

// resolveJudgeProvider's own baseUrl/apiKey fallback (when JUDGE_BASE_URL /
// JUDGE_API_KEY are unset) just inherits the agent's OpenAI-style endpoint
// and key, with no awareness that the model it resolved could be an
// OpenRouter-style "vendor/model" id (possible whenever JUDGE_MODEL is
// unset and FALLBACK_MODEL is OpenRouter-style, or when JUDGE_MODEL itself
// is deliberately set to one). This re-derives the endpoint from the
// resolved model, the same way resolveModelEndpoint does for the agent
// (server/src/agent/providerConfig.ts): an OpenRouter-style model id always
// routes to OPENROUTER_BASE_URL with OPENROUTER_API_KEY, unless the operator
// explicitly pinned JUDGE_BASE_URL / JUDGE_API_KEY, which always wins.
function resolveJudgeEndpoint(
  model: string,
  provider: { apiKey: string | undefined; baseUrl: string },
  env: Record<string, string | undefined>,
): JudgeEndpoint {
  const explicitBaseUrl = Boolean(env.JUDGE_BASE_URL?.trim());
  const explicitApiKey = Boolean(env.JUDGE_API_KEY?.trim());
  if (isOpenRouterModelId(model) && !explicitBaseUrl) {
    return {
      baseUrl: OPENROUTER_BASE_URL,
      apiKey: explicitApiKey ? provider.apiKey : env.OPENROUTER_API_KEY,
    };
  }
  return { baseUrl: provider.baseUrl, apiKey: provider.apiKey };
}

// `envOverride`, when given, is used instead of process.env to resolve the
// judge provider. Every existing scenario call site omits it (unchanged
// behavior: resolves from this process's own env, exactly as before);
// runGoldenSetCalibration below is the one caller that passes it, so a
// UI-started run's calibration is graded by that run's own overridden judge
// rather than the server process's default one.
export async function judgeReply(
  replyText: string,
  context: JudgeContext,
  envOverride?: Record<string, string | undefined>,
): Promise<JudgeVerdict> {
  try {
    const env = envOverride ?? process.env;
    const provider = resolveJudgeProvider(envOverride);
    const model = provider.model;
    if (!model) throw new Error("JUDGE_MODEL / FALLBACK_MODEL is not set");
    const endpoint = resolveJudgeEndpoint(model, provider, env);
    const apiKey = endpoint.apiKey;
    if (!apiKey) {
      throw new Error(
        isOpenRouterModelId(model) && !env.JUDGE_BASE_URL?.trim()
          ? "OPENROUTER_API_KEY is not set (required because the resolved judge model is OpenRouter-style)"
          : "JUDGE_API_KEY / OPENAI_API_KEY is not set",
      );
    }

    const client = new OpenAI({ apiKey, baseURL: endpoint.baseUrl });
    const completion = await client.chat.completions.create({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(replyText, context) },
      ],
    });
    const raw = completion.choices[0]?.message?.content;
    if (!raw) throw new Error("Judge returned an empty response");
    return parseVerdict(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`judgeReply: judge unavailable, scenario will record an unscored verdict (${message})`);
    return { state: "unscored", notes: `judge unavailable: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Judge calibration (task P1-6): agreement between the real judge and the
// hand-labeled golden set in evals/goldenSet.ts (drafted by the assistant,
// not human-verified; see that file's header comment). Called from
// server/src/evals/runner.ts once per full-suite run, never per scenario or
// per repeat, so the extra cost is a bounded dozen short judge calls rather
// than something that scales with the suite.
// ---------------------------------------------------------------------------

export type GoldenSetVerdictLabel = "pass" | "fail" | "unscored";

export interface GoldenSetDisagreement {
  id: string;
  goldenLabel: "pass" | "fail";
  judgeVerdict: GoldenSetVerdictLabel;
}

export interface GoldenSetCalibration {
  goldenSetVersion: string;
  computedAt: string;
  total: number;
  agreeing: number;
  agreementPct: number;
  judgeModel: string | null;
  disagreements: GoldenSetDisagreement[];
}

// A judge verdict collapses to the same two-way pass/fail the golden set is
// labeled with: "pass" only when both toneOk and groundedOk are true (the
// exact bar every scenario's own `expect(judge.toneOk)...expect(judge.groundedOk)`
// check applies), "fail" for a scored-but-not-clean verdict, "unscored" for
// a judge outage (counted as a disagreement below, never silently dropped,
// same denominator-discipline rule as the rest of task P1-6).
function verdictLabel(v: JudgeVerdict): GoldenSetVerdictLabel {
  if (v.state === "unscored") return "unscored";
  return v.toneOk && v.groundedOk ? "pass" : "fail";
}

// Never throws: a judge outage during calibration degrades exactly like
// judgeReply itself (each transcript that cannot be scored is recorded as an
// "unscored" disagreement), so a calibration problem can never fail the eval
// run it rides along with.
export async function runGoldenSetCalibration(
  envOverride?: Record<string, string | undefined>,
): Promise<GoldenSetCalibration> {
  const provider = resolveJudgeProvider(envOverride);
  const disagreements: GoldenSetDisagreement[] = [];
  let agreeing = 0;
  for (const item of GOLDEN_SET) {
    const verdict = await judgeReply(item.replyText, { scenario: item.scenario, expectation: item.expectation }, envOverride);
    const judged = verdictLabel(verdict);
    if (judged === item.label) {
      agreeing += 1;
    } else {
      disagreements.push({ id: item.id, goldenLabel: item.label, judgeVerdict: judged });
    }
  }
  const total = GOLDEN_SET.length;
  return {
    goldenSetVersion: GOLDEN_SET_VERSION,
    computedAt: new Date().toISOString(),
    total,
    agreeing,
    agreementPct: total > 0 ? (agreeing / total) * 100 : 0,
    judgeModel: provider.model ?? null,
    disagreements,
  };
}
