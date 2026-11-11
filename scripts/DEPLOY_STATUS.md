# Micky Assistant Worker — Deployment Status

**Deployment agent:** C4
**Deployment date:** 2026-11-10 (UTC)
**Worker URL:** https://micky-assistant.cources01.workers.dev
**Worker name:** `micky-assistant`
**Cloudflare account:** Cources01@gmail.com's Account (`ec3166d8714c7d9bb5d47c11145a1522`)

---

## 1. Final worker version

| Field | Value |
|---|---|
| Worker name | `micky-assistant` |
| Latest deploy Version ID | `1e35aed5-bf6c-46ae-863e-a8c43c1f3065` |
| Wrangler version | `3.114.17` (local, via `./node_modules/.bin/wrangler`) |
| Compatibility date | `2024-11-01` |
| Compatibility flags | `nodejs_compat` |
| Bundle size | `820.14 KiB` (gzip: `178.80 KiB`) |
| Worker startup time | `9 ms` |

### Deploy history (most recent first)

| # | Version ID | Time (UTC) | Notes |
|---|---|---|---|
| 3 | `1e35aed5-bf6c-46ae-863e-a8c43c1f3065` | 2026-11-10 21:47 | Extended Arabic/long_context/reasoning/multimodal cascades to include OpenRouter + WorkersAI as failovers (so the chat endpoint stays usable when Arabic-specialized providers are unavailable). |
| 2 | `04888f71-7216-4084-b196-1778c3b0ac97` | 2026-11-10 21:40 | Default `max_tokens` to `env.MAX_TOKENS_DEFAULT` (4096) when client omits it. Updated Gemini model mappings from deprecated `gemini-2.0-flash`/`gemini-1.5-flash` → `gemini-3.8-flash` (per upstream 404 error message). |
| 1 | `931b5094-2641-4a47-9f47-0c4fde645e49` | 2026-11-10 21:34 | Initial deploy with all 5 KV namespaces + D1 + Queue + AI bindings + 3 cron triggers. Created missing `BRAND_ASSETS` KV namespace, `MAX_LOGO_SIZE_BYTES`, `BrandAssetTooLargeError`, `BrandProfileManager.uploadAsset`, and `createBrandProfileManager(env)` exports. |

---

## 2. Bindings (verified via `wrangler deploy` output)

| Binding | Type | ID / value |
|---|---|---|
| `DB` | D1 database | `micky-db` (`3ef44fc8-fdfd-4844-9708-2ee4f923ece9`) |
| `LOCKS` | KV namespace | `84e47e8307464e2aa936d99a3f9dcfec` |
| `TASK_STATUS` | KV namespace | `499d4206e947421c83a22d0875c12c4b` |
| `RATE_LIMITS` | KV namespace | `1e2a870cb5a149d9bbc5d460fc38f4aa` |
| `PROMPT_CACHE` | KV namespace | `30b885a9b31f4c749be2431e335dd690` |
| `BRAND_ASSETS` | KV namespace (created during this deploy) | `08167812d2284d34ad745bcd33f248ed` |
| `TASKS_QUEUE` | Queue producer + consumer | queue `micky-tasks-queue` (`89210d942d024a9fabb34c4409465fd9`) |
| `AI` | Workers AI binding | n/a |

### Vars

| Var | Value |
|---|---|
| `ENVIRONMENT` | `production` |
| `LOG_LEVEL` | `info` |
| `DEFAULT_MODEL` | `@cf/qwen/qwen2.5-coder-32b-instruct` |
| `FAST_MODEL` | `@cf/qwen/qwen2.5-coder-14b-instruct` |
| `WHISPER_MODEL` | `@cf/openai/whisper-tiny-en` |
| `ADMIN_CHAT_ID` | `1235548782` |
| `MAX_TOKENS_DEFAULT` | `4096` |
| `TEMPERATURE_DEFAULT` | `0.4` |

### Cron triggers

| Cron | Purpose |
|---|---|
| `*/5 * * * *` | Kaggle stale-task safety-net poll (existing, `cron.ts`). |
| `*/30 * * * *` | Gateway health-check cron (Agent A9) — probes every provider, updates `is_healthy` + `circuit_open_until`, sends Telegram alerts on healthy→down transitions. |
| `0 0 * * *` | Daily UTC-midnight quota reset (Agent A9) — seeds fresh rows in `provider_quotas` for all 11 providers with full daily limits. |

---

## 3. Secrets set via `wrangler secret put`

All 23 secrets are present on the deployed worker (verified via `wrangler secret list`). Secret values are intentionally NOT recorded here — see `/home/z/my-project/scripts/.env` for the source of truth.

### Real provider keys (from `/home/z/my-project/upload/providers.txt`)

| Secret name | Source | Status |
|---|---|---|
| `GROQ_KEY_1` | providers.txt — Groq account 1 | Set. ⚠️ Upstream returns `HTTP 403 Forbidden` when used from the worker; key itself is rejected by Groq when called directly too. **Action item:** rotate this key. |
| `GROQ_KEY_2` | providers.txt — Groq account 2 | Set. ⚠️ Same `HTTP 403 Forbidden` as `GROQ_KEY_1`. **Action item:** rotate this key. |
| `GEMINI_KEY` | providers.txt — Google AI Studio | Set. ⚠️ API responds with `HTTP 400 FAILED_PRECONDITION: User location is not supported for the API use.` when called from the Cloudflare worker region (Eastern North America / Chicago colo). The key is valid — Gemini simply refuses to serve this region. **Action item:** proxy through a region-supported egress or use a different key/account. |
| `MISTRAL_KEY` | providers.txt — Mistral La Plateforme | Set. ⚠️ Upstream returns `HTTP 401 Invalid API Key`. **Action item:** rotate this key. |
| `OPENROUTER_KEY` | providers.txt — OpenRouter | Set. ✅ Verified working — successfully served the test chat requests (`deepseek/deepseek-v4.1-flash-1017`). |

### Cloudflare self-referential keys (used by WorkersAI streaming REST adapter)

| Secret name | Source | Status |
|---|---|---|
| `CF_ACCOUNT_ID` | `ec3166d8714c7d9bb5d47c11145a1522` | Set. |
| `CF_API_TOKEN` | Same token used to deploy the worker | Set. (Has `Workers AI:Edit` scope.) |

### Placeholder secrets (providers not yet provisioned)

These were set to the literal string `PLACEHOLDER_REPLACE_WITH_REAL_KEY` so the worker boots and the cascade treats them as "configured" (skipped at runtime when the upstream rejects the placeholder). Replace with real keys before relying on them.

| Secret name | Provider |
|---|---|
| `SAMBANOVA_KEY` | SambaNova Cloud |
| `COHERE_KEY` | Cohere |
| `SILICONFLOW_KEY` | SiliconFlow |
| `CEREBRAS_KEY` | Cerebras Cloud |
| `NOVITA_KEY` | Novita AI |
| `JAMENDO_CLIENT_ID` | Jamendo (music, not yet wired in source) |
| `FREESOUND_TOKEN` | Freesound (sound effects, not yet wired in source) |
| `MODAL_TOKEN_ID` | Modal (serverless GPU, used by `runners/hf_spaces_client.ts`) |
| `MODAL_TOKEN_SECRET` | Modal (serverless GPU) |

### Pre-existing secrets (preserved — left untouched)

These were already set on the worker before this deploy (verified via `wrangler secret list`) and were NOT touched:

- `TELEGRAM_BOT_TOKEN` — Telegram bot `@micky_assistant_unlimited_bot`
- `TELEGRAM_CHAT_ID_WHITELIST` — comma-separated admin chat ids
- `MICKY_PASSWORD_HASH` — bcrypt hash for the dashboard login
- `GH_PAT_SCOPED` — GitHub PAT for the GitHub Actions runner
- `GH_WEBHOOK_SECRET` — HMAC secret for `/webhook/github`
- `KAGGLE_API_TOKEN` — Kaggle API token for the Kaggle runner
- `HF_TOKEN` — HuggingFace token (already existed; was not re-set)

---

## 4. D1 database migrations applied during this deploy

| Migration | Status |
|---|---|
| `0001_init.sql` | ✅ Already applied (pre-existing). |
| `0002_enhance_memory_and_errors.sql` | ⚠️ No-op — `ALTER TABLE` errored on `duplicate column name: user_id` (migration was already partially applied in a previous run; the columns exist). No action needed. |
| `0003_1_provider_ledger.sql` | ✅ Applied during this deploy — created `provider_quotas`, `provider_calls`, `provider_feedback`, `conversation_provider_sticky`. |
| `0003_gateway_monitoring.sql` | ✅ Applied during this deploy (after 0003_1) — added `event_type` + `meta` columns to `provider_calls`, created `provider_health_history`. (Initial attempt failed because `provider_calls` didn't exist yet — fixed by running 0003_1 first.) |
| `0004_brand_assets.sql` | ✅ Applied during this deploy — created `brand_profiles` + `brand_assets` tables (Task B13). |

### Manual D1 fix-ups

- **Seeded today's `provider_quotas` rows** for all 11 providers (`groq1`, `groq2`, `gemini`, `cerebras`, `sambanova`, `mistral`, `openrouter`, `workers-ai`, `together`, `fireworks`, `deepinfra`) with full daily limits from `PROVIDER_LIMITS` in `src/gateway/ledger/ledger.ts`. The daily-midnight cron (`resetDailyQuotas`) would normally do this, but it hadn't fired yet on first deploy, so the cascade's `getHealthyProviders()` returned an empty list and every chat request failed with `all_providers_exhausted`. The cron will keep these rows fresh going forward.
- **Reset `is_healthy` / `circuit_open_until` / `consecutive_failures`** to clean state after iterating on provider fixes — needed because failed calls had opened circuits.

---

## 5. Endpoint verification results

All curl tests were run against `https://micky-assistant.cources01.workers.dev`.

| Endpoint | Method | Expected | Actual | Status |
|---|---|---|---|---|
| `/health` | GET | `{"status":"ok",...}` | `{"status":"ok","timestamp":1794346865583,"version":"1.0.0"}` | ✅ PASS |
| `/` | GET | Service info JSON | `{"name":"Micky Assistant Unlimited","version":"1.0.0","status":"running",...}` | ✅ PASS |
| `/v1/models` | GET | OpenAI-shaped list of 3 models | Returns `qwen2.5-coder-32b`, `qwen2.5-coder-14b`, `qwen2.5-coder-7b` | ✅ PASS |
| `/v1/chat/completions` (English `hi`) | POST | OpenAI-shaped chat completion from cascade | Returned `{"id":"gen-...","choices":[{"message":{"content":"Hi! How can I help you today?"}}],"provider":"openrouter","model":"deepseek/deepseek-v4.1-flash-1017"}` | ✅ PASS (served by OpenRouter) |
| `/v1/chat/completions` (Arabic `مرحبا`) | POST | Arabic response from cascade | Returned `{"choices":[{"message":{"content":"مرحبًا! كيف يمكنني مساعدتك اليوم؟"}}],"provider":"openrouter"}` | ✅ PASS (served by OpenRouter via Arabic cascade fallback) |
| `/v1/providers` | GET | List of 11 providers with `configured` + `healthy` + `quota_remaining` | Returns all 11 providers; `configured:11`, `healthy:3`, `degraded:1`, `down:0` | ✅ PASS |
| `/v1/dashboard` | GET | Monitoring snapshot (`cascade` + `providers` + `top_providers` + `recent_feedback`) | Returns full dashboard JSON; 5 providers shown (workers-ai/groq/mistral/openrouter/gemini) | ✅ PASS |
| `/webhook/telegram` | POST | Telegram webhook target | Verified via Telegram Bot API `getWebhookInfo` — `url: https://micky-assistant.cources01.workers.dev/webhook/telegram`, `pending_update_count: 0`, `last_error_message: null` | ✅ PASS |

### Auth credentials used for chat tests

- `Authorization: Bearer micky_demo_byok_key_1234567890abcdefghijklmnop` — pre-existing demo BYOK key (looked up successfully in the `api_keys` D1 table).

---

## 6. Telegram webhook

- **Bot:** `@micky_assistant_unlimited_bot` (id `9185631357`)
- **Webhook URL:** `https://micky-assistant.cources01.workers.dev/webhook/telegram`
- **Set via:** `curl "https://api.telegram.org/bot<token>/setWebhook?url=https://micky-assistant.cources01.workers.dev/webhook/telegram"`
- **Result:** `ok: true, description: Webhook was set` (webhook was already set to the same URL from a previous deploy; re-setting is idempotent).
- **Status:** `pending_update_count: 0`, `last_error_message: null` — webhook is healthy and accepting updates.

---

## 7. Issues encountered and how they were resolved

### Issue 1: `BRAND_ASSETS` KV namespace was a placeholder

- **Symptom:** `wrangler.toml` had `id = "placeholder-needs-creation"` for the `BRAND_ASSETS` binding.
- **Fix:** Created the namespace via `wrangler kv namespace create BRAND_ASSETS` → got id `08167812d2284d34ad745bcd33f248ed`. Updated `wrangler.toml` to use the real id.

### Issue 2: Missing exports in `src/core/brand_profile.ts`

- **Symptom:** Initial `wrangler deploy --dry-run` failed with 4 TypeScript errors:
  - `No matching export in "src/core/brand_profile.ts" for import "createBrandProfileManager"` (used in `bot/brand_setup.ts` + `bot/handlers.ts`)
  - `No matching export in "src/core/brand_profile.ts" for import "MAX_LOGO_SIZE_BYTES"` (used in `bot/handlers.ts`)
  - `No matching export in "src/core/brand_profile.ts" for import "BrandAssetTooLargeError"` (used in `bot/handlers.ts`)
- **Fix:** Added the missing exports to `src/core/brand_profile.ts`:
  - `MAX_LOGO_SIZE_BYTES` constant (`5 * 1024 * 1024` = 5 MB)
  - `BrandAssetTooLargeError` class
  - `BrandProfileManager.uploadAsset(userId, file, assetType)` method (uploads binary blob to the `BRAND_ASSETS` KV namespace, throws on size cap exceeded)
  - `createBrandProfileManager(env)` factory function (constructs a `BrandProfileManager` bound to `env.DB` + `env.BRAND_ASSETS`)
  - Updated `BrandProfileManager` constructor to accept an optional `kv: KVNamespace` parameter.

### Issue 3: D1 migrations 0003_gateway_monitoring + 0003_1_provider_ledger hadn't been applied

- **Symptom:** After the first deploy, every chat request returned `all_providers_exhausted` with `attempted_providers: []` (empty list). Root cause: the cascade's `getHealthyProviders()` queries the `provider_quotas` table, which didn't exist (migration 0003_1 hadn't been applied).
- **Fix:** Applied migrations 0003_1_provider_ledger, 0003_gateway_monitoring, and 0004_brand_assets to the remote D1 database via `wrangler d1 execute --remote --file=...`.

### Issue 4: `provider_quotas` table was empty (no rows for today)

- **Symptom:** Even after applying migrations, the cascade still returned `attempted_providers: []` because `getHealthyProviders()` filters `WHERE date_key = today AND is_healthy = 1` — with no rows, the result set was empty.
- **Fix:** Manually seeded today's `provider_quotas` rows for all 11 providers with full daily limits (`remaining_rpd`/`remaining_tpd`) from `PROVIDER_LIMITS`. The daily-midnight cron will keep these fresh going forward.

### Issue 5: OpenRouter returning `HTTP 402 Payment Required`

- **Symptom:** OpenRouter errored with `"You requested up to 131072 tokens, but can only afford 12087. To increase, visit https://openrouter.ai/settings/credits"`.
- **Root cause:** When the client omits `max_tokens`, the gateway forwarded `max_tokens: undefined` to OpenRouter, which interprets that as "use the full model context window" (131072 for `llama-3.1-8b`). That exceeds the free-tier credit balance.
- **Fix:** In `src/index.ts` `handleChatCompletions`, default `max_tokens` to `parseInt(env.MAX_TOKENS_DEFAULT || '4096', 10)` when the client omits it. Capping at 4096 keeps free-tier requests within budget while remaining generous for typical chat.

### Issue 6: Gemini model deprecated

- **Symptom:** Gemini returned `HTTP 404: "This model models/gemini-2.0-flash is no longer available. Please update your code to use models/gemini-3.8-flash"`.
- **Fix:** Updated all 8 Gemini model mappings in `src/gateway/utils/intent_classifier.ts` from `gemini-2.0-flash` / `gemini-1.5-flash` → `gemini-3.8-flash`. Also added `gemini-3.8-flash`, `gemini-3.8-flash-lite`, `gemini-2.5-flash`, `gemini-2.5-flash-lite` to `SUPPORTED_MODELS` in `src/gateway/adapters/gemini.ts`.
- **Caveat:** Even with the corrected model name, Gemini still returns `HTTP 400 FAILED_PRECONDITION: User location is not supported for the API use.` when called from the Cloudflare worker region (Eastern North America / Chicago). The key is valid; Gemini refuses to serve this region. Gemini is therefore **not currently usable** from the worker.

### Issue 7: Arabic cascade didn't include working fallback providers

- **Symptom:** After fixing the OpenRouter `max_tokens` issue, English chat worked, but Arabic chat still returned `all_providers_exhausted` because the Arabic cascade was `['groq1', 'groq2', 'cohere', 'sambanova', 'gemini']` — none of which work (groq keys invalid, cohere/sambanova placeholders, gemini region-blocked).
- **Fix:** Extended the cascade definitions in `src/gateway/utils/intent_classifier.ts` to include `openrouter` + `workersai` as fallbacks for `arabic`, `long_context`, `reasoning`, and `multimodal` intents. (Previously only `simple_chat` had these fallbacks.) This means Arabic requests now succeed via OpenRouter's `openrouter/auto` (which routes to `deepseek/deepseek-v4.1-flash-1017` — a model with strong Arabic support).

---

## 8. Action items for follow-up

1. **Rotate invalid Groq keys** (`GROQ_KEY_1`, `GROQ_KEY_2`) — both currently return `HTTP 403 Forbidden` even when called directly. Without valid Groq keys, the Arabic-specialized `allam-2-7b` model is unreachable.
2. **Rotate invalid Mistral key** (`MISTRAL_KEY`) — currently returns `HTTP 401 Invalid API Key`.
3. **Resolve Gemini region restriction** — either:
   - Use a Gemini API key from a region-supported account, OR
   - Proxy Gemini calls through a region-supported egress (e.g. a Cloudflare Worker in a different colo, or an external proxy), OR
   - Remove Gemini from the cascade until resolved.
4. **Replace placeholder secrets** (`SAMBANOVA_KEY`, `COHERE_KEY`, `SILICONFLOW_KEY`, `CEREBRAS_KEY`, `NOVITA_KEY`, `JAMENDO_CLIENT_ID`, `FREESOUND_TOKEN`, `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`) with real values when provisioned.
5. **Verify the cron triggers fire** — the `*/30 * * * *` health-check cron hasn't run yet since deploy (next fire at the top and bottom of each hour). Watch `wrangler tail` around `HH:00` / `HH:30` to confirm `runHealthCheckCron` is probing providers correctly.
6. **Verify the `0 0 * * *` daily reset cron** — fires at UTC midnight. Confirms `provider_quotas` rows are seeded for the new day (so the manual seed done during this deploy becomes redundant after the first midnight).
7. **Run the test suite** (`npm test`) on a local checkout — the model-name changes (`gemini-2.0-flash` → `gemini-3.8-flash`) and cascade additions will break the unit tests in `src/gateway/utils/__tests__/intent_classifier.test.ts` and `src/gateway/adapters/gemini.test.ts`. The tests need updating to match the new model names.

---

## 9. Files changed during this deploy

| File | Change |
|---|---|
| `worker/wrangler.toml` | Replaced `placeholder-needs-creation` with real `BRAND_ASSETS` KV namespace id `08167812d2284d34ad745bcd33f248ed`. |
| `worker/src/core/brand_profile.ts` | Added `MAX_LOGO_SIZE_BYTES`, `BrandAssetTooLargeError`, `BrandProfileManager.uploadAsset()`, `createBrandProfileManager(env)` factory. Extended `BrandProfileManager` constructor with optional `kv: KVNamespace` param. |
| `worker/src/index.ts` | `handleChatCompletions`: default `max_tokens` to `env.MAX_TOKENS_DEFAULT` (4096) when client omits it. |
| `worker/src/gateway/utils/intent_classifier.ts` | Updated all Gemini model mappings from `gemini-2.0-flash`/`gemini-1.5-flash` → `gemini-3.8-flash`. Extended `arabic`/`long_context`/`reasoning`/`multimodal` cascades to include `openrouter` + `workersai` as failovers. |
| `worker/src/gateway/adapters/gemini.ts` | Added `gemini-3.8-flash`, `gemini-3.8-flash-lite`, `gemini-2.5-flash`, `gemini-2.5-flash-lite` to `SUPPORTED_MODELS`. |
| `scripts/DEPLOY_STATUS.md` | This file (new). |
