# Deployment Guide — Micky Assistant Unlimited v2.0.0

> Step-by-step production deployment from zero to running bot. All commands are copy-pasteable.
>
> **دليل النشر الكامل** — من الصفر إلى بوت تليجرام شغّال في ~30 دقيقة. كل الأوامر جاهزة للنسخ.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Step 1 — Clone repo + install tools](#step-1--clone-repo--install-tools)
3. [Step 2 — Cloudflare D1 + migrations](#step-2--cloudflare-d1--migrations)
4. [Step 3 — KV namespaces](#step-3--kv-namespaces)
5. [Step 4 — Queue + AI binding](#step-4--queue--ai-binding)
6. [Step 5 — Set wrangler secrets](#step-5--set-wrangler-secrets)
7. [Step 6 — Deploy the Worker](#step-6--deploy-the-worker)
8. [Step 7 — Set up Kaggle kernels](#step-7--set-up-kaggle-kernels)
9. [Step 8 — Set up HF Space (optional)](#step-8--set-up-hf-space-optional)
10. [Step 9 — Wire Telegram webhook](#step-9--wire-telegram-webhook)
11. [Step 10 — Verify](#step-10--verify)
12. [Troubleshooting](#troubleshooting)

---

## 1. Prerequisites

### Accounts (all free, no card required)

| Account | URL | What you get |
|---|---|---|
| Cloudflare | https://dash.cloudflare.com/sign-up | Workers + D1 + KV + Queues + Workers AI |
| Kaggle | https://www.kaggle.com/account/login | 30h GPU/week (T4 × 2) |
| HuggingFace | https://huggingface.co/join | ZeroGPU (optional, for B-roll) |
| GitHub | https://github.com/signup | Public + private repos |
| Telegram BotFather | https://t.me/BotFather | Bot Token |

### Local tools

| Tool | Version | Install |
|---|---|---|
| Node.js | 20+ | `curl -fsSL https://deb.nodesource.com/setup_20.x \| sudo -E bash - && sudo apt install -y nodejs` |
| wrangler | 3.85+ | `npm install -g wrangler` |
| Bun (optional, faster) | 1.1+ | `curl -fsSL https://bun.sh/install \| bash` |
| Python | 3.10+ | (for Kaggle CLI) |
| kaggle CLI | latest | `pip install kaggle` |
| git | latest | `sudo apt install git` |

---

## Step 1 — Clone repo + install tools

```bash
git clone https://github.com/mickystudio/micky-infra.git
cd micky-infra/worker
npm install -g wrangler
npm install
wrangler login   # opens browser for Cloudflare OAuth
```

Verify:
```bash
wrangler --version        # 3.85+
node --version            # v20+
```

---

## Step 2 — Cloudflare D1 + migrations

### 2.1 Create the database

```bash
wrangler d1 create micky-db
```

Copy the printed `database_id` (format: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) and paste it into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "micky-db"
database_id = "<paste-here>"
```

### 2.2 Apply migrations (in order)

```bash
wrangler d1 execute micky-db --remote --file=migrations/0001_init.sql
wrangler d1 execute micky-db --remote --file=migrations/0002_enhance_memory_and_errors.sql
wrangler d1 execute micky-db --remote --file=migrations/0003_provider_gateway.sql
wrangler d1 execute micky-db --remote --file=migrations/0003_gateway_monitoring.sql
wrangler d1 execute micky-db --remote --file=migrations/0004_brand_assets.sql
wrangler d1 execute micky-db --remote --file=src/gateway/ledger/schema.sql
```

### 2.3 Verify

```bash
wrangler d1 execute micky-db --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

Expected output should include: `users`, `projects`, `chats`, `messages`, `tasks`, `brand_profiles`, `brand_assets`, `provider_quota`, `provider_health`, `provider_calls`, `conversation_provider_sticky`, `provider_feedback`, `provider_health_history`, `message_feedback`, `provider_call_log`, `conversation_sticky_session`, etc.

---

## Step 3 — KV namespaces

### 3.1 Create the 5 namespaces

```bash
wrangler kv namespace create LOCKS
wrangler kv namespace create TASK_STATUS
wrangler kv namespace create RATE_LIMITS
wrangler kv namespace create PROMPT_CACHE
wrangler kv namespace create BRAND_ASSETS
```

Each command prints an `id`. Copy all 5 into `wrangler.toml` as:

```toml
[[kv_namespaces]]
binding = "LOCKS"            # / TASK_STATUS / RATE_LIMITS / PROMPT_CACHE / BRAND_ASSETS
id = "<id-from-output>"
```

> ⚠️ The default `wrangler.toml` ships with `BRAND_ASSETS`'s `id = "placeholder-needs-creation"`. Replace it before deploy.

---

## Step 4 — Queue + AI binding

### 4.1 Create the queue

```bash
wrangler queues create micky-tasks-queue
```

### 4.2 Confirm wrangler.toml has the bindings

```toml
[[queues.producers]]
binding = "TASKS_QUEUE"
queue = "micky-tasks-queue"

[[queues.consumers]]
queue = "micky-tasks-queue"
max_batch_size = 1
max_batch_timeout = 5

[ai]
binding = "AI"

[triggers]
crons = ["*/5 * * * *", "*/30 * * * *", "0 0 * * *"]
```

The cron schedule:
- `*/5 * * * *` — Kaggle stale-task poll
- `*/30 * * * *` — gateway health-check probes (every 30 min)
- `0 0 * * *` — daily UTC-midnight quota reset (seeds today's rows for all 11 providers)

---

## Step 5 — Set wrangler secrets

You need 16 secrets total. See [`docs/SECRETS.md`](SECRETS.md) for signup URLs and which are required vs optional.

### 5.1 Telegram + admin

```bash
wrangler secret put TELEGRAM_BOT_TOKEN              # from @BotFather
wrangler secret put TELEGRAM_CHAT_ID_WHITELIST       # 1235548782 (Micky's chat_id)
wrangler secret put MICKY_PASSWORD_HASH              # bcrypt hash of your password
```

To generate the bcrypt hash:
```bash
node -e "console.log(require('bcryptjs').hashSync('your-password', 10))"
```

### 5.2 GitHub

```bash
wrangler secret put GH_PAT_SCOPED          # personal access token, scopes: repo:status + pull_requests:write
wrangler secret put GH_WEBHOOK_SECRET      # random 32-char string (also configure on GitHub webhook)
wrangler secret put KAGGLE_API_TOKEN       # from kaggle.com → Account → Create New Token
```

### 5.3 The 10 provider API keys

```bash
wrangler secret put GROQ_KEY_1          # https://console.groq.com/keys
wrangler secret put GROQ_KEY_2          # second Groq account (use a different email)
wrangler secret put GEMINI_KEY          # https://aistudio.google.com/app/apikey
wrangler secret put MISTRAL_KEY         # https://console.mistral.ai/api-keys
wrangler secret put OPENROUTER_KEY      # https://openrouter.ai/keys
wrangler secret put SAMBANOVA_KEY       # https://cloud.sambanova.ai/apis
wrangler secret put COHERE_KEY          # https://dashboard.cohere.com/api-keys
wrangler secret put SILICONFLOW_KEY     # https://cloud.siliconflow.cn/account/ak
wrangler secret put CEREBRAS_KEY        # https://cloud.cerebras.ai/
wrangler secret put NOVITA_KEY          # https://novita.ai/getKey
```

### 5.4 Optional (HF Spaces + Modal for B-roll)

```bash
wrangler secret put HF_TOKEN            # https://huggingface.co/settings/tokens (read scope)
wrangler secret put HF_SPACE_ID         # your-username/micky-broll (after creating the Space)
wrangler secret put MODAL_TOKEN_ID      # https://modal.com/settings/tokens (optional)
wrangler secret put MODAL_TOKEN_SECRET  # paired with MODAL_TOKEN_ID
wrangler secret put MODAL_APP_NAME      # your-modal-username/micky-assistant
```

### 5.5 Verify all secrets are set

```bash
wrangler secret list
```

Expected count: ~22 secrets (16 required + 6 optional).

---

## Step 6 — Deploy the Worker

```bash
wrangler deploy
```

You should see `Uploaded micky-assistant` and `https://micky-assistant.cources01.workers.dev` in the output.

### Smoke test

```bash
curl https://micky-assistant.cources01.workers.dev/health
# {"status":"ok","timestamp":...,"version":"1.0.0"}

curl https://micky-assistant.cources01.workers.dev/v1/dashboard
# {"providers":[{"id":"groq1","healthy":true,"quota":14400,...}, ...]}
```

If `/v1/dashboard` returns 11 providers with `healthy: true`, the gateway is live.

---

## Step 7 — Set up Kaggle kernels

### 7.1 Install kaggle CLI

```bash
pip install kaggle
mkdir -p ~/.kaggle
mv ~/Downloads/kaggle.json ~/.kaggle/kaggle.json   # from kaggle.com → Account → Create New Token
chmod 600 ~/.kaggle/kaggle.json
```

### 7.2 Push the notebooks

Notebooks in `kaggle/`: `montage_pipeline.ipynb` (main 10-stage pipeline), `whisper_transcribe.ipynb` (standalone WhisperX), `rvm_background.ipynb` (background removal), `sdxl_generate.ipynb` (SDXL images).

```bash
kaggle kernels push -p kaggle/    # repeat for each notebook
```

### 7.3 Create a Kaggle Dataset with the montage source

```bash
kaggle datasets init -p kaggle-src/montage/
# Edit kaggle-src/montage/dataset-metadata.json:
#   "title": "micky-montage-src", "id": "your-username/micky-montage-src"
kaggle datasets create -p kaggle-src/montage/
```

The notebooks reference this dataset (mounted at `/kaggle/input/micky-montage-src/`).

### 7.4 Set up secrets in Kaggle

In each notebook, add Kaggle secrets (Add-ons → Secrets): `HF_TOKEN` (WhisperX + B-roll models), `MICKY_WORKER_URL` (`https://micky-assistant.cources01.workers.dev`), `MICKY_WEBHOOK_SECRET` (same as `GH_WEBHOOK_SECRET`).

### 7.5 Test the montage

Open `montage_pipeline.ipynb` on Kaggle, set accelerator to GPU T4 × 2, run all cells with a test MP4. Expected output: 5 reels in `/kaggle/working/output/`.

---

## Step 8 — Set up HF Space (optional)

Skip this if you don't need B-roll generation. The pipeline falls back to Kaggle T4 when HF Space isn't configured.

### 8.1 Create a ZeroGPU Space

1. Go to https://huggingface.co/new-space
2. Name: `micky-broll`, SDK: Gradio, Hardware: ZeroGPU (free, 10s/session), Visibility: Private

### 8.2 Upload the Space code

```bash
cd kaggle-src/montage
git init
git remote add space https://huggingface.co/spaces/your-username/micky-broll
git add . && git commit -m "Initial HF Space for B-roll generation" && git push space main
```

### 8.3 Wire the worker

The `HF_SPACE_ID` secret you set in Step 5.4 lets `worker/src/runners/hf_spaces_client.ts` call the Space's API.

---

## Step 9 — Wire Telegram webhook

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://micky-assistant.cources01.workers.dev/webhook/telegram",
    "max_connections": 10,
    "allowed_updates": ["message", "callback_query", "edited_message"]
  }'
```

Verify:
```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"
# Should show: "url":"https://micky-assistant.cources01.workers.dev/webhook/telegram"
```

---

## Step 10 — Verify

Run through this checklist:

```bash
# 1. Worker health
curl https://micky-assistant.cources01.workers.dev/health
# → {"status":"ok"}

# 2. D1 reachable
wrangler d1 execute micky-db --remote --command "SELECT COUNT(*) FROM users;"
# → 1 (the seeded admin user)

# 3. KV namespaces exist
wrangler kv namespace list
# → 5 namespaces

# 4. Queue exists
wrangler queues list
# → micky-tasks-queue

# 5. All secrets set
wrangler secret list | wc -l
# → ≥16

# 6. Provider dashboard shows 11 healthy providers
curl https://micky-assistant.cources01.workers.dev/v1/dashboard | jq '.providers | length'
# → 11

# 7. Telegram webhook configured
curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo | jq '.result.url'
# → "https://micky-assistant.cources01.workers.dev/webhook/telegram"

# 8. Send /start to the bot in Telegram
# → Bot should respond asking for password

# 9. Enter password → bot authenticates you
# 10. Send /help → see the full command list
```

If all 10 checks pass, you're done. 🎉

---

## Troubleshooting

### Worker returns 503 from `/v1/chat/completions`

Likely cause: all 11 providers are circuit-open or quota-exhausted.

```bash
# Check provider health
curl https://micky-assistant.cources01.workers.dev/v1/dashboard | jq '.providers[] | {id, healthy, remaining}'

# If all are unhealthy, check the last error:
wrangler d1 execute micky-db --remote --command \
  "SELECT provider, last_error_kind, last_failure_status, circuit_open_until FROM provider_health;"

# Force-reset all circuits (emergency):
wrangler d1 execute micky-db --remote --command \
  "UPDATE provider_health SET is_healthy=1, consecutive_failures=0, circuit_open_until=0;"
```

### D1 migration fails with "column already exists"

You ran the migration twice. Migrations 0002 / 0003-gateway-monitoring / 0004 use `ALTER TABLE ADD COLUMN` which isn't idempotent in SQLite. **Solution:** skip that migration (it's already applied).

```bash
wrangler d1 execute micky-db --remote --command "PRAGMA table_info(users);"
# Check if the column already exists; if so, skip the migration
```

### KV namespace "not found" on deploy

You forgot to copy the namespace id into `wrangler.toml`. Re-run:
```bash
wrangler kv namespace list
# Copy the id for each namespace → wrangler.toml
```

### `wrangler secret put` shows `NaN` or fails

Make sure you're running it from the `worker/` directory and have run `wrangler login` first. Try `wrangler whoami` to confirm you're logged in.

### Bot doesn't respond after `/start`

1. Check webhook is set: `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo`
2. Check worker is deployed: `curl https://micky-assistant.cources01.workers.dev/health`
3. Tail the worker logs: `wrangler tail`, then send `/start` again and watch for errors.

Common causes: `TELEGRAM_CHAT_ID_WHITELIST` not set or wrong chat_id (must be `1235548782`); `MICKY_PASSWORD_HASH` malformed (must be bcrypt hash, not plaintext); D1 unreachable (check `wrangler d1 list`).

### Montage task stuck at `queued`

1. Check Kaggle kernel actually started: `kaggle kernels status your-username/montage-pipeline`
2. Check `KAGGLE_API_TOKEN` is valid: `kaggle competitions list` (should return data)
3. Force-resume a stuck task:
   ```bash
   wrangler d1 execute micky-db --remote --command \
     "UPDATE tasks SET status='failed', error_log='manual recovery' WHERE status='queued' AND queued_at < unixepoch()-3600;"
   ```

### WhisperX fails on Kaggle (missing HF_TOKEN)

WhisperX needs `HF_TOKEN` to download the pyannote diarization model. Either: set `HF_TOKEN` as a Kaggle secret (Add-ons → Secrets), or pass `skip_diarization=True` in the pipeline options.

### Telegram webhook returns 429

Telegram has a per-bot rate limit (~30 messages/sec). The bot shouldn't hit this for single-user use. If you see 429s in `wrangler tail`, check if any handler is sending multiple messages in a tight loop.

### `provider_quotas` table is empty

The daily reset cron (`0 0 * * *`) seeds today's rows. If you deployed mid-day, run it manually:

```bash
wrangler d1 execute micky-db --remote --command \
  "INSERT INTO provider_quota (provider, day, remaining, limit) VALUES
   ('groq1', date('now'), 14400, 14400), ('groq2', date('now'), 14400, 14400),
   ('gemini', date('now'), 1500, 1500), ('mistral', date('now'), 500, 500),
   ('openrouter', date('now'), 1000, 1000), ('workers-ai', date('now'), 10000, 10000),
   ('sambanova', date('now'), 1200, 1200), ('cohere', date('now'), 1000, 1000),
   ('siliconflow', date('now'), 1000, 1000), ('cerebras', date('now'), 1500, 1500),
   ('novita', date('now'), 1000, 1000) ON CONFLICT(provider, day) DO NOTHING;"
```

### B-roll generation OOM on T4

Wan2.1-T2V-1.3B needs ~8 GB VRAM. If you have WhisperX + Qwen2.5-VL loaded simultaneously, you may OOM. Either: run B-roll generation in a separate Kaggle session, disable WhisperX (`use_whisperx=False`) and use plain Whisper, or reduce `b_roll_resolution` to `(640, 360)`.

### Voice clone sounds robotic

OpenVoice v2 needs at least 3 seconds of clean reference audio. If the clone sounds robotic: use a longer reference (10-15s is ideal), make sure the reference has no background noise, or for Arabic try the Coqui XTTS v2 fallback (`voice_model='CoquiXTTS'`) — but it's NC-licensed, dev-only.

### Cron jobs not firing

```bash
wrangler tail --format=json | jq 'select(.type=="scheduled")'
```

If you see no scheduled events, check `wrangler.toml` has the `[triggers]` block with the 3 cron schedules. Redeploy after editing.

### How to roll back a deploy

```bash
wrangler deployments list
wrangler deployments rollback --version-id=<previous-version-id>
```

Cloudflare keeps the last 10 versions.

---

## Need more help?

- **Architecture deep-dive:** [`docs/architecture.md`](architecture.md)
- **API reference:** [`docs/api_reference.md`](api_reference.md)
- **Troubleshooting (Arabic):** [`docs/troubleshooting.md`](troubleshooting.md)
- **All secrets explained:** [`docs/SECRETS.md`](SECRETS.md)
- **Cascade internals:** [`docs/CASCADE_GUIDE.md`](CASCADE_GUIDE.md)
- **Montage internals:** [`docs/MONTAGE_GUIDE.md`](MONTAGE_GUIDE.md)
