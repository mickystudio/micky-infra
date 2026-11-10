# 🔧 استكشاف الأخطاء وإصلاحها — Micky Assistant Unlimited

> دليل شامل لحل المشكلات الشائعة في Micky Assistant Unlimited. كل مشكلة لها: الأعراض، السبب، والحل خطوة بخطوة.

---

## 📑 جدول المحتويات

1. [مشاكل النشر والـ Worker](#1-مشاكل-النشر-وال-worker)
2. [مشاكل Telegram Webhook](#2-مشاكل-telegram-webhook)
3. [مشاكل قاعدة البيانات D1](#3-مشاكل-قاعدة-البيانات-d1)
4. [مشاكل Workers AI](#4-مشاكل-workers-ai)
5. [مشاكل GitHub Actions](#5-مشاكل-github-actions)
6. [مشاكل Kaggle GPU](#6-مشاكل-kaggle-gpu)
7. [مشاكل العرض والترميز (Arabic/Cairo)](#7-مشاكل-العرض-والترميز)
8. [مشاكل R2 وStorage](#8-مشاكل-r2-وstorage)
9. [مشاكل CORS](#9-مشاكل-cors)
10. [مشاكل عامة](#10-مشاكل-عامة)
11. [أوامر تشخيصية مفيدة](#11-أوامر-تشخيصية-مفيدة)

---

## 1. مشاكل النشر والـ Worker

### 1.1 ❌ الـ Worker يُرجع 404 عند زيارة `workers.dev` URL

**الأعراض:**
- `curl https://micky-assistant.cources01.workers.dev/health` يُرجع `404 Not Found`.
- زيارة الـ URL في المتصفح تُظهر صفحة Cloudflare خطأ.

**السبب:**
لم يتم إنشاء `workers.dev subdomain` بعد. كل Workers تحتاج subdomain أساسي للعمل.

**الحل:**

1. اذهب إلى https://dash.cloudflare.com/
2. من القائمة الجانبية: **Workers & Pages** → **Subdomain**
3. اضغط **"Set up"** أو **"Claim a subdomain"**
4. اختر الـ subdomain: `cources01` (أو أي اسم متاح)
5. اضغط **"Set up"**
6. انتظر 1-2 دقيقة، ثم اختبر:

```bash
curl https://micky-assistant.cources01.workers.dev/health
# يجب أن يُرجع: {"status":"ok","timestamp":...,"version":"1.0.0"}
```

> 📌 **للتحقق من الـ subdomain المسجّل:** اذهب إلى dashboard → Workers & Pages → ستجد الـ subdomain في الأعلى.

---

### 1.2 ❌ `wrangler deploy` يفشل بـ "Authentication error"

**الأعراض:**
```
✘ [ERROR] Your token has invalid authentication. Re-authenticate ...
```

**السبب:**
انتهت صلاحية الـ OAuth token أو لم تُسجّل الدخول.

**الحل:**

```bash
# إعادة تسجيل الدخول:
wrangler logout
wrangler login

# التحقق:
wrangler whoami
# يجب أن يُظهر Account Name + Account ID
```

---

### 1.3 ❌ `wrangler deploy` يفشل بـ "Binding not found"

**الأعراض:**
```
✘ [ERROR] The binding "DB" references a D1 database "micky-db" that doesn't exist.
```

**السبب:**
الـ `database_id` في `wrangler.toml` غير صحيح أو D1 غير منشأ.

**الحل:**

```bash
# التحقق من قائمة D1 databases:
wrangler d1 list

# إذا لم تجد micky-db، أنشئه:
wrangler d1 create micky-db

# انسخ database_id الجديد وحدّث wrangler.toml:
[[d1_databases]]
binding = "DB"
database_name = "micky-db"
database_id = "<NEW_DATABASE_ID>"   # ← الصق هنا
```

---

### 1.4 ❌ الـ Worker يُرجع 500 Internal Server Error

**الأعراض:**
```json
{"error":"Internal Server Error","message":"TypeError: Cannot read property 'prepare' of undefined"}
```

**السبب:**
أحد الـ bindings غير مُعرّف في `wrangler.toml`. الكود يحاول الوصول لـ `env.DB` لكنه `undefined`.

**الحل:**

```bash
# 1) فحص السجلات المباشرة:
wrangler tail

# 2) التحقق من wrangler.toml — يجب أن يحوي كل bindings:
[[d1_databases]]
binding = "DB"
...

[[kv_namespaces]]
binding = "LOCKS"
...
(binding = "TASK_STATUS")
(binding = "RATE_LIMITS")
(binding = "PROMPT_CACHE")

[[queues.producers]]
binding = "TASKS_QUEUE"
...

[ai]
binding = "AI"

# 3) إعادة النشر بعد التصحيح:
wrangler deploy
```

---

### 1.5 ❌ الـ Worker timeout (تجاوز وقت 10ms CPU)

**الأعراض:**
```
Error: Worker exceeded CPU time limit of 10ms
```

**السبب:**
الباقة المجانية لـ Workers لها حد 10ms CPU/طلب. معالجة معقدة تتجاوز هذا الحد.

**الحل:**

```typescript
// بدلًا من معالجة كل شيء في الـ request:
async fetch(request, env, ctx) {
  // ❌ خطأ: معالجة متزامنة
  // const result = await longRunningTask();

  // ✅ صح: استخدام ctx.waitUntil لمعالجة في الخلفية
  ctx.waitUntil(longRunningTask());
  return json({ ok: true, message: "processing in background" });
}
```

**بدائل:**
- نقل المهام الثقيلة إلى Queue consumer (لا يخضع لحد 10ms).
- استخدام Workers Paid Plan ($5/شهر، حد 30 ثانية CPU).
- نقل المعالجة إلى GitHub Actions.

---

## 2. مشاكل Telegram Webhook

### 2.1 ❌ الـ Webhook لا يستقبل الرسائل

**الأعراض:**
- Micky يرسل `/start` للبوت، لا يحدث شيء.
- `getWebhookInfo` يُظهر `pending_update_count > 0`.

**السبب المحتمل:**
1. الـ chat_id ليس في الـ whitelist.
2. الـ Webhook URL غير صحيح.
3. الـ Worker يُرجع خطأ 5xx.

**الحل — خطوة بخطوة:**

```bash
# 1) فحص حالة الـ webhook:
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo" | jq .

# مثال على الرد مع خطأ:
# {
#   "ok": true,
#   "result": {
#     "url": "https://micky-assistant.cources01.workers.dev/webhook/telegram",
#     "pending_update_count": 5,
#     "last_error_date": 1731216000,
#     "last_error_message": "Wrong response from the webhook: 500 Internal Server Error"
#   }
# }

# 2) فحص سجلات الـ Worker:
wrangler tail
# شغّل هذا في نافذة، ثم أرسل /start من تليجرام

# 3) إذا رأيت خطأ "chat_id not in whitelist":
# أضف chat_id الصحيح:
wrangler secret put TELEGRAM_CHAT_ID_WHITELIST
# الصق: 1235548782 (chat_id الخاص بـ Micky)

# 4) إعادة تعيين الـ webhook:
curl -X POST "https://api.telegram.org/bot<TOKEN>/deleteWebhook"
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://micky-assistant.cources01.workers.dev/webhook/telegram"
```

---

### 2.2 ❌ Telegram يرفض الـ webhook URL (SSL error)

**الأعراض:**
```
"last_error_message": "SSL error: certificate verify failed"
```

**السبب:**
Cloudflare يُصدر شهادات SSL تلقائيًا، لكن إذا كان الـ subdomain جديدًا قد يستغرق بعض الوقت.

**الحل:**

```bash
# انتظر 5-10 دقائق بعد أول نشر.
# إذا استمر الخطأ، اختبر SSL:
curl -vI https://micky-assistant.cources01.workers.dev/health 2>&1 | grep -E "(SSL|certificate)"

# يجب أن ترى:
# * SSL connection using TLSv1.3 / TLS_AES_128_GCM_SHA256
# * Server certificate: verify OK

# إذا فشل التحقق، استخدم workers.dev (مضمون SSL):
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://micky-assistant.cources01.workers.dev/webhook/telegram"
```

---

### 2.3 ❌ رسالة Telegram "Message too long"

**الأعراض:**
```
{"ok":false,"error_code":400,"description":"Bad Request: message is too long"}
```

**السبب:**
حد تليجرام هو **4096 حرف** لكل رسالة. ردود LLM قد تتجاوز هذا الحد.

**الحل:**

```typescript
// في كود إرسال الرسائل، قسّم النص الطويل:
async function sendTelegramMessage(env, chatId, text) {
  const MAX_LENGTH = 4000;  // أقل من 4096 بأمان

  if (text.length <= MAX_LENGTH) {
    return await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
  }

  // تقسيم النص عند حدود سطرية منطقية:
  const chunks = [];
  let remaining = text;
  while (remaining.length > MAX_LENGTH) {
    let splitAt = remaining.lastIndexOf('\n\n', MAX_LENGTH);
    if (splitAt === -1) splitAt = MAX_LENGTH;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trim();
  }
  chunks.push(remaining);

  // إرسال كل قطعة:
  for (const chunk of chunks) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'Markdown' }),
    });
  }
}
```

---

## 3. مشاكل قاعدة البيانات D1

### 3.1 ❌ D1 query تفشل بـ "SQL syntax error"

**الأعراض:**
```
D1_ERROR: near "INSERT": syntax error
```

**السبب:**
بناء SQL خاطئ. شائع جدًا مع:
- استخدام `?` بدل `?` الصحيح (يجب استخدام bind parameters).
- نسيان فاصلة منقوطة.
- استخدام كلمات محجوزة كأسماء أعمدة.

**الحل:**

```bash
# 1) اختبار الاستعلام مباشرة:
wrangler d1 execute micky-db --local --command "SELECT * FROM users LIMIT 5;"
# (local أسرع ولا يستهلك من حصة production)

# 2) فحص الجداول الموجودة:
wrangler d1 execute micky-db --remote --command ".schema"

# 3) فحص الـ schema الكامل:
wrangler d1 execute micky-db --remote --command "SELECT sql FROM sqlite_master WHERE type='table';"
```

**أخطاء SQL شائعة:**

```sql
-- ❌ خطأ: استخدم كلمة محجوزة
CREATE TABLE order (id INTEGER PRIMARY KEY);  -- order محجوزة
-- ✅ صح:
CREATE TABLE orders (id INTEGER PRIMARY KEY);

-- ❌ خطأ: نسيان الفاصلة المنقوطة
INSERT INTO users (chat_id) VALUES (1235548782)
-- ✅ صح:
INSERT INTO users (chat_id) VALUES (1235548782);

-- ❌ خطأ: bind parameter خاطئ
SELECT * FROM users WHERE chat_id = ?;  -- هذا صحيح في الواقع
-- لكن تأكد من .bind() في TypeScript:
await env.DB.prepare('SELECT * FROM users WHERE chat_id = ?').bind(chatId).first();
```

---

### 3.2 ❌ D1 query بطيئة (slow query)

**الأعراض:**
- بعض الطلبات تستغرق > 2 ثانية.
- العداد `rows_read` مرتفع في سجلات D1.

**السبب:**
- الاستعلام يفحص الجدول كاملًا (Full Table Scan).
- لا يوجد فهرس على الأعمدة المستخدمة في WHERE.

**الحل:**

```bash
# 1) فحص EXPLAIN QUERY PLAN:
wrangler d1 execute micky-db --remote --command \
  "EXPLAIN QUERY PLAN SELECT * FROM messages WHERE chat_id = 'default';"

# إذا رأيت "SCAN TABLE messages" = سيئ (full scan)
# إذا رأيت "SEARCH TABLE messages USING INDEX" = جيد

# 2) إضافة فهارس:
wrangler d1 execute micky-db --remote --command \
  "CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);"

# 3) تحسين الاستعلام — استخدم LIMIT:
# ❌ بطيء: SELECT * FROM messages WHERE chat_id = ?
# ✅ سريع: SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 50;
```

---

### 3.3 ❌ تجاوز حد D1 writes اليومي (100K/day)

**الأعراض:**
```
D1_ERROR: daily write limit exceeded
```

**السبب:**
كتابة أكثر من 100,000 صف يوميًا (شائع في batch inserts غير محسّنة).

**الحل:**

```typescript
// ❌ خطأ: كتابة كل رسالة على حدة:
for (const msg of messages) {
  await env.DB.prepare('INSERT INTO messages VALUES (?, ?, ?)').bind(...).run();
}

// ✅ صح: batch inserts:
const stmts = messages.map(msg =>
  env.DB.prepare('INSERT INTO messages VALUES (?, ?, ?)').bind(...)
);
await env.DB.batch(stmts);  // إرسالها كدفعة واحدة (1 write)

// أو تجميع:
await env.DB.prepare(
  'INSERT INTO messages (id, role, content) VALUES ' +
  messages.map(() => '(?, ?, ?)').join(', ')
).bind(...messages.flatMap(m => [m.id, m.role, m.content])).run();
```

---

## 4. مشاكل Workers AI

### 4.1 ❌ Workers AI timeout

**الأعراض:**
```
Error: AI inference timed out after 30s
```

**السبب:**
- النموذج 32B بطيء على الـ input طويل.
- طلب `max_tokens` كبير.

**الحل:**

```typescript
// 1) استخدام النموذج السريع للأسئلة البسيطة:
const isSimpleQuery = messages.length < 3 && text.length < 200;
const model = isSimpleQuery ? env.FAST_MODEL : env.DEFAULT_MODEL;

// 2) تقليل max_tokens:
max_tokens: 1024  // بدل 4096

// 3) تقليل طول input (ضغط البرومبت):
const compressedPrompt = await compressPrompt(systemPrompt);

// 4) إضافة timeout صريح:
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 25000);

try {
  const response = await env.AI.run(model, {
    messages,
    max_tokens: 1024,
  }, { signal: controller.signal });
  clearTimeout(timeoutId);
} catch (err) {
  // fallback للنموذج الأسرع:
  const response = await env.AI.run(env.FAST_MODEL, {
    messages,
    max_tokens: 512,
  });
}
```

---

### 4.2 ❌ "Model not found" أو "model not available"

**الأعراض:**
```
Error: Model @cf/qwen/qwen2.5-coder-32b-instruct not found
```

**السبب:**
اسم النموذج غير صحيح، أو النموذج غير متاح في منطقتك.

**الحل:**

```bash
# 1) التحقق من النماذج المتاحة:
curl https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/models/search \
  -H "Authorization: Bearer <CF_API_TOKEN>" | jq .

# 2) استخدام الأسماء الصحيحة (من wrangler.toml):
DEFAULT_MODEL = "@cf/qwen/qwen2.5-coder-32b-instruct"
FAST_MODEL = "@cf/qwen/qwen2.5-coder-14b-instruct"
WHISPER_MODEL = "@cf/openai/whisper-tiny-en"

# 3) تأكد من كتابة الاسم بالكامل (مع @cf/):
# ❌ خطأ: 'qwen2.5-coder-32b'
# ✅ صح: '@cf/qwen/qwen2.5-coder-32b-instruct'
```

---

### 4.3 ❌ تجاوز حد Neurons اليومي (10K/day)

**الأعراض:**
```
Error: AI neuron quota exceeded
```

**السبب:**
استخدام ثقيل (مونتاج متعدد، أو جلسات طويلة).

**الحل:**

```typescript
// 1) استخدام كاش البرومبت (PROMPT_CACHE KV):
const promptHash = await sha256(JSON.stringify(messages));
const cached = await env.PROMPT_CACHE.get(`prompt:${promptHash}`);
if (cached) {
  return JSON.parse(cached);  // إرجاع الرد المخزّن
}

// 2) تقليل عدد الاستدعاءات (batch):
// بدلًا من 10 استدعاءات منفصلة، استدعاء واحد بكل الأسئلة.

// 3) استخدام FAST_MODEL (14B) للأسئلة البسيطة:
const model = queryComplexity < 5 ? env.FAST_MODEL : env.DEFAULT_MODEL;

// 4) مراقبة الاستخدام اليومي:
curl https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/usage | jq .
```

---

## 5. مشاكل GitHub Actions

### 5.1 ❌ تجاوز حد GitHub Actions (private repo)

**الأعراض:**
```
Error: You have exceeded your GitHub Actions minutes quota
```

**السبب:**
المستودعات الخاصة لها حد 2000 دقيقة/شهر.

**الحل:**

```bash
# 1) نقل Workflows للمستودع العام (micky-infra):
# public repo = دقائق غير محدودة!

# 2) تحسين workflow ليستغرق وقتًا أقل:
# - تقليل الخطوات غير الضرورية
# - استخدام cache لتسريع التثبيت:
- uses: actions/cache@v3
  with:
    path: ~/.cache
    key: ${{ runner.os }}-cache

# 3) فحص الاستخدام الحالي:
gh api /repos/mickystudio/micky-vault/actions/permissions
gh api /repos/mickystudio/micky-infra/actions/runs --jq '.workflow_runs[].run_started_at'
```

---

### 5.2 ❌ `repository_dispatch` لا يصل للـ Workflow

**الأعراض:**
- Worker يرسل `repository_dispatch` لكن الـ workflow لا يعمل.
- لا سجلّات للـ runs.

**السبب:**
- الـ workflow file غير موجود في الفرع الرئيسي.
- اسم الـ event type لا يطابق `types:` في YAML.

**الحل:**

```bash
# 1) التحقق من أن workflow في main branch:
gh api /repos/mickystudio/micky-infra/contents/.github/workflows/runner.yml

# 2) التحقق من تطابق event_type:
# في Worker (TypeScript):
await fetch('https://api.github.com/repos/mickystudio/micky-infra/dispatches', {
  body: JSON.stringify({ event_type: 'micky_task', ... })
});

# في runner.yml:
on:
  repository_dispatch:
    types: [micky_task]   # ← يجب أن يطابق event_type

# 3) اختبار الـ dispatch يدويًا:
gh api /repos/mickystudio/micky-infra/dispatches \
  -f event_type=micky_task \
  -f client_payload[task_id]=test123

# 4) فحص سجلات الـ dispatch:
gh run list --repo mickystudio/micky-infra --limit 5
```

---

### 5.3 ❌ الـ workflow يفشل بـ "Permission denied"

**الأعراض:**
```
Error: Permission denied: cannot create pull request
```

**السبب:**
PAT لا يملك الصلاحيات الكافية.

**الحل:**

```bash
# 1) إنشاء PAT بصلاحيات كافية:
# https://github.com/settings/tokens → Generate new token (classic)
# Required scopes:
# - repo (full)
# - workflow
# - read:org

# 2) تحديث secret:
wrangler secret put GH_PAT_SCOPED
# الصق PAT الجديد

# 3) أيضًا في micky-vault:
gh secret set GH_PAT --repo mickystudio/micky-vault --body "<NEW_PAT>"
```

---

## 6. مشاكل Kaggle GPU

### 6.1 ❌ Kaggle kernel يفشل بـ "GPU quota exhausted"

**الأعراض:**
```
Kaggle API Error: Your GPU quota has been exhausted.
```

**السبب:**
استخدام أكثر من 30 ساعة GPU في الأسبوع.

**الحل:**

```bash
# 1) فحص الحصة المتبقية:
# اذهب إلى https://www.kaggle.com/dentistmichaelnabil/account
# ستجد: "GPU Quota: X hours left until next reset"

# 2) إعادة الجدولة (التأجيل):
# في الـ Worker، أجّل المهمة:
await env.TASKS_QUEUE.send({
  type: 'montage',
  chat_id,
  task_id,
  payload,
  delaySeconds: 60 * 60 * 24 * 7,  // أسبوع تأجيل
});

# 3) الانتقال لـ HuggingFace Space (CPU mode) كبديل:
# (إعداد منفصل — راجع docs/architecture.md - section 9.2)

# 4) تحسين الـ notebook لاستهلاك أقل:
# - تقليل الـ epochs
# - استخدام دقة أقل (fp16 بدل fp32)
# - معالجة في batches أصغر
```

---

### 6.2 ❌ Kaggle kernel timeout (تجاوز 12 ساعة)

**الأعراض:**
```
Kernel was killed after 12 hours of runtime.
```

**السبب:**
حد الجلسة الواحدة على Kaggle هو 12 ساعة.

**الحل:**

```python
# في الـ notebook، احفظ الحالة دوريًا:
import pickle

# كل 30 دقيقة، احفظ progress:
with open('/kaggle/working/checkpoint.pkl', 'wb') as f:
    pickle.dump({
        'current_step': current_step,
        'results': results_so_far,
    }, f)

# عند بدء الجلسة، تحقق من checkpoint:
import os
if os.path.exists('/kaggle/working/checkpoint.pkl'):
    with open('/kaggle/working/checkpoint.pkl', 'rb') as f:
        state = pickle.load(f)
        current_step = state['current_step']
        results = state['results']
```

> 📌 **بديل:** تقسيم المهمة لـ notebooks متعددة، كل واحد يستغرق < 10 ساعات.

---

### 6.3 ❌ Kaggle API: "401 Unauthorized"

**الأعراض:**
```
HTTP Error: 401 Unauthorized
```

**السبب:**
- KAGGLE_API_TOKEN غير صحيح.
- انتهت صلاحية الـ token.

**الحل:**

```bash
# 1) إنشاء token جديد:
# https://www.kaggle.com/dentistmichaelnabil/account → "Create New API Token"
# يُنزّل kaggle.json

# 2) تحويل الـ token لـ base64:
cat kaggle.json | base64 -w 0
# مثال الناتج: eyJ1c2VybmFtZSI6ImRlbnRpc21pY2hhZWxuYWJpbCIsImtleSI6ImExYjJjM2Q0...

# 3) تحديث الـ secret:
wrangler secret put KAGGLE_API_TOKEN
# الصق قيمة base64

# 4) اختبار:
curl -H "Authorization: Bearer <TOKEN>" https://www.kaggle.com/api/v1/kernels/list?user=dentistmichaelnabil
```

---

## 7. مشاكل العرض والترميز

### 7.1 ❌ النص العربي يظهر كمربعات أو حروف متقطعة

**الأعراض:**
- في مخرجات الفيديو (Montage Mode): النص العربي يظهر كمربعات `□□□`.
- في الصور المُولّدة: حروف متقطعة أو غير متصلة.

**السبب:**
الخط المستخدم لا يدعم العربية بشكل كامل. كثير من الخطوط اللاتينية لا تحوي الحروف العربية.

**الحل:**

```python
# استخدم خط Cairo-Bold أو Tajawal-Regular (موجودة في kaggle-src/assets/fonts/):
from PIL import ImageFont, ImageDraw, Image

# ❌ خطأ: خط افتراضي
font = ImageFont.load_default()

# ✅ صح: خط عربي:
font = ImageFont.truetype('assets/fonts/Cairo-Bold.ttf', size=48)

# في Remotion (للأنيميشن):
# /kaggle-src/remotion/src/index.tsx:
import { loadFont } from '@remotion/google-fonts/Cairo';
const { fontFamily } = loadFont('normal', {
  weights: ['400', '700'],
});

# في CSS:
.arabic-text {
  font-family: 'Cairo', 'Tajawal', sans-serif;
  direction: rtl;
  text-align: right;
}
```

> 📌 **الخطوط الموصى بها للعربية:**
> - **Cairo** (الأكثر احترافية، يحوي كل الأوزان)
> - **Tajawal** (نظيف وعصري)
> - **Amiri** (تقليدي، للقرآن والمحتوى الديني)
> - **Noto Sans Arabic** (مدعوم من Google، مفتوح المصدر)

---

### 7.2 ❌ اتجاه النص خاطئ (LTR بدل RTL)

**الأعراض:**
- النص العربي يُعرض من اليسار لليمين (يجب أن يكون من اليمين لليسار).
- الكلمات تظهر بترتيب عكسي.

**السبب:**
خصائص CSS مفقودة أو HTML lang غير صحيح.

**الحل:**

```html
<!-- ✅ صح: -->
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
</head>
<body>
  <p style="direction: rtl; text-align: right; font-family: 'Cairo', sans-serif;">
    مرحبًا بك في Micky Assistant
  </p>
</body>
</html>
```

```css
/* في CSS العام: */
.arabic {
  direction: rtl;
  unicode-bidi: embed;
  text-align: right;
  font-family: 'Cairo', 'Tajawal', sans-serif;
}
```

---

### 7.3 ❌ تشفير UTF-8 مفقود في JSON

**الأعراض:**
- النص العربي في JSON يظهر كـ `\u0645\u0631\u062d\u0628\u0627`.
- أو علامات استفهام `?` بدل الحروف.

**السبب:**
JSON.stringify يحول غير ASCII إلى escape sequences افتراضيًا.

**الحل:**

```typescript
// ❌ خطأ: افتراضي يحول لـ \uXXXX
JSON.stringify({ text: 'مرحبًا' });
// الناتج: '{"text":"\u0645\u0631\u062d\u0628\u0627"}'

// ✅ صح: استخدم non-ASCII printable
JSON.stringify({ text: 'مرحبًا' }).replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => {
  return String.fromCharCode(parseInt(hex, 16));
});

// أو في Response:
new Response(JSON.stringify({ text: 'مرحبًا' }, null, 2), {
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
  },
});
```

---

## 8. مشاكل R2 وStorage

### 8.1 ❌ "R2 not enabled" — خطأ عند إنشاء bucket

**الأعراض:**
```bash
$ wrangler r2 bucket create micky-storage
✘ [ERROR] R2 is not enabled for this account. Please enable R2 in the dashboard.
```

**السبب:**
R2 يحتاج تفعيل يدوي أول مرة (يتطلب تأكيد المعلومات).

**الحل:**

1. افتح https://dash.cloudflare.com/
2. من القائمة الجانبية: **R2 Object Storage**
3. اضغط **"Enable R2"** أو **"Activate R2"**
4. اتبع التعليمات (قد يطلب تأكيد رقم هاتف — لا يحتاج بطاقة دفع).
5. بعد التفعيل، أعد المحاولة:

```bash
wrangler r2 bucket create micky-storage
# ✨ Successfully created bucket 'micky-storage'
```

> 📌 **بدائل إن فشل التفعيل:**
> - استخدام GitHub Releases (2GB/ملف، مجاني)
> - HuggingFace Datasets (مجاني بلا حدود)
> - Cloudflare KV (للملفات الصغيرة < 25MB)

---

### 8.2 ❌ ملف مفقود في R2

**الأعراض:**
```
Error: Object not found: project-files/file.pdf
```

**السبب:**
- الملف لم يُرفع بنجاح.
- اسم الـ key غير صحيح.
- الباكيت خاطئ.

**الحل:**

```bash
# 1) سرد كل الملفات:
wrangler r2 object list micky-storage

# 2) فحص ملف محدد:
wrangler r2 object get micky-storage/project-files/file.pdf --local=/tmp/test.pdf

# 3) التحقق من الحجم:
wrangler r2 object head micky-storage/project-files/file.pdf
```

---

### 8.3 ❌ تجاوز حد R2 (10GB)

**الأعراض:**
```
Error: R2 storage quota exceeded
```

**السبب:**
تراكم ملفات الفيديو والصور.

**الحل:**

```bash
# 1) فحص الاستخدام:
# اذهب لـ dashboard → R2 → ستجد المساحة المستخدمة

# 2) حذف الملفات القديمة:
wrangler r2 object delete micky-storage/old-files/2025-video.mp4

# 3) أرشفة الملفات القديمة لـ GitHub Releases (بلا حدود):
gh release create archive-2025 --repo mickystudio/micky-infra old-files/*
# ثم احذفها من R2
```

---

## 9. مشاكل CORS

### 9.1 ❌ خطأ CORS في المتصفح

**الأعراض (في console المتصفح):**
```
Access to fetch at 'https://micky-assistant.cources01.workers.dev/v1/chat/completions'
from origin 'https://example.com' has been blocked by CORS policy:
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

**السبب:**
المتصفح يمنع الطلبات cross-origin بلا headers CORS صحيحة.

**الحل:**

```typescript
// ✅ الكود الحالي في index.ts يعالج هذا بالفعل:

// 1) CORS preflight (OPTIONS):
function handleCORS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Project-ID, X-Task-Mode',
    },
  });
}

// 2) إضافة headers CORS لكل response:
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Project-ID, X-Task-Mode',
    },
  });
}

// 3) معالجة OPTIONS في بداية الـ router:
if (method === 'OPTIONS') {
  return handleCORS();
}
```

> ⚠️ **ملاحظة أمنية:** `Access-Control-Allow-Origin: '*'` يسمح لأي موقع بالاتصال. للأمان، حدد النطاقات المسموحة:
>
> ```typescript
> const allowedOrigins = ['https://app.micky.com', 'https://clink.app'];
> const origin = request.headers.get('Origin');
> const allowOrigin = allowedOrigins.includes(origin) ? origin : 'null';
> ```

---

### 9.2 ❌ CORS لـ HuggingFace Space

**الأعراض:**
- استدعاء HF Space من المتصفح يفشل بـ CORS.

**الحل:**

في HF Space (ملف `app.py`):

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://micky-assistant.cources01.workers.dev",
        "https://your-canvas.pages.dev",
    ],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)
```

---

## 10. مشاكل عامة

### 10.1 ❌ البوت لا يستجيب لكلمة المرور الصحيحة

**الأعراض:**
- Micky يرسل كلمة المرور الصحيحة، لكن البوت يقول "خطأ".
- بعد 3 محاولات: حظر 24 ساعة.

**السبب:**
- `MICKY_PASSWORD_HASH` غير مطابق لكلمة المرور الفعلية.
- bcrypt hash خاطئ.

**الحل:**

```bash
# 1) توليد hash جديد:
node -e "
const bcrypt = require('bcryptjs');
const password = 'MickyPassword2026';
console.log(bcrypt.hashSync(password, 10));
"
# مثال الناتج: $2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy

# 2) تحديث الـ secret:
wrangler secret put MICKY_PASSWORD_HASH
# الصق الـ hash الجديد

# 3) إعادة تعيين failed_attempts في D1:
wrangler d1 execute micky-db --remote --command \
  "UPDATE users SET failed_attempts=0, locked_until=NULL WHERE chat_id=1235548782;"
```

---

### 10.2 ❌ تليجرام يبطئ (slow responses)

**الأعراض:**
- الردود تتأخر > 30 ثانية.
- تليجرام يُظهر "Sending..." لفترة طويلة.

**السبب:**
- Workers AI بطيء.
- أو: المعالجة المتزامنة في الـ webhook تتجاوز 25 ثانية (حد تليجرام لانتظار الرد).

**الحل:**

```typescript
// استخدم ctx.waitUntil() دائمًا للعمليات الطويلة:
async fetch(request, env, ctx) {
  // ✅ صح: ارد على تليجرام فورًا، عالج في الخلفية
  ctx.waitUntil(processTelegramUpdate(update, env));
  return json({ ok: true });
}

// بدلًا من:
// ❌ خطأ: انتظر اكتمال المعالجة ثم ارد
// const result = await processTelegramUpdate(update, env);
// return json({ ok: true, result });
```

---

### 10.3 ❌ الأوامر لا تعمل بعد `/start`

**الأعراض:**
- `/start` يعمل، لكن `/text`, `/help`, إلخ لا تستجيب.

**السبب:**
- كود معالجة الأوامر غير مكتمل.
- أو: حالة المستخدم (`is_authorized=0`) لم تُحدّث بعد المصادقة.

**الحل:**

```bash
# 1) التحقق من حالة المستخدم:
wrangler d1 execute micky-db --remote --command \
  "SELECT chat_id, is_authorized, failed_attempts, locked_until FROM users;"

# 2) إذا is_authorized=0، فعّله يدويًا:
wrangler d1 execute micky-db --remote --command \
  "UPDATE users SET is_authorized=1 WHERE chat_id=1235548782;"

# 3) إذا locked_until > 0, احذف القفل:
wrangler d1 execute micky-db --remote --command \
  "UPDATE users SET locked_until=NULL, failed_attempts=0 WHERE chat_id=1235548782;"
```

---

## 11. أوامر تشخيصية مفيدة

### 11.1 فحص صحة شامل

```bash
#!/bin/bash
# احفظ هذا في /home/z/my-project/scripts/health-check.sh

echo "=== 1. Worker Health ==="
curl -s https://micky-assistant.cources01.workers.dev/health | jq .

echo -e "\n=== 2. Telegram Webhook Info ==="
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo" | jq .

echo -e "\n=== 3. D1 Database — Latest Logs ==="
wrangler d1 execute micky-db --remote --command \
  "SELECT * FROM system_logs ORDER BY id DESC LIMIT 5;"

echo -e "\n=== 4. Workers AI — Test Inference ==="
curl -s -X POST https://micky-assistant.cources01.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer ${BYOK_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"test"}],"max_tokens":50}' | jq .

echo -e "\n=== 5. KV Namespaces ==="
wrangler kv key list --binding=RATE_LIMITS --remote | jq '. | length'

echo -e "\n=== 6. Queue Status ==="
wrangler queues list
```

### 11.2 سجلات لحظية

```bash
# سجلات الـ Worker (live):
wrangler tail

# سجلات الـ Worker (مصفاة للأخطاء):
wrangler tail --format=pretty | grep -i error

# سجلات GitHub Actions:
gh run watch --repo mickystudio/micky-infra --exit-status

# سجلات Kaggle:
kaggle kernels output dentistmichaelnabil/montage_pipeline -p /tmp/kaggle-logs/
```

### 11.3 تنظيف البيانات التجريبية

```bash
# ⚠️ تحذير: هذه الأوامر تحذف بيانات. استخدمها بحذر!

# حذف كل الرسائل التجريبية:
wrangler d1 execute micky-db --remote --command \
  "DELETE FROM messages WHERE created_at < unixepoch() - 86400;"

# حذف كل المهام المكتملة (> 7 أيام):
wrangler d1 execute micky-db --remote --command \
  "DELETE FROM tasks WHERE status='completed' AND completed_at < unixepoch() - 604800;"

# تفريغ system_logs (أبقِ آخر 7 أيام فقط):
wrangler d1 execute micky-db --remote --command \
  "DELETE FROM system_logs WHERE created_at < unixepoch() - 604800;"
```

---

## 📚 موارد إضافية

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Cloudflare D1 Docs](https://developers.cloudflare.com/d1/)
- [Workers AI Docs](https://developers.cloudflare.com/workers-ai/)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [GitHub Actions Docs](https://docs.github.com/en/actions)
- [Kaggle API Docs](https://github.com/Kaggle/kaggle-api)

---

## 🆘 إذا فشل كل شيء

إذا جربت كل الحلول أعلاه ولم يعمل شيء، جرب هذا الإجراء الكامل:

```bash
# 1) إعادة نشر الـ Worker:
cd /home/z/my-project/download/micky-assistant/worker
wrangler deploy

# 2) إعادة تعيين الـ webhook:
TOKEN="<your_token>"
curl -X POST "https://api.telegram.org/bot${TOKEN}/deleteWebhook"
curl -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  -d "url=https://micky-assistant.cources01.workers.dev/webhook/telegram"

# 3) فحص السجلات:
wrangler tail
# (في نافذة منفصلة، أرسل /start من تليجرام)

# 4) إذا استمرت المشكلة، راجع plan.md:
cat /home/z/my-project/download/plan.md | grep -A 10 "المشكلة"
```

---

**السابق:** [`deployment.md`](deployment.md)
**التالي:** [`api_reference.md`](api_reference.md) — مرجع API الكامل.
