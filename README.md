# Micky Assistant Unlimited 🤖

> **مساعد Micky الشخصي اللامحدود** — مساعد ذكي احترافي يعمل داخل تليجرام، مبني بالكامل على بنية Cloudflare المجانية بلا بطاقة دفع. يدعم 11 مزوّد LLM، خط مونتاج سينمائي متكامل (30+ وحدة بايثون)، ونظام BYOK متوافق مع OpenAI.

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Workers AI](https://img.shields.io/badge/Workers%20AI-Qwen2.5--Coder-0052CC?logo=cloudflare)](https://developers.cloudflare.com/workers-ai/)
[![Telegram Bot](https://img.shields.io/badge/Telegram-Bot-26A5E4?logo=telegram&logoColor=white)](https://t.me/micky_assistant_unlimited_bot)
[![License](https://img.shields.io/badge/License-Private-red)]()

**Version 2.0.0** — multi-provider LLM cascade + cinematic montage pipeline + brand overlay + multi-cam + A/B variants + AI generation.

---

## 📌 Project Overview

Micky Assistant Unlimited is a single-tenant Telegram assistant built for one dentist (Micky, chat_id `1235548782`). It bundles four professional capabilities behind one chat interface — text chat, code generation, AI graphics, and cinematic video montage — all running on free-tier infrastructure with zero monthly cost.

| Capability | What it does | Output |
|---|---|---|
| 📝 **Text Mode** | OpenAI-compatible multi-provider cascade (11 LLM providers) | Markdown replies, Arabic-native |
| 💻 **Code Mode** | BYOK key generator for coding assistants (Cline / Qoder / Roo Code) | API key + YAML block, 1000 calls/day |
| 🎬 **Montage Mode** | 10-stage cinematic pipeline on Kaggle T4 GPU | 5 platform-ready reels + captions + hashtags |
| 🎨 **Graphics Mode** | Image generation (HF Spaces, Modal, Workers AI) | High-res images + canvas editor |

> **السبب من المشروع:** بديل مجاني كامل لـ Oracle Cloud / ChatGPT Plus / Adobe Premiere. كل المكوّنات على الباقات المجانية، لا توجد أي رسوم خفية.

---

## 🏗️ Architecture (ASCII)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       📱 Telegram (@micky_assistant_unlimited_bot)            │
│                       chat_id: 1235548782 (Micky only)                       │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ HTTPS Webhook
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                ⚡ Cloudflare Worker (micky-assistant, serverless)             │
│                https://micky-assistant.cources01.workers.dev                   │
│                                                                               │
│   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────────────────┐   │
│   │ Webhook      │ │ BYOK API     │ │ Queue        │ │ Prompt Compiler    │   │
│   │ Handlers     │ │ /v1/chat     │ │ Manager      │ │ (4-layer pipeline) │   │
│   └──────────────┘ └──────────────┘ └──────────────┘ └────────────────────┘   │
│                                                                               │
│   ┌──────────────────────────────────────────────────────────────────────┐    │
│   │   🌐 LLM Gateway (multi-provider cascade, 11 providers)               │    │
│   │   ┌──────────────────┐    ┌─────────────────┐    ┌──────────────┐    │    │
│   │   │ Intent          │ -> │ Cascade Router  │ -> │ SSE         │    │    │
│   │   │ Classifier (7)  │    │ (sticky + CB)   │    │ Normalizer  │    │    │
│   │   └──────────────────┘    └─────────────────┘    └──────────────┘    │    │
│   └──────────────────────────────────────────────────────────────────────┘    │
│                                                                               │
│   Bindings: D1 (DB) · 5× KV · TASKS_QUEUE · AI (Workers AI)                   │
└──────┬────────────────────────┬──────────────────────┬─────────────────────────┘
       │                        │                       │
       ▼                        ▼                       ▼
┌──────────────┐    ┌────────────────────┐   ┌──────────────────────────┐
│ 🗄️ D1 DB     │    │ 📦 KV Namespaces    │   │ 🤖 11 LLM Providers      │
│ micky-db      │    │ • LOCKS             │   │ ┌──────────────────────┐ │
│ (5 GB free)   │    │ • TASK_STATUS       │   │ │ groq1 / groq2        │ │
│               │    │ • RATE_LIMITS       │   │ │ gemini / mistral     │ │
│ 13 tables:    │    │ • PROMPT_CACHE      │   │ │ openrouter / workers │ │
│ users,        │    │ • BRAND_ASSETS      │   │ │ sambanova / cohere   │ │
│ projects,     │    └────────────────────┘   │ │ siliconflow          │ │
│ chats, msgs,  │                             │ │ cerebras / novita    │ │
│ tasks,        │                             │ └──────────────────────┘ │
│ brand_assets, │                             └──────────────────────────┘
│ quotas,       │
│ call_log,     │                             ┌──────────────────────────┐
│ feedback...   │                             │ 🔄 Cron + Queue          │
└──────────────┘                             │ • */5 min: stale tasks   │
                                             │ • */30 min: health probe │
                                             │ • 0 UTC: quota reset     │
                                             └────────────┬─────────────┘
                                                          │
                                                          ▼
                       ┌──────────────────────────────────────────────────────┐
                       │  🎬 Montage Pipeline (Kaggle GPU, 30 modules)        │
                       │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐         │
                       │  │Whisper │→│Takes   │→│Audio   │→│BG Remv │→ ...    │
                       │  │large-v3│ │selector│ │enhance │ │(RVM)   │         │
                       │  └────────┘ └────────┘ └────────┘ └────────┘         │
                       │  → Color → Captions → Sound → Remotion → Export       │
                       │  → (optional) B-roll + Voice clone + Multi-cam        │
                       └──────────────────────────────────────────────────────┘
                                              │
                                              ▼
                       ┌──────────────────────────────────────────────────────┐
                       │  📦 Output: 5 platform-ready reels (TikTok/YT/IG/...) │
                       │  + captions (.ass + .srt) + hashtags + manifest.json  │
                       └──────────────────────────────────────────────────────┘
```

---

## 🧩 Components

### 1. Worker (Cloudflare, TypeScript)
The orchestrator. Receives Telegram updates + BYOK HTTP requests and dispatches them to the gateway, queue, or montage runners.

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/` | GET | none | Bot info / landing |
| `/health` | GET | none | Liveness probe |
| `/webhook/telegram` | POST | Telegram | Receive bot updates |
| `/webhook/github` | POST | HMAC | GitHub Actions callbacks |
| `/webhook/kaggle` | POST | shared secret | Kaggle kernel completion |
| `/v1/chat/completions` | POST | `micky_*` BYOK key | OpenAI-compatible chat |
| `/v1/models` | GET | BYOK key | List models (32B / 14B / 7B Qwen) |
| `/v1/providers` | GET | BYOK key | List 11 providers + status |
| `/v1/dashboard` | GET | none | Provider health + quota snapshot |
| `/v1/feedback` | POST | none | Thumbs-up/down per message |

### 2. Gateway — Multi-Provider LLM Cascade
11 providers on the free tier, dispatched by intent:

| # | Provider | Default model | Free tier (RPD / TPD) | Notes |
|---|---|---|---|---|
| 1 | `groq1` | `llama-3.1-8b-instant` | 14,400 / 1M | Primary fast |
| 2 | `groq2` | `llama-3.1-8b-instant` | 14,400 / 1M | Backup Groq account |
| 3 | `gemini` | `gemini-2.0-flash` | 1,500 / 1M | Only vision in free tier |
| 4 | `mistral` | `mistral-small-latest` | 500 / 500K | Monthly quota |
| 5 | `openrouter` | `openrouter/auto` | 1,000 / 1M | Aggregator |
| 6 | `workersai` | `@cf/meta/llama-3.1-8b-instruct` | 10,000 / 5M | Cloudflare binding |
| 7 | `sambanova` | `DeepSeek-V3.1` | 1,200 / 500K | Per-model rate limits |
| 8 | `cohere` | `command-a-plus-05-2026` | 1,000/mo / — | Monthly quota |
| 9 | `siliconflow` | `deepseek-ai/DeepSeek-V3` | ~$2 credit / — | Vendor-prefix model ids |
| 10 | `cerebras` | `qwen-3.8-27b` | 1,500 / 500K | Ultra-fast (2k tok/s) |
| 11 | `novita` | `deepseek/deepseek-v4.1-flash` | voucher / — | Per-model base URLs |

Cascade ordering is per-intent — see [`docs/CASCADE_GUIDE.md`](docs/CASCADE_GUIDE.md).

### 3. Montage Pipeline (Kaggle GPU, Python)
30+ modules organized into 10 stages. Runs on Kaggle T4×2 (32 GB VRAM, 30h/week free). Input: raw 1080p 9:16 vertical video (Redmi Note 13 + Boya BY-V30 mic). Output: 5 platform-ready reels.

| Stage | Module | Input → Output |
|---|---|---|
| 1 | `whisperx_engine.py` | audio → word-level transcript (JSON) |
| 2 | `take_selector_v3.py` | transcript + video → best takes (with VLM re-rank) |
| 3 | `audio_enhancer_v2.py` | audio → -16 LUFS EBU R128 normalized WAV |
| 4 | `background_remover.py` | video → matted video (RVM + 5 dental backgrounds) |
| 5 | `color_grader_v2.py` | video → color-graded video (CLIP mood → LUT) |
| 6 | `caption_generator.py` | transcript → Hormozi kinetic captions (.ass) |
| 4.5 | `sound_designer.py` | music (Jamendo CC-BY) + SFX (Freesound CC0) + ducking |
| 7 | `remotion_renderer.py` | React-based animations + kinetic text |
| 8 | `ai_video_gen.py` + `voice_clone.py` | (optional) B-roll + cloned narration |
| 8.5 | `brand_overlay.py` | (optional) logo watermark + intro/outro |
| 9 | `multi_export.py` | render → 5 platform exports (IG/TikTok/YT/FB/WA) |
| 10 | `platform_adapter.py` + `ab_variant_generator.py` | (optional) platform-spec re-encode + A/B variants |

See [`docs/MONTAGE_GUIDE.md`](docs/MONTAGE_GUIDE.md) for the full stage-by-stage breakdown.

### 4. D1 Database (`micky-db`, id `3ef44fc8-fdfd-4844-9708-2ee4f923ece9`)
13 tables across 4 migrations:

| Migration | Tables added |
|---|---|
| `0001_init.sql` | users, projects, project_files, chats, messages, chat_summaries, project_memory, tasks, file_locks, error_book, api_keys, system_logs, settings |
| `0002_enhance_memory_and_errors.sql` | adds `user_id`, `expires_at` to project_memory; adds operational cols to error_book |
| `0003_provider_gateway.sql` | provider_quota, provider_health, conversation_sticky_session, provider_call_log, message_feedback |
| `0003_gateway_monitoring.sql` | provider_health_history (additive on ledger schema) |
| `0004_brand_assets.sql` | brand_profiles, brand_assets (adds `active_brand_profile` to users) |

### 5. KV Namespaces (5)

| Binding | Purpose |
|---|---|
| `LOCKS` | Distributed locks + storyboard pending tokens (TTL 10 min) |
| `TASK_STATUS` | Async task status cache (KV read-your-writes) |
| `RATE_LIMITS` | BYOK per-key daily counters (1000/day each) |
| `PROMPT_CACHE` | Compiled prompt cache (4-layer compiler) |
| `BRAND_ASSETS` | Binary blobs: logos, fonts, LUTs, intro/outro clips |

### 6. Queue + Cron

- **Queue** `micky-tasks-queue` — async dispatch for heavy tasks (Kaggle, GitHub Actions). Consumer batch size 1, 5s timeout.
- **Cron** (3 schedules in `wrangler.toml`):
  - `*/5 * * * *` — Kaggle stale-task safety-net poll
  - `*/30 * * * *` — provider health-check probes (updates `is_healthy` + `circuit_open_until`)
  - `0 0 * * *` — daily UTC-midnight quota reset (seeds fresh rows for all 11 providers)

---

## 🚀 Setup

### Prerequisites
- Cloudflare account (no card) — https://dash.cloudflare.com/sign-up
- Kaggle account (free T4 GPU, 30h/week) — https://www.kaggle.com/account/login
- HuggingFace account (optional, for ZeroGPU B-roll) — https://huggingface.co/join
- GitHub account (public + private repo) — https://github.com/signup
- Telegram BotFather (Bot Token) — https://t.me/BotFather

### 5-minute Quickstart

```bash
# 1) Clone the repo
git clone https://github.com/mickystudio/micky-infra.git
cd micky-infra/worker

# 2) Install tools
npm install -g wrangler
npm install
pip install kaggle  # for kaggle CLI

# 3) Login + create D1 database
wrangler login
wrangler d1 create micky-db       # copy database_id → wrangler.toml

# 4) Apply migrations (in order)
wrangler d1 execute micky-db --remote --file=migrations/0001_init.sql
wrangler d1 execute micky-db --remote --file=migrations/0002_enhance_memory_and_errors.sql
wrangler d1 execute micky-db --remote --file=migrations/0003_provider_gateway.sql
wrangler d1 execute micky-db --remote --file=migrations/0003_gateway_monitoring.sql
wrangler d1 execute micky-db --remote --file=migrations/0004_brand_assets.sql
wrangler d1 execute micky-db --remote --file=src/gateway/ledger/schema.sql

# 5) Create KV namespaces (5)
for ns in LOCKS TASK_STATUS RATE_LIMITS PROMPT_CACHE BRAND_ASSETS; do
  wrangler kv namespace create "$ns"
  # copy the printed id → wrangler.toml
done

# 6) Create Queue
wrangler queues create micky-tasks-queue

# 7) Set secrets (see docs/SECRETS.md for the full list)
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID_WHITELIST
wrangler secret put MICKY_PASSWORD_HASH
wrangler secret put GH_PAT_SCOPED
wrangler secret put GH_WEBHOOK_SECRET
wrangler secret put KAGGLE_API_TOKEN
# 10 provider keys:
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

# 8) Deploy the worker
wrangler deploy

# 9) Wire Telegram webhook
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://micky-assistant.cources01.workers.dev/webhook/telegram"

# 10) Set up Kaggle kernels (montage_pipeline, whisper_transcribe, rvm_background, sdxl_generate)
#     and HF Space (optional). See docs/DEPLOYMENT.md.
```

📖 **Full deployment guide:** [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)
📖 **All secrets + signup URLs:** [`docs/SECRETS.md`](docs/SECRETS.md)

---

## 📱 User Guide (Telegram)

### Authentication
1. Send `/start` to `@micky_assistant_unlimited_bot`
2. Enter password (3 attempts → 24h lockout)
3. Optional biometric layer via the WebApp

### Commands

| Command | Description |
|---|---|
| `/help` | Show all commands |
| `/text` | Switch to Text Mode (free chat) |
| `/code` | Generate a BYOK API key (paste code after to analyze) |
| `/graphics` | Switch to image generation mode |
| `/montage` | Start a new montage project (then send a video) |
| `/storyboard` | Re-show pending storyboard |
| `/approve` | Approve the most recent pending storyboard |
| `/edit <#> <desc>` | Edit storyboard take `#` with description |
| `/brand` | Show active brand profile |
| `/brand set <field> <value>` | Update brand field (color_primary, font_primary, ...) |
| `/brand logo` | Reply with a photo to set the logo |
| `/brand new [name]` | Kick off the 4-step brand wizard |
| `/brand list` | List all brand profiles |
| `/brand profile <name>` | Switch active profile |
| `/cancel` | Cancel the current operation |

### Multi-cam workflow
1. Send `/montage`
2. Send the first camera video (the reference)
3. Bot asks "Multi-cam?" → tap "Yes, sync additional cameras"
4. Send additional camera videos one by one (or all in a media group)
5. Choose sync method: `auto` / `cross_correlation` / `clap_detection`
6. Choose switch mode: `smart` / `round_robin` / `beat_sync` / `speaker`
7. Pipeline runs MultiCamSync → MultiCamSwitcher, then proceeds through stages 1-10

### BYOK (Bring Your Own Key)
1. Send `/code` to generate a key (`micky_<64 random chars>`)
2. Bot returns YAML ready to paste into Cline / Qoder / Roo Code
3. Use `https://micky-assistant.cources01.workers.dev/v1` as base URL
4. Send any code paste — bot will analyze it

📖 **Detailed user guide:** [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md)

---

## 📡 API Reference

All endpoints accept `Content-Type: application/json` and respond with JSON or SSE.

### `POST /v1/chat/completions` (OpenAI-compatible)

```bash
curl -X POST https://micky-assistant.cources01.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer micky_a1b2c3d4e5f6..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [
      {"role": "system", "content": "You are a TypeScript expert."},
      {"role": "user", "content": "Write a function to validate email addresses."}
    ],
    "max_tokens": 1024,
    "temperature": 0.4,
    "stream": false
  }'
```

Response (OpenAI-shaped):
```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1731216000,
  "model": "llama-3.1-8b-instant",
  "choices": [{"index":0, "message":{"role":"assistant","content":"..."}, "finish_reason":"stop"}],
  "usage": {"prompt_tokens":42, "completion_tokens":156, "total_tokens":198},
  "provider": "groq1",
  "model_used": "llama-3.1-8b-instant"
}
```

The gateway picks the provider + model based on the intent (code / reasoning / arabic / long_context / multimodal / tool_calling / simple_chat). Streaming returns OpenAI-shaped SSE (`data: {...}\n\n`).

### `GET /v1/models`
Returns the model list (Qwen 32B / 14B / 7B + cascade aliases).

### `GET /v1/providers`
Returns the 11 providers with health + remaining quota.

### `GET /v1/dashboard`
Returns a snapshot: per-provider health, circuit state, 24h call count, success rate, avg latency, tokens used.

### `POST /v1/feedback`
```json
{ "message_id": "msg_abc123", "rating": 1 }  // 1 = thumbs up, -1 = down
```
Records feedback on the provider that served the message. Powers cascade reordering.

---

## 💰 Free Tier Usage

| Service | Free quota | Expected usage | Status |
|---|---|---|---|
| Cloudflare Workers | 100K req/day | < 1K req/day | ✅ Safe |
| Cloudflare D1 | 5M reads + 100K writes/day, 5 GB | < 50K reads/day | ✅ Safe |
| Cloudflare KV | 100K reads + 1K writes/day | < 5K reads/day | ✅ Safe |
| Cloudflare Queues | 100K ops/day | < 100 ops/day | ✅ Safe |
| Workers AI | 10K Neurons/day | 500-2000/day | ⚠️ Monitor |
| Kaggle GPU | 30h/week + 12h/session | 10-15h/week | ⚠️ Monitor |
| GitHub Actions (public) | unlimited | on-demand | ✅ Safe |
| Telegram Bot API | unlimited | — | ✅ Safe |

> **الخلاصة:** All services use <10% of the free quota. Zero monthly cost.

---

## 🛠️ Local Development

```bash
cd worker
npm run dev              # Miniflare local worker
npm run tail             # Tail production logs
npm run db:query "SELECT * FROM users LIMIT 5;"
npm run db:migrate       # Apply pending migrations
npm test                 # Run vitest suite
```

Requirements: Node.js 20+, wrangler 3.85+, TypeScript 5.6+.

---

## 📚 Documentation Index

| File | Purpose |
|---|---|
| [📖 `docs/CASCADE_GUIDE.md`](docs/CASCADE_GUIDE.md) | The 11-provider cascade algorithm, intent rules, sticky sessions, circuit breaker |
| [🎬 `docs/MONTAGE_GUIDE.md`](docs/MONTAGE_GUIDE.md) | Full 10-stage montage pipeline + optional features + benchmarks |
| [🚀 `docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Step-by-step deploy guide (10 phases) + troubleshooting |
| [🔑 `docs/SECRETS.md`](docs/SECRETS.md) | Every secret / env var, where to get each, required vs optional |
| [📱 `docs/USER_GUIDE.md`](docs/USER_GUIDE.md) | Telegram bot commands + multi-cam workflow + BYOK usage |
| [🔧 `docs/CASCADE.md`](docs/CASCADE.md) | Technical spec: provider configs, rate limits, D1 schema, adapter interface |
| [📋 `docs/CHANGELOG.md`](docs/CHANGELOG.md) | Version 2.0.0 changes, before/after, breaking changes |
| [🏗️ `docs/architecture.md`](docs/architecture.md) | Legacy architecture deep-dive (Arabic) |
| [📡 `docs/api_reference.md`](docs/api_reference.md) | Legacy full API reference (Arabic) |
| [🛠️ `docs/troubleshooting.md`](docs/troubleshooting.md) | Common issues + fixes (Arabic) |

---

## 📄 License Notes

| Component | License | Notes |
|---|---|---|
| Worker (TypeScript) | Private / personal | Owned by Micky, not for redistribution |
| Whisper (large-v3) | MIT | Open source, commercial-safe |
| WhisperX | BSD-4-Clause | Subprocess invocation, commercial-safe |
| DeepFilterNet2 | MIT | Subprocess invocation |
| Robust Video Matting | MIT | Subprocess invocation |
| Remotion | MIT (core) | Source-available, free for individuals; commercial orgs need a Remotion license |
| PySceneDetect | BSD-3-Clause | MIT-equivalent |
| auto-editor | MIT | Subprocess |
| FFmpeg | LGPL/GPL | Linked dynamically; GPL components isolated |
| LUTs (3D) | CC0 / CC-BY | Public domain or attribution |
| Jamendo music | CC-BY (Jamendo Licensing) | Attribution required in caption |
| Freesound SFX | CC0 / CC-BY | Mostly CC0 |
| Wan2.1-T2V (B-roll) | Apache-2.0 | Commercial-safe |
| OpenVoice v2 (voice clone) | MIT | Commercial-safe |
| Coqui XTTS v2 | Coqui Public Model License | **NC — dev-only fallback**, never ships in production |
| FLUX.1-schnell (thumbnails) | Apache-2.0 | Commercial-safe |
| Qwen2.5-Coder / Llama 3.x | Apache-2.0 / Llama License | Commercial-safe with attribution |

> **GPL-via-subprocess** = the GPL component runs as a separate OS process (not linked into the worker bundle). The worker only spawns it. This keeps the worker source non-GPL.

> **NC-dev-only** = the model license forbids commercial use. Loaded only when no MIT/Apache alternative is available; never invoked in production traffic.

---

## 📋 Project Status

| Phase | Status |
|---|---|
| Phase 0 — Infrastructure | ✅ Complete (Worker + D1 + KV + Queue + Cron) |
| Phase 1 — Core (auth, projects, chats, memory) | ✅ Complete |
| Phase 2 — Text Mode (gateway + cascade + SSE) | ✅ Complete (11 providers) |
| Phase 3 — Code Mode (BYOK + API key management) | ✅ Complete |
| Phase 4 — Montage Mode (10 stages, 30+ modules) | ✅ Complete (incl. storyboard, brand, multi-cam, A/B, AI gen) |
| Phase 5 — Graphics Mode (HF Spaces + Modal) | ✅ Complete |
| Phase 6 — Polish + docs + deployment | ✅ Complete (v2.0.0) |

---

## 📞 Support

- **Owner:** Micky (dentist, chat_id `1235548782`)
- **Bot:** [@micky_assistant_unlimited_bot](https://t.me/micky_assistant_unlimited_bot)
- **Worker URL:** https://micky-assistant.cources01.workers.dev

---

<div align="center">

**صُنع بحب لـ Micky 🦷✨**

*Version 2.0.0 — multi-provider cascade + cinematic montage pipeline*

</div>
