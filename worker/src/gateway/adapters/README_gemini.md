# Gemini Adapter — `gemini.ts`

Adapter for the **Google Gemini (Generative Language API)** in the multi-provider
LLLM gateway. Converts OpenAI-shaped Chat Completions requests ↔ Gemini's native
wire format and normalizes Gemini responses back into the OpenAI shape the
gateway emits.

- **File:** `worker/src/gateway/adapters/gemini.ts`
- **Tests:** `worker/src/gateway/adapters/gemini.test.ts` (34 tests, all passing)
- **Agent:** A4

---

## 1. Critical Differences from OpenAI

Gemini's API is **NOT** OpenAI-compatible. The adapter exists precisely because
the request shape, response shape, streaming protocol, auth scheme, and rate-
limit headers all differ. A passthrough proxy is not enough — every field needs
translation.

| Aspect | OpenAI | Gemini |
|---|---|---|
| Endpoint | `POST /v1/chat/completions` | `POST /v1beta/models/{model}:generateContent` |
| Stream endpoint | same path with `stream: true` | `:streamGenerateContent?alt=sse` |
| Auth | `Authorization: Bearer KEY` | `x-goog-api-key: KEY` header (or `?key=…`) |
| Roles | `system`, `user`, `assistant`, `tool` | `user`, `model` only |
| Content | flat `string` (or parts array) | always `parts: [{ text: '…' }]` |
| System prompt | first message with `role: 'system'` | separate top-level `system_instruction` field |
| Tool schema | `tools: [{ type: 'function', function: {…} }]` | `tools: [{ functionDeclarations: [{…}] }]` |
| Tool call (out) | `message.tool_calls` | `parts[].functionCall: { name, args }` |
| Tool result | `role: 'tool'` message | `user` role with `functionResponse: { name, response }` part |
| Usage | `usage: { prompt_tokens, completion_tokens, total_tokens }` | `usageMetadata: { promptTokenCount, candidatesTokenCount, totalTokenCount }` |
| Finish reasons | `stop`, `length`, `tool_calls`, `content_filter` | `STOP`, `MAX_TOKENS`, `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT` |
| Streaming | SSE `data: {json}\n\n` w/ `choices[].delta.content` | SSE `data: {json}\n\n` w/ `candidates[0].content.parts[0].text` |
| Rate-limit headers | `x-ratelimit-remaining-*`, `x-ratelimit-reset-*` | **NOT reliably returned on the free tier** |
| 429 signal | HTTP 429 + `retry-after` | HTTP 429 `RESOURCE_EXHAUSTED` + optional `retry-after` |

---

## 2. System Prompt Handling

OpenAI puts the system prompt as the **first message** in the `messages` array
with `role: 'system'`. Gemini **forbids** a `system` role inside `contents` —
it must be sent as a top-level `system_instruction` field:

```jsonc
// OpenAI shape (in)
{
  "messages": [
    { "role": "system", "content": "Be concise." },
    { "role": "user", "content": "Hi" }
  ]
}

// Gemini shape (out — produced by formatRequest)
{
  "system_instruction": { "parts": [{ "text": "Be concise." }] },
  "contents": [
    { "role": "user", "parts": [{ "text": "Hi" }] }
  ]
}
```

**Multiple system messages** are accumulated (joined with `\n\n`) into a single
`system_instruction` block — Gemini accepts only one. A `system` message that
appears mid-conversation is also hoisted out and merged into the system
instruction.

---

## 3. Tool Calling Schema Differences

### 3.1 Declaring tools

```jsonc
// OpenAI shape (in)
{
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "Get current weather",
      "parameters": { "type": "object", "properties": { "city": { "type": "string" } } }
    }
  }]
}

// Gemini shape (out — produced by formatRequest)
{
  "tools": [{
    "functionDeclarations": [{
      "name": "get_weather",
      "description": "Get current weather",
      "parameters": { "type": "object", "properties": { "city": { "type": "string" } } }
    }]
  }]
}
```

### 3.2 Model invoking a tool (assistant → model)

```jsonc
// OpenAI: assistant message with tool_calls
{
  "role": "assistant",
  "content": "",
  "tool_calls": [{
    "id": "call_1",
    "type": "function",
    "function": { "name": "get_weather", "arguments": "{\"city\":\"Cairo\"}" }
  }]
}

// Gemini: model turn with a functionCall part
{
  "role": "model",
  "parts": [{
    "functionCall": { "name": "get_weather", "args": { "city": "Cairo" } }
  }]
}
```

Note: Gemini's `args` is a **parsed object**, not a JSON string. The adapter
`JSON.parse`s OpenAI's `arguments` string into an object on the way in, and
`JSON.stringify`s Gemini's `args` object back into a string on the way out.

### 3.3 Returning a tool result (tool → user)

```jsonc
// OpenAI: tool message
{
  "role": "tool",
  "content": "{\"temperature\":25}",
  "tool_call_id": "call_1",
  "name": "get_weather"
}

// Gemini: user turn with a functionResponse part
{
  "role": "user",
  "parts": [{
    "functionResponse": {
      "name": "get_weather",
      "response": { "temperature": 25 }
    }
  }]
}
```

Note: Gemini's `response` is a **parsed object**, not a JSON string. The
adapter parses OpenAI's `content` string into an object on the way in.

### 3.4 Empty assistant turns

OpenAI clients sometimes send a "stub" assistant message with `content: ""` +
`tool_call_id` but no `tool_calls` array, between the user request and the
tool result. Gemini **requires** an explicit model turn in this position
(otherwise the functionResponse has no preceding model call to respond to).
The adapter therefore always preserves a `model` turn even when its `parts`
array is empty — see the `formatRequest` comment in `gemini.ts`.

---

## 4. Rate Limit Workaround

### The problem

Gemini's free tier (no billing card on file) **does not return reliable
`x-ratelimit-*` response headers**. There is no `x-ratelimit-remaining-requests`,
no `x-ratelimit-reset-requests`, no `x-ratelimit-remaining-tokens`. The only
signal that you've been throttled is an HTTP **429 RESOURCE_EXHAUSTED** with an
optional `retry-after` header.

This breaks the standard "read the rate-limit headers and decrement locally"
pattern that works for Groq / OpenAI / Mistral / OpenRouter.

### The solution

`extractRateLimitInfo()` returns an **empty `RateLimitInfo` object** for the
common case (no headers present), and only populates `retryAfter` when Gemini
actually sets `retry-after` on a 429. The gateway MUST therefore:

1. **Maintain its own internal request ledger** keyed on
   `(apiKey, model, day)` — increment on each request, decrement (with a TTL)
   on each response.
2. **Treat 429 RESOURCE_EXHAUSTED as ground truth** — when it fires, the
   gateway should:
   - Mark the key as "throttled" until `retry-after` seconds (or a sensible
     default like 60s if no header) have elapsed.
   - Trip the circuit breaker for that `(key, model)` pair.
   - Fail over to another provider via the gateway's fallback chain.
3. **Not rely on headers alone** — a successful 200 response does NOT mean
   "1 RPD consumed"; only the 429 confirms the boundary.

### Documented Gemini free-tier limits (no card on file)

| Model | RPD (requests/day) |
|---|---|
| gemini-1.5-flash-8b / gemini-2.0-flash-lite | ~1000 |
| gemini-1.5-flash / gemini-2.0-flash | ~1500 |
| gemini-1.5-pro / gemini-2.0-pro | ~50 |

These numbers can change; the gateway ledger should discover them dynamically
by reacting to 429s rather than hardcoding the thresholds.

### The typed error

`chat()` and `chatStream()` throw a `GeminiRateLimitError` (subclass of
`Error` with `status = 429` and `retryAfter: number | null`) on 429s, so the
gateway's circuit-breaker can `instanceof`-check rather than parse response
bodies:

```ts
try {
  const res = await geminiAdapter.chat(req, apiKey);
} catch (err) {
  if (err instanceof GeminiRateLimitError) {
    // trip circuit breaker; sleep retryAfter seconds; fail over.
  } else if (err instanceof GeminiApiError) {
    // any other non-2xx status
  }
}
```

---

## 5. Streaming

Gemini's streaming endpoint is `:streamGenerateContent?alt=sse`. Without
`alt=sse` Gemini returns a JSON array (one big response), which is **NOT**
streaming — the `alt=sse` query param forces SSE framing (`data: {json}\n\n`).

Each SSE chunk contains a partial Gemini response with `candidates[0].content.parts[0].text`
holding the delta text. The adapter:

1. Reads the response body as a `ReadableStream<Uint8Array>`.
2. Decodes with `TextDecoder({ stream: true })` to handle multi-byte UTF-8
   boundaries across chunks.
3. Splits the buffer on `\n\n` (SSE event separator).
4. For each event, walks its `data:` lines and calls `parseStreamChunk(line)`.
5. Yields a `DeltaChunk` per parsed line (OpenAI `chat.completion.chunk` shape).

Final usage-only chunks (no `candidates`, just `usageMetadata`) are silently
skipped — the gateway can compute approximate usage from the accumulated
content using `estimateTokens()` from `worker/src/utils/tokens.ts` if needed.

---

## 6. Auth

The adapter sends the API key via the **`x-goog-api-key` header** rather than
the `?key=` query parameter. Reasons:

- Query-string keys leak into server logs, browser referer headers, and CDN
  access logs — all bad for a secret.
- Header-based auth is consistent with how the gateway handles other providers
  (Authorization: Bearer for OpenAI / Mistral / Groq / OpenRouter).

If the gateway needs to support the `?key=` fallback (e.g. for a broken proxy
that strips custom headers), swap `getHeaders()` to add the key to the URL
instead — the rest of the adapter is unchanged.

---

## 7. Adapter Surface

The adapter implements the `ProviderAdapter` contract (8 methods) AND exposes
additional high-level I/O methods for direct use:

| Method | Source | Purpose |
|---|---|---|
| `provider` | contract | `'gemini'` identity |
| `getBaseUrl()` | contract | `https://generativelanguage.googleapis.com/v1beta` |
| `getChatCompletionsPath()` | contract | `/models` (Gemini uses per-model paths; prefer `buildChatUrl`) |
| `getSupportedModels()` | contract | curated static list of Flash / Flash-Lite / Pro models |
| `getHeaders(apiKey)` | contract | `x-goog-api-key` auth + JSON content-type |
| `formatRequest(req)` | contract | OpenAI → Gemini body translation |
| `parseResponse(raw)` | contract | Gemini → OpenAI chat.completion |
| `parseStreamChunk(chunk)` | contract | SSE line → DeltaChunk |
| `extractRateLimitInfo(headers)` | contract | returns empty / `retryAfter` only |
| `buildChatUrl(model)` | additive | `…:generateContent` endpoint |
| `buildStreamUrl(model)` | additive | `…:streamGenerateContent?alt=sse` endpoint |
| `chat(req, apiKey, fetchFn?)` | additive | non-streaming call (mockable) |
| `chatStream(req, apiKey, fetchFn?)` | additive | async generator of `DeltaChunk` |
| `listModels(apiKey, fetchFn?)` | additive | strips `models/` prefix |
| `healthCheck(apiKey, fetchFn?)` | additive | true iff `listModels` succeeds |

The `fetchFn` parameter on the I/O methods defaults to the global `fetch` and
is injectable so unit tests can mock the network without touching
`globalThis.fetch`.

---

## 8. Edge Compatibility

The adapter uses ONLY runtime globals available on Cloudflare Workers:

- `fetch`, `Response`, `Headers`, `ReadableStream`
- `TextDecoder`
- `JSON`, `Math`, `Date`, `parseInt`, `Number`

No Node-only imports (`fs`, `path`, `crypto`, `Buffer`, `process`). Safe to
deploy directly to a Worker.

---

## 9. Type Safety

The codebase enforces `strict: true` + `noImplicitAny: true`. The adapter
complies by:

- Using `unknown` for all untrusted external data (Gemini responses).
- Providing type guards: `isObject`, `asString`, `asNumber`, `asArray`.
- Never using `any`. The single `Record<string, unknown>` cast at the end of
  `formatRequest` is the bridge between the internal `GeminiRequestBody`
  shape and the `Record<string, unknown>` return type the `ProviderAdapter`
  contract requires.

---

## 10. Test Coverage

`gemini.test.ts` — 34 tests, all passing. Coverage:

- **formatRequest (8 tests):** user message, system message →
  `system_instruction`, multiple system messages merged, multi-turn role
  mapping (assistant → model), OpenAI tools → `functionDeclarations`,
  generationConfig mapping, assistant `tool_calls` → `functionCall` parts,
  tool-result messages → `functionResponse` parts.
- **parseResponse (6 tests):** text + STOP, MAX_TOKENS → length, SAFETY et al
  → content_filter, usageMetadata mapping, functionCall → tool_calls +
  finish_reason=tool_calls, empty candidates graceful degradation.
- **parseStreamChunk (6 tests):** `data: {json}` line, no-prefix line,
  `[DONE]`, empty/non-JSON lines, usage-only chunk skipped, functionCall
  delta mid-stream.
- **extractRateLimitInfo (2 tests):** empty when no headers, `retry-after`
  parsed on 429.
- **chat (mocked fetch, 4 tests):** POSTs to `:generateContent` with
  `x-goog-api-key`, 429 → `GeminiRateLimitError`, non-429 non-2xx →
  `GeminiApiError`, body is Gemini-shaped.
- **chatStream (mocked fetch, 2 tests):** yields ordered deltas, 429 →
  `GeminiRateLimitError`.
- **listModels / healthCheck (3 tests):** strips `models/` prefix,
  healthCheck true on success, false on failure.
- **identity & URL builders (4 tests):** provider id, base URL,
  `:generateContent` URL, `:streamGenerateContent?alt=sse` URL, fresh-class
  instantiation.

Run with:

```bash
cd worker && bunx vitest run src/gateway/adapters/gemini.test.ts
```

---

## 11. Known Limitations / Future Work

1. **No multimodal input.** OpenAI `image_url` content parts are not currently
   converted to Gemini `inlineData` parts. Add when the gateway needs vision.
2. **No `tool_choice` mapping.** Gemini supports `functionCallingConfig.mode`
   (`AUTO` / `ANY` / `NONE`); adapter currently drops `tool_choice`. Add if a
   caller needs forced tool selection.
3. **No response_format (JSON mode).** Gemini has `responseMimeType: 'application/json'`
   in `generationConfig`; not currently mapped from OpenAI's
   `response_format: { type: 'json_object' }`.
4. **No safety settings passthrough.** Gemini's `safetySettings` (per-category
   block thresholds) are not exposed. Defaults apply.
5. **Single-candidate only.** `parseResponse` reads `candidates[0]` only —
   Gemini's `n > 1` is not supported (OpenAI gateway callers don't use it).
6. **No internal ledger implementation.** This adapter is responsible only
   for the wire translation + 429 typing. The actual per-key request counter
   and circuit breaker live in the gateway layer (TBD by another task).
