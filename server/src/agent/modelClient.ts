import { ChatOpenAI } from "@langchain/openai";
import type { BaseMessage, AIMessage, AIMessageChunk } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type Database from "better-sqlite3";
import { consumeFault, isFaultActive } from "../faults/registry.js";
import { emitEvent, publishStreamEvent } from "../events/emitter.js";
import { ModelsUnavailable } from "./errors.js";
import { resolveAgentProvider } from "./providerConfig.js";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES_PER_MODEL = 2; // up to 2 retries (3 attempts total) before failing over
const BASE_BACKOFF_MS = 300;
const MAX_BACKOFF_MS = 2_000;

class SimulatedModelFault extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SimulatedModelFault";
    this.status = status;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(err: unknown): boolean {
  const status = (err as { status?: number } | undefined)?.status;
  return status === 429 || (typeof status === "number" && status >= 500);
}

function backoffMs(attempt: number): number {
  const raw = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  return raw + Math.random() * 100;
}

// model_down_all takes down every model on every call (non-consuming: stays
// active until the eval/UI clears it). model_rate_limit_primary only affects
// the primary model and is consumed N times (Section 5: "the next N calls").
function checkModelFault(role: "primary" | "fallback"): void {
  if (isFaultActive("model_down_all")) {
    throw new SimulatedModelFault(503, `Model unavailable (model_down_all fault active).`);
  }
  if (role === "primary" && consumeFault("model_rate_limit_primary")) {
    throw new SimulatedModelFault(429, "Primary model rate limited (model_rate_limit_primary fault active).");
  }
}

// Endpoint and key come from providerConfig (OPENAI_API_KEY, optional
// OPENAI_BASE_URL), so any OpenAI-compatible chat-completions provider can
// stand in without a code change. The baseURL is always passed explicitly
// rather than left to the SDK's own env lookup, so what the trace records
// and what the request hits are resolved in one place.
function buildClient(model: string): ChatOpenAI {
  const provider = resolveAgentProvider();
  return new ChatOpenAI({
    model,
    temperature: 0,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 0, // retry/backoff is owned by this wrapper, not the SDK
    apiKey: provider.apiKey,
    configuration: { baseURL: provider.baseUrl },
    streamUsage: true, // keep tokensIn/tokensOut populated on the streamed result
  });
}

function chunkText(content: AIMessageChunk["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
    .join("");
}

// Replaces a naked `as unknown as AIMessage` cast on the accumulated stream
// chunk with a structural check. This is a plain runtime check, not Zod,
// because the value is a LangChain class instance (AIMessageChunk), not a
// plain JSON boundary value. Thrown inside callWithRetry's existing try
// block, so a malformed response goes through the exact same retry/backoff
// and primary-to-fallback failover ladder, and emits the same `error` event,
// as any other model-call failure; no new code path is introduced.
function assertValidAIMessageShape(message: AIMessageChunk): void {
  const content = message.content;
  if (typeof content !== "string" && !Array.isArray(content)) {
    throw new Error(`Model response has a malformed content field: expected a string or array, got ${typeof content}.`);
  }
  const toolCalls = message.tool_calls;
  if (toolCalls !== undefined) {
    if (!Array.isArray(toolCalls)) {
      throw new Error("Model response has a malformed tool_calls field: expected an array.");
    }
    for (const call of toolCalls) {
      const name = (call as { name?: unknown } | null | undefined)?.name;
      const args = (call as { args?: unknown } | null | undefined)?.args;
      if (typeof name !== "string" || typeof args !== "object" || args === null) {
        throw new Error(
          "Model response has a malformed tool call: expected { name: string, args: object } for every entry in tool_calls.",
        );
      }
    }
  }
}

interface CallOnceParams {
  role: "primary" | "fallback";
  model: string;
  messages: BaseMessage[];
  tools: StructuredToolInterface[];
  threadId: string;
  db: Database.Database;
}

async function callWithRetry({ role, model, messages, tools, threadId, db }: CallOnceParams): Promise<AIMessage> {
  const client = buildClient(model).bindTools(tools);
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
    const startedAt = Date.now();
    try {
      checkModelFault(role);
      publishStreamEvent(threadId, { type: "start" });
      const stream = await client.stream(messages);
      let accumulated: AIMessageChunk | undefined;
      for await (const chunk of stream) {
        accumulated = accumulated ? accumulated.concat(chunk) : chunk;
        const text = chunkText(chunk.content);
        if (text) publishStreamEvent(threadId, { type: "delta", text });
      }
      publishStreamEvent(threadId, { type: "end" });
      if (!accumulated) throw new Error("Model stream produced no chunks.");
      assertValidAIMessageShape(accumulated);
      const result = accumulated as unknown as AIMessage;
      emitEvent(db, {
        threadId,
        type: "llm_call",
        payload: { role, model, attempt },
        latencyMs: Date.now() - startedAt,
        tokensIn: result.usage_metadata?.input_tokens ?? null,
        tokensOut: result.usage_metadata?.output_tokens ?? null,
        model,
      });
      return result;
    } catch (err) {
      lastError = err;
      emitEvent(db, {
        threadId,
        type: "error",
        payload: {
          stage: "llm_call",
          role,
          model,
          attempt,
          retryable: isRetryableStatus(err),
          message: err instanceof Error ? err.message : String(err),
        },
        latencyMs: Date.now() - startedAt,
        model,
      });
      if (!isRetryableStatus(err) || attempt === MAX_RETRIES_PER_MODEL) break;
      await sleep(backoffMs(attempt));
    }
  }
  throw lastError;
}

// PLAN Section 6: 30s timeout, retry with backoff+jitter (max 2 retries) on
// 429/5xx, then failover to FALLBACK_MODEL emitting a `failover` event. If
// both fail, throws ModelsUnavailable; the caller returns the LLM-free
// degraded reply and never touches a model client again on that path.
export async function callModelWithFailover(
  db: Database.Database,
  threadId: string,
  messages: BaseMessage[],
  tools: StructuredToolInterface[],
): Promise<AIMessage> {
  const { primaryModel, fallbackModel } = resolveAgentProvider();
  if (!primaryModel || !fallbackModel) {
    throw new Error("PRIMARY_MODEL and FALLBACK_MODEL must be set (see .env.example).");
  }

  try {
    return await callWithRetry({ role: "primary", model: primaryModel, messages, tools, threadId, db });
  } catch (primaryError) {
    emitEvent(db, {
      threadId,
      type: "failover",
      payload: {
        from: primaryModel,
        to: fallbackModel,
        reason: primaryError instanceof Error ? primaryError.message : String(primaryError),
      },
    });
    try {
      return await callWithRetry({ role: "fallback", model: fallbackModel, messages, tools, threadId, db });
    } catch (fallbackError) {
      throw new ModelsUnavailable(
        "Both primary and fallback models are unavailable.",
        primaryError,
        fallbackError,
      );
    }
  }
}
