# Plan 011: Prompt cache friendliness and cache observability

## Problem

Provider-side prompt caching (OpenAI automatic prefix caching, and the equivalents OpenRouter passes through for DeepSeek and Gemini) bills only the tokens after the first changed token of the prompt. Our current request layout wastes most of that:

- `agentNode` builds one system message as `SYSTEM_PROMPT + "\n\n" + retrievedContextBlock` (graph.ts).
- `retrievedContextBlock` is rebuilt every turn by loadContext.ts and changes every turn: the policy chunks and history hits depend on the latest customer message, payments and orders mutate after any refund, and the date line flips at UTC midnight.
- Prefix caching stops at the first changed token, so across turns the cache hit ends at the static SYSTEM_PROMPT (~2k tokens). The context block (~3k tokens) and the entire growing conversation history sit behind it and are re-billed as uncached input on every turn.

We also have no way to see whether caching happens at all: the `llm_call` event records tokensIn/tokensOut but not cached input tokens, even though the provider reports them (`prompt_tokens_details.cached_tokens`, surfaced by LangChain as `usage_metadata.input_token_details.cache_read`).

## Changes

### 1. Cache observability (zero model-behavior risk)

- modelClient.ts: read `result.usage_metadata?.input_token_details?.cache_read` and record it in the `llm_call` event payload as `cacheReadTokens` (null when the provider does not report it).
- emitter.ts (`emitTurnRollup`): sum `cacheReadTokens` across the turn's llm_call rows via `json_extract` and add `tokensCachedIn` to the rollup payload.
- TracePanel.tsx: show the cached count on the llm_call line and the rollup line when present; older events without the field render exactly as before.

No schema change: the count lives in the payload JSON, not a new column.

### 2. Cache-friendly message layout

Move the volatile context block out of the system message. New request shape, assembled by a pure helper (`assembleMessages.ts`) so it is unit-testable:

```
[ SystemMessage(SYSTEM_PROMPT)            (static, byte-identical every call)
, ...history up to the latest HumanMessage
, SystemMessage(retrievedContextBlock)    (volatile, rebuilt per turn)
, latest HumanMessage
, ...current-turn AI/tool messages ]
```

Placement rationale (context immediately BEFORE the latest human message, not after it):

- Within a turn (agent, tools, agent loop) every later call is a pure append, so the full prefix including the context block stays cached. This is today's best-cached path and is preserved.
- Across turns, the next request diverges only where the previous turn's context block sat, so the cached prefix covers the static prompt plus all history before the previous turn's final exchange. Today the divergence happens immediately after SYSTEM_PROMPT.
- The context message is assembled at call time from graph state and never persisted into the checkpointer, so history stays pure conversation and old turns are never rewritten.
- Inserting before the latest HumanMessage can never split an AIMessage/ToolMessage pair: the message preceding it is always a prior turn's final AI reply (or a decision-notice AIMessage from notify.ts).
- Fallback: if the state somehow contains no HumanMessage, append the context message at the end.

Prompt wording: hard rule 6 and the Tools section say the context is "below" inside the same system prompt. Those references change to point at the separate pre-loaded context message; no rule semantics change.

## Testing

- New unit test for `assembleMessages`: insertion point, in-turn append stability, no-human fallback, context never persisted.
- `npm run test` and `npm run typecheck` green.
- Trace panel checked in the running dev UI via playwright.
- Gate: this is a prompt-shape change, so `npm run eval` (plus `repeat-scenario` replay of the judgment scenarios) must pass before it merges. Eval runs cost credits and are started only with the user's go-ahead, so the run is requested, not started by this change.

## Follow-ups (not in this plan)

- Price cached input at the provider's discounted rate in emitTurnRollup and evals pricing; today all input tokens are priced at the full prompt rate, so the cost column slightly overstates when cache hits occur.
- Provider caveat, documented here for the record: Anthropic models behind OpenRouter would need explicit cache_control breakpoints that plain ChatOpenAI never sends; OpenAI, DeepSeek and Gemini cache implicitly. Failover to FALLBACK_MODEL is always a cold cache (different model, different cache).
