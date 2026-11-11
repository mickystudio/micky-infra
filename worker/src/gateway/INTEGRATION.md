# Multi-provider LLM Gateway — Integration Guide

**Agent:** C1 (gateway wiring + integration pass)
**Date:** 2026-11-10
**Scope:** End-to-end wiring of the multi-provider gateway into the worker entry point (`src/index.ts`), the scheduled cron, the Telegram bot, and the deploy configuration. This document is the canonical "what's wired + what to deploy" reference.

---

## 1. Architecture at a glance

```
HTTP / Telegram Bot Update
            │
            ▼
   ┌────────────────────────┐
   │ src/index.ts (router) │  Cloudflare Worker default export
   └─────────┬──────────────┘
             │
   ┌─────────┴─────────────────────────────────────────────────┐
   │                                                         │
   ▼                                                         ▼
POST /v1/chat/completions                          POST /webhook/telegram
  (BYOK API-key auth, KV rate-limit)               (whitelist + dispatch)
   │                                                         │
   ▼                                                         ▼
gateway.routeChat / routeChatStream                  processTelegramUpdate
   │                                                  ├─ /brand         → bot/handlers.ts handleBrandCommand
   ▼                                                  ├─ /storyboard   → bot/handlers.ts handleStoryboardCommand
gateway/model_router.ts routeInternal()              ├─ /approve      → bot/handlers.ts handleApproveCommand
  1. validateRequest                                 ├─ /edit         → bot/handlers.ts handleEditCommand
  2. classifyIntent  (utils/intent_classifier)       └─ callback_query → sb:* / brand:setup:* / multicam:sync:* / multicam:mode:*
  3. resolveSticky    (ledger.getStickyProvider)      
  4. buildCascade    (intent_classifier.getCascadeForIntent)
  5. for each providerId:
     - getHealthyProviders filter (registry + ledger)
     - decrementQuota (atomic D1 UPDATE WHERE remaining>0)
     - adapter.chat() / adapter.chatStream()  (registry.ts Handle)
     - on success: recordCall + setStickyProvider (ctx.waitUntil)
     - on 429:    record429 + setProviderHealthy(false, +5min)
     - on 5xx:    record429 + if consecutive_failures>=3 → setProviderHealthy(false, +1h)
  6. all fail → 503 all_providers_exhausted

GET  /v1/providers    → ProviderMonitor.getDashboardData + registry.isConfigured
GET  /v1/dashboard    → ProviderMonitor.getDashboardData (full ops view)
POST /v1/feedback     → handleFeedback → ledger.recordFeedback (D1)

Cron triggers:
  '*/5 * * * *'   → cron.ts handleScheduled          (Kaggle stale-task poll)
  '*/30 * * * *'  → cron_handler.dispatchGatewayCron → health_checker.runHealthCheckCron
  '0 0 * * *'     → cron_handler.dispatchGatewayCron → resetDailyQuotas
```

---

## 2. Routes wired

| Method | Path                  | Handler                       | Source                       | Notes                                                                              |
|--------|-----------------------|-------------------------------|------------------------------|------------------------------------------------------------------------------------|
| GET    | `/`                   | inline                        | `src/index.ts`               | Landing — bot info + endpoints list.                                               |
| GET    | `/health`             | inline                        | `src/index.ts`               | Liveness probe.                                                                    |
| POST   | `/webhook/telegram`  | `handleTelegramWebhook`       | `src/index.ts`               | Bot update dispatch — async via `ctx.waitUntil`.                                   |
| POST   | `/webhook/github`    | `handleGitHubWebhook`         | `src/index.ts`               | GitHub Actions callback (signature TODO).                                          |
| POST   | `/webhook/kaggle`    | `handleKaggleWebhook`         | `src/index.ts`               | Kaggle kernel completion callback (verified via `X-Webhook-Secret`).               |
| GET    | `/v1/models`         | inline                        | `src/index.ts`               | Hardcoded 3-model list (Workers AI Qwen2.5-coder).                                 |
| POST   | `/v1/chat/completions` | `handleChatCompletions`     | `src/index.ts`               | BYOK API-key auth (D1 lookup) + KV rate-limit + `gateway.routeChat` / `routeChatStream` cascade. Streaming requests (`body.stream===true`) dispatch to `routeChatStream`; non-streaming to `routeChat`. Both share the same cascade / sticky-session / circuit-breaker code path. |
| POST   | `/v1/feedback`       | `handleFeedback`              | `src/index.ts`               | Thumbs-up/down (`{message_id, rating: 1|-1}`) — `gateway.handleProviderFeedback` records to D1. Best-effort. |
| GET    | `/v1/providers`      | `handleProviderList`          | `src/index.ts`               | Returns all 11 cascade providers with `status` (`healthy`/`degraded`/`down`/`unknown`), `configured`, `quota_remaining` (`rpd`, `tpd`), `calls_today`, `success_rate`, `circuit_open_until`. Joins `registry.isConfigured` + `ProviderMonitor.getDashboardData`. |
| GET    | `/v1/dashboard`      | `handleDashboard`              | `src/index.ts`               | Heavy ops view — full `ProviderMonitor.getDashboardData` snapshot + 24h cascade analytics + recent feedback counts. |
| (cron) | `*/5 * * * *`        | `handleScheduled`             | `src/cron.ts`                | Kaggle stale-task safety-net poll (no gateway involvement).                        |
| (cron) | `*/30 * * * *`       | `dispatchGatewayCron`         | `gateway/cron_handler.ts`    | Health-check every provider + send alerts on healthy→down transitions.            |
| (cron) | `0 0 * * *`          | `dispatchGatewayCron`         | `gateway/cron_handler.ts`     | Daily UTC-midnight quota reset — seeds fresh `provider_quotas` rows for all 11 providers with full daily limits. |
| (queue)| `micky-tasks-queue`  | `processQueuedTask`            | `src/core/queue_manager.ts`  | Montage + montage_resume task processing (Kaggle GPU runner).                       |

### Telegram commands wired

| Command                          | Handler (in `bot/handlers.ts`)        | Notes |
|----------------------------------|----------------------------------------|-------|
| `/start`                         | inline                                 | Auth check + main menu. |
| `/help`                          | inline                                 | Command list. |
| `/text`                          | inline                                 | Text-mode prompt. |
| `/code [new]`                    | `modes/code_mode.ts handleCodeCommand` | Generate / list / revoke BYOK API keys. |
| `/graphics`                      | inline                                 | Placeholder (SDXL). |
| `/montage`                       | inline                                 | Montage-mode prompt. |
| `/cancel [taskId]`               | `handleCancelCommand`                  | Cancel active task. |
| `/settings`                      | `handleSettingsCommand`                | User settings. |
| `/biometric [action]`            | `handleBiometricCommand`               | Biometric enrollment. |
| `/brand [args]`                  | `handleBrandCommand`                   | Brand profile management (set / logo / font / color / list / new / delete). |
| `/skip`                          | `handleBrandSetupSkip`                 | Brand wizard logo-step skip. |
| `/projects`                      | `handleProjectsCommand`                | Project list. |
| `/newproject`                    | `handleNewProjectCommand`              | New-project wizard. |
| `/storyboard [taskId]`           | `handleStoryboardCommand`              | Storyboard status / re-send. |
| `/approve`                       | `handleApproveCommand`                 | Approve latest pending storyboard. |
| `/edit <take#> <description>`    | `handleEditCommand`                    | Edit a storyboard take. |
| `/stats`, `/health`              | inline                                 | Stats / health check. |

### Callback-query routing (Telegram inline keyboards)

| `callback_data` prefix       | Handler                                           | Notes |
|------------------------------|---------------------------------------------------|-------|
| `brand:setup:*`              | `bot/brand_setup.ts handleBrandSetupCallback`     | Brand wizard step picker (color / font / platform). |
| `sb:*`                       | `bot/handlers.ts routeCallbackQuery` → `bot/storyboard_handler.ts handleStoryboardApproval` | Storyboard approve / edit / regen / cancel. |
| `multicam:sync:<method>`     | `bot/handlers.ts handleMulticamSyncChoice`        | Multi-cam alignment choice: `auto` / `clap_detection` / `manual` / `skip`. |
| `multicam:mode:<switchMode>`| `bot/handlers.ts handleMulticamSwitchModeChoice` | Multi-cam switching mode: `smart` / `round_robin` / `beat_sync` / `speaker`. Enqueues the multi-cam montage task. |
| `mode:*`, `menu:*`, `project:*`, `chat:*`, `code:*`, `montage:*`, `task:*`, `page:*`, `confirm:*`, `cancel:` | (not yet routed in `src/index.ts`) | Existing UI keyboards — these are no-ops until future agents wire them. |

The manual-offset text input (after `multicam:sync:manual`) is intercepted inside the free-text branch of `processTelegramUpdate` and routed to `handleMulticamManualOffsetText` before the text-mode fallback.

### Multi-cam detection (multiple video uploads)

When the user sends 2+ videos within a 60-second window, `handleMediaMessage` (in `src/index.ts`) calls `handleMulticamVideoUpload` (in `bot/handlers.ts`) which:

1. Stashes the video URLs in `LOCKS` KV under `multicam:pending:<chatId>` (60s TTL).
2. Sends the multi-cam prompt with `multicamSyncKeyboard()`.
3. Returns `true` to signal the caller NOT to start a single-cam task.

The user then picks a sync method (callback `multicam:sync:*`) → switch mode (callback `multicam:mode:*`) → `handleMulticamSwitchModeChoice` enqueues a single montage task with `multicam_mode` + `multicam_videos` in the input_spec.

---

## 3. Environment variables

All env vars are declared on the `Env` interface in `src/index.ts`. Required vars MUST be set (via `wrangler secret put`); optional vars degrade gracefully when absent.

### Required (core worker)

| Env var                    | Source             | Purpose                                                  |
|----------------------------|--------------------|----------------------------------------------------------|
| `TELEGRAM_BOT_TOKEN`       | secret             | Telegram bot auth.                                       |
| `TELEGRAM_CHAT_ID_WHITELIST` | secret           | Comma-separated allowed chat ids (admin gate).           |
| `MICKY_PASSWORD_HASH`      | secret             | bcrypt hash for `/start` password prompt.                |
| `GH_PAT_SCOPED`            | secret             | GitHub Actions PAT (for the GitHub runner).              |
| `GH_WEBHOOK_SECRET`        | secret             | Shared secret for Kaggle webhook HMAC verification.      |
| `KAGGLE_API_TOKEN`         | secret             | Kaggle API bearer token.                                 |

### Required (gateway — provider API keys)

The 10 provider API keys. Each is a REQUIRED string on the `ProviderKeys` interface (`gateway/types.ts`). At runtime, an empty/missing key causes `registry.isProviderConfigured(id, env)` to return `false` and the provider is silently skipped in the cascade.

| Env var           | Provider                | Tier / notes                          |
|-------------------|-------------------------|---------------------------------------|
| `GROQ_KEY_1`      | Groq (account 1)        | Free tier — Llama 3.1 8B / 70B.       |
| `GROQ_KEY_2`      | Groq (account 2)        | Load-shedding when account 1 hits 429. |
| `GEMINI_KEY`      | Google Gemini           | AI Studio — Gemini 1.5 / 2.0 Flash.   |
| `MISTRAL_KEY`     | Mistral AI              | La Plateforme — Mistral Small / Large.|
| `OPENROUTER_KEY`  | OpenRouter              | Free models (DeepSeek, Llama, Mistral).|
| `SAMBANOVA_KEY`   | SambaNova Cloud         | Llama 3.1 405B (free Meta release).   |
| `COHERE_KEY`      | Cohere                  | Command R / Command R+.               |
| `SILICONFLOW_KEY` | SiliconFlow             | Aggregator (DeepSeek, Qwen).           |
| `CEREBRAS_KEY`    | Cerebras Cloud          | Llama 3.1 8B / 70B (ultra-low latency).|
| `NOVITA_KEY`      | Novita AI               | DeepSeek / Llama / Mistral.            |

### Optional (integration secrets — graceful degradation when absent)

| Env var                | Purpose                                                              | Fallback when absent |
|------------------------|----------------------------------------------------------------------|----------------------|
| `JAMENDO_CLIENT_ID`    | Jamendo API — free CC-licensed background music for montage pipeline. | Empty music list → pipeline falls back to silence. |
| `FREESOUND_TOKEN`      | Freesound API — SFX library.                                          | No SFX fetched. |
| `HF_TOKEN`             | HuggingFace access token (ZeroGPU montage runner).                   | `dispatchToHFSpaces` throws — Kaggle runner used. |
| `HF_SPACE_ID`          | HF Space hosting the ZeroGPU montage runner.                          | Same as `HF_TOKEN`. |
| `MODAL_TOKEN_ID`       | Modal serverless GPU — token id.                                      | `dispatchToModal` throws — Kaggle runner used. |
| `MODAL_TOKEN_SECRET`   | Modal serverless GPU — token secret.                                  | Same as `MODAL_TOKEN_ID`. |
| `MODAL_APP_NAME`       | Modal app/workspace name.                                             | Same as above. |
| `CF_ACCOUNT_ID`        | Cloudflare account id (Media Transform API + R2).                    | In-pipeline ffmpeg thumbnail extraction. |
| `CF_API_TOKEN`         | Cloudflare API token (Media:Edit + Workers:AI perms).                | Telegram-hosted output URLs only. |

### Optional (gateway cascade tunables — declared via `cascade_types.ts` declaration-merge)

These are read off `env` by `cascade_types.ts`'s `declare module '../index'` augmentation (no manual change needed in `src/index.ts`):

| Env var                              | Default | Purpose |
|--------------------------------------|---------|---------|
| `GROQ_BASE_URL`                      | (built-in) | Override Groq base URL. |
| `MISTRAL_BASE_URL`                   | (built-in) | Override Mistral base URL. |
| `OPENROUTER_BASE_URL`                | (built-in) | Override OpenRouter base URL. |
| `GEMINI_BASE_URL`                    | (built-in) | Override Gemini base URL. |
| `GROQ_DEFAULT_MODEL`                 | `llama-3.1-8b-instant` | Override Groq default model. |
| `MISTRAL_DEFAULT_MODEL`              | `mistral-small-latest` | Override Mistral default model. |
| `OPENROUTER_DEFAULT_MODEL`           | `openrouter/auto` | Override OpenRouter default model. |
| `GEMINI_DEFAULT_MODEL`               | `gemini-1.5-flash` | Override Gemini default model. |
| `GATEWAY_STICKY_TTL_MS`              | `3_600_000` (1h) | Sticky-session TTL. |
| `GATEWAY_CB_FAILURE_THRESHOLD`       | `3` | Consecutive failures before opening the 1h circuit. |
| `GATEWAY_CB_OPEN_MS`                 | `3_600_000` (1h) | Server-error circuit open duration. |
| `GATEWAY_CB_RATE_LIMIT_OPEN_MS`      | `300_000` (5min) | Rate-limit (429) circuit open duration. |
| `GATEWAY_DAILY_QUOTA_DEFAULT`        | `1000` | Default daily request quota per provider. |

---

## 4. KV namespaces required

Declared in `wrangler.toml` under `[[kv_namespaces]]`:

| Binding         | Purpose                                                          | Used by |
|-----------------|------------------------------------------------------------------|---------|
| `LOCKS`         | Task / wizard / multi-cam pending / storyboard approval state.   | `bot/handlers.ts`, `bot/brand_setup.ts`, `bot/storyboard_handler.ts`, `core/state_machine.ts`. |
| `TASK_STATUS`   | KV cache of task status (D1 mirror, TTL'd).                     | `core/state_machine.ts`, `cron.ts`. |
| `RATE_LIMITS`   | Per-API-key daily call counter (BYOK rate limit) + alert rate-limit fallback. | `src/index.ts handleChatCompletions`, `gateway/alerts.ts`. |
| `PROMPT_CACHE`  | Compiled prompt cache (1h TTL).                                  | `core/prompt_compiler.ts`. |
| `BRAND_ASSETS`  | Binary blobs for logos / fonts / intro-outro / LUTs (Task B13).  | `core/brand_profile.ts` (future `uploadAsset`), `bot/brand_setup.ts`. |

Optional `PROVIDER_ALERTS` (commented out) — when bound, the alert manager uses it for per-(provider, alert) rate-limiting instead of falling back to `RATE_LIMITS`.

---

## 5. D1 migrations needed

Apply in order before first deploy (idempotent — re-running is safe):

```bash
npx wrangler d1 execute micky-db --remote --file=migrations/0001_init.sql
npx wrangler d1 execute micky-db --remote --file=migrations/0002_enhance_memory_and_errors.sql
npx wrangler d1 execute micky-db --remote --file=migrations/0003_1_provider_ledger.sql
npx wrangler d1 execute micky-db --remote --file=migrations/0003_gateway_monitoring.sql
npx wrangler d1 execute micky-db --remote --file=migrations/0004_brand_assets.sql
```

Or all-in-one:

```bash
npx wrangler d1 execute micky-db --remote --file=migrations/_combined.sql
```

### Tables created

| Migration                        | Tables                                                                                                  | Owner |
|----------------------------------|----------------------------------------------------------------------------------------------------------|-------|
| `0001_init.sql`                  | `users`, `projects`, `chats`, `messages`, `tasks`, `api_keys`, `project_files`, `project_memory`, `system_logs`, `error_book` | Initial schema. |
| `0002_enhance_memory_and_errors.sql` | Indexes + columns on `project_memory` and `error_book`. | Memory engine + error book enhancements. |
| `0003_1_provider_ledger.sql`     | `provider_quotas`, `provider_calls`, `provider_feedback`, `conversation_provider_sticky`                | Agent A2 (gateway ledger). |
| `0003_gateway_monitoring.sql`    | `provider_health_history` + `provider_calls.event_type` / `meta` columns                                | Agent A9 (monitoring). |
| `0004_brand_assets.sql`          | `brand_profiles`, `brand_assets`                                                                          | Task B13 (brand profile). |

---

## 6. Deploy commands

### One-time setup

```bash
# 1. Create the D1 database (skip if exists)
npx wrangler d1 create micky-db
# → paste the returned database_id into wrangler.toml `[[d1_databases]]`

# 2. Create the KV namespaces (skip if exists)
npx wrangler kv namespace create LOCKS
npx wrangler kv namespace create TASK_STATUS
npx wrangler kv namespace create RATE_LIMITS
npx wrangler kv namespace create PROMPT_CACHE
npx wrangler kv namespace create BRAND_ASSETS
# → paste each returned id into wrangler.toml `[[kv_namespaces]]`

# 3. Create the queue (skip if exists)
npx wrangler queues create micky-tasks-queue

# 4. Apply migrations (see section 5)
for f in migrations/0001_init.sql migrations/0002_enhance_memory_and_errors.sql \
         migrations/0003_1_provider_ledger.sql migrations/0003_gateway_monitoring.sql \
         migrations/0004_brand_assets.sql; do
  npx wrangler d1 execute micky-db --remote --file=$f
done
```

### Secret configuration

```bash
# Core (required)
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID_WHITELIST
npx wrangler secret put MICKY_PASSWORD_HASH
npx wrangler secret put GH_PAT_SCOPED
npx wrangler secret put GH_WEBHOOK_SECRET
npx wrangler secret put KAGGLE_API_TOKEN

# Gateway — 10 provider API keys (required)
npx wrangler secret put GROQ_KEY_1
npx wrangler secret put GROQ_KEY_2
npx wrangler secret put GEMINI_KEY
npx wrangler secret put MISTRAL_KEY
npx wrangler secret put OPENROUTER_KEY
npx wrangler secret put SAMBANOVA_KEY
npx wrangler secret put COHERE_KEY
npx wrangler secret put SILICONFLOW_KEY
npx wrangler secret put CEREBRAS_KEY
npx wrangler secret put NOVITA_KEY

# Optional integrations
npx wrangler secret put JAMENDO_CLIENT_ID        # optional
npx wrangler secret put FREESOUND_TOKEN          # optional
npx wrangler secret put HF_TOKEN                  # optional
npx wrangler secret put HF_SPACE_ID               # optional
npx wrangler secret put MODAL_TOKEN_ID             # optional
npx wrangler secret put MODAL_TOKEN_SECRET         # optional
npx wrangler secret put MODAL_APP_NAME              # optional
npx wrangler secret put CF_ACCOUNT_ID               # optional
npx wrangler secret put CF_API_TOKEN                # optional
```

### Deploy

```bash
# Local dev (with hot reload)
bun run dev
# or
npx wrangler dev

# Production deploy
npx wrangler deploy

# Tail logs
npx wrangler tail
```

### Telegram webhook registration (after first deploy)

```bash
WORKER_URL="https://micky-assistant.<your-subdomain>.workers.dev"
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=${WORKER_URL}/webhook/telegram" \
  -d "allowed_updates=[\"message\",\"edited_message\",\"callback_query\"]"
```

---

## 7. Type-check status

```bash
cd worker && npx tsc --noEmit
```

**As of Agent C1 (2026-11-10): 0 errors in `src/gateway/`.**

The remaining tsc errors (if any) live in `src/bot/` and `src/core/` (legacy / unrelated to the gateway). The wrangler build uses esbuild (transpile-only) so those don't block runtime deploys.

---

## 8. File layout (post-C1)

```
worker/src/gateway/
├── INTEGRATION.md          ← this file (Agent C1)
├── README.md               ← architecture overview (Agent A1-retry)
├── MONITORING.md           ← health-check + dashboard ops docs (Agent A9)
├── ROUTER.md               ← cascade router design notes (Agent A8-retry2)
├── index.ts                ← thin re-export of routeChat/routeChatStream/handleFeedback (Agent A1-retry + A8-retry2)
├── model_router.ts         ← cascade orchestrator: routeInternal / tryProvider / recordSuccess / handleFailure (Agent A8-retry2)
├── types.ts                ← unified canonical types: ProviderId (11) / GatewayEnv / ProviderAdapter (Agent A1-retry)
├── registry.ts             ← 11-handle registry: GroqHandle / GeminiHandle / MistralHandle / WorkersAIHandle / BaseCompatHandle (Agent A1-retry)
├── cascade_types.ts        ← legacy 5-provider type system used by monitoring/alerts (Agent A8, kept — not duplicate of types.ts)
├── monitoring.ts           ← ProviderMonitor.getDashboardData (Agent A9)
├── monitoring_types.ts     ← HealthStatus / ProviderProbe / ALL_PROVIDERS / PROVIDER_PROBES (Agent A9)
├── health_checker.ts       ← runHealthCheckCron + HealthChecker (Agent A9)
├── alerts.ts               ← AlertManager (Telegram alerts on healthy→down transitions) (Agent A9)
├── metrics.ts              ← recordMetric + getMetrics (event log) (Agent A9)
├── cron_handler.ts         ← dispatchGatewayCron + resetDailyQuotas (Agent A9)
├── error_handler.ts        ← CascadeErrorHandler (legacy A8 — still used by tests)
├── sse_normalizer.ts       ← SSENormalizer class (legacy A8 — still used by tests)
├── router_helpers.ts       ← classifyIntent / resolveConversationId / CASCADE_ORDER (legacy A8 — still used by tests)
├── adapters.ts             ← makeStubAdapter / AdapterError (legacy A8 — still used by tests)
├── adapters/               ← the 11 provider adapters (Agents A3 / A4 / A6 / A10)
│   ├── _base.ts            ← BaseOpenAICompatibleAdapter (Agent A10)
│   ├── _types.ts           ← ChatStreamChunk / HealthStatus / ModelInfo / NetworkError / ProviderError / RateLimitError (Agent A10)
│   ├── types.ts            ← OpenAI-compatible shape types: ChatRequest / ChatResponse / DeltaChunk / ChatUsage (canonical adapter contract)
│   ├── groq.ts             ← groq1Adapter / groq2Adapter / GroqAdapter (Agent A3)
│   ├── gemini.ts           ← geminiAdapter / GeminiAdapter (Agent A4)
│   ├── mistral.ts          ← mistralAdapter / MistralAdapter (Agent A2/A3)
│   ├── workersai.ts        ← workersaiAdapter / WorkersAIAdapter (Agent A6-retry)
│   ├── openrouter.ts       ← OpenRouterAdapter class (Agent A6/A10)
│   ├── sambanova.ts        ← SambaNovaAdapter class (Agent A6/A10)
│   ├── cohere.ts           ← CohereAdapter class (Agent A6/A10)
│   ├── siliconflow.ts      ← SiliconFlowAdapter class (Agent A6/A10)
│   ├── cerebras.ts         ← CerebrasAdapter class (Agent A6/A10)
│   ├── novita.ts           ← NovitaAdapter class (Agent A6/A10)
│   └── README_*.md         ← per-adapter docs (quirks, auth, rate-limit notes)
├── utils/
│   ├── intent_classifier.ts ← classifyIntent / getCascadeForIntent / pickBestModel (Agent A7)
│   ├── token_counter.ts     ← countMessageTokens / willFitInProviderContext / getProviderContextLimit (Agent A7)
│   └── types.ts             ← ChatMessage / IntentType / cascade intent types (Agent A7)
├── ledger/
│   ├── ledger.ts            ← QuotaLedger class (Agent A2) — atomic decrementQuota, recordCall, record429, setProviderHealthy, getStickyProvider, setStickyProvider, recordFeedback, getHealthyProviders, resetDailyQuotas
│   ├── schema.sql           ← D1 schema for provider_quotas / provider_calls / provider_feedback / conversation_provider_sticky (Agent A2)
│   └── init.ts               ← `ensureSchema()` idempotent bootstrap (Agent A2)
└── __tests__/
    ├── model_router.test.ts ← 19 vitest tests for the new model_router (Agent A8-retry2)
    ├── error_handler.test.ts ← backoff + circuit-breaker tests (Agent A8)
    └── sse_normalizer.test.ts ← SSE normalization tests (Agent A8)
```

### Files deleted by C1 (legacy — superseded by `adapters/` + `model_router.ts`)

| File                              | Why deleted                                                          |
|-----------------------------------|----------------------------------------------------------------------|
| `gateway/provider_adapters.ts`    | Replaced by `adapters/{groq,openrouter,…}.ts` (Agent A1-retry's `registry.ts` consumes the new files). Had 2 tsc errors (`refusal` field, `chat` signature mismatch with `ProviderAdapter`). |
| `gateway/workersai_adapter.ts`    | Replaced by `adapters/workersai.ts` (Agent A6-retry). Had 8 tsc errors (missing exports, `unknown` casts, `chat` signature mismatch). |
| `gateway/cascade_router.ts`       | Replaced by `model_router.ts` (Agent A8-retry2). No tsc errors of its own, but depended on the deleted `provider_adapters.ts`. Was only referenced by the legacy `tests/model_router.test.ts` (which has 8 failing tests against the old API). |

### Files kept (not deleted — still alive)

| File                              | Why kept                                                                                              |
|-----------------------------------|--------------------------------------------------------------------------------------------------------|
| `gateway/cascade_types.ts`        | Provides the 5-provider `ProviderId` union (`workers-ai`/`groq`/`mistral`/`openrouter`/`gemini`) used by the monitoring/alerts layer (`monitoring.ts`, `alerts.ts`, `metrics.ts`, `health_checker.ts`, `monitoring_types.ts`). NOT a duplicate of `types.ts` — different (coarser) granularity. |
| `gateway/error_handler.ts`        | `CascadeErrorHandler` — used by `__tests__/error_handler.test.ts`. No tsc errors. |
| `gateway/sse_normalizer.ts`      | `SSENormalizer` — used by `__tests__/sse_normalizer.test.ts`. No tsc errors. The new `model_router.ts` does inline SSE normalization via `wrapStreamWithErrorHandler` — `SSENormalizer` is retained for tests + as a future-extension point. |
| `gateway/router_helpers.ts`       | `classifyIntent` / `resolveConversationId` / `CASCADE_ORDER` (legacy) — used by `__tests__/error_handler.test.ts`. No tsc errors. |
| `gateway/adapters.ts`             | `makeStubAdapter` / `AdapterError` (test helpers) — used by `__tests__/error_handler.test.ts`. No tsc errors. |

---

## 9. Edge-runtime compatibility

All gateway code is Workers-runtime-safe:

- Standard web globals only: `fetch`, `Headers`, `Request`, `Response`, `ReadableStream`, `TextEncoder`, `TextDecoder`, `AbortController`, `setTimeout`, `clearTimeout`, `crypto.randomUUID`, `crypto.subtle`, `Date`, `JSON`, `Map`, `Set`, `Promise`.
- No Node-only APIs (`fs`, `path`, `Buffer`, `process`, etc.).
- No `any` types — uses `unknown` + structural casts where adapter shapes don't directly match (see `registry.ts` `as unknown as Parameters<typeof ...>`).
- TypeScript strict mode compliant for all gateway files.

---

## 10. What a future agent should do

1. **Delete the orphaned `gateway/error_handler.ts` / `sse_normalizer.ts` / `router_helpers.ts` / `adapters.ts`** once their tests are migrated to the new `model_router.ts` API. Currently the only consumers are `__tests__/error_handler.test.ts` + `tests/model_router.test.ts` (legacy, 8 failing).

2. **Reconcile the 5-provider vs 11-provider granularity**. The monitoring layer (`monitoring.ts`, `alerts.ts`, `metrics.ts`, `health_checker.ts`, `cascade_types.ts`) operates on 5-provider routing-layer granularity (`workers-ai`/`groq`/`mistral`/`openrouter`/`gemini`); the registry + cascade operate on 11-provider per-key granularity (`groq1`/`groq2`/`workersai`/etc.). The `model_router.ts` casts between the two via `ledgerName()` / `normalizeProviderId()`. A future reconciliation would unify them — but the runtime behavior is correct today.

3. **Add `provider_calls.message_id` column** so `handleFeedback` can attribute feedback to the exact call (not the conversation — currently `handleFeedback` queries by `conversation_id` which works for single-turn flows only).

4. **Add a `_removeLegacy` cleanup task** to delete `cascade_types.ts`, `error_handler.ts`, `sse_normalizer.ts`, `router_helpers.ts`, `adapters.ts` once the legacy tests are migrated. The new `model_router.ts` does NOT depend on any of them.

5. **Wire the remaining `mode:*` / `menu:*` / `project:*` / `chat:*` / `code:*` / `montage:*` callback queries** — currently they're acked but no handler is invoked.
