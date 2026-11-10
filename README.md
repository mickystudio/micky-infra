# Micky Assistant Unlimited 🤖

> **مساعد Micky الشخصي اللامحدود** — مساعد ذكي احترافي يعمل داخل تليجرام، مبني بالكامل على بنية Cloudflare المجانية بلا بطاقة دفع.

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Workers AI](https://img.shields.io/badge/Workers%20AI-Qwen2.5--Coder-0052CC?logo=cloudflare)](https://developers.cloudflare.com/workers-ai/)
[![Telegram Bot](https://img.shields.io/badge/Telegram-Bot-26A5E4?logo=telegram&logoColor=white)](https://t.me/micky_assistant_unlimited_bot)
[![License](https://img.shields.io/badge/License-Private-red)]()

---

## 📌 ما هذا المشروع؟

**Micky Assistant Unlimited** هو مساعد شخصي ذكي مصمّم خصيصًا لطبيب الأسنان **Micky**. يجمع المساعد بين أربع قدرات احترافية في واجهة تليجرام واحدة بسيطة:

| الوضع | الوصف | المخرج |
|---|---|---|
| 📝 **Text Mode** | محادثة نصية احترافية تنافس Claude/ChatGPT | ردود نصية بتنسيق Markdown |
| 💻 **Code Mode** | مولّد مفاتيح BYOK لمساعدات البرمجة (Cline/Qoder) | API key + YAML block جاهز للنسخ |
| 🎨 **Graphics Mode** | إنشاء صور احترافية بالذكاء الاصطناعي | صور بدقة عالية + تحرير عبر Canvas |
| 🎬 **Montage Mode** | محرك مونتاج سينمائي طبي كامل | 5 مخرجات فيديو لمنصات مختلفة |

> **السبب من المشروع:** بديل مجاني كامل لـ Oracle Cloud الذي يتطلب بطاقة دفع. كل المكوّنات تعمل على الباقات المجانية بلا تكلفة.

---

## ✨ المميزات الرئيسية

### 1. أربعة أوضاع في مساعد واحد
بدلاً من الاشتراك في ChatGPT Plus + Midjourney + Adobe Premiere + Claude API، يجمع Micky Assistant Unlimited كل هذه القدرات في بوت تليجرام واحد.

### 2. مجاني 100% بلا بطاقة دفع
كل البنية التحتية على Cloudflare Free Tier + GitHub Actions (public) + Kaggle GPU المجاني. لا توجد أي رسوم خفية.

### 3. آمن ومحمي
- **طبقة 1:** ربط `chat_id` حصري (Whitelist صارمة).
- **طبقة 2:** كلمة مرور bcrypt (3 محاولات فقط ثم حظر 24 ساعة).
- **طبقة 3 (اختياري):** بصمة الهاتف عبر WebApp (Biometric).

### 4. سريع عالميًا
Cloudflare Workers يعمل على شبكة عالمية (300+ موقع)، زمن الاستجابة أقل من 50 مللي ثانية لأي مكان في العالم.

### 5. لا يحتاج صيانة
Serverless = لا خوادم لإدارتها، لا تحديثات أمنية، لا استرجاع للنسخة الخاملة. كل شيء تلقائي.

### 6. ذاكرة دائمة
المساعد "يتعلّم" من كل محادثة ناجحة ويحقن سياق المشروع تلقائيًا في كل طلب جديد.

---

## 🏗️ البنية المعمارية

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        📱 Telegram (واجهة المستخدم)                       │
│                  @micky_assistant_unlimited_bot                          │
│                  chat_id: 1235548782 (Micky only)                        │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ HTTPS Webhook
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              ⚡ Cloudflare Worker (الدماغ Serverless)                      │
│              https://micky-assistant.cources01.workers.dev                │
│                                                                          │
│   ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────────────┐  │
│   │ Webhook    │  │ BYOK API   │  │ Queue       │  │ Prompt Compiler  │  │
│   │ Handlers   │  │ /v1/chat   │  │ Manager     │  │ (4 طبقات)         │  │
│   └────────────┘  └────────────┘  └────────────┘  └──────────────────┘  │
│                                                                          │
│   ┌──────────────────────────────────────────────────────────────────┐   │
│   │                    Bindings                                       │   │
│   │  DB (D1)  │  4× KV  │  TASKS_QUEUE  │  AI (Workers AI)            │   │
│   └──────────────────────────────────────────────────────────────────┘   │
└──────┬──────────────────────────┬───────────────────────┬───────────────┘
       │                          │                       │
       ▼                          ▼                       ▼
┌──────────────┐     ┌──────────────────────┐    ┌──────────────────────┐
│ 🗄️ D1 DB     │     │ 📦 KV Namespaces    │    │ 🤖 Workers AI        │
│ micky-db     │     │ • LOCKS              │    │ Qwen2.5-Coder-32B    │
│ 5GB مجاني    │     │ • TASK_STATUS        │    │ Qwen2.5-Coder-14B    │
│              │     │ • RATE_LIMITS        │    │ Whisper-tiny-en      │
└──────────────┘     │ • PROMPT_CACHE       │    └──────────────────────┘
                     └──────────────────────┘
                               │
                               ▼ (للمهام الثقيلة: Code + Montage + Graphics)
                     ┌──────────────────────┐
                     │ 🔄 Cloudflare Queue   │
                     │ micky-tasks-queue     │
                     └──────────┬───────────┘
                                ▼
                     ┌──────────────────────┐      ┌──────────────────────┐
                     │ ⚙️ GitHub Actions     │      │ 🚀 Kaggle GPU         │
                     │ micky-infra (public) │      │ 2× T4 (32GB VRAM)    │
                     │ - LLM inference      │      │ - Whisper large-v3   │
                     │ - Code tasks + PRs   │      │ - SDXL/FLUX          │
                     │ - Unlimited minutes  │      │ - RVM matting        │
                     └──────────────────────┘      │ - Remotion renderer  │
                                                   │ 30h GPU/week         │
                                                   └──────────────────────┘
```

---

## 🚀 البدء السريع (Quick Start)

### المتطلبات المسبقة
قبل البدء، تأكد أن لديك الحسابات التالية (كلها مجانية):

| الحساب | الرابط | ملاحظة |
|---|---|---|
| Cloudflare | https://dash.cloudflare.com/sign-up | لا يحتاج بطاقة |
| GitHub | https://github.com/signup | حسابان: مستودع public + private |
| Kaggle | https://www.kaggle.com/account/login | للحصول على GPU مجاني |
| Telegram | https://t.me/BotFather | لإنشاء Bot Token |

### خطوات التشغيل في 5 دقائق

```bash
# 1) استنساخ المستودع
git clone https://github.com/mickystudio/micky-infra.git
cd micky-infra/worker

# 2) تثبيت الأدوات
npm install -g wrangler
npm install

# 3) تسجيل الدخول لـ Cloudflare
wrangler login

# 4) إنشاء قاعدة البيانات (D1)
wrangler d1 create micky-db
# نسخ database_id الناتج إلى wrangler.toml

# 5) تنفيذ الهجرات (Migrations)
wrangler d1 execute micky-db --file=migrations/0001_init.sql

# 6) إنشاء KV namespaces (4)
wrangler kv:namespace create LOCKS
wrangler kv:namespace create TASK_STATUS
wrangler kv:namespace create RATE_LIMITS
wrangler kv:namespace create PROMPT_CACHE

# 7) إنشاء Queue
wrangler queues create micky-tasks-queue

# 8) إعداد Secrets
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID_WHITELIST
wrangler secret put MICKY_PASSWORD_HASH
wrangler secret put GH_PAT_SCOPED
wrangler secret put GH_WEBHOOK_SECRET
wrangler secret put KAGGLE_API_TOKEN

# 9) نشر الـ Worker
wrangler deploy

# 10) ربط الـ Webhook بـ Telegram
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://micky-assistant.cources01.workers.dev/webhook/telegram"
```

> 📖 **دليل النشر الكامل:** انظر [`docs/deployment.md`](docs/deployment.md) لتفاصيل كل خطوة.

---

## 📱 كيف تستخدم البوت؟

### الخطوة 1: البدء
افتح تليجرام وابحث عن `@micky_assistant_unlimited_bot`، ثم اضغط Start أو أرسل:

```
/start
```

### الخطوة 2: المصادقة
- إذا كانت هذه أول مرة، سيطلب البوت كلمة المرور.
- أدخل كلمة المرور الصحيحة.
- بعد 3 محاولات خاطئة، يتم حظر الـ `chat_id` لمدة 24 ساعة.

### الخطوة 3: الأوامر المتاحة

بعد تسجيل الدخول، يمكنك استخدام الأوامر التالية:

#### 🎯 أوضاع العمل (Modes)
| الأمر | الوصف | مثال استخدام |
|---|---|---|
| `/text` | تفعيل وضع المحادثة النصية | المحادثة اليومية، الأسئلة الطبية |
| `/code` | تفعيل وضع توليد BYOK للأكواد | توليد API key لـ Cline |
| `/graphics` | تفعيل وضع إنشاء الصور | توليد صورة لكاريوسيل طبي |
| `/montage` | تفعيل وضع مونتاج الفيديو | تحويل فيديو خام لـ Reels جاهز |

#### 📂 إدارة المشاريع
| الأمر | الوصف |
|---|---|
| `/projects` | عرض كل المشاريع |
| `/newproject` | إنشاء مشروع جديد (اسم + وصف + جمهور + نبرة) |
| `/files` | رفع أو إدارة ملفات المشروع |

#### 📊 الإحصائيات والصحة
| الأمر | الوصف |
|---|---|
| `/stats` | إحصائيات الاستخدام اليومي والأسبوعي |
| `/health` | حالة كل المكوّنات (Worker, D1, KV, AI, Queue) |
| `/settings` | تعديل الإعدادات (النموذج، الحرارة، إلخ) |
| `/cancel` | إلغاء المهمة الحالية |
| `/help` | عرض كل الأوامر |

### الخطوة 4: التفاعل الطبيعي
في وضع Text Mode، فقط اكتب رسالتك بشكل طبيعي وسيُجيب المساعد:

```
أنت: ما هي أفضل طريقة لتبييض الأسنان؟
البوت: 🦷 تبييض الأسنان له عدة خيارات احترافية:
       1. التبييض المنزلي (Custom Trays)...
       2. التبييض في العيادة (In-Office)...
       3. تأثير يدوم 6-12 شهرًا...
```

---

## 🔑 كيف يعمل BYOK (Code Mode)؟

**BYOK** = **B**ring **Y**our **O**wn **K**ey = "أحضر مفتاحك الخاص".

### الفكرة
في Code Mode، يولّد البوت لك مفتاح API خاص يمكنك استخدامه في مساعدات البرمجة مثل **Cline** و**Qoder** و**Roo Code**. هذا المفتاح يسمح لها باستخدام نماذج LLM القوية (Qwen2.5-Coder-32B) عبر Workers AI.

### آلية العمل

```
1. أرسل /code للبوت
2. اختر المشروع (أو أنشئ واحدًا)
3. اضغط "توليد مفتاح جديد"
4. البوت يولّد: micky_<64 حرف عشوائي>
5. يخزّن hash المفتاح فقط في D1 (لا يمكن استرجاع الأصلي)
6. يعرض لك YAML block جاهز للنسخ:

   ┌─────────────────────────────────────────────┐
   │ Base URL: https://micky-assistant.cources01.workers.dev/v1 │
   │ API Key:  micky_a1b2c3d4e5f6...               │
   │ Model ID: qwen2.5-coder-32b                   │
   │                                              │
   │ Custom Headers:                              │
   │   X-Project-ID: proj_a3b7c9...               │
   │   X-Task-Mode: surgical                      │
   └─────────────────────────────────────────────┘

7. انسخ الإعداد والصقه في Cline/Qoder
8. ابدأ البرمجة! 🎉
```

### المميزات الأمنية لـ BYOK
- ✅ **لا تخزين للمفتاح الأصلي**: فقط SHA-256 hash يُحفظ.
- ✅ **ربط project_id**: كل مفتاح مرتبط بمشروع محدد.
- ✅ **Rate limit**: 1000 طلب/يوم لكل مفتاح (يُمنع الإسخدام المفرط).
- ✅ **Revocation**: يمكنك إلغاء أي مفتاح فورًا عبر `/keys`.
- ✅ **OpenAI-compatible**: يعمل مع أي أداة تدعم OpenAI API.

### مثال استخدام المفتاح (curl)

```bash
curl -X POST https://micky-assistant.cources01.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer micky_a1b2c3d4e5f6..." \
  -H "X-Project-ID: proj_a3b7c9..." \
  -H "X-Task-Mode: surgical" \
  -d '{
    "model": "qwen2.5-coder-32b",
    "messages": [
      {"role": "system", "content": "You are a TypeScript expert."},
      {"role": "user", "content": "Write a function to validate email addresses."}
    ],
    "max_tokens": 1024,
    "temperature": 0.4
  }'
```

> 📖 **دليل API الكامل:** انظر [`docs/api_reference.md`](docs/api_reference.md).

---

## ☁️ ملخص النشر (Deployment Summary)

| المكوّن | القيمة المنشورة |
|---|---|
| **Worker URL** | `https://micky-assistant.cources01.workers.dev` |
| **Workers.dev Subdomain** | `cources01` |
| **D1 Database** | `micky-db` (uuid: `3ef44fc8-fdfd-4844-9708-2ee4f923ece9`) |
| **KV Namespaces** | `MICKY_LOCKS`, `MICKY_TASK_STATUS`, `MICKY_RATE_LIMITS`, `MICKY_PROMPT_CACHE` |
| **Queue** | `micky-tasks-queue` |
| **Workers AI Model (default)** | `@cf/qwen/qwen2.5-coder-32b-instruct` |
| **Workers AI Model (fast)** | `@cf/qwen/qwen2.5-coder-14b-instruct` |
| **Telegram Bot** | `@micky_assistant_unlimited_bot` |
| **Admin chat_id** | `1235548782` |
| **GitHub Repos** | `mickystudio/micky-infra` (public), `mickystudio/micky-vault` (private) |

---

## 💰 الباقة المجانية المستخدمة (Free Tier)

| الخدمة | الحصة المجانية | الاستخدام المتوقع | حالة |
|---|---|---|---|
| **Cloudflare Workers** | 100K طلب/يوم | < 1K طلب/يوم | ✅ آمن |
| **Cloudflare D1** | 5M قراءة + 100K كتابة/يوم + 5GB | < 50K قراءة/يوم | ✅ آمن |
| **Cloudflare KV** | 100K قراءة + 1K كتابة/يوم | < 5K قراءة/يوم | ✅ آمن |
| **Cloudflare Queues** | 100K عملية/يوم | < 100 عملية/يوم | ✅ آمن |
| **Cloudflare R2** | 10GB + 1M Class A/شهر | < 5GB | ✅ آمن |
| **Workers AI** | 10K Neurons/يوم | ~500-2000/يوم | ⚠️ راقب |
| **GitHub Actions (public)** | دقائق غير محدودة | حسب الطلب | ✅ آمن |
| **GitHub Actions (private)** | 2000 دقيقة/شهر | < 1000/شهر | ✅ آمن |
| **GitHub Releases** | غير محدود (2GB/ملف) | — | ✅ آمن |
| **Kaggle GPU** | 30 ساعة/أسبوع + 12 ساعة/جلسة | ~10-15/أسبوع | ⚠️ راقب |
| **Telegram Bot API** | غير محدود | — | ✅ آمن |

> 📊 **الخلاصة:** كل الخدمات تستخدم أقل من 10% من الحصة المجانية. لا توجد أي تكلفة شهرية.

---

## 🔒 ملاحظات أمنية

### 1. المصادقة متعددة الطبقات
- **Layer 1 — chat_id Whitelist:** فقط `chat_id: 1235548782` يمكنه التفاعل مع البوت. أي `chat_id` آخر يُتجاهل صامتًا (لا رد، لا خطأ).
- **Layer 2 — Password Gate:** حتى بعد تجاوز الـ Whitelist، يطلب البوت كلمة مرور. 3 محاولات خاطئة = حظر 24 ساعة.
- **Layer 3 (اختياري) — Biometric:** عبر WebApp، يمكن تفعيل بصمة الهاتف كطبقة إضافية.

### 2. إدارة المفاتيح (Secrets)
- كل المفاتيح الحساسة (`TELEGRAM_BOT_TOKEN`, `GH_PAT_SCOPED`, `KAGGLE_API_TOKEN`) مخزّنة كـ **Wrangler Secrets** (مشفّرة، لا تظهر في الكود ولا السجلات).
- مفاتيح BYOK تُخزّن كـ **SHA-256 hash** فقط في D1. لا يمكن استرجاع المفتاح الأصلي حتى من قاعدة البيانات.
- PAT الخاص بـ GitHub محدود الصلاحيات (scoped): فقط `repo:status` و `pull_requests:write`.

### 3. أمان الـ Webhook
- Telegram Webhook: يتم التحقق من `chat_id` قبل أي معالجة.
- GitHub Webhook: يتم التحقق من توقيع `X-Hub-Signature-256` باستخدام `GH_WEBHOOK_SECRET`.
- BYOK Endpoint: يتطلب `Authorization: Bearer micky_xxx` صالح.

### 4. Rate Limiting
- BYOK: 1000 طلب/يوم لكل مفتاح (يُعدّ في KV).
- Telegram: لا يوجد حد (مستخدم واحد فقط).
- Workers AI: يخضع لحدود Cloudflare التلقائية.

### 5. النسخ الاحتياطي
- D1 يدعم النسخ الاحتياطي التلقائي (Point-in-Time Recovery).
- نسخ احتياطي يومي عبر GitHub Actions إلى GitHub Release.
- ملفات الـ Vault محفوظة في `mickystudio/micky-vault` (private).

### 6. عدم تسريب البيانات
- لا توجد سجلات تحتوي على محتوى رسائل المستخدم (فقط metadata).
- لا توجد تكاملات مع خدمات خارجية غير ضرورية.
- المساعد يعمل لمستخدم واحد فقط = لا مشاركة بيانات.

---

## 📚 الوثائق الإضافية

| الملف | الوصف |
|---|---|
| [📖 `docs/architecture.md`](docs/architecture.md) | شرح معماري مفصّل للنظام |
| [🚀 `docs/deployment.md`](docs/deployment.md) | دليل النشر خطوة بخطوة |
| [🔧 `docs/troubleshooting.md`](docs/troubleshooting.md) | حل المشكلات الشائعة |
| [📡 `docs/api_reference.md`](docs/api_reference.md) | مرجع كامل لـ API |

---

## 🛠️ التطوير المحلي (Local Development)

```bash
# تشغيل Worker محليًا (Miniflare)
cd worker
npm run dev

# فحص السجلات المباشرة للـ Worker المنشور
npm run tail

# تنفيذ استعلام على D1
npm run db:query "SELECT * FROM users LIMIT 5;"

# تنفيذ Migration جديد
npm run db:migrate
```

### متطلبات التطوير
- Node.js 20 أو أحدث
- wrangler 3.85+
- TypeScript 5.6+

---

## 📋 حالة المشروع

| المرحلة | الحالة |
|---|---|
| Phase 0 — البنية التحتية | ✅ مكتمل |
| Phase 1 — الأساس النووي | ✅ مكتمل (Worker + D1 + KV + Queue) |
| Phase 2 — Text Mode | 🚧 قيد التطوير |
| Phase 3 — Code Mode + BYOK | 🚧 قيد التطوير |
| Phase 4 — Montage Mode | ⏳ مخطط |
| Phase 5 — Graphics Mode | ⏳ مخطط |
| Phase 6 — التلميع والنشر | ⏳ مخطط |

---

## 📞 الدعم

- **المستخدم الوحيد:** Micky (طبيب أسنان)
- **المسؤول:** `chat_id: 1235548782`
- **Bot:** [@micky_assistant_unlimited_bot](https://t.me/micky_assistant_unlimited_bot)
- **التوثيق المرجعي:** [`plan.md`](plan.md)

---

## 📄 الترخيص

**ملكية خاصة — للاستخدام الشخصي الحصري.** لا يُسمح باستخدام هذا المشروع أو توزيعه أو تعديله لأي شخص آخر غير Micky.

---

<div align="center">

**صُنع بحب لـ Micky 🦷✨**

*الإصدار: v6.0 — Workers + Workers AI architecture*
*تاريخ البدء: 2026-11-10*

</div>
