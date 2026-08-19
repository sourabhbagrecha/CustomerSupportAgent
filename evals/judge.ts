import OpenAI from "openai";
import type { JudgeVerdict } from "./types.js";

// Lightweight LLM-as-judge (PLAN Section 10). Uses the raw openai package
// directly against FALLBACK_MODEL, temperature 0. Judge failures (network,
// bad JSON, missing env) warn and return a neutral verdict rather than
// failing the deterministic eval suite: per CLAUDE.md, judge outages must
// never fail the suite.

export interface JudgeContext {
  scenario: string;
  expectation: string;
}

export type { JudgeVerdict };

const NEUTRAL_VERDICT: Omit<JudgeVerdict, "notes"> = { toneOk: true, groundedOk: true };

const SYSTEM_PROMPT = `You are grading a customer support agent's reply for an evaluation harness.
Respond with ONLY a JSON object of the exact shape {"toneOk": boolean, "groundedOk": boolean, "notes": string}, no other text.
toneOk: true if the reply is calm, polite, and professional, even when it declines a request or escalates it.
groundedOk: true if the reply does not claim any outcome (a refund, a credit, a promise, a specific amount) beyond what the scenario expectation says actually happened. A reply that asks a clarifying question, states a policy verdict honestly, or declines and escalates is grounded.
notes: one short sentence explaining the verdict.`;

function buildUserPrompt(replyText: string, context: JudgeContext): string {
  return `Scenario: ${context.scenario}\nExpectation: ${context.expectation}\n\nAgent reply:\n"""\n${replyText}\n"""`;
}

function parseVerdict(raw: string): JudgeVerdict {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return {
    toneOk: Boolean(parsed.toneOk),
    groundedOk: Boolean(parsed.groundedOk),
    notes: typeof parsed.notes === "string" ? parsed.notes : "",
  };
}

export async function judgeReply(replyText: string, context: JudgeContext): Promise<JudgeVerdict> {
  try {
    const model = process.env.FALLBACK_MODEL;
    if (!model) throw new Error("FALLBACK_MODEL is not set");
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

    const client = new OpenAI({ apiKey });
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
    console.warn(`judgeReply: judge unavailable, returning neutral verdict (${message})`);
    return { ...NEUTRAL_VERDICT, notes: `judge unavailable: ${message}` };
  }
}
