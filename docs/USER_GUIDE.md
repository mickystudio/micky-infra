# User Guide — Micky Assistant Telegram Bot

> How to use the Micky Assistant Telegram bot. Every command, every workflow, every secret.
>
> **دليل المستخدم الكامل** — كل الأوامر، سير عمل المونتاج متعدد الكاميرات، وكيفية استخدام BYOK مع مساعدات البرمجة مثل Cline و Qoder.

**Bot username:** [@micky_assistant_unlimited_bot](https://t.me/micky_assistant_unlimited_bot)
**Admin chat_id:** `1235548782` (Micky only — single-tenant bot)

---

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [Text Mode](#2-text-mode)
3. [Code Mode + BYOK](#3-code-mode--byok)
4. [Montage Mode](#4-montage-mode)
5. [Storyboard Workflow](#5-storyboard-workflow)
6. [Brand Profile Management](#6-brand-profile-management)
7. [Multi-Cam Workflow](#7-multi-cam-workflow)
8. [Command Reference](#8-command-reference)

---

## 1. Getting Started

### Authentication

1. Open Telegram and search for `@micky_assistant_unlimited_bot`
2. Tap **Start** (or send `/start`)
3. The bot asks for your password
4. Enter the password (3 attempts → 24-hour lockout)
5. After successful auth, you'll see the main menu

> 🔒 **Security layers:**
> - Layer 1: chat_id whitelist (only `1235548782` can interact)
> - Layer 2: bcrypt password gate
> - Layer 3 (optional): biometric via the WebApp (Canvas page)

### Main menu

After auth, send `/help` to see all commands:

```
🤖 Micky Assistant — الأوامر المتاحة

📝 /text — محادثة نصية احترافية
💻 /code — توليد BYOK للأكواد
🎨 /graphics — إنشاء صور
🎬 /montage — مونتاج فيديو
📊 /stats — إحصائيات الاستخدام
⚙️ /settings — الإعدادات
🎨 /brand — هوية بصرية (شعار/ألوان/خطوط)
✨ /biometric — بصمة الهاتف (طبقة أمان إضافية)
🏥 /health — حالة النظام
❌ /cancel — إلغاء المهمة الحالية
```

---

## 2. Text Mode

Switch to Text Mode with `/text`. From this point, every plain text message you send is treated as a chat prompt to the LLM cascade.

### Examples

```
You: ما هي أفضل طريقة لتبييض الأسنان؟
Bot: 🦷 تبييض الأسنان له عدة خيارات احترافية:
     1. التبييض المنزلي (Custom Trays) — tray مخصص من العيادة
     2. التبييض في العيادة (In-Office) — جلسة 60-90 دقيقة
     3. تأثير يدوم 6-12 شهرًا حسب نمط الحياة...
```

```
You: write a function to validate email addresses
Bot: Here's a TypeScript function that validates email addresses:

     ```typescript
     function isValidEmail(email: string): boolean {
       const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
       return re.test(email);
     }
     ```
```

### How it works (under the hood)

1. Your message is sent to the LLM gateway
2. The intent classifier detects: `simple_chat`, `code`, `arabic`, `reasoning`, `long_context`, `tool_calling`, or `multimodal`
3. The cascade router tries the best provider for that intent (e.g. `code` → Groq qwen3-32b first, then Mistral Codestral, then ...)
4. If the first provider is rate-limited or unhealthy, it falls back to the next in the cascade
5. The response is streamed back as OpenAI-shaped SSE and re-formatted for Telegram (Markdown)

### Tips

- **Arabic works natively** — the classifier detects Arabic script >50% and routes to providers with Arabic-specialized models (Groq's `allam-2-7b`, Cohere's `aya-23-35b`).
- **Code is auto-detected** — paste any code fence (```...```) or file reference (`foo.ts`) and the classifier routes to coder-tuned models.
- **Long context** — if your message is >16K tokens (very long paste), the cascade routes to Gemini (1M context).
- **Switch back to menu** — send `/cancel` to exit Text Mode.

---

## 3. Code Mode + BYOK

`/code` switches to Code Mode and generates a BYOK ("Bring Your Own Key") API key for use in coding assistants.

### Step-by-step

1. Send `/code`
2. The bot shows your projects (or prompts to create one)
3. Pick a project (or tap "New project" and enter name + description + audience + tone)
4. Tap **"Generate new key"**
5. The bot generates: `micky_<64 random chars>` (stored as SHA-256 hash in D1 — the original is shown once and never recoverable)
6. The bot returns a YAML block ready to paste into Cline / Qoder / Roo Code:

   ```
   Base URL: https://micky-assistant.cources01.workers.dev/v1
   API Key:  micky_a1b2c3d4e5f6789...
   Model ID: auto   (or: qwen2.5-coder-32b / qwen2.5-coder-14b / qwen2.5-coder-7b)

   Custom Headers:
     X-Project-ID: proj_a3b7c9...
     X-Task-Mode: surgical   # or: explore, refactor, debug
   ```

### Using the key in Cline

1. Open Cline → Settings → API Provider → "OpenAI Compatible"
2. Paste:
   - **Base URL:** `https://micky-assistant.cources01.workers.dev/v1`
   - **API Key:** `micky_a1b2c3d4e5f6789...`
   - **Model:** `auto` (gateway picks the best provider per request)
3. Save. Start coding.

### Using the key in Qoder

1. Open Qoder → Settings → Models → Add custom model
2. Same config as Cline above

### Quick test (curl)

```bash
curl -X POST https://micky-assistant.cources01.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer micky_a1b2c3d4e5f6789..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [
      {"role": "system", "content": "You are a TypeScript expert."},
      {"role": "user", "content": "Write a function to validate email addresses."}
    ],
    "max_tokens": 1024
  }'
```

### Key management

- **List your keys:** `/keys` (in Code Mode)
- **Revoke a key:** `/keys revoke <key_id>` (or tap the "Revoke" button)
- **Rate limit:** 1000 requests/day per key (KV counter)
- **Quota:** each request goes through the 11-provider cascade — your key never expires due to upstream rate limits

### What if my key stops working?

1. Check `/health` — is the worker up?
2. Check `/stats` — have you hit the 1000/day BYOK limit?
3. If neither, your key may have been revoked. Generate a new one with `/code` → "Generate new key".

---

## 4. Montage Mode

`/montage` starts a cinematic montage project. Send a raw video, get 5 platform-ready reels back.

### Step-by-step

1. Send `/montage`
2. The bot asks for the project name (e.g. "Teeth whitening Q&A")
3. Pick an audience: `patients` (default) or `colleagues`
4. Pick a tone: `educational` (default), `enthusiastic`, `calm`
5. Send the raw video (or multiple videos for multi-cam — see [§7](#7-multi-cam-workflow))
6. The bot detects the video, queues a Kaggle task, and starts the 10-stage pipeline
7. After Stage 2 (take selection), the bot sends the **storyboard** with inline buttons (see [§5](#5-storyboard-workflow))
8. After you approve, the pipeline resumes (Stages 3-10)
9. On completion, the bot sends 5 platform-ready reels (Instagram, TikTok, YouTube, Facebook, WhatsApp) + captions + hashtags

### What the bot sends during the pipeline

```
🎬 Stage 1: Transcribing audio (WhisperX)...
✅ Transcribed: 312 words, 4 speakers detected

🎬 Stage 2: Selecting best takes...
✅ Selected 8 takes (avg score 0.81)

🎨 Storyboard ready — please review:
[photo: 3-column grid of take thumbnails]
[inline buttons: ✅ Approve | ✏️ Edit #1 | ✏️ Edit #2 | ... | 🔄 Regenerate]
⏳ Awaiting your approval (TTL: 30 minutes)

[after approval]
🎬 Stage 3: Enhancing audio...
🎬 Stage 4: Removing background (RVM)...
🎬 Stage 5: Color grading (CLIP → LUT)...
🎬 Stage 6: Generating captions (Hormozi kinetic)...
🎬 Stage 4.5: Sound design (music + SFX)...
🎬 Stage 7: Remotion animation render...
🎬 Stage 8.5: Brand overlay applied
🎬 Stage 9: Exporting to 5 platforms...

✅ اكتملت معالجة الفيديو بنجاح!
📥 [Instagram reel]
📥 [TikTok reel]
📥 [YouTube Short]
📥 [Facebook reel]
📥 [WhatsApp status]

📋 Captions:
🦷 تبييض الأسنان: ما تحتاج معرفته
#dentist #dental #teeth_whitening # улыбка ...
```

### Options you can pass

After sending the video, you can reply with text to override defaults:

| Text | Effect |
|---|---|
| `background: dental_office` | Override background (default `dental_office`) |
| `lut: warm_clinical` | Override LUT (default `medical_clean`) |
| `caption_style: minimal` | Override caption style (default `hormozi`) |
| `language: en` | Override caption language (default `ar`) |
| `add_b_roll: true` | Enable AI B-roll generation (slower) |
| `generate_variants: 2` | Generate 2 A/B variants |

---

## 5. Storyboard Workflow

After Stage 2 (take selection), the pipeline **pauses** and sends you a storyboard JPG for review.

### The storyboard image

- 3-column grid of take thumbnails (320×236 px each)
- Each cell shows the middle frame of a take
- Label: `#idx · duration · score` (e.g. `#3 · 12.4s · 0.82`)
- File size: <500 KB (auto-re-encoded until it fits Telegram's photo limit)

### Inline buttons

Each take has its own row:
- `✅ Approve` — approves all takes, resumes the pipeline
- `✏️ Edit #N` — opens an edit prompt for take N
- `🔄 Regenerate` — re-runs the take selector with a new random seed

### Editing a take

Tap `✏️ Edit #N` (or send `/edit <N> <description>`):

```
You: /edit 3 اجعل المشهد أقصر
Bot: ✏️ Editing take #3 with description: "اجعل المشهد أقصر"
     Re-running take selector for take #3...
     Updated storyboard:
     [new photo]
```

The take selector re-runs with your description as an additional constraint (the LLM scorer reads it as a hint).

### `/approve`

If you don't see the inline buttons (e.g. the message got buried), send:

```
/approve
```

The bot finds the most recent pending storyboard for your chat_id and approves it.

### `/storyboard <task_id>`

If you want to re-query the storyboard for a specific task:

```
/storyboard task_abc123
```

The bot re-sends the storyboard image (TTL still applies — if 30 minutes have passed, it returns "expired").

### Time limit

The storyboard expires after **30 minutes** (configurable in the bot). If you don't approve in time, the pipeline aborts and you'll need to re-send the video.

---

## 6. Brand Profile Management

`/brand` manages your visual identity (logo, colors, fonts, intro/outro clips). The pipeline applies your brand to every montage output.

### Show the active profile

```
/brand
```

Output:

```
🎨 ملف الهوية النشط: default

الشعار: https://...logo.png (مرفوع)
اللون الأساسي: #FF5733
اللون الثانوي: #FFFFFF
لون التمييز: #FFC300
الخط الأساسي: Anton
الخط الثانوي: Cairo
موضع الشعار: bottom-right
شفافية الشعار: 0.3
المنصة الافتراضية: tiktok
النمط الافتراضي: bold_pop

عدّل بـ: `/brand set <field> <value>`
```

### `/brand set <field> <value>`

Update one field. Available fields:

| Field | Format | Example |
|---|---|---|
| `color_primary` | hex `#RRGGBB` | `/brand set color_primary #FF5733` |
| `color_secondary` | hex `#RRGGBB` | `/brand set color_secondary #FFFFFF` |
| `color_accent` | hex `#RRGGBB` | `/brand set color_accent #FFC300` |
| `watermark_position` | `top-left`/`top-right`/`bottom-left`/`bottom-right`/`center` | `/brand set watermark_position top-right` |
| `watermark_opacity` | float 0.0-1.0 | `/brand set watermark_opacity 0.5` |
| `font_primary` | font name (e.g. `Anton`, `Cairo`, `Tajawal`) | `/brand set font_primary Tajawal` |
| `font_secondary` | font name | `/brand set font_secondary Cairo` |
| `default_platform` | `tiktok`/`youtube`/`instagram`/`reels`/`facebook` | `/brand set default_platform youtube` |
| `default_style` | `bold_pop`/`karaoke_fill`/`boxed`/`clean_lower`/`hormozi`/`tiktok_default` | `/brand set default_style hormozi` |
| `logo_url` | URL (use `/brand logo` instead for upload) | `/brand set logo_url https://...` |
| `intro_video_url` | URL | `/brand set intro_video_url https://...` |
| `outro_video_url` | URL | `/brand set outro_video_url https://...` |

### `/brand logo` (upload a logo)

1. Send `/brand logo`
2. The bot replies "أرسل صورة الشعار الآن" (waiting for a photo)
3. Reply with a photo (PNG or WebP, ≤5 MB)
4. The bot uploads it to the `BRAND_ASSETS` KV namespace and updates `brand_profiles.logo_url`

### Shortcuts

- `/brand font <name>` → equivalent to `/brand set font_primary <name>`
- `/brand color <#hex>` → equivalent to `/brand set color_primary <#hex>`

### Multiple profiles

You can have multiple brand profiles (e.g. "default", "personal", "business"):

- `/brand new business` — kick off a 4-step interactive wizard (name → color → font → logo upload)
- `/brand list` — show all profiles for your user
- `/brand profile business` — switch the active profile to "business"
- `/brand delete business` — delete a profile (refuses to delete the last one)

---

## 7. Multi-Cam Workflow

When you send **multiple** videos, the bot detects multi-cam mode and prompts for sync + switching options.

### Step-by-step

1. Send `/montage`
2. Send the **reference camera** video first (e.g. the wide shot)
3. The bot asks: "هل تريد مزامنة كاميرات إضافية؟" (Want to sync additional cameras?)
4. Tap **"Yes, sync additional cameras"**
5. Send the additional camera videos one-by-one (or all at once as a media group)
6. The bot asks you to pick a **sync method**:

| Method | What it does | When to use |
|---|---|---|
| `auto` (default) | Tries clap detection first, falls back to FFT cross-correlation | Most cases |
| `cross_correlation` | scipy FFT cross-correlation on the audio tracks | Clear audio, no claps |
| `clap_detection` | librosa spectral flux to find a clap/sync point | Live events, talks |

7. Pick a **switching mode**:

| Mode | Behavior |
|---|---|
| `smart` (default) | Picks the best camera per segment (uses VLM scorer B7) |
| `round_robin` | Cycles through cameras every N seconds (default 5s) |
| `beat_sync` | Switches on beat timestamps (from `beat_sync.py`) |
| `speaker` | Picks the camera with the loudest audio (active speaker) |

8. (Optional) preview the sync: tap **"Preview sync"** to get a side-by-side 30-second MP4 before committing
9. Tap **"Confirm + render"**
10. The pipeline runs `multicam_sync.align_videos()` → `multicam_switcher.generate_cut_plan(mode)` → `multicam_switcher.render_multicam_video()`, then proceeds through Stages 1-10 on the switched output

### Manual offset

If auto-sync fails or you want to override: `/multicam offset <camera_index> <milliseconds>` — this manually offsets a camera's audio alignment.

### Up to 4 cameras

The pipeline supports up to 4 cameras. More cameras = longer sync time (~5s per camera).

---

## 8. Command Reference

### General

| Command | Description |
|---|---|
| `/start` | Initialize / re-authenticate |
| `/help` | Show all commands |
| `/cancel` / `/cancel <task_id>` | Cancel the current operation / a specific queued task |
| `/health` | Show system health (Worker, D1, KV, AI, Queue, providers) |
| `/stats` | Show usage stats (today, this week, this month) |
| `/settings` | Show / change settings (default model, temperature, top_p, top_k, max_tokens) |
| `/biometric` | Manage biometric (phone fingerprint) auth layer |

### Modes

| Command | Description |
|---|---|
| `/text` | Switch to Text Mode (free chat) |
| `/code` | Switch to Code Mode (BYOK key management) |
| `/graphics` | Switch to Graphics Mode (image generation) |
| `/montage` | Start a new montage project |

### Projects

| Command | Description |
|---|---|
| `/projects` | List all projects |
| `/newproject` | Start the new-project wizard (name → description → audience → tone) |
| `/files` | Manage project files (upload, list, delete) |

### Storyboard

| Command | Description |
|---|---|
| `/storyboard` / `/storyboard <task_id>` | Re-show the most recent pending storyboard (or for a specific task) |
| `/approve` | Approve the most recent pending storyboard |
| `/edit <#> <description>` | Edit storyboard take `#` with the given description |

### Brand

| Command | Description |
|---|---|
| `/brand` | Show the active brand profile |
| `/brand set <field> <value>` | Update one field of the active profile |
| `/brand logo` | Set "waiting for photo" state; reply with a photo to upload the logo |
| `/brand font <name>` | Shortcut for `/brand set font_primary <name>` |
| `/brand color <#hex>` | Shortcut for `/brand set color_primary <#hex>` |
| `/brand profile <name>` | Switch the active profile (creates a new empty one if it doesn't exist) |
| `/brand list` | List all brand profiles for your user |
| `/brand new [name]` | Kick off the 4-step interactive brand setup wizard |
| `/brand delete <name>` | Delete a profile (refuses to delete the last one) |

### Multi-cam (within montage flow)

| Command | Description |
|---|---|
| (tap) `Yes, sync additional cameras` | Enter multi-cam mode after sending the first video |
| (tap) `Preview sync` / `Confirm + render` | Preview the sync / Commit + proceed |
| `/multicam offset <idx> <ms>` | Manually override a camera's audio offset |

---

## Tips & Tricks

### Quick BYOK key generation

If you already have a project and just need a new key: send `/code`, tap "Default project", tap "Generate new key". The whole flow takes 5 seconds.

### Reuse the same conversation

The gateway remembers which provider served your last message (sticky session, 1-hour TTL). If you're mid-conversation, subsequent messages go to the same provider — preserving response style. To force a fresh provider pick, send `/cancel` then start a new conversation.

### Long videos

The Kaggle T4 has a 12-hour session limit. A 5-minute source video with all features enabled takes ~25 minutes to render — well within limits. If you're processing a 30+ minute video, disable B-roll generation (`add_b_roll: false`) or split the video.

### Arabic captions

The pipeline supports Arabic natively (RTL wrapping, custom Arabic fonts). For mixed Arabic/English content, set `language: ar` and the captions will use the Arabic font for Arabic words and the Latin font for English.

### Brand profile per project

You can have multiple brand profiles and switch between them per project. For example: `default` (your main dentist brand), `personal` (personal vlog style, no logo), `business` (separate clinic brand). Use `/brand profile <name>` before sending the video to switch.

### Cancel mid-pipeline

If you realize you sent the wrong video, send `/cancel` immediately. The Kaggle task will be marked as `cancelled` on the next 5-minute stale-task poll. (The Kaggle kernel itself may keep running until completion, but its output will be discarded.)
