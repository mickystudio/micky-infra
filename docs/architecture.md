# 📖 المعمارية التفصيلية — Micky Assistant Unlimited

> هذا المستند يشرح البنية المعمارية الكاملة لمشروع Micky Assistant Unlimited: المكوّنات، تدفق البيانات، قاعدة البيانات، الربط بين الأنظمة، حدود الباقة المجانية، واستراتيجيات التعافي من الأعطال.

---

## 📑 جدول المحتويات

1. [نظرة عامة على النظام](#1-نظرة-عامة-على-النظام)
2. [مخطط المكوّنات (Component Diagram)](#2-مخطط-المكوّنات)
3. [تدفق البيانات: من رسالة المستخدم إلى الرد](#3-تدفق-البيانات)
4. [شرح مخطط قاعدة البيانات (D1 Schema)](#4-مخطط-قاعدة-البيانات)
5. [روابط الـ Worker (Bindings)](#5-روابط-ال-worker-bindings)
6. [تكامل GitHub Actions](#6-تكامل-github-actions)
7. [تكامل Kaggle GPU](#7-تكامل-kaggle-gpu)
8. [حدود الباقة المجانية](#8-حدود-الباقة-المجانية)
9. [استراتيجيات التعافي (Fallback Strategies)](#9-استراتيجيات-التعافي)

---

## 1. نظرة عامة على النظام

**Micky Assistant Unlimited** هو مساعد ذكي شخصي يعمل داخل تليجرام، مبني على بنية **Serverless** كاملة بلا خوادم تقليدية. الهدف: استبدال Oracle Cloud (الذي يتطلب بطاقة دفع) ببديل مجاني 100% وأكثر استقرارًا.

### المبادئ المعمارية الأساسية

| المبدأ | الشرح |
|---|---|
| **Serverless-first** | كل المنطق على Cloudflare Workers. لا خوادم لإدارتها. |
| **Multi-tier Fallback** | كل مكوّن له بديل جاهز عند الفشل. |
| **Stateless + Stateful separation** | المنطق stateless، البيانات في D1/KV/R2. |
| **Edge computing** | المعالجة قريبة من المستخدم (300+ موقع Cloudflare). |
| **Cost-zero** | الباقة المجانية تكفي للاستخدام الشخصي الحصري. |
| **Security-by-design** | 3 طبقات مصادقة + minimally-scoped tokens. |

### الأطراف المعنية (Actors)

| الطرف | الدور |
|---|---|
| **Micky (User)** | المستخدم الوحيد (طبيب أسنان، chat_id: 1235548782) |
| **Telegram Bot API** | واجهة المستخدم |
| **Cloudflare Worker** | الدماغ Serverless (منسّق كل العمليات) |
| **Workers AI** | محرك LLM (Qwen2.5-Coder) |
| **Cloudflare D1** | قاعدة البيانات الرئيسية |
| **Cloudflare KV** | كاش لحظي + أقفال + عدّادات |
| **Cloudflare Queues** | طوابير المهام الطويلة |
| **GitHub Actions** | عضلة تنفيذ الكود + PRs |
| **Kaggle GPU** | عضلة المونتاج + الصور الثقيلة |

---

## 2. مخطط المكوّنات

### المخطط الكامل (High-Level Architecture)

```
                            ┌──────────────────────┐
                            │  👤 Micky (المستخدم)   │
                            │  chat_id: 1235548782  │
                            └──────────┬───────────┘
                                       │
                                       │ Telegram.sendMessage
                                       │ (HTTPS, JSON)
                                       ▼
        ┌──────────────────────────────────────────────────────────┐
        │           📱 Telegram Bot API (api.telegram.org)          │
        │  @micky_assistant_unlimited_bot                            │
        └──────────────────────────────┬───────────────────────────┘
                                       │ Webhook (POST JSON)
                                       ▼
        ┌──────────────────────────────────────────────────────────┐
        │     ⚡ Cloudflare Worker (TypeScript + Edge Runtime)       │
        │     https://micky-assistant.cources01.workers.dev         │
        │                                                            │
        │   ┌──────────────────────────────────────────────────┐    │
        │   │              Router (itty-router)                 │    │
        │   │                                                  │    │
        │   │   GET  /                  → bot info             │    │
        │   │   GET  /health            → health check         │    │
        │   │   POST /webhook/telegram  → Telegram handler     │    │
        │   │   POST /webhook/github    → GitHub callbacks     │    │
        │   │   GET  /v1/models         → list models (BYOK)   │    │
        │   │   POST /v1/chat/completions → LLM proxy (BYOK)   │    │
        │   └──────────────────────────────────────────────────┘    │
        │                                                            │
        │   ┌────────────────┐  ┌────────────────────────────────┐  │
        │   │ Auth Layer     │  │ Bot Handlers (Telegram)        │  │
        │   │ • chat_id WL   │  │ • /start, /help, /text, /code  │  │
        │   │ • password     │  │ • /graphics, /montage          │  │
        │   │ • rate limits  │  │ • /projects, /stats, /health   │  │
        │   └────────────────┘  └────────────────────────────────┘  │
        │                                                            │
        │   ┌────────────────┐  ┌────────────────────────────────┐  │
        │   │ Queue Consumer │  │ BYOK Endpoint (OpenAI-compat)  │  │
        │   │ (async tasks)  │  │ • API key validation (D1)      │  │
        │   │                │  │ • Rate limiting (KV)           │  │
        │   └────────────────┘  └────────────────────────────────┘  │
        └─────┬──────────┬────────────┬───────────────┬────────────┘
              │          │            │               │
              ▼          ▼            ▼               ▼
         ┌────────┐ ┌────────┐  ┌────────────┐  ┌─────────────┐
         │ D1 DB  │ │  KV    │  │   Queue    │  │ Workers AI  │
         │        │ │        │  │            │  │             │
         │micky-db│ │4 NS    │  │ micky-     │  │ Qwen2.5-    │
         │        │ │        │  │ tasks-queue│  │ Coder-32B   │
         └────────┘ └────────┘  └─────┬──────┘  └─────────────┘
                                          │
                                          │ (async dispatch for heavy tasks)
                                          ▼
                          ┌───────────────────────────────┐
                          │     🔄 Task Dispatcher         │
                          │  • type=code      → GitHub    │
                          │  • type=montage   → Kaggle    │
                          │  • type=graphics  → Kaggle    │
                          │  • type=inference → Workers AI│
                          └──────────┬────────────────────┘
                                     │
              ┌──────────────────────┴──────────────────────┐
              │                                              │
              ▼                                              ▼
        ┌──────────────────────┐                  ┌────────────────────┐
        │ ⚙️ GitHub Actions     │                  │ 🚀 Kaggle GPU       │
        │ micky-infra (public)  │                  │ dentistmichaelnabil │
        │                       │                  │                     │
        │ Workflow runs:        │                  │ Notebooks:          │
        │  • run_inference.yml   │                  │  • montage_pipeline │
        │  • prewarm.yml         │                  │  • sdxl_generate    │
        │  • backup.yml         │                  │  • whisper_transcribe│
        │                       │                  │                     │
        │ Triggers:             │                  │ Hardware:           │
        │  • repository_dispatch │                  │  • 2× T4 GPU        │
        │  • schedule (cron)    │                  │  • 30h/week         │
        │                       │                  │  • 12h/session      │
        │ Output:               │                  │                     │
        │  • Pull Request       │                  │ Output:             │
        │  • GitHub Release     │                  │  • GitHub Release   │
        │  • Webhook callback   │                  │  • Webhook callback │
        └──────────┬───────────┘                  └─────────┬──────────┘
                   │                                         │
                   └──────────────┬──────────────────────────┘
                                  │
                                  ▼
                       ┌────────────────────────┐
                       │ POST /webhook/github   │
                       │ (Update task status    │
                       │  in D1 + notify user)  │
                       └────────────────────────┘
```

---

## 3. تدفق البيانات

### 3.1 السيناريو 1: رسالة نصية بسيطة (Text Mode)

```
الوقت    الحدث                                              المكان
─────    ────                                              ──────
0ms      Micky يرسل رسالة في تليجرام                       Telegram App
↓        Telegram يوجّه Webhook إلى Worker                 → POST /webhook/telegram
~50ms    Worker يستلم الطلب                                Cloudflare Edge
↓        ctx.waitUntil() → معالجة في الخلفية                Worker (async)
~55ms    التحقق من chat_id في whitelist                    KV/Env var
~60ms    البحث عن user في D1                               D1 query (idx on chat_id)
~65ms    التحقق من is_authorized                           D1 record
~70ms    حفظ رسالة المستخدم في D1                          INSERT INTO messages
~75ms    استدعاء Workers AI (Qwen2.5-Coder-32B)             Workers AI binding
~3-15s   انتظار رد النموذج                                 Workers AI inference
~15s     حفظ رد المساعد في D1                              INSERT INTO messages
~15s     إرسال الرد إلى Telegram                           → Telegram sendMessage API
~15.5s   Micky يرى الرد                                    Telegram App
```

### 3.2 السيناريو 2: طلب BYOK من Cline (Code Mode)

```
الوقت    الحدث
─────    ────
0ms      Cline يرسل POST /v1/chat/completions              → Worker BYOK endpoint
~5ms     استخراج API key من Authorization header           Worker
~10ms    حساب SHA-256 hash للمفتاح                         crypto.subtle.digest
~15ms    البحث في جدول api_keys (idx on key_hash)         D1 query
~20ms    التحقق: key موجود + revoked=0                    D1 record
~25ms    فحص rate limit (KV)                              KV get rate:limit:<key_id>:<date>
~30ms    إذا current >= 1000 → رفض 429                    —
~35ms    استدعاء Workers AI                                env.AI.run(model, {messages,...})
~3-15s   LLM inference                                     Workers AI
~15s     increment counter in KV (TTL 24h)                 KV put
~15s     تحديث last_used في D1                            UPDATE api_keys
~15s     تسجيل استخدام في system_logs                      INSERT INTO system_logs
~15s     إرجاع OpenAI-compatible response                 JSON {choices:[...]}
~15s     Cline يستلم الرد ويستخدمه                         Cline IDE
```

### 3.3 السيناريو 3: مونتاج فيديو (Montage Mode — async)

```
الوقت     الحدث                                                      المكان
──────    ────                                                      ──────
0s        Micky يرفع فيديو + يضغط "Montage"                          Telegram
~1s       Worker يحفظ الفيديو في R2                                  R2 put
~2s       Worker ينشئ مهمة في D1 (status=queued)                    INSERT INTO tasks
~3s       Worker يرسل رسالة لـ Queue                                  → TASKS_QUEUE.send()
~3s       Telegram يرد: "تم استلام الطلب، رقم المهمة: t5k3..."     Telegram
                                                                       ↓
~5s       Queue consumer يستلم المهمة                                 Worker (queue handler)
~6s       تحديد type=montage → dispatch إلى Kaggle                   Kaggle API
~10s      Kaggle يبدأ تشغيل Notebook                                  Kaggle GPU (T4)
~30s      Notebook يحمّل الفيديو من GitHub Release                    Kaggle
~1min     Whisper transcription                                       Kaggle (T4)
~10min    RVM background removal + LUTs + Remotion                    Kaggle (T4)
~30min    Multi-export (5 platforms)                                 Kaggle
~31min    رفع النتائج إلى GitHub Release                              GitHub
~31min    Kaggle يرسل webhook للـ Worker                              → POST /webhook/github
~31min    Worker يحدّث task status=completed                          UPDATE tasks
~31min    Worker يرسل إشعار تليجرام بالروابط                         Telegram sendMessage
~32min    Micky يرى الروابط وينزّل المخرجات                           Telegram
```

---

## 4. مخطط قاعدة البيانات

### 4.1 D1 Schema — شرح الجداول

قاعدة البيانات الرئيسية `micky-db` تحتوي على **11 جدولًا**. كل جدول له فهرس على الأعمدة الحرجة لتقليل `rows read` (مهم لأن D1 يحسب التكلفة بالقراءات).

#### 📋 الجداول الأساسية

| الجدول | الهدف | الفهرس الرئيسي |
|---|---|---|
| `users` | مستخدم واحد حصري (Micky). يحفظ `chat_id`, `password_hash`, `is_authorized`. | `chat_id` (UNIQUE) |
| `projects` | مشاريع Micky (مثل: "حملة تبييض الأسنان"). كل مشروع له `system_prompt` دائم. | `user_id` |
| `project_files` | ملفات المشروع (PDF, صور، نصوص). تحوي `extracted_text` للنصوص المستخرجة من PDF. | `project_id` |
| `chats` | محادثات داخل المشاريع. كل محادثة لها `mode` (text/code/graphics/montage). | `project_id`, `status` |

#### 💬 جداول المحادثات

| الجدول | الهدف |
|---|---|
| `messages` | كل رسالة في المحادثة (user/assistant/system). يحتوي على `prompt_compiled` و `model_used`. |
| `chat_summaries` | ملخصات تلقائية للمحادثات الطويلة (إدارة السياق). |
| `project_memory` | الذاكرة الدائمة للمشروع (تتعلم مع الوقت). حقن تلقائي في البرومبت. |

#### ⚙️ جداول التشغيل

| الجدول | الهدف |
|---|---|
| `tasks` | المهام غير المتزامنة (queue → dispatched → running → completed). |
| `file_locks` | أقفال لمنع تعارض التزامن (UNIQUE على `project_id + file_path`). |
| `error_book` | "كتاب الأخطاء" — يتعلم من الفشل. يحقن في البرومبت لتفادي التكرار. |
| `api_keys` | مفاتيح BYOK. يُخزّن `key_hash` فقط (لا الأصلي). |

#### 📊 جداول النظام

| الجدول | الهدف |
|---|---|
| `system_logs` | سجلات تشغيلية (info/warn/error). للتنقيح ومراقبة الأداء. |
| `settings` | إعدادات النظام (key-value): `default_model`, `temperature`, إلخ. |

### 4.2 مثال: جدول `tasks` بالتفصيل

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,              -- t5k3...
  chat_id TEXT,                     -- FK to chats
  type TEXT NOT NULL,               -- inference | montage | graphics | code
  status TEXT DEFAULT 'queued',     -- queued | dispatched | running | verifying | completed | failed
  priority INTEGER DEFAULT 5,       -- 1 (عاجل) → 10 (منخفض)
  runner TEXT,                      -- hf-space | github-actions | kaggle | workers-ai
  runner_job_id TEXT,               -- GH run id / kaggle kernel id
  input_spec TEXT,                  -- JSON: معطيات المهمة
  output_url TEXT,                  -- GitHub Release URL (نتيجة)
  output_meta TEXT,                 -- JSON: إحصائيات، ملفات، إلخ
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  error_log TEXT,
  queued_at INTEGER,
  dispatched_at INTEGER,
  completed_at INTEGER
);
```

#### آلة الحالة للمهمة (State Machine)

```
                        ┌────────────────────┐
                        │      queued        │ ← المهمة في الطابور
                        └──────────┬─────────┘
                                   │ Queue consumer يلتقطها
                                   ▼
                        ┌────────────────────┐
                        │    dispatched       │ ← أُرسلت للـ runner
                        └──────────┬─────────┘
                                   │ runner يبدأ التنفيذ
                                   ▼
                        ┌────────────────────┐
                        │      running       │ ← قيد التنفيذ
                        └──────────┬─────────┘
                                   │ runner ينهي ويرسل webhook
                                   ▼
                        ┌────────────────────┐
                        │     verifying      │ ← Worker يتحقق من الناتج
                        └──────────┬─────────┘
                                   │
                       ┌───────────┴───────────┐
                       │                       │
                       ▼                       ▼
              ┌────────────────┐       ┌────────────────┐
              │   completed    │       │     failed     │
              │ (نجاح)         │       │ (فشل)           │
              └────────────────┘       └────────┬───────┘
                                                │ attempts < max?
                                                ▼
                                       ┌────────────────┐
                                       │ retry → queued │
                                       └────────────────┘
```

### 4.3 KV Namespaces

| Namespace | الهدف | مثال مفتاح | TTL |
|---|---|---|---|
| `LOCKS` | أقفال الملفات (منع التزامن) | `lock:proj_x:file_y.txt` | 15min |
| `TASK_STATUS` | حالة المهمة اللحظية (كاش) | `task:status:t5k3...` | 1h |
| `RATE_LIMITS` | عدّادات الحدود اليومية | `ratelimit:7:2026-11-10` | 24h |
| `PROMPT_CACHE` | برومبت مُجمَّع (kash) | `cache:prompt:sha256hash` | 7d |

---

## 5. روابط الـ Worker (Bindings)

ملف `wrangler.toml` يربط الـ Worker بكل الموارد الخارجية:

```toml
# D1 Database
[[d1_databases]]
binding = "DB"                        # → env.DB
database_name = "micky-db"
database_id = "3ef44fc8-fdfd-4844-9708-2ee4f923ece9"

# KV Namespaces (4)
[[kv_namespaces]]
binding = "LOCKS"                     # → env.LOCKS
id = "84e47e8307464e2aa936d99a3f9dcfec"

[[kv_namespaces]]
binding = "TASK_STATUS"               # → env.TASK_STATUS
id = "499d4206e947421c83a22d0875c12c4b"

[[kv_namespaces]]
binding = "RATE_LIMITS"               # → env.RATE_LIMITS
id = "1e2a870cb5a149d9bbc5d460fc38f4aa"

[[kv_namespaces]]
binding = "PROMPT_CACHE"              # → env.PROMPT_CACHE
id = "30b885a9b31f4c749be2431e335dd690"

# Queue
[[queues.producers]]
binding = "TASKS_QUEUE"               # → env.TASKS_QUEUE.send()
queue = "micky-tasks-queue"

[[queues.consumers]]
queue = "micky-tasks-queue"
max_batch_size = 1
max_batch_timeout = 5

# Workers AI
[ai]
binding = "AI"                        # → env.AI.run()

# Environment Variables (non-secret)
[vars]
ENVIRONMENT = "production"
DEFAULT_MODEL = "@cf/qwen/qwen2.5-coder-32b-instruct"
FAST_MODEL = "@cf/qwen/qwen2.5-coder-14b-instruct"
WHISPER_MODEL = "@cf/openai/whisper-tiny-en"
ADMIN_CHAT_ID = "1235548782"
```

### قائمة Bindings الكاملة

| الربط | النوع | الاستخدام في الكود | مثال |
|---|---|---|---|
| `DB` | D1 Database | `env.DB.prepare(...).bind(...).run()` | حفظ الرسائل |
| `LOCKS` | KV | `env.LOCKS.put(key, val, {expirationTtl})` | منع تعارض الملفات |
| `TASK_STATUS` | KV | `env.TASK_STATUS.get(key)` | فحص حالة المهمة |
| `RATE_LIMITS` | KV | `env.RATE_LIMITS.put(key, count)` | عدّاد BYOK |
| `PROMPT_CACHE` | KV | `env.PROMPT_CACHE.get(hash)` | كاش البرومبت |
| `TASKS_QUEUE` | Queue | `env.TASKS_QUEUE.send(msg)` | إرسال مهمة async |
| `AI` | Workers AI | `env.AI.run(model, {messages})` | LLM inference |

### الأسرار (Secrets)

| الـ Secret | الهدف | يُحقن عبر |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API | `wrangler secret put` |
| `TELEGRAM_CHAT_ID_WHITELIST` | قائمة chat_ids المصرّح بها | `wrangler secret put` |
| `MICKY_PASSWORD_HASH` | bcrypt hash لكلمة مرور Micky | `wrangler secret put` |
| `GH_PAT_SCOPED` | Personal Access Token (scoped) | `wrangler secret put` |
| `GH_WEBHOOK_SECRET` | للتحقق من توقيع GitHub webhooks | `wrangler secret put` |
| `KAGGLE_API_TOKEN` | تشغيل Kaggle kernels | `wrangler secret put` |

---

## 6. تكامل GitHub Actions

### 6.1 لماذا GitHub Actions؟

| السبب | الشرح |
|---|---|
| **مجاني للمستودعات العامة** | دقائق غير محدودة (بدل 2000 دقيقة/شهر للخاص). |
| **متوافق مع x86_64** | يعمل عليه Ollama / llama.cpp. |
| **4 cores + 16GB RAM** | موارد كافية لـ LLM inference. |
| **مدمج مع GitHub** | فتح PRs تلقائيًا، Releases لتخزين النتائج. |

### 6.2 المستودعان

| المستودع | الرؤية | الدور |
|---|---|---|
| `mickystudio/micky-infra` | **Public** | يحوي Workflows، scripts، و GGUFs (in Releases). |
| `mickystudio/micky-vault` | **Private** | يحوي المهام الحساسة (specs, secrets). |

### 6.3 آلية الـ dispatch

```
Worker → repository_dispatch event → GitHub Actions → Workflow run → Webhook callback → Worker
                  ↓                                                                          ↓
              micky-infra                                                         تحديث task status
              (public repo)                                                       في D1 + إشعار
                                                                                   Telegram
```

#### مثال: إرسال مهمة code من Worker إلى GitHub Actions

```typescript
// في Worker (TypeScript)
await fetch(`https://api.github.com/repos/mickystudio/micky-infra/dispatches`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${env.GH_PAT_SCOPED}`,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    event_type: 'micky_task',
    client_payload: {
      task_id: 't5k3abc',
      spec_url: 'https://r2.cloudflarestorage.com/.../spec.yaml',
      callback_url: 'https://micky-assistant.cources01.workers.dev/webhook/github',
    },
  }),
});
```

### 6.4 Workflows الأساسية

| Workflow | الملف | الجدولة | الوظيفة |
|---|---|---|---|
| `runner.yml` | `.github/workflows/runner.yml` | `on: repository_dispatch` | تنفيذ مهمة LLM/code وتفتح PR |
| `prewarm.yml` | `.github/workflows/prewarm.yml` | `cron: "0 */4 * * *"` | تسخين الكاش كل 4 ساعات |
| `backup.yml` | `.github/workflows/backup.yml` | `cron: "0 2 * * *"` | نسخ احتياطي يومي لـ D1 |

### 6.5 أمان GitHub Actions

- ✅ PAT محدود الصلاحيات: فقط `repo:status` و `pull_requests:write`.
- ✅ لا أسرار في السجلات (public repo!) — كل secret عبر `secrets.GH_*`.
- ✅ التحقق من توقيع الـ webhook القادم من GitHub.
- ✅ التحقق من `runner_job_id` يطابق ما أُرسل.

---

## 7. تكامل Kaggle GPU

### 7.1 لماذا Kaggle؟

| الميزة | القيمة |
|---|---|
| **GPU مجاني** | 2× Tesla T4 (16GB كل واحد = 32GB VRAM) |
| **الحصة الأسبوعية** | 30 ساعة GPU (تكفي لـ 20-25 فيديو) |
| **مدة الجلسة** | 12 ساعة كحد أقصى |
| **التخزين المؤقت** | 50GB (مؤقت) |
| **بدون بطاقة** | حساب كاجل فقط |

### 7.2 آلية التشغيل

```
1. Worker ينشئ مهمة montage في D1 (status=queued)
2. Worker يرسل رسالة للـ Queue
3. Queue consumer يلتقطها → يحدد type=montage → dispatch إلى Kaggle
4. Worker يستدعي Kaggle API:
   POST https://www.kaggle.com/api/v1/kernels/run
   - notebook: dentistmichaelnabil/montage_pipeline
   - input: {task_id, video_url, options}
5. Kaggle يبدأ kernel على GPU
6. Notebook يحمّل الفيديو من GitHub Release
7. تنفيذ خط المعالجة (Whisper → RVM → LUTs → Remotion → multi-export)
8. رفع النتائج إلى GitHub Release
9. Kaggle يرسل webhook للـ Worker
10. Worker يحدّث task status=completed
11. Worker يرسل إشعار تليجرام بالروابط
12. Worker يتحقق من توقف Kaggle (لتفادي استنزاف الحصة)
```

### 7.3 Notebooks المستخدمة

| Notebook | الغرض |
|---|---|
| `montage_pipeline.ipynb` | خط معالجة المونتاج الكامل |
| `whisper_transcribe.ipynb` | تفريغ صوتي (للرسائل الصوتية) |
| `sdxl_generate.ipynb` | توليد صور بالذكاء الاصطناعي |
| `rvm_background.ipynb` | إزالة الخلفية (Robust Video Matting) |

### 7.4 إدارة الحصة (Quota Management)

- ✅ الـ Worker يتحقق من توقف الـ kernel بعد انتهاء كل مهمة.
- ✅ لا يُسمح بأكثر من مهمة montage متزامنة (Queue max_batch_size=1).
- ✅ مراقبة الاستخدام عبر `/stats` (إجمالي الساعات المستخدمة هذا الأسبوع).
- ⚠️ إذا قاربت الحصة على النفاد (28/30 ساعة)، يُرسل البوت تنبيهًا.

---

## 8. حدود الباقة المجانية

### 8.1 جدول الحدود الكامل

| الخدمة | الحد اليومي/الشهري | الاستخدام المتوقع | نسبة الاستخدام | الحالة |
|---|---|---|---|---|
| **Cloudflare Workers — Requests** | 100,000/يوم | < 1,000/يوم | < 1% | ✅ آمن |
| **Cloudflare Workers — CPU time** | 10ms/طلب | ~5ms avg | 50% | ⚠️ راقب |
| **Cloudflare D1 — Reads** | 5,000,000/يوم | < 50,000/يوم | < 1% | ✅ آمن |
| **Cloudflare D1 — Writes** | 100,000/يوم | < 5,000/يوم | < 5% | ✅ آمن |
| **Cloudflare D1 — Storage** | 5GB | < 500MB | < 10% | ✅ آمن |
| **Cloudflare KV — Reads** | 100,000/يوم | < 5,000/يوم | < 5% | ✅ آمن |
| **Cloudflare KV — Writes** | 1,000/يوم | < 100/يوم | < 10% | ✅ آمن |
| **Cloudflare KV — Storage** | 1GB | < 50MB | < 5% | ✅ آمن |
| **Cloudflare KV — Deletes** | 1,000/يوم | < 50/يوم | < 5% | ✅ آمن |
| **Cloudflare Queues — Operations** | 100,000/يوم | < 100/يوم | < 1% | ✅ آمن |
| **Cloudflare R2 — Storage** | 10GB | < 5GB | < 50% | ⚠️ راقب |
| **Cloudflare R2 — Class A ops** | 1,000,000/شهر | < 10,000/شهر | < 1% | ✅ آمن |
| **Workers AI — Neurons** | 10,000/يوم | ~500-2,000/يوم | 5-20% | ⚠️ راقب |
| **GitHub Actions (public)** | غير محدود | حسب الطلب | — | ✅ آمن |
| **GitHub Actions (private)** | 2,000 دقيقة/شهر | < 1,000/شهر | < 50% | ⚠️ راقب |
| **GitHub Releases** | 2GB/ملف، غير محدود | — | — | ✅ آمن |
| **Kaggle GPU** | 30h/أسبوع، 12h/جلسة | ~10-15h/أسبوع | 33-50% | ⚠️ راقب |
| **Telegram Bot API** | غير محدود | — | — | ✅ آمن |

### 8.2 استراتيجيات تجاوز الحدود

| المورد | الاستراتيجية |
|---|---|
| **Workers AI Neurons** | استخدام النموذج 14B (سريع) للأسئلة البسيطة، 32B للمعقدة. كاش البرومبت. |
| **KV Writes** | Batch writes. تجميع التحديثات. |
| **GitHub Actions (private)** | نقل Workflows غير الحساسة إلى المستودع العام. |
| **Kaggle GPU** | نقل عمليات الصور البسيطة إلى Workers AI (مدعوم محدودًا). |

---

## 9. استراتيجيات التعافي (Fallback Strategies)

> **مبدأ أساسي:** لا توجد نقطة فشل واحدة (Single Point of Failure). كل مكوّن له بديل جاهز.

### 9.1 مصفوفة Fallback

| المكوّن الأساسي | الفشل المحتمل | البديل (Fallback) | زمن التحويل |
|---|---|---|---|
| **Workers AI (Qwen2.5-Coder-32B)** | timeout / rate limit | التحول إلى Qwen2.5-Coder-14B (الأسرع) | فوري |
| **Workers AI (all models)** | توقف الخدمة كاملًا | GitHub Actions + llama.cpp (Q4_K_M) | ~5min |
| **GitHub Actions** | rate limit (private) | نقل المهمة للمستودع العام | ~2min |
| **Kaggle GPU** | نفاد الحصة | HuggingFace Space (CPU mode) | ~10min |
| **Telegram Bot API** | تجاوز الحد (30 msg/sec) | تأخير الطلبات + قائمة انتظار | فوري |
| **Cloudflare D1** | فشل مؤقت | إعادة تلقائية (Built-in retry) | ~1s |
| **Cloudflare KV** | فشل مؤقت | القراءة من D1 (أبطأ لكن متاح) | ~100ms |
| **Cloudflare Queue** | فشل مؤقت | إعادة محاولة بعد 30 ثانية (built-in) | 30s |

### 9.2 سيناريو فشل نموذجي: Workers AI timeout

```
1. Worker يرسل طلب إلى Workers AI (Qwen2.5-Coder-32B)
2. بعد 30 ثانية بدون رد → timeout
3. Worker يسجل الخطأ في error_book + system_logs
4. Worker يعيد المحاولة مع Qwen2.5-Coder-14B (الأسرع)
5. إذا نجح → إرجاع الرد للمستخدم + إشعار "تم استخدام النموذج السريع"
6. إذا فشل مرة ثانية → محاولة أخيرة عبر GitHub Actions
7. إذا فشلت كل المحاولات → إشعار المستخدم + تسجيل في error_book
```

### 9.3 سيناريو فشل نموذجي: Kaggle GPU quota exhausted

```
1. Worker يحاول dispatch مهمة montage إلى Kaggle
2. Kaggle API يرفض: "quota exceeded"
3. Worker يبحث عن HuggingFace Space بديل (CPU mode)
4. Worker يعيد جدولة المهمة في طابور منخفض الأولوية
5. Worker يرسل إشعار للمستخدم: "المهمة مؤجلة حتى تجديد الحصة يوم الأحد"
6. يوم الأحد: Scheduler تلقائي يعيد المحاولة
```

### 9.4 مراقبة الصحة (Health Monitoring)

- ✅ `/health` endpoint يعطي حالة لحظية لكل المكوّنات.
- ✅ `prewarm.yml` workflow يفحص استجابة كل خدمة كل 4 ساعات.
- ✅ `system_logs` يسجّل كل خطأ (level=error) لمشاهدة لاحقة.
- ✅ `error_book` يحفظ أنماط الأخطاء لتجنّبها مستقبلاً.

---

## 📊 ملخص المعمارية

```
                       ┌─────────────────────────────┐
                       │      Telegram (UI)           │
                       └──────────────┬──────────────┘
                                      │
                       ┌──────────────▼──────────────┐
                       │  Cloudflare Worker (الدماغ)   │
                       │  - 6 endpoints               │
                       │  - 4 handlers                │
                       │  - 7 bindings                │
                       │  - 6 secrets                 │
                       └──┬────────┬─────────┬────────┘
                          │        │         │
            ┌─────────────┘        │         └─────────────────┐
            ▼                      ▼                           ▼
       ┌─────────┐         ┌─────────────┐            ┌───────────────┐
       │   D1    │         │  Workers AI │            │  KV (4 NS)    │
       │ micky-db│         │  (Qwen LLM) │            │  (cache/locks)│
       │  11 جدول │         │             │            │               │
       └─────────┘         └─────────────┘            └───────────────┘
            │
            ▼
       ┌─────────────┐    ┌────────────────────┐    ┌────────────────┐
       │ Queue       │───▶│ GitHub Actions    │    │  Kaggle GPU    │
       │ micky-tasks │    │ micky-infra       │    │  (T4 ×2)       │
       │             │    │ (Code + LLM)      │    │ (Montage +     │
       └─────────────┘    └────────┬──────────┘    │  Graphics)     │
                                   │               └────────┬───────┘
                                   │                        │
                                   └────────┬───────────────┘
                                            ▼
                                   ┌────────────────┐
                                   │ webhook callback│
                                   │ → Worker → D1  │
                                   │ → Telegram     │
                                   └────────────────┘
```

---

**التالي:** [`deployment.md`](deployment.md) — دليل النشر خطوة بخطوة.
