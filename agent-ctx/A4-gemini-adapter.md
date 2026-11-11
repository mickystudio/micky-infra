# Agent A4 — Gemini Adapter — Work Record

## Task

Build a Gemini adapter for the multi-provider LLM gateway on Cloudflare Workers.
Convert OpenAI Chat Completions requests ↔ Gemini native format and Gemini
responses → OpenAI format.

## Deliverables

1. `worker/src/gateway/adapters/gemini.ts` (490 lines)
   - `export class GeminiAdapter implements ProviderAdapter`
   - Full interface methods (8): `provider`, `getBaseUrl`,
     `getChatCompletionsPath`, `getSupportedModels`, `getHeaders`,
     `formatRequest`, `parseResponse`, `parseStreamChunk`,
     `extractRateLimitInfo`
   - Additive high-level I/O methods (required by task spec):
     `buildChatUrl`, `buildStreamUrl`, `chat`, `chatStream`, `listModels`,
     `healthCheck`
   - Typed errors: `GeminiRateLimitError` (429), `GeminiApiError` (other non-2xx)
   - Singleton export: `geminiAdapter`
   - Re-exports shared types from `./types`

2. `worker/src/gateway/adapters/gemini.test.ts` (490 lines, 34 tests, all passing)
   - formatRequest: 8 tests (user/system/multi-turn/tools/generationConfig/
     tool_calls/tool results)
   - parseResponse: 6 tests (text, finish reasons, usage, tool_calls, empty)
   - parseStreamChunk: 6 tests (data line, no-prefix, [DONE], empty, usage-only,
     functionCall delta)
   - extractRateLimitInfo: 2 tests (empty, retry-after)
   - chat (mocked fetch): 4 tests (URL/headers/body, 429, non-429, body shape)
   - chatStream (mocked fetch): 2 tests (ordered deltas, 429)
   - listModels / healthCheck: 3 tests
   - identity & URL builders: 4 tests

3. `worker/src/gateway/adapters/README_gemini.md`
   - Critical differences table (OpenAI vs Gemini across 14 dimensions)
   - System prompt handling (extracted to `system_instruction`)
   - Tool calling schema (functionDeclarations, functionCall, functionResponse)
   - Rate limit workaround (no headers → count internally; 429 typing)
   - Streaming notes (`alt=sse`)
   - Auth (`x-goog-api-key` vs `?key=`)
   - Edge compatibility, type safety, known limitations

## Design Decisions

### Type alignment with existing codebase

The codebase has TWO competing type files:
- `worker/src/gateway/types.ts` (Agent A6 — uses `ChatCompletionRequest`,
  `AdapterEnv`, `getHeaders(env)`, etc.) — used by `_base.ts` (Agent A10),
  which is currently broken (references types not in that file).
- `worker/src/gateway/adapters/types.ts` (older convention — uses `ChatRequest`,
  `provider` field, `getHeaders(apiKey)`, `DeltaChunk`).

The existing `mistral.ts` adapter imports from `./types` (the adapters-local
one). My Gemini adapter follows the SAME convention (`import … from './types'`)
to compose cleanly with `mistral.ts` and the established `ProviderAdapter`
contract.

### Task-spec compliance

The Agent A4 task brief explicitly requires `chat`, `chatStream`,
`listModels`, `healthCheck` methods — but these are NOT in the
`ProviderAdapter` interface. I implemented them as additive public methods on
the class (beyond the interface). TypeScript lets a class that `implements
ProviderAdapter` have additional public methods, so both worlds are served:
gateway code can call the 8 interface methods uniformly across providers;
direct callers/tests can use the higher-level methods.

### No `any` constraint satisfied

Used `unknown` + type guards (`isObject`, `asString`, `asNumber`, `asArray`)
throughout. The single `Record<string, unknown>` cast at the end of
`formatRequest` is the typed bridge between internal `GeminiRequestBody` and
the contract's `Record<string, unknown>` return type — no `any` involved.

### Edge compatibility

Uses only: `fetch`, `Response`, `Headers`, `ReadableStream`, `TextDecoder`,
`JSON`, `Math`, `Date`, `parseInt`, `Number`. No Node-only imports. Safe for
Cloudflare Workers.

### Rate limit handling

`extractRateLimitInfo(headers)` returns an empty `RateLimitInfo` object
(rather than `null`) to match the contract return type — all fields are
optional so `{}` is semantically equivalent to "no info". When Gemini sets
`retry-after` (typically on 429), it's parsed into `info.retryAfter`. The
README documents that the gateway MUST maintain its own internal ledger
because Gemini's free tier doesn't return `x-ratelimit-*` headers reliably.

### Tool-call stub messages

OpenAI clients sometimes send an assistant message with `content: ""` +
`tool_call_id` but no `tool_calls` array, as a placeholder between the user
request and the tool result. Gemini requires an explicit model turn there,
so `formatRequest` always preserves a `model` turn even when `parts` is
empty. (One test specifically covers this case.)

## Pre-existing project issues (NOT my responsibility, noted for next agent)

- `worker/src/gateway/adapters/_base.ts` (Agent A10) has 17+ TS errors. It
  imports from `'../types'` (gateway root types.ts from Agent A6) but
  references symbols (`ChatStreamChunk`, `HealthStatus`, `ModelInfo`,
  `ProviderId`, `StreamParseContext`, `NetworkError`, `ProviderError`,
  `RateLimitError`) that don't exist there. Agent A10 was written assuming
  a different types file than Agent A6 produced. Either:
  - Agent A6 needs to extend `gateway/types.ts` to add those missing types, OR
  - Agent A10 needs to align with the actual `gateway/types.ts` shape, OR
  - The two conventions need to be reconciled into one.
- The `mistral.ts` adapter (which predates my work) uses the
  `gateway/adapters/types.ts` convention. My Gemini adapter follows that
  same convention for consistency.

## Verification

- `bunx vitest run src/gateway/adapters/gemini.test.ts` → 34 passed (0 failed)
- `npx tsc --noEmit --project tsconfig.json 2>&1 | grep gemini` → no output
  (zero type errors in either gemini.ts or gemini.test.ts)
- File lengths: gemini.ts = 490 lines (<500 ✓), gemini.test.ts = 490 lines,
  README_gemini.md ~ 230 lines.

## Files Created

```
worker/src/gateway/adapters/gemini.ts         (490 lines)
worker/src/gateway/adapters/gemini.test.ts    (490 lines, 34 tests)
worker/src/gateway/adapters/README_gemini.md  (~230 lines)
```

## Summary

Done. Gemini adapter is feature-complete, tested, type-safe, and edge-ready.
It implements the established `ProviderAdapter` contract (composing cleanly
with the existing `mistral.ts` adapter convention) AND adds the high-level
`chat` / `chatStream` / `listModels` / `healthCheck` methods required by
the task brief. All 34 unit tests pass; zero TypeScript errors in either
file. The README documents all Gemini quirks so future agents working on the
gateway circuit-breaker / rate-limit ledger know exactly what to expect from
this adapter.
