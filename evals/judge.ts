import OpenAI from "openai";
import { resolveJudgeProvider } from "../server/src/agent/providerConfig.js";
import type { JudgeVerdict } from "./types.js";

// Lightweight LLM-as-judge (PLAN Section 10). Uses the raw openai package
// directly, temperature 0, against the judge provider resolved in
// server/src/agent/providerConfig.ts: JUDGE_MODEL / JUDGE_BASE_URL /
// JUDGE_API_KEY when set, else FALLBACK_MODEL on the agent's own endpoint and
// key. Pinning the judge lets the agent under test move to another provider
// while every run is still graded by the same model. Judge outages (missing
// model, missing key, network error, empty response,
// unparseable JSON, or a parseable-but-malformed response missing the
// boolean keys) never fail the deterministic eval suite: per CLAUDE.md, a
// judge outage must never fail the suite. But it is no longer silently
// scored as a pass either. judgeReply returns a discriminated union, and an
// outage comes back as an explicit "unscored" state with a reason, so it
// stays visible in evals/RESULTS.md instead of being folded into a neutral
// true/true verdict.

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

export async function judgeReply(replyText: string, context: JudgeContext): Promise<JudgeVerdict> {
  try {
    const provider = resolveJudgeProvider();
    const model = provider.model;
    if (!model) throw new Error("JUDGE_MODEL / FALLBACK_MODEL is not set");
    const apiKey = provider.apiKey;
    if (!apiKey) throw new Error("JUDGE_API_KEY / OPENAI_API_KEY is not set");

    const client = new OpenAI({ apiKey, baseURL: provider.baseUrl });
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
