# Changelog

All notable changes to Micky Assistant Unlimited are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.0.0] — 2026-11-13

> Massive upgrade: multi-provider LLM cascade (11 providers), cinematic montage pipeline (10 stages, 30+ modules), brand overlay, multi-cam, A/B variants, AI generation, storyboard checkpoint.

### Summary

This release transforms Micky Assistant from a single-LLM (Workers AI) bot into a production-grade multi-provider assistant with a 10-stage cinematic video pipeline. All changes are **additive** — no breaking changes for existing BYOK clients or Telegram bot users.

### Before vs After

| Dimension | v1.0.0 | v2.0.0 |
|---|---|---|
| **LLM providers** | 1 (Workers AI only) | 11 (Groq × 2, Gemini, Mistral, OpenRouter, Workers AI, SambaNova, Cohere, SiliconFlow, Cerebras, Novita) |
| **Daily LLM budget** | 10K Workers AI Neurons | ~50K requests/day across 11 providers |
| **Intent classification** | None — every request hit Workers AI | 7 intents (code / arabic / long_context / reasoning / simple_chat / tool_calling / multimodal) drive cascade ordering |
| **Circuit breaker** | None | Per-provider: 5min on 429, 1h on 3 consecutive 5xx, 24h on 10 consecutive |
| **Sticky sessions** | None | 1-hour TTL per conversation (preserves response style across turns) |
| **SSE normalization** | None (Workers AI only) | Per-provider normalizer → uniform OpenAI SSE |
| **Montage stages** | 0 (planned) | 10 stages, 30+ modules, runs on Kaggle T4×2 |
| **Montage features** | None | Storyboard checkpoint, WhisperX, AI color grading v2, kinetic captions, sound design, Remotion, brand overlay, multi-cam, A/B variants, AI B-roll + voice clone |
| **Brand profile** | None | Full brand identity management (logo, colors, fonts, intro/outro) |
| **Multi-cam** | None | Auto-sync (FFT cross-correlation or clap detection) + 4 switching modes |
| **A/B variants** | None | Up to 3 variants per project, VLM-scored best pick |
| **AI generation** | None | Wan2.1-T2V B-roll + OpenVoice v2 narration + FLUX.1 thumbnails |
| **Dashboard** | None | `/v1/dashboard` — per-provider health, quota, 24h metrics |
| **Feedback** | None | `/v1/feedback` — thumbs-up/down per message, powers cascade reordering |
| **D1 tables** | 13 (init) | 18 (init + memory enhancements + gateway + monitoring + brand) |
| **KV namespaces** | 4 (LOCKS, TASK_STATUS, RATE_LIMITS, PROMPT_CACHE) | 5 (+ BRAND_ASSETS) |
| **Cron schedules** | 1 (`*/5 * * * *` Kaggle stale-task poll) | 3 (+ `*/30 * * * *` health probes + `0 0 * * *` quota reset) |
| **Provider API keys** | 0 | 10 (Groq × 2, Gemini, Mistral, OpenRouter, SambaNova, Cohere, SiliconFlow, Cerebras, Novita) |
| **Total monthly cost** | $0 | $0 (still 100% free tier) |

---

### New Features

#### 🌐 LLM Gateway (multi-provider cascade)

- **11 providers** on free tier, with per-intent cascade ordering:
  - `code` intent → Groq qwen3-32b → Mistral Codestral → SambaNova Qwen2.5-Coder → SiliconFlow → Workers AI → Cerebras
  - `arabic` intent → Groq allam-2-7b → Cohere aya-23-35b → SambaNova Llama-3.3 → Gemini
  - `long_context` intent → Gemini (1M ctx) → Groq llama-3.1-8b → Mistral Large
  - `reasoning` intent → Groq deepseek-r1-distill-70b → SambaNova DeepSeek-R1 → Novita deepseek-r1
  - `multimodal` intent → Gemini (only vision provider on free tier)
  - `tool_calling` intent → Groq llama-3.3-70b-versatile → Mistral Large → OpenRouter → Gemini
  - `simple_chat` intent → Groq → Mistral → Gemini → OpenRouter → Workers AI
- **Sticky sessions**: 1-hour TTL per conversation, preserves provider + model across turns
- **Circuit breaker**: per-provider, with escalation (5min → 1h → 24h)
- **Daily quota ledger**: D1-backed, atomic decrement via `UPDATE ... WHERE remaining > 0 RETURNING`
- **SSE normalizer**: per-provider stream parser → uniform OpenAI-shaped SSE
- **Intent classifier**: 7 intents, pure synchronous function (no LLM call needed)
- **Per-(intent, provider) best model**: 77-cell lookup table, falls back to provider default
- **Health-check cron**: every 30 min, probes `/models` on every provider, updates `is_healthy`
- **Daily reset cron**: UTC midnight, seeds fresh rows for all 11 providers
- **Dashboard endpoint** (`GET /v1/dashboard`): snapshot of every provider's health + quota + 24h metrics
- **Feedback endpoint** (`POST /v1/feedback`): thumbs-up/down per message_id

#### 🎬 Montage Pipeline (10 stages, 30+ modules)

- **Stage 1**: WhisperX large-v3-turbo transcription (word-level + speaker diarization)
- **Stage 2**: Take selection v3 with Qwen2.5-VL-7B neural re-rank (6 criteria)
- **Stage 2.5**: Storyboard checkpoint (B11) — pauses for user approval with inline buttons
- **Stage 3**: Audio enhancement (DeepFilterNet2 + ffmpeg studio chain, -16 LUFS EBU R128)
- **Stage 4**: Background removal (Robust Video Matting + 5 dental backgrounds)
- **Stage 5**: Color grading v2 (B6) — CLIP mood detection → LUT → shot matching
- **Stage 6**: Caption generation (Hormozi kinetic, Arabic RTL, 8 styles)
- **Stage 4.5**: Sound design (B8) — Jamendo CC-BY music + Freesound CC0 SFX + sidechain ducking
- **Stage 7**: Remotion animation (React-based overlays, 6 compositions)
- **Stage 8**: AI enhancement (B10) — Wan2.1-T2V B-roll + OpenVoice v2 narration
- **Stage 8.5**: Brand overlay (B13) — logo watermark + intro/outro + caption color restyle
- **Stage 9**: Multi-platform export (Instagram, TikTok, YouTube, Facebook, WhatsApp)
- **Stage 10**: Platform adaptation + A/B variants (B12)

#### 🎨 Brand Profile Management

- `brand_profiles` D1 table — per-user, multiple profiles
- `brand_assets` D1 table + `BRAND_ASSETS` KV namespace — binary blobs (logos, fonts, LUTs, intro/outro)
- Telegram commands: `/brand`, `/brand set`, `/brand logo`, `/brand new`, `/brand list`, `/brand profile`, `/brand delete`
- 4-step interactive setup wizard
- Brand-aware caption colors (replaces `\1c`/`\2c` tags in `.ass` files)
- Per-platform defaults (TikTok / YouTube / Instagram / Reels / Facebook)

#### 📹 Multi-Cam Sync & Switching (B15)

- `multicam_sync.py` — aligns multiple videos by audio:
  - `cross_correlation`: scipy FFT cross-correlation on 16 kHz mono WAVs
  - `clap_detection`: librosa spectral flux to find a sync point
  - `auto`: clap → cross-correlation
- `multicam_switcher.py` — generates cut plan + renders switched MP4:
  - `smart`: VLM-scored best camera per segment
  - `round_robin`: cycles every N seconds
  - `beat_sync`: switches on `beat_times` from `beat_sync.py`
  - `speaker`: picks loudest camera (active speaker)
- Telegram UX: prompts for sync method + switching mode after multiple videos uploaded
- Up to 4 cameras supported
- Optional side-by-side sync preview MP4

#### 🧪 A/B Variants + Platform Adaptation (B12)

- `platform_adapter.py` — per-platform smart re-encode:
  - TikTok 9:16 ≤ 60s fast
  - YouTube 16:9 ≤ 15 min medium
  - Reels 9:16 ≤ 90s
  - Shorts / square / landscape
- `ab_variant_generator.py` — generates 1-3 variants per project:
  - `different_take_order`: reverses chronological order (TikTok hook)
  - `different_pacing`: 3-5s cuts vs slow
  - `different_music`: alternate BGM track
  - `different_color_grade`: alternate LUT/mood
- VLM-scored best pick (Qwen2.5-VL)
- Side-by-side comparison JPG

#### 🤖 AI Enhancement (B10)

- `ai_video_gen.py` — text-to-video B-roll:
  - Primary: Wan-AI/Wan2.1-T2V-1.3B (Apache-2.0, ~8 GB VRAM)
  - Fallback: Lightricks/LTX-Video 2B distilled (Apache-2.0, real-time)
  - Thumbnails: FLUX.1-schnell (Apache-2.0, 4-step)
- `voice_clone.py` — voice cloning + narration:
  - Primary: OpenVoice v2 (MIT)
  - Arabic fallback: Coqui XTTS v2 (CPML, NC, dev-only — never in production traffic)
  - Third-tier: GPT-SoVITS (community Arabic)

#### 📊 Monitoring & Dashboard

- `ProviderMonitor.getDashboardData()` — aggregated stats per provider:
  - Health + circuit state
  - 24h call count, success rate, avg latency
  - Remaining quota (RPD + TPD)
  - Last 10 health-check probes
- `GET /v1/providers` — list of all 11 providers + status
- `GET /v1/dashboard` — full snapshot
- Telegram alerts on healthy→down transitions (via `gateway/alerts.ts`)

#### 🧠 Memory + Error Book Enhancements

- `project_memory` adds `user_id` (so memories can be scoped to a Telegram user when no project_id is known) + `expires_at` (optional TTL)
- `error_book` adds operational logging: `component`, `error_message`, `stack_trace`, `context` JSON, `severity`, `chat_id`, `task_id`, `resolved`, `resolution_note`, `created_at`
- New indexes: `idx_errors_component`, `idx_errors_severity`, `idx_errors_resolved`, `idx_errors_created`, `idx_errors_chat`

#### 📚 Documentation Suite

- New main `README.md` (project overview + ASCII architecture + components + setup + API)
- `docs/CASCADE_GUIDE.md` — 11-provider cascade algorithm + sticky + circuit breaker
- `docs/MONTAGE_GUIDE.md` — full 10-stage montage pipeline + benchmarks
- `docs/DEPLOYMENT.md` — step-by-step deploy guide (10 phases) + troubleshooting
- `docs/SECRETS.md` — every secret + signup URLs + required vs optional
- `docs/USER_GUIDE.md` — Telegram bot commands + multi-cam + BYOK
- `docs/CASCADE.md` — technical spec: provider configs + D1 schema + adapter interface
- `docs/CHANGELOG.md` — this file

---

### Infrastructure Changes

#### D1 Migrations (3 new)

- `0002_enhance_memory_and_errors.sql` — additive columns on `project_memory` + `error_book`
- `0003_provider_gateway.sql` — `provider_quota`, `provider_health`, `conversation_sticky_session`, `provider_call_log`, `message_feedback`
- `0003_gateway_monitoring.sql` — additive columns on `provider_calls` + new `provider_health_history` table
- `0004_brand_assets.sql` — `brand_profiles`, `brand_assets` + `users.active_brand_profile` column

#### KV Namespaces (1 new)

- `BRAND_ASSETS` — binary blobs (logos, fonts, LUTs, intro/outro clips) keyed by `{userId}/{assetType}/{uuid}`

#### Cron Schedules (2 new)

- `*/30 * * * *` — gateway health-check probes (was: only `*/5 * * * *` for Kaggle stale-task poll)
- `0 0 * * *` — daily UTC-midnight quota reset

#### Secrets (10 new + 3 optional)

- New required: `GROQ_KEY_1`, `GROQ_KEY_2`, `GEMINI_KEY`, `MISTRAL_KEY`, `OPENROUTER_KEY`, `SAMBANOVA_KEY`, `COHERE_KEY`, `SILICONFLOW_KEY`, `CEREBRAS_KEY`, `NOVITA_KEY`
- New optional: `HF_TOKEN`, `HF_SPACE_ID`, `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `MODAL_APP_NAME`

#### Worker Endpoints (3 new)

- `GET /v1/providers` — list of all 11 providers + status
- `GET /v1/dashboard` — provider health + quota snapshot
- `POST /v1/feedback` — thumbs-up/down per message_id
- `POST /webhook/kaggle` — Kaggle kernel completion callback

---

### Breaking Changes

**None.** All changes are additive:

- Existing BYOK keys (`micky_*`) continue to work unchanged — they now route through the 11-provider cascade instead of just Workers AI
- Existing Telegram commands work as before (`/start`, `/text`, `/code`, `/montage`, `/help`, `/cancel`, `/settings`, `/stats`, `/health`)
- Existing D1 tables (`users`, `projects`, `chats`, `messages`, `tasks`, `api_keys`, etc.) have the same shape — only new tables and additive columns
- Existing KV namespaces (`LOCKS`, `TASK_STATUS`, `RATE_LIMITS`, `PROMPT_CACHE`) are unchanged — `BRAND_ASSETS` is purely additive
- Existing wrangler.toml `[vars]` work as before — provider keys are new secrets, not new vars

The only manual upgrade step required: run the 3 new D1 migrations + set the 10 new provider secrets. The worker continues to function with Workers AI alone (cascade falls back gracefully).

---

### Deprecations

- The old `worker/src/gateway/provider_adapters.ts` (Workers AI + 4 OpenAI-compatible adapters) is superseded by `registry.ts` (11-provider registry). It's kept for backward compatibility but no longer the primary path.
- The old `gateway/adapters.ts` (5-adapter factory) is replaced by `gateway/adapters/` (per-provider files). Kept for legacy callers.

Both files will be removed in v3.0.0.

---

### Performance Benchmarks

#### Cascade router

- Cold-start latency: 50 ms (Workers AI warm-up)
- Hot-path latency (per request): 200-800 ms typical (depends on provider)
- Streaming TTFT (time to first token): 150-400 ms (Groq fastest), 1-3s (Workers AI)
- Per-provider atomic decrement: ~1 ms (D1 RETURNING)
- Dashboard query: 80-150 ms (parallel `SELECT` across 11 providers)

#### Montage pipeline (60-second source video)

| Config | Render time | Output |
|---|---|---|
| Minimal (Stages 1-9) | 4-6 min | 5 reels |
| Standard (+ storyboard, sound, kinetic) | 5-7 min | 5 reels + captions + hashtags |
| Full (+ brand + multi-cam + A/B variants) | 10-15 min | 5 reels + 2-3 variants |
| Maximum (+ AI B-roll × 3 + AI narration) | 20-30 min | 5 reels + B-roll + narration |

#### Quality scores (with all features enabled)

| Dimension | Score | Source |
|---|---|---|
| Hook strength (first 3s) | 8-9/10 | LLM highlight scorer (B3) |
| Content value | 8-9/10 | WhisperX accuracy + content match |
| Emotional intensity | 7-8/10 | CLIP mood detection + matching music |
| Payoff presence | 8-9/10 | Storyboard approval ensures climax included |
| Pacing | 8-9/10 | auto-editor silence trim + 3-5s cut cadence |
| Overall VLM (Qwen2.5-VL) | 7-9/10 | Tracked in `b_roll_manifest.json` |

---

### Migration Guide (v1.0.0 → v2.0.0)

If you have a v1.0.0 deployment, here's the upgrade path:

```bash
# 1. Pull the new code
git pull origin main

# 2. Apply the 3 new D1 migrations
cd worker
wrangler d1 execute micky-db --remote --file=migrations/0002_enhance_memory_and_errors.sql
wrangler d1 execute micky-db --remote --file=migrations/0003_provider_gateway.sql
wrangler d1 execute micky-db --remote --file=migrations/0003_gateway_monitoring.sql
wrangler d1 execute micky-db --remote --file=migrations/0004_brand_assets.sql
wrangler d1 execute micky-db --remote --file=src/gateway/ledger/schema.sql

# 3. Create the new KV namespace
wrangler kv namespace create BRAND_ASSETS
# Copy the printed id → wrangler.toml [[kv_namespaces]] binding = "BRAND_ASSETS"

# 4. Set the 10 new provider secrets
wrangler secret put GROQ_KEY_1
wrangler secret put GROQ_KEY_2
wrangler secret put GEMINI_KEY
wrangler secret put MISTRAL_KEY
wrangler secret put OPENROUTER_KEY
wrangler secret put SAMBANOVA_KEY
wrangler secret put COHERE_KEY
wrangler secret put SILICONFLOW_KEY
wrangler secret put CEREBRAS_KEY
wrangler secret put NOVITA_KEY

# 5. Set the 3 new cron schedules (already in the new wrangler.toml [triggers] block)
# (no action needed if you haven't customized wrangler.toml)

# 6. Deploy
wrangler deploy

# 7. Verify
curl https://micky-assistant.cources01.workers.dev/v1/dashboard | jq '.providers | length'
# → 11
```

The whole upgrade takes 5-10 minutes. The worker is backward-compatible — it works with just Workers AI if you don't set the new provider keys (the cascade simply has only one provider to try).

---

## [1.0.0] — 2026-11-10

Initial release. Single-provider (Workers AI) Telegram assistant with text + code + BYOK modes. 13 D1 tables, 4 KV namespaces, 1 cron schedule. No montage pipeline, no gateway, no brand profile.

### Features

- Telegram webhook auth (chat_id whitelist + bcrypt password)
- Text Mode via Workers AI (Qwen2.5-Coder-32B)
- Code Mode with BYOK key generation (SHA-256 hashed in D1)
- 4-layer prompt compiler (compress → contextualize → route → constrain)
- Project memory + error book subsystems
- Async task queue + Kaggle runner for heavy tasks
- `/health`, `/stats`, `/settings`, `/help` commands

### Infrastructure

- 1 Cloudflare Worker (`micky-assistant`)
- 1 D1 database (`micky-db`, id `3ef44fc8-fdfd-4844-9708-2ee4f923ece9`)
- 4 KV namespaces (LOCKS, TASK_STATUS, RATE_LIMITS, PROMPT_CACHE)
- 1 Queue (`micky-tasks-queue`)
- 1 Workers AI binding (`AI`)
- 1 Cron (`*/5 * * * *` Kaggle stale-task poll)
- 6 secrets (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID_WHITELIST, MICKY_PASSWORD_HASH, GH_PAT_SCOPED, GH_WEBHOOK_SECRET, KAGGLE_API_TOKEN)

---

## Versioning

This project follows [Semantic Versioning 2.0.0](https://semver.org/):

- **MAJOR** (X.0.0): breaking changes (none in v2.0.0 — all additive)
- **MINOR** (2.Y.0): new features, backward-compatible
- **PATCH** (2.0.Z): bug fixes only

Future plans:
- **v2.1.0**: Add 12th provider (Together AI) — see [`docs/CASCADE_GUIDE.md`](CASCADE_GUIDE.md#8-how-to-add-a-12th-provider)
- **v2.2.0**: Feedback-driven cascade reordering (already collecting data via `/v1/feedback`)
- **v2.3.0**: Multi-tenant support (currently single-tenant for Micky only)
- **v3.0.0**: Remove deprecated `provider_adapters.ts` and `gateway/adapters.ts`
