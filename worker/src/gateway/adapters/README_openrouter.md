# OpenRouter Adapter

`worker/src/gateway/adapters/openrouter.ts`

OpenRouter is an OpenAI-compatible aggregator: a single Bearer token
routes to ~200 models from Anthropic, Google, Meta, Mistral, Qwen, etc.
Free-tier models are suffixed `:free` and share a 50 req/day budget
across the entire account (no credit card required).

This adapter follows the **Agent A10 pattern**: it extends the shared
[`BaseOpenAICompatibleAdapter`](./_base.ts) so it inherits the standard
fetch-retry-stream-parse lifecycle. Only the OpenRouter-specific quirks
are overridden (see "Hook overrides" below).

---

## Wiring

| Env var | Required | Purpose |
|---|---|---|
| `OPENROUTER_KEY` | yes | Bearer token. Set as a Workers secret. |

```bash
wrangler secret put OPENROUTER_KEY
```

The adapter also sends `X-Title: Micky Assistant` and
`HTTP-Referer: https://micky-assistant.workers.dev` on every request.
Both are overridable via the constructor:

```ts
import { OpenRouterAdapter, createOpenRouterAdapter } from './adapters/openrouter';

// Production: factory resolves the key from env and throws if missing.
const adapter = createOpenRouterAdapter(env);

// Or construct directly:
const custom = new OpenRouterAdapter('sk-...', {
  referer: 'https://your-app.example',
  title: 'Your App Name',
  freeModels: new Set(['your-org/your-model']),  // replaces default list
});
```

---

## Hook overrides (vs. the base class)

| Hook | Override reason |
|---|---|
| `PROVIDER_ID` | `'openrouter'` (added to `ProviderId` union in `_types.ts`) |
| `getBaseUrl()` | `'https://openrouter.ai/api/v1'` |
| `mutateRequest(req)` | Auto-append `:free` when the bare model id is in the curated free list AND the caller hasn't already specified a `:` qualifier |
| `getHeaders(apiKey?)` | Emit `HTTP-Referer` + `X-Title` in addition to Bearer auth; accepts an explicit `apiKey` arg (falls back to the constructor-captured key when called bare) |
| `mutateRawResponse(raw)` | Detach `usage.cost` (USD) into a private `__or_cost` marker so the base parser sees a clean OpenAI shape |
| `parseResponse(raw, model)` | Lift the `__or_cost` marker onto `provider_meta.cost` after delegating to the base parser |
| `rateLimitHeaderMap()` | Map OpenRouter's older single-token headers (`x-ratelimit-limit`, `-remaining`, `-reset`, `-reset-timestamp`) to the canonical `RateLimitInfo` fields |

Inherited behaviour from the base class (no override needed):
- **Retry**: 1 initial + 2 retries with exponential backoff on 5xx and 429
- **Error classes**: `ProviderError` / `RateLimitError` / `NetworkError`
- **SSE streaming**: line-buffered `data: <json>\n\n` parser → normalized `ChatStreamChunk`s
- **Health check**: `GET /models` with 5s `AbortController` timeout
- **`listModels` fallback**: returns the static curated list if `/models` 5xx's

---

## Free models list

OpenRouter marks free-tier models with the `:free` suffix, e.g.
`meta-llama/llama-3.1-8b-instruct:free`. The adapter ships a curated
default set in `OPENROUTER_FREE_MODELS` and `mutateRequest()` will
auto-append `:free` to any incoming model id whose bare form is in the
set (unless the caller already specified a `:` qualifier).

Curated list (verified free at time of writing — re-check quarterly):

```
meta-llama/llama-3.1-8b-instruct
meta-llama/llama-3.1-70b-instruct
meta-llama/llama-3.3-70b-instruct
google/gemini-flash-1.5
google/gemini-flash-1.5-8b
qwen/qwen-2-7b-instruct
qwen/qwen-2.5-7b-instruct
qwen/qwen-2.5-coder-7b-instruct
mistralai/mistral-7b-instruct
mistralai/mistral-nemo
mistralai/mistral-7b-instruct-v0.3
microsoft/phi-3-medium-128k-instruct
microsoft/phi-3-mini-128k-instruct
microsoft/phi-3.5-mini-128k-instruct
huggingfaceh4/zephyr-7b-beta
openchat/openchat-7b
gryphe/tomy-8b
nousresearch/hermes-2-theta-llama-3-8b
teknium/openhermes-2.5-mistral-7b
cognitivecomputations/dolphin-mistral-7b
undichat/undichat-7b
sao10k/l3-euryale-70b
sophosympatheia/rogue-rose-103b-v0.2
alpindale/goliath-120b
```

Paid-only models (`anthropic/claude-3.5-sonnet`, `openai/gpt-4o`, …)
are passed through untouched.

---

## Free-tier daily limit tracking

OpenRouter exposes the free-tier budget in response headers:

| Header | Meaning |
|---|---|
| `x-ratelimit-limit` | Daily cap (50 for free models, no card). |
| `x-ratelimit-remaining` | Requests remaining in the window. |
| `x-ratelimit-reset` | Epoch seconds until the window resets. |
| `x-ratelimit-reset-timestamp` | Alias for the above (some models). |
| `x-or-cost-usd` | USD cost of the request (mirrors `usage.cost`). |

`extractRateLimitInfo(headers)` (inherited from the base class, with
OpenRouter's older single-token headers mapped via
`rateLimitHeaderMap()`) returns a typed `RateLimitInfo` object plus a
`rawHeaders` snapshot for the dashboard. The gateway should persist
`remaining` after each request and short-circuit to the Workers AI
fallback when it hits zero — continuing to call OpenRouter after the
limit returns HTTP 429 and burns the daily quota.

> ⚠️ The 50 req/day free budget is **shared across the entire
> account**, not per-user. A BYOK setup where each user supplies their
> own `OPENROUTER_KEY` sidesteps this; a shared-key deployment must
> enforce per-user throttling in front of the gateway.

OpenRouter also echoes the USD cost of each request in the response body
(`usage.cost` field, sometimes surfaced as a top-level `cost`).
`parseResponse()` lifts this into `provider_meta.cost` on the
normalized `ChatResponse` so the gateway can record spend telemetry
without losing the OpenAI response shape.

---

## Why the `HTTP-Referer` and `X-Title` headers matter

1. **Dashboard attribution.** OpenRouter groups request volume by
   `HTTP-Referer`. Apps without a stable Referer are bucketed as
   "Unknown" and are harder to debug.
2. **Leaderboard ranking.** Apps that send a stable Referer + X-Title
   are eligible for OpenRouter's public app leaderboard (free
   marketing).
3. **Deprioritisation under load.** During capacity crunches OpenRouter
   has historically throttled anonymous traffic first.

---

## Singleton + factory

The module exports both a singleton (no API key) and a factory:

```ts
import { openrouterAdapter, createOpenRouterAdapter, OpenRouterAdapter } from './adapters/openrouter';

// Singleton — useful for accessing shape helpers (formatRequest,
// parseResponse, mutateRequest, etc.) without a key bound at
// module-load time. Calling getHeaders() bare throws.
openrouterAdapter.PROVIDER_ID;  // 'openrouter'
openrouterAdapter.formatRequest({ model: 'meta-llama/llama-3.1-8b-instruct', messages: [] });

// Factory — the recommended way to construct a wired adapter for real I/O.
const adapter = createOpenRouterAdapter(env);
await adapter.chat({ model: '...', messages: [...] });
```

---

## API shape cheat-sheet

| Direction | Shape |
|---|---|
| Request (in) | OpenAI `chat.completions` body |
| Request (out) | Same, with `model` rewritten to `…:free` when applicable |
| Response | OpenAI + `usage.cost` (USD) → `provider_meta.cost` |
| Stream | OpenAI SSE: `data: {choices:[{delta:{content}}]}` + `data: [DONE]` |
| Rate-limit | `x-ratelimit-*` headers (mapped to canonical `RateLimitInfo`) |

---

## Files

```
worker/src/gateway/adapters/
├── openrouter.ts                          # adapter (305 LOC, edge-compatible)
├── __tests__/openrouter.test.ts           # 26 pure unit tests (mocked fetch)
└── README_openrouter.md                   # this file
```
