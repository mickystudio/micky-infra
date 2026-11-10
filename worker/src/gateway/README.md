# Micky Assistant — Multi-Provider LLM Gateway

A multi-provider LLM cascade for the Micky Assistant Cloudflare Worker.
Routes OpenAI-compatible `/v1/chat/completions` requests across **11
providers** with automatic failover, rate-limit tracking, and circuit
breaking — all running in the Worker runtime (no external sidecar).

**Task A1-retry** — created 2026-11-10. Replaces the earlier A1 scaffold
with a leaner design: a single canonical types file, a registry that
imports the 11 adapter instances built by sibling agents, and an inline
cascade router (`routeChat`).

---

## Architecture overview

```
                ┌──────────────────────────────────────────┐
                │          POST /v1/chat/completions      │
                │              (in worker/src/index.ts)   │
                │  ─ verify BYOK api key (D1 api_keys)    │
                │  ─ check per-key daily rate limit (KV)  │
                └────────────────────┬─────────────────────┘
                                     │
                                     ▼
            ┌────────────────────────────────────────────────┐
            │          gateway.routeChat(req, env, ctx)    │  ← src/gateway/index.ts
            │  ─ validate request (messages, roles)        │
            │  ─ detect intent (chat / code / vision /     │
            │    tools / fast / long_context / arabic /     │
            │    reasoning)                                 │
            │  ─ for each provider in the intent cascade:  │
            │       ─ skip if not configured (key/binding)  │
            │       ─ adapter.chat(req, env) or             │
            │         adapter.chatStream(req, env)          │
            │       ─ on success → 200 JSON or SSE          │
            │       ─ on 429/5xx → record + try next      │
            │  ─ all fail → 502 with attempted list        │
            └────────────┬───────────────────┬──────────────┘
                         │                   │
              ┌──────────▼─────┐   ┌─────────▼──────────┐
              │   registry     │   │  adapters/          │
              │  ─ PROVIDERS   │   │  ─ groq.ts          │
              │    × 11        │   │  ─ gemini.ts        │
              │  ─ getProvider │   │  ─ mistral.ts       │
              │  ─ listProviders│  │  ─ openrouter.ts    │
              │  ─ getHealthy  │   │  ─ workersai.ts     │
              └──────┬─────────┘   │  ─ sambanova.ts     │
                     │             │  ─ cohere.ts        │
                     │             │  ─ siliconflow.ts   │
                     │             │  ─ cerebras.ts      │
                     │             │  ─ novita.ts        │
                     │             │  ─ _base.ts          │
                     │             └─────────┬──────────┘
                     │                       │ fetch() or env.AI.run()
                     │  read / write (best-effort, D1)
                     ▼
              ┌──────────────────────────────────────────┐
              │  D1: provider_quotas (ledger/schema.sql) │
              │  ─ remaining_rpd / remaining_tpd         │
              │  ─ consecutive_failures / circuit_open  │
              │  ─ is_healthy                             │
              │  + provider_calls (audit log)            │
              │  + provider_feedback (thumbs up/down)   │
              └──────────────────────────────────────────┘
```

### Request flow (concrete example)

1. Client sends `POST /v1/chat/completions` with
   `{ messages, stream: true, tools: [...] }`.
2. `handleChatCompletions` in `src/index.ts` verifies the BYOK API key in
   D1, checks the per-key rate limit in KV.
3. On success, it delegates to `gateway.routeChat(body, env, ctx)`.
4. `routeChat` validates the body, classifies the intent via
   `utils/intent_classifier.classifyIntent` → `'tool_calling'`.
5. The intent's cascade is `[groq1, groq2, mistral, openrouter, gemini,
   sambanova, siliconflow, workersai, cerebras, cohere, novita]`
   (per-intent cascade table lives in `utils/intent_classifier.ts`).
6. The cascade is filtered by `isProviderConfigured(id, env)` — drops any
   provider whose API key isn't set.
7. Try `groq1` first. If it returns 429 → record failure in D1 ledger,
   try `groq2`. If `groq2` returns success → record success, return SSE
   stream.
8. Custom response headers `X-Provider: groq2`, `X-Fallback-Used: true`
   tell the client what happened.

---

## Files in this directory

| File | Owner | Purpose |
|---|---|---|
| `types.ts` | A1-retry | **Canonical type import path.** Re-exports the OpenAI-compatible shape types (`ChatRequest`, `ChatResponse`, `DeltaChunk`, …) from `./adapters/types.ts`, defines the 11-provider `ProviderId` union, `ProviderKeys` + `GatewayEnv`, and the runtime `ProviderAdapter` interface (what the registry stores + what `routeChat` calls). |
| `registry.ts` | A1-retry | Imports all 11 adapter instances / factories from `./adapters/`, wraps each in a uniform runtime handle, exposes `PROVIDERS`, `getProvider`, `listProviders`, `isProviderConfigured`, `getHealthyProviders`. |
| `index.ts` | A1-retry | The public entry point: `routeChat(req, env, ctx)`, `routeChatStream(req, env, ctx)`, `handleProviderFeedback(messageId, rating, env)`. Inline cascade (no separate model_router dependency). |
| `README.md` | A1-retry | This file. |
| `adapters/types.ts` | A2/A3 | OpenAI-compatible shape types + the SHAPE `ProviderAdapter` interface (no `chat()` method). Re-exported via `types.ts`. |
| `adapters/_base.ts` | A10 | `BaseOpenAICompatibleAdapter` — shared base for OpenRouter / SambaNova / Cohere / SiliconFlow / Cerebras / Novita. Handles fetch-retry-stream-parse with per-adapter quirks via hook points (`mutateRequest`, `rateLimitHeaderMap`, …). |
| `adapters/_types.ts` | A10 | Self-contained type set for the 5 new OpenAI-compat providers (`ProviderError`, `RateLimitError`, `NetworkError`, `HealthStatus`, `ModelInfo`, …). |
| `adapters/groq.ts` | A3 | `GroqAdapter` — multi-account Groq adapter. Exports `groq1Adapter`, `groq2Adapter` singletons. |
| `adapters/gemini.ts` | A4 | `GeminiAdapter` — native Google API (system_instruction / parts). Exports `geminiAdapter` singleton. |
| `adapters/mistral.ts` | A2/A3 | `MistralAdapter` — shape-only (formatRequest/parseResponse/parseStreamChunk). Exports `mistralAdapter` singleton. The registry's `MistralHandle` does the fetch itself. |
| `adapters/openrouter.ts` | A6 | `OpenRouterAdapter extends BaseOpenAICompatibleAdapter`. Free-model aggregator with `:free` suffix routing. Factory `createOpenRouterAdapter(env)`. |
| `adapters/workersai.ts` | A6 | `WorkersAIAdapter` — binding-based (calls `env.AI.run()` for non-stream, REST endpoint for stream). Exports `workersaiAdapter` singleton. |
| `adapters/sambanova.ts` | A10 | `SambaNovaAdapter extends BaseOpenAICompatibleAdapter`. Per-model rate-limit quirk. Factory `createSambaNovaAdapter(env)`. |
| `adapters/cohere.ts` | A10 | `CohereAdapter extends BaseOpenAICompatibleAdapter`. Monthly quota (not daily). Factory `createCohereAdapter(env)`. |
| `adapters/siliconflow.ts` | A10 | `SiliconFlowAdapter extends BaseOpenAICompatibleAdapter`. Factory `createSiliconFlowAdapter(env)`. |
| `adapters/cerebras.ts` | A10 | `CerebrasAdapter extends BaseOpenAICompatibleAdapter`. Wafer-scale inference. Factory `createCerebrasAdapter(env)`. |
| `adapters/novita.ts` | A10 | `NovitaAdapter extends BaseOpenAICompatibleAdapter`. Per-model base-URL overrides. Factory `createNovitaAdapter(env)`. |
| `utils/types.ts` | A7 | Self-contained types for the token counter + intent classifier. Has its own `ProviderId` union (same 11 ids — kept in sync with `types.ts`). |
| `utils/token_counter.ts` | A7 | Heuristic token estimator (no tiktoken WASM). Script-ratio-weighted; ±20% accuracy. |
| `utils/intent_classifier.ts` | A7 | `classifyIntent(req)` → one of 7 intents. `getCascadeForIntent(intent)` → ordered provider list. `pickBestModel(intent, provider)` → best model id. |
| `ledger/ledger.ts` | A2 | `QuotaLedger` — D1-backed atomic quota tracking. `decrementQuota`, `record429`, `recordCall`, `recordFeedback`, `getHealthyProviders`, `resetDailyQuotas`. |
| `ledger/schema.sql` | A2 | D1 schema for `provider_quotas`, `provider_calls`, `provider_feedback`, `conversation_provider_sticky`. |
| `health_checker.ts` | A9 | `HealthChecker` — cron-driven background probes (every 30 min). Updates `provider_quotas.is_healthy` + circuit breaker. |
| `monitoring.ts` | A9 | `ProviderMonitor` — read-only dashboard queries. `getDashboardData(env)`, `getProviderHistory`, `getCascadeAnalytics`. |
| `alerts.ts` | A9 | `AlertManager` — Telegram alerts to `ADMIN_CHAT_ID` on provider down / circuit open / all-providers-down. |
| `metrics.ts` | A9 | `recordMetric(env, event)` — append-only event log to `provider_calls`. 6 event types. |
| `cron_handler.ts` | A9 | `dispatchGatewayCron(cron, env, ctx)` — maps CF cron triggers to `runHealthCheckCron` / `resetDailyQuotas`. |

### Legacy files (kept for sibling-agent compatibility — NOT used by A1-retry)

| File | Owner | Status |
|---|---|---|
| `model_router.ts` | A1 (earlier attempt) | Earlier cascade router with a different `ProviderAdapter` interface (`chat(req, env, ctx) => ChatResult`). NOT imported by A1-retry's `index.ts` (we use an inline cascade). Sibling agent A8 is rebuilding this; once it lands, `routeChat` can delegate to it. |
| `provider_adapters.ts` | A1 (earlier attempt) | Earlier `OpenAICompatibleAdapter` + `WorkersAIAdapter` classes (different shape contract). NOT imported by A1-retry. |
| `cascade_types.ts` | A8 | Cascade-layer types with the 5-provider `ProviderId` union (`workers-ai` | `groq` | `mistral` | `openrouter` | `gemini`). Used by A9's monitoring layer. |
| `cascade_router.ts` | A8 | Alternate cascade router implementation. NOT used by A1-retry. |
| `workersai_adapter.ts` | A1 (earlier attempt) | Earlier WorkersAI adapter. Superseded by `adapters/workersai.ts`. |
| `router_helpers.ts`, `error_handler.ts`, `sse_normalizer.ts` | A8 | Helpers for the cascade_router; not used by A1-retry's inline cascade. |

---

## How to add a new provider (5 steps)

### Step 1 — Add the id to the `ProviderId` union

In `types.ts`:

```typescript
export type ProviderId =
  | 'groq1' | 'groq2' | 'gemini' | 'mistral' | 'openrouter' | 'workersai'
  | 'sambanova' | 'cohere' | 'siliconflow' | 'cerebras' | 'novita'
  | 'yournewprovider';   // ← add this
```

Also update `isProviderId()` and `PROVIDER_LABELS`.

### Step 2 — Add the API key to `ProviderKeys`

In `types.ts`:

```typescript
export interface ProviderKeys {
  // … existing 10 keys …
  YOURNEWPROVIDER_KEY: string;   // ← add this
}
```

Update `Env` in `src/index.ts` to declare the new key (required string).

### Step 3 — Build the adapter (or import one)

If the provider is OpenAI-compatible (most are), the easiest path is to
subclass `BaseOpenAICompatibleAdapter` in
`adapters/yournewprovider.ts`:

```typescript
import { BaseOpenAICompatibleAdapter } from './_base';
import type { ModelInfo, ProviderId } from './_types';

export const YOUR_BASE_URL = 'https://api.yournewprovider.com/v1';
export const YOUR_KEY_ENV = 'YOURNEWPROVIDER_KEY';
export const YOUR_DEFAULT_MODEL = 'your-model-1';
export const YOUR_MODELS: ModelInfo[] = [ /* … */ ];

export class YourNewProviderAdapter extends BaseOpenAICompatibleAdapter {
  readonly PROVIDER_ID: ProviderId = 'yournewprovider';
  constructor(apiKey: string) {
    super({ apiKey, baseUrl: YOUR_BASE_URL,
      defaultModel: YOUR_DEFAULT_MODEL, staticModels: YOUR_MODELS });
  }
  // Override mutateRequest / rateLimitHeaderMap if the provider has quirks.
}

export function createYourNewProviderAdapter(env: Record<string, unknown>) {
  const key = env[YOUR_KEY_ENV];
  if (typeof key !== 'string' || key.length === 0)
    throw new Error(`${YOUR_KEY_ENV} not configured`);
  return new YourNewProviderAdapter(key);
}
```

If the provider needs a fundamentally different transport (e.g. a binding
like WorkersAI, or a non-OpenAI API like native Gemini), implement the
SHAPE `ProviderAdapter` interface from `adapters/types.ts` directly +
ship your own `chat` / `chatStream` / `healthCheck` methods (Groq,
Mistral, Gemini, WorkersAI all do this).

### Step 4 — Register the adapter in `registry.ts`

Add a row to `HANDLES`:

```typescript
yournewprovider: new BaseCompatHandle(
  'yournewprovider', 'Your New Provider', 'YOURNEWPROVIDER_KEY',
  YourNewProviderAdapter as unknown as BaseCompatCtor,
),
```

Or, if you wrote a custom adapter with its own chat signature, add a new
`Handle` class (see `GroqHandle` / `GeminiHandle` / `MistralHandle` /
`WorkersAIHandle` for templates) and add it to `HANDLES`.

### Step 5 — Add the provider to the cascades

In `utils/intent_classifier.ts`, edit the `CASCADES` table to include
your provider in the intents where it makes sense (e.g. a coding-focused
provider goes in the `code` cascade). Also add a row to `BEST_MODEL` for
each (intent, provider) pair where you want a non-default model.

Set the API key:

```bash
wrangler secret put YOURNEWPROVIDER_KEY
```

That's it — the gateway will start routing to your provider on the next
deploy.

---

## Environment variables required

The 10 provider API keys (all required strings — missing/empty values
are treated as "provider unconfigured" and the provider is skipped in
the cascade):

| Env var | Provider | How to set |
|---|---|---|
| `GROQ_KEY_1` | groq1 | `wrangler secret put GROQ_KEY_1` |
| `GROQ_KEY_2` | groq2 | `wrangler secret put GROQ_KEY_2` |
| `GEMINI_KEY` | gemini | `wrangler secret put GEMINI_KEY` |
| `MISTRAL_KEY` | mistral | `wrangler secret put MISTRAL_KEY` |
| `OPENROUTER_KEY` | openrouter | `wrangler secret put OPENROUTER_KEY` |
| `SAMBANOVA_KEY` | sambanova | `wrangler secret put SAMBANOVA_KEY` |
| `COHERE_KEY` | cohere | `wrangler secret put COHERE_KEY` |
| `SILICONFLOW_KEY` | siliconflow | `wrangler secret put SILICONFLOW_KEY` |
| `CEREBRAS_KEY` | cerebras | `wrangler secret put CEREBRAS_KEY` |
| `NOVITA_KEY` | novita | `wrangler secret put NOVITA_KEY` |

Plus the existing worker bindings (already in `wrangler.toml`):
- `DB` (D1), `LOCKS` / `TASK_STATUS` / `RATE_LIMITS` / `PROMPT_CACHE` (KV),
  `TASKS_QUEUE` (Queue), `AI` (Workers AI binding).

WorkersAI (`workersai`) needs no API key — it uses the `AI` binding.

---

## Cascade algorithm summary

The cascade in `routeChat` (in `index.ts`) works as follows:

1. **Validate** the request body (`messages` non-empty, roles valid).
2. **Classify intent** via `utils/intent_classifier.classifyIntent`:
   one of `code`, `arabic`, `long_context`, `reasoning`, `simple_chat`,
   `tool_calling`, `multimodal`.
3. **Build the cascade** via `getCascadeForIntent(intent)` — an ordered
   list of provider ids, best-first for that intent.
4. **Filter the cascade** by `isProviderConfigured(id, env)` — drop
   providers whose API key isn't set. If all are filtered out, fall
   back to ALL configured providers in registry order (fail-open).
5. **Try each provider** in order:
   - Pick the best model for `(intent, provider)` via
     `pickBestModel(intent, provider)`.
   - Call `adapter.chat(req, env)` (non-stream) or
     `adapter.chatStream(req, env)` (stream).
   - On success → record success in D1 ledger (best-effort), return
     OpenAI-compatible Response (JSON or SSE).
   - On retriable failure (429, 5xx, network error) → record failure
     in D1 ledger (may open circuit breaker), try next provider.
   - On non-retriable failure (4xx) → return the error.
6. **All providers failed** → return 502 with a structured error body
   listing every attempted provider, the HTTP status / error code from
   each, and the total wall-clock latency.

### Circuit breaker

The D1 ledger's `provider_quotas` table tracks `consecutive_failures` and
`circuit_open_until` per (provider, date). When `record429` bumps
consecutive_failures past a threshold, the circuit opens for 60 seconds
(default; tunable). `getHealthyProviders(env)` returns only providers
with `is_healthy = 1 AND circuit_open_until < now`.

The inline cascade in `routeChat` currently doesn't read the circuit
state — it relies on the adapter's chat() throwing on a 429, then
records the failure and tries the next provider. A richer router (A8's
`model_router.ts` when it lands) should pre-filter the cascade by
`getHealthyProviders` to avoid wasting a request slot on a known-tripped
provider.

### Streaming caveat

Cascade fallback mid-stream is NOT supported. Once a stream starts
emitting bytes to the client, we commit to it — if the upstream breaks
mid-stream, the client gets a truncated stream. We CAN still fall back
if a streaming request fails BEFORE the first byte (e.g. 429 on the
initial HTTP request); that's the common case for which the cascade is
most valuable.

---

## Public API

```typescript
import {
  routeChat,
  routeChatStream,
  handleProviderFeedback,
  // Re-exported types:
  type ChatRequest, type ChatResponse, type ProviderId, type GatewayEnv,
  // Re-exported registry:
  getProvider, listProviders, isProviderConfigured, PROVIDERS,
  // Re-exported utilities:
  classifyIntent, getCascadeForIntent, pickBestModel,
  // Re-exported ledger:
  QuotaLedger,
} from './gateway';
```

### `routeChat(req: ChatRequest, env: Env, ctx: ExecutionContext): Promise<Response>`

The main entry point. Returns an OpenAI-compatible Response — JSON for
non-streaming requests, `text/event-stream` for streaming. Custom
response headers (`X-Provider`, `X-Model`, `X-Intent`,
`X-Fallback-Used`) carry observability metadata.

### `routeChatStream(req, env, ctx): Promise<Response>`

Thin wrapper that forces `stream: true` on the request and delegates to
`routeChat`. Exposed for callers (e.g. the bot's text-mode streaming
handler) that want streaming explicitly without coupling to the
`req.stream` flag.

### `handleProviderFeedback(messageId: string, rating: 1 | -1, env: Env): Promise<void>`

Records user thumbs-up (1) / thumbs-down (-1) feedback for a message
id. Best-effort: D1 errors are swallowed. The dashboard joins
`provider_feedback` against `provider_calls` to compute per-provider
quality scores.

---

## Notes on the A1-retry redesign vs. the earlier A1 scaffold

The earlier A1 scaffold (`types.ts`, `registry.ts`, `index.ts`,
`model_router.ts`, `provider_adapters.ts`) was built before the sibling
adapter agents (A3/A4/A6/A10) landed. It used a single
`OpenAICompatibleAdapter` class for 10 providers, with config-driven
differences. The sibling agents instead built self-contained adapter
files in `adapters/`, each with its own I/O methods and quirks.

The A1-retry redesign:

- **Embraces** the sibling agents' adapter files (imports all 11
  instances).
- **Wraps** each adapter in a uniform runtime handle
  (`GroqHandle`, `GeminiHandle`, `MistralHandle`, `WorkersAIHandle`,
  `BaseCompatHandle`) that satisfies the new `ProviderAdapter` interface
  in `types.ts`.
- **Drops** the earlier `OpenAICompatibleAdapter` / `WorkersAIAdapter`
  classes (in `provider_adapters.ts`) — those are kept for backwards
  compatibility but not imported.
- **Drops** the earlier `model_router.ts` interface (which expected
  `chat(req, env, ctx) => ChatResult`) — replaced by an inline cascade in
  `index.ts`. Sibling agent A8 is rebuilding a richer `model_router.ts`;
  once it lands, the inline cascade can be replaced with a call to it.
- **Re-exports** the OpenAI-compatible shape types from
  `./adapters/types.ts` via `types.ts` so callers have ONE import path
  (`../gateway/types`) for everything.
