# Workers AI Adapter

`worker/src/gateway/adapters/workersai.ts`

Cloudflare's native inference product, reached via the `env.AI` binding.
This adapter is **special** — it is the only one in the gateway that
bypasses HTTP `fetch()` for non-streaming inference, and it does NOT
extend [`BaseOpenAICompatibleAdapter`](./_base.ts).

Instead, it implements the [`ProviderAdapter`](./_types.ts) contract
directly, with `chat(req, env)` / `chatStream(req, env)` / `listModels(env)`
/ `healthCheck(env)` accepting an optional `env` parameter (typed as
`WorkersAIEnv`) for the binding + REST credentials.

---

## Wiring

| Env var | Required | Purpose |
|---|---|---|
| `AI` | yes | Workers AI binding. Configured in `wrangler.toml`. |
| `CF_ACCOUNT_ID` | yes* | Cloudflare account id. Required by the streaming REST path. |
| `CF_API_TOKEN` | yes* | API token with `Workers AI:Edit` scope. Required by streaming. |

\* Only required when calling `chatStream()` or `getHeaders()`. The
non-streaming `chat()` path uses the binding exclusively and needs
neither.

```toml
# wrangler.toml
[ai]
binding = "AI"
```

```bash
wrangler secret put CF_ACCOUNT_ID
wrangler secret put CF_API_TOKEN   # token must have Workers AI:Edit
```

---

## Why NOT extend `BaseOpenAICompatibleAdapter`?

1. **Non-streaming chat uses `env.AI.run()`** (a binding call), not
   `fetch()`. The base class's `fetchWithRetry` loop is useless here.
2. **The CF response shape** is `{ response }`, not OpenAI's
   `{ choices: [{ message: { content } }] }` — needs a custom
   `parseResponse()`.
3. **The CF SSE shape** is `data: {"response":"…"}`, not OpenAI's
   `data: {"choices":[{"delta":...}]}` — needs a custom
   `parseStreamChunk()` plus a `TransformStream` to re-shape frames
   on the fly.
4. **No `x-ratelimit-*` headers** on CF responses — rate-limit info is
   always an empty `RateLimitInfo`.

---

## `env.AI.run` (binding) vs REST API

The adapter uses **two different transport paths** depending on the
operation:

| Operation | Transport | Why |
|---|---|---|
| `chat()` | `env.AI.run(model, inputs)` | Binding handles auth + transport; no token needed; lower latency |
| `chatStream()` | `POST /accounts/{id}/ai/run/{model}?stream=true` | Binding's `stream:true` returns a `ReadableStream<Uint8Array>` of CF-shaped bytes that we'd have to re-shape anyway — the REST endpoint lets us read the SSE frames directly and emit OpenAI-shaped `ChatStreamChunk`s via a `TransformStream`. |
| `listModels()` | (none) | Returns a static curated list — Workers AI has no public `/models` endpoint via the binding. |
| `healthCheck()` | `env.AI.run(HEALTH_MODEL, …)` | Binding is the source of truth for "is AI up". |

The binding's `stream: true` overload *does* return a
`ReadableStream<Uint8Array>`, but the bytes inside are CF-shaped
(`data: {"response":"…"}`) — not OpenAI-shaped. Re-shaping them in the
gateway would require the same parser we already use for the REST path,
so we keep one code path: REST for streaming, binding for everything
else.

---

## Response shape conversion

Workers AI text-generation models return:

```json
{ "response": "Hello!", "usage": { "prompt_tokens": 3, "completion_tokens": 5, "total_tokens": 8 } }
```

`parseResponse(raw, requestedModel)` converts this to the OpenAI shape:

```json
{
  "id": "cfchat-1731216000000",
  "object": "chat.completion",
  "created": 1731216000,
  "model": "@cf/qwen/qwen2.5-coder-32b-instruct",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "Hello!" },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 3, "completion_tokens": 5, "total_tokens": 8 }
}
```

Workers AI is single-choice (no `n` parameter), so we always emit exactly
one choice with `finish_reason: "stop"`. Embedded `errors[]` (CF
sometimes returns HTTP 200 with errors in the body) are surfaced as a
thrown `ProviderError`.

### Streaming shape conversion (via `TransformStream`)

CF streams `data: {"response":"…"}` frames; OpenAI streams
`data: {"choices":[{"delta":{"content":"…"}}]}`. `chatStream()` pipes
the upstream body through a `TransformStream<Uint8Array, ChatStreamChunk>`
that:

1. Decodes bytes → text (`TextDecoder` with `stream: true`).
2. Buffers partial lines (so frames split across chunk boundaries are
   reassembled before parsing).
3. Calls `parseStreamChunk(line, ctx)` on each complete line — which
   returns a `ChatStreamChunk` or `null` (for `[DONE]`, comments,
   event: lines, unparseable JSON).
4. Enqueues non-null chunks to the readable side.

The async generator then pulls `ChatStreamChunk`s one at a time and
yields them. Backpressure is explicit: the upstream is only read when
the consumer pulls.

---

## Neuron accounting

Workers AI bills in **neurons**, not requests. The free tier is
**10,000 neurons/day, shared across the entire Cloudflare account**.

What this means in practice:

1. **No per-request rate-limit headers.** `extractRateLimitInfo()`
   returns a typed-but-empty `RateLimitInfo` (`{ provider: 'workersai', rawHeaders: {} }`).
   The gateway cannot throttle individual callers based on response
   headers — it must rely on binding-level exceptions (HTTP 5xx /
   `errors[]` in the response body).
2. **Shared budget.** A bursty user (or a runaway loop in any other
   Worker on the same account) can exhaust the daily neuron budget for
   everyone. Workers AI does not yet support per-binding quotas.
3. **No dashboard visibility on the response.** Neuron spend is
   visible in the Cloudflare dashboard under **AI → Analytics**, NOT on
   individual inference responses.
4. **The adapter surfaces exhaustion as a thrown error.** When Workers
   AI returns `{ errors: [{ code: 7003, message: "rate limited" }] }`,
   `parseResponse()` throws a `ProviderError` — the gateway should
   catch this and fall back to OpenRouter.

### Neuron cost reference (approximate, per request)

| Model | Neurons / 1k tokens |
|---|---|
| `@cf/qwen/qwen2.5-coder-7b-instruct` | ~1.3 |
| `@cf/meta/llama-3.1-8b-instruct` | ~1.3 |
| `@cf/qwen/qwen2.5-coder-14b-instruct` | ~2.6 |
| `@cf/qwen/qwen2.5-coder-32b-instruct` | ~5.9 |

A typical 4k-token chat round-trip on the 32B model ≈ 24 neurons →
~400 requests/day on the free tier before exhaustion.

---

## Why Workers AI is kept as a fallback (not the primary provider)

1. **Smaller model catalogue.** Only `@cf/*` models — no Anthropic, no
   GPT, no Gemini. OpenRouter's free tier already covers Qwen, Llama,
   Mistral, and Phi at similar quality.
2. **Shared neuron budget.** A single misbehaving caller can starve the
   entire account; OpenRouter's 50/day cap is per-key and thus isolated.
3. **No per-request rate-limit info.** The gateway cannot gracefully
   degrade per-user — it can only fail-closed at the binding level.
4. **But:** Workers AI is **free**, **lower-latency** (no egress to a
   third party), and **region-local**. When OpenRouter is rate-limited
   or when a user specifically asks for a Qwen2.5-Coder model (where CF
   is fastest), Workers AI is the right choice. Hence: keep as fallback.

---

## Supported models

Defined in `WORKERSAI_MODELS` (exported from the module). The adapter
does NOT reject unknown `@cf/*` ids — it passes them straight to
`env.AI.run()` so newly released models work without an adapter release.
The set is documentation + `listModels()` surface only.

```
@cf/qwen/qwen2.5-coder-32b-instruct
@cf/qwen/qwen2.5-coder-14b-instruct
@cf/qwen/qwen2.5-coder-7b-instruct
@cf/meta/llama-3.1-8b-instruct
```

Health check probes `@cf/qwen/qwen2.5-coder-7b-instruct` (cheapest,
fastest) with `max_tokens: 1` and a 5s `AbortController` timeout.

---

## API shape cheat-sheet

| Direction | Shape |
|---|---|
| Request (in/out) | OpenAI `chat.completions` body, passed through unchanged |
| Response (provider) | `{ response, usage }` |
| Response (adapter) | OpenAI `chat.completion` (single choice) |
| Stream (provider) | `data: {"response":"…"}` + `data: [DONE]` |
| Stream (adapter) | OpenAI-shaped `chat.completion.chunk` (via TransformStream) |
| Rate-limit | none — neuron accounting is account-level |

---

## Singleton

The module exports a singleton with no env bound at module-load time.
Callers pass `env` to each I/O method:

```ts
import { workersaiAdapter } from './adapters/workersai';

// Shape access (no env needed):
workersaiAdapter.PROVIDER_ID;           // 'workersai'
workersaiAdapter.formatRequest(req);    // pass-through
workersaiAdapter.parseResponse(raw, 'm');

// Real I/O (env required):
await workersaiAdapter.chat(req, env);
for await (const chunk of workersaiAdapter.chatStream(req, env)) { ... }
await workersaiAdapter.listModels(env);
const health = await workersaiAdapter.healthCheck(env);
```

---

## Files

```
worker/src/gateway/adapters/
├── workersai.ts                          # adapter (398 LOC, edge-compatible)
├── __tests__/workersai.test.ts          # 35 unit tests (mocked env.AI + mocked fetch)
└── README_workersai.md                   # this file
```
