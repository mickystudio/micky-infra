# Mistral Adapter — `worker/src/gateway/adapters/mistral.ts`

Provider adapter for **Mistral AI** (`https://api.mistral.ai/v1`).

Mistral is the easiest non-OpenAI provider to integrate: its `/chat/completions`
endpoint is **~95% OpenAI-compatible** (request shape, response shape, SSE
streaming, tool calling). The handful of quirks are documented below so the
gateway can route around them.

---

## 1. OpenAI Compatibility — ~95%

| Feature | OpenAI shape | Mistral | Notes |
|---|---|---|---|
| `POST /chat/completions` body | ✓ | ✓ | Same fields, with extras below |
| `messages[].role` | system/user/assistant/tool | ✓ | Old models reject `system` at pos 0 (see §2) |
| `messages[].content` | string \| array | ✓ | Vision supported on `pixtral-*` only |
| `temperature`, `top_p`, `max_tokens` | ✓ | ✓ | |
| `stream: true` → SSE | ✓ | ✓ | Same `data: {...}` / `data: [DONE]` format |
| `tools` / `tool_choice` | ✓ | ✓ | Some old models 400 — see `warnings` |
| `response_format: { type: 'json_object' }` | ✓ | ✓ | |
| `n` (multiple completions) | ✓ | ✗ | Mistral errors if `n > 1` |
| `logprobs` | ✓ | ✗ | Not supported |
| `user` (end-user id) | ✓ | ✗ | Not supported |

**Adapter behavior:** we pass through the OpenAI-shaped request body and only
forward the optional params that are actually set — Mistral is strict and
**400s on unknown fields**, unlike OpenAI which silently ignores them.

---

## 2. The System-Message Quirk (Old Models)

`open-mixtral-8x7b` and `open-mistral-7b` were trained before Mistral added
first-class support for `role: "system"`. Sending a `system` message as the
first message **returns a 400** from Mistral.

**Adapter fix:** for these two models, `formatRequest` folds the leading
system message into the start of the first user message, separated by a blank
line:

```
// Input (ChatRequest)
[
  { role: "system",    content: "Be concise." },
  { role: "user",      content: "Hi" },
]

// Output (Mistral wire shape, old model)
[
  { role: "user",      content: "Be concise.\n\nHi" },
]
```

Models that DO support `system` natively (and are passed through unchanged):
- `mistral-large-latest`
- `mistral-small-latest`
- `open-mixtral-8x22b`
- `codestral-latest`
- `pixtral-large-latest` / `pixtral-12b-2409`

The old-model set is hard-coded in `mistral.ts` (`OLD_MODELS_WITHOUT_SYSTEM_ROLE`).
If Mistral deprecates these or expands the list, update the `Set`.

**Edge cases handled:**
- No system message → no-op.
- System message + no following user message → drop the system message
  silently (the user content was empty anyway).
- System message + first user message has **structured vision content**
  (array of parts) → prepend a `{type: "text", text: <system>}` part to the
  array rather than coercing to a string.

---

## 3. The `safe_prompt` Parameter

Mistral offers an optional `safe_prompt: boolean` field on every chat
request. When `true`, Mistral runs an additional moderation layer over both
the prompt and the completion — it can rewrite or refuse borderline content.

**Adapter behavior:**
- `req.safe_prompt === true` → forward `safe_prompt: true`.
- `req.safe_prompt === false` → forward `safe_prompt: false`.
- `req.safe_prompt` is unset → **default to `false`**.

We default to `false` to match the Mistral cookbook recommendation ("set
`safe_prompt` only when you explicitly need moderation"). Moderation rewrites
silently change completion content, which is rarely what the gateway wants.

The `ChatRequest.safe_prompt` field is a Mistral-specific extension on the
shared `ChatRequest` type (declared in `adapters/types.ts`); other providers
will simply ignore it because the gateway's request normalizer strips unknown
provider-specific fields before calling their adapter.

---

## 4. The `warnings` Field

Mistral returns an optional `warnings: Array<{ type, message }>` on the
response body when **request params were silently ignored** (e.g. `tool_choice`
sent to a model that doesn't support tools, or `response_format: json_object`
sent to a model that doesn't support JSON mode).

**Adapter behavior:** `parseResponse` captures this field into the normalized
`ChatResponse.warnings` array. Downstream consumers (the gateway router, the
UI, the alert pipeline) can read it to log/notify that the request was
silently degraded.

---

## 5. Streaming

Mistral uses standard OpenAI SSE format. The adapter's `parseStreamChunk`
handles:

- `data: {...json...}\n\n` → parse to `DeltaChunk`.
- `data: [DONE]\n\n` → return `{ done: true, choices: [{...finish_reason: "stop"}] }`.
- `: keep-alive\n\n` → return `null` (skip).
- Empty / whitespace-only → return `null`.
- Malformed JSON → return `null` (resilient — does not throw).
- Multiple `data:` lines in one chunk → return the **first** parseable delta.
- Both `\n` and `\r\n` line endings.

This is identical to the Groq / OpenAI SSE parser ("same as Groq" per the
adapter spec) — they all share the same wire shape for streaming.

---

## 6. Rate-Limit Headers

Mistral returns (on most responses, but not always — best-effort):

| Header | Meaning |
|---|---|
| `x-ratelimit-remaining-requests` | Requests remaining in current window |
| `x-ratelimit-remaining-tokens` | Tokens remaining in current window |
| `x-ratelimit-limit-requests` | Total requests allowed per window |
| `x-ratelimit-limit-tokens` | Total tokens allowed per window |
| `x-ratelimit-reset-requests` | Time until request-window resets (e.g. `"8s"`) |
| `x-ratelimit-reset-tokens` | Time until token-window resets |
| `retry-after` | Seconds until retry (on **429** only) |

**Adapter behavior:** `extractRateLimitInfo(headers)` reads all of the above
best-effort, returns them in a `RateLimitInfo` object, plus a `raw` snapshot
of the headers that were actually present (for debugging).

**429 handling:** when Mistral returns 429, the gateway layer (NOT the
adapter — the adapter is pure) should:
1. Read `extractRateLimitInfo(response.headers)` — `retryAfter` will be set.
2. Wait `retryAfter` seconds (or back off exponentially if `retry-after` is
   missing).
3. Retry, OR fail over to the next provider in the cascade.

The mocked-fetch test in `mistral.test.ts` demonstrates this end-to-end: it
mocks a 429 response with `retry-after: 45` and verifies the adapter extracts
`retryAfter === 45`, `requestsRemaining === 0`, and `resetRequestsIn === "45s"`.

---

## 7. Free Tier — Monthly Recurring Quota (NOT daily!)

Mistral's free tier is structurally **different** from Groq / Together /
Cerebras, which all reset daily.

| Tier | Limit | Reset cadence | Credit card required? |
|---|---|---|---|
| **Free (La Plateforme)** | ~1,000,000 tokens / month | **Monthly** (calendar month, UTC) | ❌ No |

### Why this matters for the gateway ledger

The rate-limit ledger (see `gateway/ledger/`) was originally designed around
**daily** provider quotas (one row per `(provider, day)`). Mistral breaks
that assumption:

- A daily key (`mistral:2026-11-10`) is the wrong granularity — Mistral's
  limit is monthly.
- The correct key is `(provider, month)` — e.g. `mistral:2026-11`.

### Adapter's role

The adapter **does not** manage quota accounting — it just exposes the
provider's own rate-limit headers via `extractRateLimitInfo`. The gateway's
ledger layer is responsible for:

1. Detecting that this provider is Mistral (via `adapter.provider === 'mistral'`).
2. Using a **monthly** key (`provider:YYYY-MM`) instead of the daily key.
3. Tracking both `tokensUsed` and `requestsUsed` separately (Mistral's free
   tier reports token usage, not request count, as the binding constraint).
4. Resetting the counter on the 1st of each month UTC, NOT at midnight.

### Fallback when Mistral headers are absent

Mistral does **not** always return `x-ratelimit-*` headers (especially on
non-429 responses). When they are absent, the ledger must count tokens
client-side by summing `usage.total_tokens` from each response. The
`ChatResponse.usage` field is captured by `parseResponse` for exactly this
reason.

---

## 8. Public API

```typescript
import { MistralAdapter, mistralAdapter } from '@/gateway/adapters/mistral';

// Singleton (the adapter is stateless).
const adapter = mistralAdapter;

// Or construct fresh:
const a = new MistralAdapter();
```

| Method | Returns | Notes |
|---|---|---|
| `provider` | `'mistral'` | Identity |
| `getBaseUrl()` | `'https://api.mistral.ai/v1'` | |
| `getChatCompletionsPath()` | `'/chat/completions'` | |
| `getSupportedModels()` | `readonly string[]` | 6 models |
| `getHeaders(apiKey)` | `HeadersInit` | Bearer + JSON content-type |
| `formatRequest(req)` | `Record<string, unknown>` | Pure; system-fold for old models; `safe_prompt` default false |
| `parseResponse(raw)` | `ChatResponse` | Captures `warnings` if present |
| `parseStreamChunk(chunk)` | `DeltaChunk \| null` | OpenAI SSE shape |
| `extractRateLimitInfo(headers)` | `RateLimitInfo` | Best-effort; reads `retry-after` on 429 |

---

## 9. Supported Models (as advertised by this adapter)

| Model ID | Family | Notes |
|---|---|---|
| `mistral-large-latest` | Mistral Large | Flagship; full system-role + tools |
| `mistral-small-latest` | Mistral Small | Fast / cheap; full system-role + tools |
| `open-mixtral-8x7b` | Mixtral 8x7B (open) | **Old** — system-fold applied |
| `open-mixtral-8x22b` | Mixtral 8x22B (open) | Newer — system-role OK |
| `open-mistral-7b` | Mistral 7B (open) | **Old** — system-fold applied |
| `codestral-latest` | Codestral | Code-tuned; tool calling supported |

Mistral also publishes `pixtral-*` (vision), `mistral-embed`, and `mistral-moderation-latest`,
which this adapter does **not** cover. Add them to `SUPPORTED_MODELS` when needed.

---

## 10. Running the Tests

```bash
cd worker
bunx vitest run src/gateway/adapters/mistral.test.ts
```

Test count: **30**. Coverage:

- Identity & wiring (3)
- `formatRequest` system-message handling for old vs new models (10)
- `parseStreamChunk` SSE parsing (6)
- `parseResponse` warning capture (4)
- `extractRateLimitInfo` including 429 `retry-after` (5)
- Mocked-fetch end-to-end (200 + 429) (2)

---

## 11. Edge-Compatibility

The adapter imports only from the shared `adapters/types.ts` and uses only
Web-standard APIs available on the Cloudflare Workers runtime:

- `Headers` (Web API; no `node:http`)
- `HeadersInit` (Web API)
- No `fs`, `path`, `stream`, `crypto`, `net`, or other Node-only modules.

`fetch`, `AbortController`, `setTimeout`, `TextEncoder/Decoder`, and
`ReadableStream` (used by the gateway layer that wraps this adapter) are all
part of the Workers runtime — verified against
`@cloudflare/workers-types@^4.20241101.0`.

---

## 12. See Also

- `adapters/types.ts` — shared types & the `ProviderAdapter` interface.
- `adapters/mistral.test.ts` — vitest suite.
- `gateway/ledger/ledger.ts` — quota ledger; **must** use monthly keys for
  Mistral (see §7).
- `gateway/cascade_types.ts` — fallback chain definitions.
- `docs/llm-gateway-research.md` — provider selection rationale.
