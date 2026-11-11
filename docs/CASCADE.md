# CASCADE — Technical Spec

> Deep technical reference for the multi-provider LLM cascade: provider configs, rate limits, adapter interface, cascade algorithm pseudocode, D1 schema. For the user-facing guide see [`CASCADE_GUIDE.md`](CASCADE_GUIDE.md).
>
> **المواصفات التقنية الكاملة** — كل تفاصيل الـ cascade، الإعدادات، حدود الأسعار، واجهة الـ adapter، pseudocode لخوارزمية التوجيه، و D1 schema لجدول الحصص.

---

## Table of Contents

1. [Provider Configs (11 providers)](#1-provider-configs-11-providers)
2. [Rate Limits Table](#2-rate-limits-table)
3. [Adapter Interface](#3-adapter-interface)
4. [Cascade Algorithm (pseudocode)](#4-cascade-algorithm-pseudocode)
5. [D1 Schema for Quotas](#5-d1-schema-for-quotas)
6. [Error Classification + SSE Normalization](#6-error-classification--sse-normalization)

---

## 1. Provider Configs (11 providers)

Each provider has a static `ProviderConfig` (identity + capabilities) plus a runtime `ProviderAdapter` (HTTP I/O). All configs are TypeScript objects defined in `worker/src/gateway/types.ts` and `registry.ts`.

### 1.1 `groq1` / `groq2`

```ts
{
  id: 'groq1',
  display_name: 'Groq (Account 1)',
  base_url: 'https://api.groq.com/openai/v1',
  default_model: 'llama-3.1-8b-instant',
  api_key_env: 'GROQ_KEY_1',
  rpm: 30, rpd: 14400, tpm: 6000, tpd: 1_000_000,
  supports_streaming: true, supports_tools: true, supports_vision: false,
  max_context_tokens: 131072,
}
```

Two keys → two provider entries (`groq1`, `groq2`) — same config modulo `api_key_env`. Doubles daily quota.

### 1.2 `gemini`

```ts
{
  id: 'gemini',
  display_name: 'Google Gemini',
  base_url: 'https://generativelanguage.googleapis.com/v1beta',
  default_model: 'gemini-2.0-flash',
  api_key_env: 'GEMINI_KEY',
  rpm: 15, rpd: 1500, tpm: 1_000_000, tpd: 1_000_000,
  supports_streaming: true, supports_tools: true, supports_vision: true,  // ONLY vision on free tier
  max_context_tokens: 1_048_576,  // 1M
}
```

Native format translation (system_instruction + parts → OpenAI messages) in `gateway/adapters/gemini.ts`.

### 1.3 `mistral`

```ts
{
  id: 'mistral', display_name: 'Mistral AI',
  base_url: 'https://api.mistral.ai/v1',
  default_model: 'mistral-small-latest',
  api_key_env: 'MISTRAL_KEY',
  rpm: 1, rpd: 500, tpm: 500_000, tpd: 500_000,
  supports_streaming: true, supports_tools: true, supports_vision: false,
  max_context_tokens: 131072,
}
```

### 1.4 `openrouter`

```ts
{
  id: 'openrouter', display_name: 'OpenRouter',
  base_url: 'https://openrouter.ai/api/v1',
  default_model: 'openrouter/auto',
  api_key_env: 'OPENROUTER_KEY',
  rpm: 20, rpd: 1000, tpm: 200_000, tpd: 1_000_000,
  supports_streaming: true, supports_tools: true, supports_vision: false,
  max_context_tokens: 131072,
}
```

### 1.5 `workersai` (Cloudflare Workers AI binding)

```ts
{
  id: 'workersai', display_name: 'Cloudflare Workers AI',
  base_url: null,                            // uses env.AI binding, no HTTP fetch
  default_model: '@cf/meta/llama-3.1-8b-instruct',
  api_key_env: null,                         // no API key — binding auth
  rpm: 50, rpd: 10_000, tpm: 50_000, tpd: 5_000_000,
  supports_streaming: true, supports_tools: false, supports_vision: false,
  max_context_tokens: 8192,
}
```

### 1.6-1.10 OpenAI-compatible providers (compacted)

The remaining 5 providers all use OpenAI-compatible `/v1/chat/completions` (or `/compatibility/v1` for Cohere, `/openai` prefix for Novita). They share the same shape and differ only in base URL + auth + quirks:

```ts
{ id: 'sambanova',   base_url: 'https://api.sambanova.ai/v1',
  default_model: 'DeepSeek-V3.1',           api_key_env: 'SAMBANOVA_KEY',
  rpm: 20, rpd: 1200, tpm: 0, tpd: 500_000, max_context_tokens: 131072,
  quirks: 'rate limits PER-MODEL not per-account; 429s arrive without Retry-After' }

{ id: 'cohere',      base_url: 'https://api.cohere.com/compatibility/v1',  // NOT /v1
  default_model: 'command-a-plus-05-2026',  api_key_env: 'COHERE_KEY',
  rpm: 20, rpd: 1000, tpm: 0, tpd: 0,       max_context_tokens: 131072,
  monthly_quota: 1000,  // monthly, NOT daily
  quirks: 'tool-calling normalized server-side by compatibility endpoint' }

{ id: 'siliconflow', base_url: 'https://api.siliconflow.cn/v1',
  default_model: 'deepseek-ai/DeepSeek-V3', api_key_env: 'SILICONFLOW_KEY',
  rpm: 0, rpd: 1000, tpm: 0, tpd: 500_000,  max_context_tokens: 131072,
  quirks: 'vendor-prefix model ids; response includes USD cost field' }

{ id: 'cerebras',    base_url: 'https://api.cerebras.ai/v1',
  default_model: 'qwen-3.8-27b',            api_key_env: 'CEREBRAS_KEY',
  rpm: 30, rpd: 1500, tpm: 100_000, tpd: 500_000, max_context_tokens: 131072,
  quirks: 'ultra-fast inference (~2000 tok/s on LPU); do NOT apply client-side throttles' }

{ id: 'novita',      base_url: 'https://api.novita.ai/openai',  // /openai prefix, NOT /v1
  default_model: 'deepseek/deepseek-v4.1-flash', api_key_env: 'NOVITA_KEY',
  rpm: 0, rpd: 1000, tpm: 0, tpd: 500_000,  max_context_tokens: 131072,
  quirks: 'some models live on alternate base URLs (NOVITA_MODEL_BASE_OVERRIDES)' }
```

All 5 share: `supports_streaming: true, supports_tools: true, supports_vision: false`.

---

## 2. Rate Limits Table

Combined free-tier limits across all 11 providers:

| Provider | RPM | RPD | TPD | Notes |
|---|---|---|---|---|
| `groq1` | 30 | 14,400 | 1,000,000 | Per-key, daily reset |
| `groq2` | 30 | 14,400 | 1,000,000 | Per-key, daily reset |
| `gemini` | 15 | 1,500 | 1,000,000 | Per-key, daily reset |
| `mistral` | 1 | 500 | 500,000 | Per-key, daily reset |
| `openrouter` | 20 | 1,000 | 1,000,000 | Per-key, daily reset |
| `workersai` | 50 | 10,000 | 5,000,000 | Neurons/day metering |
| `sambanova` | 20 | 1,200 | 500,000 | Per-MODEL, not per-account |
| `cohere` | 20 | 1,000 | — | Monthly (1,000/month) |
| `siliconflow` | — | 1,000 | 500,000 | $2 signup credit + free models |
| `cerebras` | 30 | 1,500 | 500,000 | Per-key, daily reset |
| `novita` | — | 1,000 | 500,000 | Voucher-based |
| **TOTAL** | **~245** | **~49,500** | **~11.5M** | Combined daily budget |

### Quota semantics

- `RPD` = requests per day (tracked atomically in D1)
- `RPM` = requests per minute (burst limit; enforced upstream, returned as 429 with `Retry-After`)
- `TPD` = tokens per day (sum of input + output)
- `TPM` = tokens per minute (burst limit; enforced upstream)

### Workers AI Neuron accounting

Each model has a Neuron-per-token rate:

| Model | Neurons / 1K tokens |
|---|---|
| `@cf/qwen/qwen2.5-coder-32b-instruct` | 230 |
| `@cf/qwen/qwen2.5-coder-14b-instruct` | 130 |
| `@cf/meta/llama-3.1-8b-instruct` | 16 |
| `@cf/openai/whisper-tiny-en` | 100 |

10,000 Neurons/day covers ~500-2000 typical chat requests.

---

## 3. Adapter Interface

Every provider implements the runtime `ProviderAdapter` interface (in `worker/src/gateway/types.ts`):

```ts
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly label: string;
  chat(req: ChatRequest, env: GatewayEnv): Promise<ChatResponse>;          // throws on failure
  chatStream(req: ChatRequest, env: GatewayEnv): Promise<ReadableStream<Uint8Array>>;  // OpenAI SSE bytes
  healthCheck(env: GatewayEnv): Promise<boolean>;                          // liveness probe
  isConfigured(env: GatewayEnv): boolean;                                  // key/binding set?
}
```

### Three adapter shapes

#### 3.1 `BaseOpenAICompatibleAdapter` subclasses

Used by: `openrouter`, `sambanova`, `cohere`, `siliconflow`, `cerebras`, `novita`. All OpenAI-compatible `/v1/chat/completions`; differ only in base URL + auth + quirks.

The base class (`gateway/adapters/_base.ts`, ~250 lines) provides:
- fetch + retry (1 initial + 2 retries, exponential backoff with ±20% jitter)
- Error classes: `ProviderError` (`status`, `retryable`, `upstreamBody`), `RateLimitError` (429 + rate-limit info), `NetworkError` (always retryable)
- Rate-limit parsing: standard `x-ratelimit-*` + `Retry-After` (seconds or HTTP-date)
- SSE streaming: line-buffered `data: <json>\n\n` parser → normalized `ChatStreamChunk`s
- Health check: `GET /models` with 5s `AbortController` timeout

Subclasses override only quirks via protected hooks (e.g. SambaNova synthesizes a 3s default `retryAfterSeconds` because the upstream never sends `Retry-After`).

#### 3.2 Hand-written adapters

For: `groq1`/`groq2` (env-passed), `gemini` (apiKey-passed, native format translation), `mistral` (no chat method; registry does fetch), `workersai` (env.AI binding). The registry wraps each in a Handle class that satisfies the runtime `ProviderAdapter` interface.

#### 3.3 Registry

`registry.ts` builds the `Record<ProviderId, ProviderAdapter>` with one entry per provider. Public API: `getProvider(id)`, `listProviders()`, `isProviderConfigured(id, env)`, `getHealthyProviders(env, intent?)`.

---

## 4. Cascade Algorithm (pseudocode)

```
function routeInternal(req, env, ctx, isStream):
    if req.messages is empty: return errorResponse(400, "messages required")

    ledger = env.DB ? new QuotaLedger(env.DB) : null
    conversationId = resolveConversationId(req)
    startedAt = Date.now()

    # 1. Try sticky session (1h TTL)
    sticky = ledger ? await resolveSticky(ledger, env, conversationId) : null
    if sticky ≠ null:
        outcome = tryProvider(sticky.provider, sticky.model, req, env, ledger, ctx,
                              conversationId, isStream, false, startedAt, 'simple_chat')
        if outcome.response ≠ null: return outcome.response

    # 2. Classify intent + build cascade
    intent = safeClassifyIntent(req)
    cascade = getCascadeForIntent(intent)
    healthy = new Set(await getHealthyProviders(env))
    filtered = cascade.filter(p => healthy.has(p))
    if filtered is empty: return errorResponse(503, "all_providers_exhausted")

    # 3. Iterate cascade
    attempted = sticky ? [sticky.provider] : []
    for provider in filtered:
        if provider == sticky.provider: continue
        fallbackUsed = attempted.length > 0
        model = pickBestModel(intent, provider) OR req.model OR provider
        estTokens = countMessageTokens(req.messages, model)
        if not willFitInProviderContext(estTokens, provider, model): continue

        # Atomic quota check (also gates on circuit-breaker state in D1)
        if ledger:
            try:
                dec = await ledger.decrementQuota(provider, model, estTokens)
                if not dec.ok: continue  # exhausted or circuit open
            catch: pass  # best-effort

        outcome = tryProvider(provider, model, req, env, ledger, ctx,
                              conversationId, isStream, fallbackUsed, startedAt, intent)
        if outcome.response ≠ null: return outcome.response
        attempted.push(provider)

    # 4. All providers exhausted
    return errorResponse(503, "all_providers_exhausted",
        { attempted_providers: attempted, intent, total_latency_ms: Date.now() - startedAt })


function tryProvider(provider, model, req, env, ledger, ctx, conversationId, isStream, fallbackUsed, startedAt, intent):
    adapter = getProvider(provider)
    modifiedReq = { ...req, model }
    t0 = Date.now()
    try:
        if isStream:
            stream = await withTimeout(adapter.chatStream(modifiedReq, env), 25_000)
            if ledger: ctx.waitUntil(recordSuccess(ledger, provider, model, intent, conversationId, Date.now() - t0, estTokens, 0))
            return { response: buildStreamResponse(stream, provider, model, fallbackUsed) }
        chatResponse = await withTimeout(adapter.chat(modifiedReq, env), 25_000)
        latency = Date.now() - t0
        inputTokens = chatResponse.usage?.prompt_tokens ?? estTokens
        outputTokens = chatResponse.usage?.completion_tokens ?? 0
        if ledger: ctx.waitUntil(recordSuccess(ledger, provider, model, intent, conversationId, latency, inputTokens, outputTokens))
        return { response: buildJsonResponse(chatResponse, provider, model, fallbackUsed) }
    catch err:
        if ledger: ctx.waitUntil(handleFailure(ledger, provider, model, intent, conversationId, err, Date.now() - t0, estTokens))
        return { response: null, continueCascade: true }


# handleFailure logic (simplified):
#   - status 429: open circuit 5 min + zero today's quota
#   - status >= 500 OR network/timeout: bump consecutive_failures; if >= 3 → open 1h
#   - status 0 (network): same as 5xx
#   - 10+ consecutive failures: escalate to 24h
#   - 4xx (other than 429): NEVER open the circuit (client-side bug, not provider health)
#   - Always: recordCall({provider, model, intent, conversation_id, status, latency, tokens, error})
#   - On success: recordCall(status='success') + setStickyProvider(conversationId, provider, model) with 1h TTL
```

---

## 5. D1 Schema for Quotas

The ledger uses 5 tables across 3 migrations (`0003_provider_gateway.sql`, `0003_gateway_monitoring.sql`, and the additive `gateway/ledger/schema.sql`).

### 5.1 `provider_quota` — daily quota ledger

```sql
CREATE TABLE provider_quota (
  provider   TEXT NOT NULL,
  day        TEXT NOT NULL,          -- 'YYYY-MM-DD' UTC partition key
  remaining  INTEGER NOT NULL,
  limit      INTEGER NOT NULL,
  PRIMARY KEY (provider, day)
);
CREATE INDEX idx_quota_provider_day ON provider_quota(provider, day);
```

Atomic decrement (single-statement; D1 serializes via single Durable Object writer):
```sql
UPDATE provider_quota
   SET remaining = remaining - 1
 WHERE provider = ? AND day = ? AND remaining > 0
RETURNING remaining;
```
0 rows returned → provider exhausted → cascade to next.

### 5.2 `provider_health` — circuit-breaker state

```sql
CREATE TABLE provider_health (
  provider              TEXT PRIMARY KEY,
  is_healthy            INTEGER NOT NULL DEFAULT 1,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  circuit_open_until    INTEGER NOT NULL DEFAULT 0,  -- epoch ms; 0 = closed
  last_failure_at       INTEGER, last_failure_status INTEGER,
  last_error_kind       TEXT,  -- 'rate_limit' | 'server_error' | 'network' | 'timeout' | 'client_error'
  total_calls           INTEGER NOT NULL DEFAULT 0,
  total_failures        INTEGER NOT NULL DEFAULT 0,
  updated_at            INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
INSERT OR IGNORE INTO provider_health (provider) VALUES
  ('workers-ai'), ('groq1'), ('groq2'), ('mistral'),
  ('openrouter'), ('gemini'),
  ('sambanova'), ('cohere'), ('siliconflow'),
  ('cerebras'), ('novita');
```

### 5.3 `conversation_sticky_session` — sticky mapping (1h TTL)

```sql
CREATE TABLE conversation_sticky_session (
  conversation_id   TEXT PRIMARY KEY,
  provider          TEXT NOT NULL,
  message_id_last   TEXT,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  expires_at        INTEGER NOT NULL  -- epoch ms; 1h after creation
);
CREATE INDEX idx_sticky_expires ON conversation_sticky_session(expires_at);
```

### 5.4 `provider_call_log` — per-call audit log

```sql
CREATE TABLE provider_call_log (
  id              TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,
  intent          TEXT,  -- 'code' | 'reasoning' | 'fast' | 'multimodal' | 'default' | 'arabic' | 'long_context' | 'tool_calling' | 'simple_chat'
  conversation_id TEXT, message_id TEXT,
  status_code     INTEGER NOT NULL, latency_ms INTEGER NOT NULL,
  tokens_in       INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
  success         INTEGER NOT NULL DEFAULT 0,
  error_kind      TEXT, error_message TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX idx_calllog_provider ON provider_call_log(provider);
CREATE INDEX idx_calllog_created ON provider_call_log(created_at);
CREATE INDEX idx_calllog_conversation ON provider_call_log(conversation_id);
CREATE INDEX idx_calllog_success ON provider_call_log(success);
```

### 5.5 `message_feedback` — thumbs-up / thumbs-down

```sql
CREATE TABLE message_feedback (
  id              TEXT PRIMARY KEY,
  message_id      TEXT NOT NULL,
  rating          INTEGER NOT NULL,        -- +1 (up) | -1 (down)
  provider        TEXT, intent TEXT, conversation_id TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX idx_feedback_message ON message_feedback(message_id);
CREATE INDEX idx_feedback_provider ON message_feedback(provider);
CREATE INDEX idx_feedback_created ON message_feedback(created_at);
```

### 5.6 Additive ledger tables (`gateway/ledger/schema.sql`)

The gateway/ledger module defines its own set (developed in parallel). Both schemas coexist in production:

- `provider_quotas` — similar to `provider_quota` but per-(provider, model, date_key)
- `conversation_provider_sticky` — similar to `conversation_sticky_session` (+ model + request_count)
- `provider_feedback` — similar to `message_feedback`
- `provider_calls` — similar to `provider_call_log` (status TEXT instead of INTEGER)

From `0003_gateway_monitoring.sql` (additive):

```sql
ALTER TABLE provider_calls ADD COLUMN event_type TEXT;  -- 'call_success' | 'call_failure' | 'fallback_triggered' | 'circuit_opened' | 'quota_depleted' | 'feedback_received'
ALTER TABLE provider_calls ADD COLUMN meta TEXT;         -- JSON blob

CREATE TABLE provider_health_history (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  provider            TEXT NOT NULL,
  status              TEXT NOT NULL,           -- 'healthy' | 'degraded' | 'down'
  latency_ms          INTEGER, error TEXT,
  quota_rpd_remaining INTEGER, quota_tpd_remaining INTEGER,
  checked_at          INTEGER NOT NULL DEFAULT (unixepoch())
);
```

---

## 6. Error Classification + SSE Normalization

### Error classification (`classifyError(err, provider, status)`)

| Status | kind | Retry? |
|---|---|---|
| 429 | `rate_limit` | ✅ (try next provider) |
| 500, 502, 503, 504 | `server_error` | ✅ |
| 4xx (other) | `client_error` | ❌ (same request will fail everywhere) |
| 0 + AbortError / TimeoutError | `timeout` | ✅ |
| 0 + (anything else) | `network` | ✅ |

### Circuit-breaker policy (`shouldOpenCircuit`)

| Trigger | Open duration |
|---|---|
| Single 429 | 5 minutes (`cbRateLimitOpenMs`) |
| 3+ consecutive 5xx/network/timeout | 1 hour (`cbOpenMs`) |
| 10+ consecutive failures (escalation) | 24 hours (`ESCALATED_CB_OPEN_MS`) |
| 4xx (other than 429) | never (client-side bug) |

### Backoff (in-provider retries — not currently used in the cascade)

```
exponential: BASE * 2^attempt
   → 250ms · 500ms · 1s · 2s · 4s · 8s (cap)
+ ±20% jitter
honor Retry-After header if present (capped at 8s)
```

### SSE normalization

`SSENormalizer` (`gateway/sse_normalizer.ts`) parses every provider's SSE format and emits OpenAI-shaped chunks.

**Input formats:**

| Provider | Format |
|---|---|
| Groq, Mistral, OpenRouter | `data: {"choices":[{"delta":{"content":"..."}}]}\n\n` (OpenAI-native) |
| Gemini | `data: {"candidates":[{"content":{"parts":[{"text":"..."}]}}]}\n\n` (native) |
| Workers AI | `{"response":"..."}\n` (NDJSON, no `data: ` prefix) |
| SambaNova, Cohere, SiliconFlow, Cerebras, Novita | OpenAI-compatible (via `BaseOpenAICompatibleAdapter`) |

**Output (OpenAI-compatible):**

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1731216000,"model":"...","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1731216000,"model":"...","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1731216000,"model":"...","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":42,"completion_tokens":156,"total_tokens":198}}

data: [DONE]
```

**Mid-stream errors:** if the upstream stream errors mid-flight, the wrapper emits `data: {"error":"Provider failed: <message>"}` followed by `data: [DONE]` and closes cleanly. The client sees an honest error rather than a hung connection.

**Performance:** single-pass parser (no whole-buffering). 64 KB line buffer (overflow = drop + log). Throughput on Workers: ~100 MB/s of SSE bytes (well above any LLM provider's output rate).

---

## 7. File Map

See `worker/src/gateway/` — key files: `index.ts`, `model_router.ts` (orchestrator), `cascade_router.ts`, `cascade_types.ts` / `types.ts`, `registry.ts` (11-provider registry), `router_helpers.ts` (`CASCADE_ORDER` + `classifyIntent`), `error_handler.ts` (circuit breaker), `sse_normalizer.ts`, `monitoring.ts` / `health_checker.ts` / `alerts.ts` / `cron_handler.ts` (health probes + dashboard + alerts), `utils/intent_classifier.ts` (`classifyIntent` + `getCascadeForIntent` + `pickBestModel`), `utils/token_counter.ts`, `adapters/_base.ts` (`BaseOpenAICompatibleAdapter`), `adapters/{groq,gemini,mistral,workersai}.ts` (hand-written adapters), `adapters/{openrouter,sambanova,cohere,siliconflow,cerebras,novita}.ts` (subclasses), `ledger/{ledger.ts,schema.sql,init.ts}` (QuotaLedger + idempotent schema + runtime bootstrap), `__tests__/` (per-adapter + cascade integration tests).
