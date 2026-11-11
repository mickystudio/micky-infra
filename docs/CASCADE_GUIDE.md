# Cascade Guide — 11-Provider LLM Gateway

> How Micky Assistant routes a chat request through 11 free-tier LLM providers, with sticky sessions, circuit breakers, and per-day quota tracking. كل التفاصيل التقنية لخوارزمية الـ cascade.

**Related files:**
- `worker/src/gateway/model_router.ts` — the orchestrator
- `worker/src/gateway/utils/intent_classifier.ts` — intent → cascade mapping
- `worker/src/gateway/registry.ts` — 11-provider registry
- `worker/src/gateway/error_handler.ts` — circuit breaker policy
- `worker/src/gateway/ledger/ledger.ts` — D1-backed quota ledger
- `worker/src/gateway/adapters/` — one adapter per provider

---

## Table of Contents

1. [The 11 Providers](#1-the-11-providers)
2. [Intent Classification Rules](#2-intent-classification-rules)
3. [Cascade Ordering per Intent](#3-cascade-ordering-per-intent)
4. [Cascade Algorithm (pseudocode)](#4-cascade-algorithm-pseudocode)
5. [Sticky Session Lifecycle](#5-sticky-session-lifecycle)
6. [Circuit Breaker Thresholds](#6-circuit-breaker-thresholds)
7. [Daily Quota Tracking](#7-daily-quota-tracking)
8. [How to Add a 12th Provider](#8-how-to-add-a-12th-provider)

---

## 1. The 11 Providers

| # | id | Label | Free tier (RPD / TPD) | Default model | OpenAI-compat | Quirks |
|---|---|---|---|---|---|---|
| 1 | `groq1` | Groq (Account 1) | 14,400 / 1M | `llama-3.1-8b-instant` | `/openai/v1` | Llama3 family + allam-2-7b (Arabic) + deepseek-r1-distill |
| 2 | `groq2` | Groq (Account 2) | 14,400 / 1M | `llama-3.1-8b-instant` | `/openai/v1` | Backup key so we can double daily quota |
| 3 | `gemini` | Google Gemini | 1,500 / 1M | `gemini-2.0-flash` | Native (translated) | Only provider that does vision on free tier |
| 4 | `mistral` | Mistral AI | 500 / 500K | `mistral-small-latest` | `/v1` | Codestral for code; Magistral for reasoning |
| 5 | `openrouter` | OpenRouter | 1,000 / 1M | `openrouter/auto` | `/api/v1` | Routes to many models behind the scenes |
| 6 | `workersai` | Cloudflare Workers AI | 10,000 / 5M | `@cf/meta/llama-3.1-8b-instruct` | Native (binding) | In-process, no fetch round-trip |
| 7 | `sambanova` | SambaNova Cloud | 1,200 / 500K | `DeepSeek-V3.1` | `/v1` | Per-model rate limits; no Retry-After on 429 |
| 8 | `cohere` | Cohere | 1,000 / month | `command-a-plus-05-2026` | `/compatibility/v1` | Monthly quota (not daily) |
| 9 | `siliconflow` | SiliconFlow | ~$2 credit | `deepseek-ai/DeepSeek-V3` | `/v1` | Vendor-prefixed model ids; returns cost field |
| 10 | `cerebras` | Cerebras Cloud | 1,500 / 500K | `qwen-3.8-27b` | `/v1` | Ultra-fast (2000+ tok/s on LPU) |
| 11 | `novita` | Novita AI | voucher | `deepseek/deepseek-v4.1-flash` | `/openai` prefix | Per-model base URL overrides |

Total **free** capacity: ~50,000 requests/day across all 11 providers.

---

## 2. Intent Classification Rules

The classifier (`worker/src/gateway/utils/intent_classifier.ts`) is a pure, synchronous function that runs on every request. It uses **7 intents** in strict priority order (first match wins):

```
1. multimodal      if any message has an `image_url` content part
                   → HARD constraint: only Gemini does vision on free tier

2. tool_calling    if `req.tools` is a non-empty array
                   → SEMI-HARD: must use a function-calling-capable model

3. long_context    if estimated prompt tokens > 16,000
                   → HARD on context size; a 20k prompt won't fit in an 8k model

4. code            if last user message contains:
                     • a ```fenced code block```
                     • a file extension (foo.ts, app.py, ...)
                     • ≥2 distinct code keywords (def, function, class, import, ...)

5. arabic          if >50% of characters in the last user message are Arabic script
                   (Arabic block U+0600..U+06FF + Supplement + Presentation Forms)

6. reasoning       if last user message matches:
                   \b(explain why|step-by-step|reason|think|analyze|reasoning|
                      chain of thought|walk through|derive|prove|why does|why is|
                      why are|justify)\b   (case-insensitive)

7. simple_chat     fallback for ordinary chitchat
```

**Why inspect only the last user message?** Older turns are context, not intent — the model will respond to whatever the user just said. Inspecting only the last turn keeps the classifier O(1) in the message count.

**Arabic ratio:** counts Arabic Unicode code points (excluding whitespace) divided by total non-whitespace code points. Threshold is 50% so mixed Arabic/English messages still route to Arabic-specialized models.

**Override hooks:** `req.metadata.intent_override` and `req.metadata.provider_override` (admin / debug only) bypass the classifier entirely.

---

## 3. Cascade Ordering per Intent

After classification, the router looks up the ordered provider list for that intent. First provider is primary; rest are failover fallbacks in priority order.

| Intent | Cascade order (primary → fallbacks) |
|---|---|
| `code` | `groq1` → `groq2` → `mistral` → `sambanova` → `siliconflow` → `workersai` → `cerebras` |
| `arabic` | `groq1` → `groq2` → `cohere` → `sambanova` → `gemini` |
| `long_context` | `gemini` → `groq1` → `groq2` → `mistral` |
| `reasoning` | `groq1` → `groq2` → `sambanova` → `novita` |
| `simple_chat` | `groq1` → `groq2` → `mistral` → `gemini` → `openrouter` → `workersai` |
| `tool_calling` | `groq1` → `groq2` → `mistral` → `openrouter` → `gemini` |
| `multimodal` | `gemini` (only) |

### Rationale

- **`code`**: Groq's `qwen3-32b` is the fastest coder on free tier. Mistral's `codestral-latest` is next-best; SambaNova + SiliconFlow host Qwen2.5-Coder-32B; Workers AI has it in-process; Cerebras is the LPU fallback.
- **`arabic`**: Groq hosts `allam-2-7b` (IBM's Arabic-specialized model); Cohere's `aya-23-35b` is the next best multilingual; SambaNova + Gemini cover the rest.
- **`long_context`**: Gemini 1.5 has 1M tokens; Groq's `llama-3.1-8b-instant` (131K) and Mistral Large (128K) cover the 16K-128K range. Hard ceiling: anything > 1M tokens fails.
- **`reasoning`**: DeepSeek-R1 / V3.1 are the strongest open reasoning models. Groq has the distilled 70B (fastest); SambaNova and Novita host the full-size.
- **`simple_chat`**: Spread across the cheapest-fastest providers first; fall back to OpenRouter + Workers AI as catch-alls.
- **`tool_calling`**: OpenAI-compatible function-calling on Groq + Mistral + OpenRouter; Gemini's native function-calling translation as final fallback.
- **`multimodal`**: Only Gemini serves vision in the free tier. Single-provider cascade.

### Per-(intent, provider) best model

The router also picks the best model id for each (intent, provider) pair — see `pickBestModel()` in `intent_classifier.ts`. The mapping table covers all 7×11 = 77 combinations; for unlisted pairs it falls back to the provider's default model.

---

## 4. Cascade Algorithm (pseudocode)

```
function routeChat(req, env, ctx):
    conversationId = resolveConversationId(req)
    today = todayUtc()           # "YYYY-MM-DD" UTC, partition key
    ledger = new QuotaLedger(env.DB)
    startedAt = Date.now()

    # ─── Step 1: try sticky session ─────────────────────────────────
    sticky = ledger.getStickyProvider(conversationId)
    if sticky ≠ null:
        if sticky.isHealthy AND sticky.hasQuota(today):
            result = tryProvider(sticky, req, env, ledger, ctx, conversationId, today, startedAt)
            if result.success:
                return result.response

    # ─── Step 2: classify + iterate cascade ──────────────────────────
    intent = req.metadata.intent_override ?? classifyIntent(req)
    cascade = req.metadata.provider_override
              ? [provider_override]
              : CASCADES[intent]

    healthy = getHealthyProviders(env)  # filters out circuit-open + unconfigured

    for provider in cascade:
        if provider == sticky: continue  # already tried
        if provider not in healthy: continue

        model = pickBestModel(intent, provider) OR req.model OR provider
        if not willFitInProviderContext(estimateTokens(req), provider, model):
            continue                    # context window too small for this provider

        # atomic quota check (also gates on circuit-breaker state in D1)
        decrement = ledger.decrementQuota(provider, model, estTokens)
        if not decrement.ok: continue   # exhausted or circuit open

        try:
            if req.stream:
                stream = withTimeout(adapter.chatStream(req, env), 25_000)
                ctx.waitUntil(recordSuccess(ledger, provider, ...))
                return buildStreamResponse(stream, provider, model, fallbackUsed=(attempted.length>0))
            else:
                chatResponse = withTimeout(adapter.chat(req, env), 25_000)
                ctx.waitUntil(recordSuccess(ledger, provider, ...))
                return buildJsonResponse(chatResponse, provider, model, fallbackUsed)

        catch err:
            ctx.waitUntil(handleFailure(ledger, provider, model, intent, conversationId, err, ...))
            attempted.push(provider)
            continue

    # ─── Step 3: all providers failed ────────────────────────────────
    return errorResponse(
        message="All providers exhausted. Please retry in a few minutes.",
        status=503,
        code="all_providers_exhausted",
        extra={ attempted_providers: attempted, intent, total_latency_ms: Date.now() - startedAt }
    )
```

### Key behaviors

- **Sticky-first**: a successful call writes `(conversationId → provider, model)` to `conversation_sticky_session` with a 1h TTL. The next turn of the same conversation tries the same provider first — this preserves response style and reduces cross-provider format drift.
- **Healthy filter**: `getHealthyProviders(env)` returns the subset of providers that are (a) configured (API key set) AND (b) marked `is_healthy = 1` in D1.
- **Atomic quota decrement**: `ledger.decrementQuota()` runs `UPDATE ... WHERE remaining > 0 RETURNING` — a single-statement atomic check-and-decrement. Concurrent requests cannot oversell.
- **25-second timeout per attempt**: each `adapter.chat()` / `chatStream()` call is wrapped in a `Promise.race` against an `AbortController`-backed 25s timer. On timeout, the error is classified as `timeout` and the cascade continues.
- **Best-effort logging**: success / failure records are written via `ctx.waitUntil()` so they don't block the response. D1 failures degrade silently (the gateway still serves the user).
- **Mid-stream error handling**: if a stream errors mid-flight, the wrapper emits `data: {"error":"Provider failed: ..."}\n\n` followed by `data: [DONE]\n\n` and closes cleanly. The client sees an honest error rather than a hung connection.

---

## 5. Sticky Session Lifecycle

Sticky sessions keep a conversation on the same provider across turns.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ TURN 1: user sends "hello"                                                  │
│  1. resolveConversationId(req) → "conv_abc123"                              │
│  2. ledger.getStickyProvider("conv_abc123") → null (first turn)            │
│  3. classifyIntent → simple_chat → cascade [groq1, groq2, ...]              │
│  4. groq1 succeeds                                                          │
│  5. ledger.setStickyProvider("conv_abc123", "groq1", "llama-3.1-8b-...")   │
│     TTL = 60 * 60 * 1000 ms = 1 hour                                       │
└────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼  (within 1 hour)
┌────────────────────────────────────────────────────────────────────────────┐
│ TURN 2: user sends "what about for kids?"                                  │
│  1. resolveConversationId(req) → "conv_abc123"  (same hash)                │
│  2. ledger.getStickyProvider("conv_abc123") → "groq1"                      │
│  3. groq1.isHealthy? yes  /  hasQuota(today)? yes  →  try groq1 first      │
│  4. groq1 succeeds → refresh sticky TTL (1h from now)                     │
└────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼  (sticky provider fails)
┌────────────────────────────────────────────────────────────────────────────┐
│ TURN 3: user sends "..."                                                   │
│  1. sticky = "groq1"                                                       │
│  2. groq1 fails (429 or 5xx) → circuit opens for groq1                    │
│  3. classifyIntent → cascade iteration → groq2 succeeds                    │
│  4. ledger.setStickyProvider("conv_abc123", "groq2", ...)                  │
│     ← sticky session migrates to groq2                                     │
└────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼  (1 hour passes with no activity)
┌────────────────────────────────────────────────────────────────────────────┐
│ TURN 4: row in conversation_sticky_session has expired_at < now            │
│  (a cleanup cron prunes expired rows; or getStickyProvider returns null)    │
│  → full cascade iteration as if it were TURN 1                             │
└────────────────────────────────────────────────────────────────────────────┘
```

### Conversation ID resolution

Priority:
1. `req.metadata.conversation_id` (explicit, best — pass this from your client!)
2. FNV-1a hash of (system prompt + first user message), prefixed `conv_`

The hash fallback is deterministic but **single-shot** — for true multi-turn stickiness, your client should pass `metadata.conversation_id` (e.g. a UUID generated once per conversation).

---

## 6. Circuit Breaker Thresholds

Implemented in `worker/src/gateway/error_handler.ts` (stateless policy) + `ledger.ts` (D1-backed state).

### When does the circuit open?

| Trigger | Open duration | Action |
|---|---|---|
| Single **429** (rate-limit) from provider | **5 minutes** (`GATEWAY_CB_RATE_LIMIT_OPEN_MS`) | Today's quota zeroed; provider skipped |
| **3 consecutive** 5xx / network / timeout failures (`GATEWAY_CB_FAILURE_THRESHOLD`) | **1 hour** (`GATEWAY_CB_OPEN_MS`) | Provider skipped |
| **10 consecutive** failures (escalation) | **24 hours** (`ESCALATED_CB_OPEN_MS`) | Provider skipped |
| 4xx (other than 429) | never | Routed to next provider without opening circuit (client-side bug, not provider health) |

### When does the circuit close?

- **Half-open probe**: when `circuitOpenUntil` has passed, the next request is allowed through. Success closes the circuit (resets `consecutiveFailures` to 0); failure re-opens it for the same duration.
- **Cron health check**: every 30 minutes, `gateway/cron_handler.ts` probes every provider's `/models` endpoint with a 5-second timeout. A healthy probe flips `is_healthy = 1` even without an in-flight request.

### Retry decisions

`shouldRetry(status, provider)` decides whether to try the next provider or surface to the client:

| Status | Retry? | Reason |
|---|---|---|
| 0 (network / abort / timeout) | ✅ | Transient |
| 429 | ✅ | Rate-limited — try someone else |
| 500, 502, 503, 504 | ✅ | Transient server error |
| 4xx (other) | ❌ | Same malformed request will fail identically on next provider |

### Backoff (when retrying inside one provider — not currently used in the cascade)

```
exponential: BASE * 2^attempt
   → 250ms · 500ms · 1s · 2s · 4s · 8s (cap)
+ ±20% jitter (so concurrent retry storms don't synchronize)
honor Retry-After header if present (capped at MAX_BACKOFF_MS = 8s)
```

### Per-provider state stored in D1 (`provider_health` table)

```sql
provider              TEXT PRIMARY KEY,
is_healthy            INTEGER NOT NULL DEFAULT 1,
consecutive_failures  INTEGER NOT NULL DEFAULT 0,
circuit_open_until    INTEGER NOT NULL DEFAULT 0,  -- epoch ms
last_failure_at       INTEGER,
last_failure_status   INTEGER,
last_error_kind       TEXT,  -- 'rate_limit' | 'server_error' | 'network' | 'timeout' | 'client_error'
total_calls           INTEGER NOT NULL DEFAULT 0,
total_failures        INTEGER NOT NULL DEFAULT 0,
updated_at            INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
```

---

## 7. Daily Quota Tracking

### Schema (`provider_quota` table)

```sql
provider   TEXT NOT NULL,
day        TEXT NOT NULL,          -- 'YYYY-MM-DD' UTC partition key
remaining  INTEGER NOT NULL,       -- decremented atomically
limit      INTEGER NOT NULL,       -- seeded at day-start
PRIMARY KEY (provider, day)
```

### The atomic decrement

```sql
UPDATE provider_quota
   SET remaining = remaining - 1
 WHERE provider = ?
   AND day = ?
   AND remaining > 0
RETURNING remaining;
```

If the query returns 0 rows, the provider is exhausted → cascade to next. If it returns a row, we have a decremented slot reserved and can make the API call.

### Daily reset cron

`crontab: 0 0 * * *` — runs `ledger.resetDailyQuotas()` at UTC midnight:

```sql
INSERT INTO provider_quota (provider, day, remaining, limit)
VALUES
  ('groq1', '<today>', 14400, 14400),
  ('groq2', '<today>', 14400, 14400),
  ('gemini', '<today>', 1500, 1500),
  ...
ON CONFLICT(provider, day) DO NOTHING;
```

Idempotent — if the cron fires slightly early or you re-run it manually, it doesn't double-count.

### Quota seed values (`PROVIDER_LIMITS` in `ledger.ts`)

| Provider | Daily limit | Tokens/day |
|---|---|---|
| groq1 / groq2 | 14,400 | 1,000,000 |
| gemini | 1,500 | 1,000,000 |
| cerebras | 1,500 | 500,000 |
| sambanova | 1,200 | 500,000 |
| mistral | 500 | 500,000 |
| openrouter | 1,000 | 1,000,000 |
| workersai | 10,000 | 5,000,000 |
| novita | voucher | — |
| siliconflow | $2 credit | — |
| cohere | 1,000 / month (not daily) | — |

> Numbers reflect public free-tier docs as of late 2025 / early 2026. **Re-verify before production tuning**.

### Quota refund on early failure

If the API call fails before consuming the quota (e.g. 429 on the initial HTTP request), `ledger.refund(provider, day, 1)` restores the slot. Mid-stream failures do NOT refund (the provider did work).

---

## 8. How to Add a 12th Provider

This template assumes the new provider is OpenAI-compatible (most are). Adapt the Gemini adapter path if it uses a native format.

### Step-by-step

1. **Choose a `ProviderId` string** (e.g. `together`). Add it to:
   - `worker/src/gateway/types.ts` → `ProviderId` union
   - `worker/src/gateway/types.ts` → `isProviderId()` runtime guard
   - `worker/src/gateway/types.ts` → `PROVIDER_LABELS` map
   - `worker/src/gateway/adapters/_types.ts` → `ProviderId` union (if you use the BaseCompat path)
   - `worker/src/gateway/utils/intent_classifier.ts` → `BEST_MODEL` map + `PROVIDER_DEFAULT_MODEL`

2. **Create the adapter file** at `worker/src/gateway/adapters/<provider>.ts`:

   ```ts
   import { BaseOpenAICompatibleAdapter } from './_base';
   import type { ModelInfo, ProviderId } from './_types';

   export const PROVIDER_BASE_URL = 'https://api.together.xyz/v1';
   export const PROVIDER_KEY_ENV = 'TOGETHER_KEY';
   export const PROVIDER_DEFAULT_MODEL = 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free';

   export const PROVIDER_MODELS: ModelInfo[] = [
     { id: PROVIDER_DEFAULT_MODEL, object: 'model', created: 0, owned_by: 'together', label: 'Llama 3.3 70B Free', free_tier: true },
   ];

   export class TogetherAdapter extends BaseOpenAICompatibleAdapter {
     readonly PROVIDER_ID: ProviderId = 'together';
     constructor(apiKey: string) {
       super({ apiKey, baseUrl: PROVIDER_BASE_URL, defaultModel: PROVIDER_DEFAULT_MODEL, staticModels: PROVIDER_MODELS });
     }
     // Override hooks here ONLY if the provider has quirks (see _base.ts for the full list)
   }

   export function createTogetherAdapter(env: Record<string, unknown>): TogetherAdapter {
     const key = env[PROVIDER_KEY_ENV];
     if (typeof key !== 'string' || key.length === 0) {
       throw new Error(`TogetherAdapter: ${PROVIDER_KEY_ENV} is not configured. Run: wrangler secret put ${PROVIDER_KEY_ENV}`);
     }
     return new TogetherAdapter(key);
   }
   ```

3. **Register the adapter** in `worker/src/gateway/registry.ts`:

   ```ts
   import { TogetherAdapter } from './adapters/together';
   // Add to HANDLES map:
   together: new BaseCompatHandle('together', 'Together AI', 'TOGETHER_KEY',
     TogetherAdapter as unknown as BaseCompatCtor),
   ```

4. **Add the API key to env**:
   - `worker/src/index.ts` → `Env` interface (add `TOGETHER_KEY: string;`)
   - `worker/src/gateway/types.ts` → `ProviderKeys` interface

5. **Wire it into cascades** in `intent_classifier.ts`:
   ```ts
   const CASCADES: Record<IntentType, ProviderId[]> = {
     ...
     simple_chat: ['groq1', 'groq2', 'mistral', 'together', 'gemini', 'openrouter', 'workersai'],
     // add 'together' to whichever intents make sense
   };
   ```

6. **Add to `PROVIDER_LIMITS`** in `worker/src/gateway/ledger/ledger.ts`:
   ```ts
   together: { rpd: 1000, tpd: 500_000, label: 'Together AI' },
   ```

7. **Add the seed row** in `worker/migrations/0003_provider_gateway.sql`:
   ```sql
   INSERT OR IGNORE INTO provider_health (provider) VALUES ('together');
   ```

8. **Set the secret**: `wrangler secret put TOGETHER_KEY`

9. **Add a row** to the comparison table in `worker/src/gateway/adapters/README_new_providers.md` (signup URL, free tier, quirks).

10. **Add tests** in `worker/src/gateway/adapters/__tests__/` (mock a `/v1/chat/completions` response and verify parsing).

11. **Document the signup URL** in `docs/SECRETS.md`.

12. **Re-deploy**: `wrangler deploy` + verify the new provider shows up in `GET /v1/providers` and `GET /v1/dashboard`.

### What you do NOT need to change

- The cascade router (`model_router.ts`) — it iterates providers generically
- The SSE normalizer — it parses OpenAI-shaped deltas regardless of upstream
- The circuit breaker policy — provider-agnostic
- The quota ledger — keyed on provider string, no schema change needed

Total work for a vanilla OpenAI-compatible provider: ~1 hour (1 adapter file + ~5 line edits across 4 files + 1 test file + 1 migration row).
