# 📡 مرجع API الكامل — Micky Assistant Unlimited

> مرجع شامل لكل الـ endpoints الخاصة بـ Micky Assistant Worker. كل endpoint موثّق بـ: الوصف، الطلب (Request)، الرد (Response)، أمثلة curl/TypeScript/Python، وأكواد الحالة.

---

## 📑 جدول المحتويات

1. [معلومات عامة](#1-معلومات-عامة)
2. [`GET /` — معلومات البوت](#2-get--معلومات-البوت)
3. [`GET /health` — فحص الصحة](#3-get-health-فحص-الصحة)
4. [`POST /webhook/telegram` — Webhook تليجرام](#4-post-webhook-telegram-webhook-تليجرام)
5. [`POST /webhook/github` — Webhook GitHub Actions](#5-post-webhook-github-webhook-github-actions)
6. [`GET /v1/models` — قائمة النماذج (BYOK)](#6-get-v1models-قائمة-النماذج-byok)
7. [`POST /v1/chat/completions` — BYOK Chat Completions](#7-post-v1chatcompletions-byok-chat-completions)
8. [المصادقة (Authentication)](#8-المصادقة-authentication)
9. [الحدود (Rate Limits)](#9-الحدود-rate-limits)
10. [أكواد الأخطاء](#10-أكواد-الأخطاء)
11. [أمثلة تكامل كاملة](#11-أمثلة-تكامل-كاملة)

---

## 1. معلومات عامة

| الحقل | القيمة |
|---|---|
| **Base URL** | `https://micky-assistant.cources01.workers.dev` |
| **البروتوكول** | HTTPS فقط (TLS 1.3) |
| **تنسيق البيانات** | JSON (`Content-Type: application/json`) |
| **التشفير** | UTF-8 (يدعم العربية كاملة) |
| **الـ CORS** | مفعّل (`Access-Control-Allow-Origin: *`) |
| **الإصدار الحالي** | `1.0.0` |

### الـ Endpoints المتاحة

| الـ Method | الـ Endpoint | الوصف | مصادقة |
|---|---|---|---|
| `GET` | `/` | معلومات البوت | لا |
| `GET` | `/health` | فحص الصحة | لا |
| `POST` | `/webhook/telegram` | استقبال تحديثات تليجرام | Telegram |
| `POST` | `/webhook/github` | استقبال callbacks من GitHub Actions | HMAC |
| `GET` | `/v1/models` | قائمة النماذج المتاحة | BYOK Key |
| `POST` | `/v1/chat/completions` | توليد ردود LLM (OpenAI-compatible) | BYOK Key |

---

## 2. `GET /` — معلومات البوت

> يعطي معلومات عامة عن البوت والـ endpoints المتاحة.

### الطلب

```http
GET / HTTP/1.1
Host: micky-assistant.cources01.workers.dev
```

### الرد

**الحالة:** `200 OK`

```json
{
  "name": "Micky Assistant Unlimited",
  "version": "1.0.0",
  "status": "running",
  "endpoints": [
    "/health",
    "/webhook/telegram",
    "/webhook/github",
    "/v1/chat/completions",
    "/v1/models"
  ],
  "models": [
    "qwen2.5-coder-32b",
    "qwen2.5-coder-14b"
  ]
}
```

### مثال curl

```bash
curl https://micky-assistant.cources01.workers.dev/
```

### مثال TypeScript

```typescript
const response = await fetch('https://micky-assistant.cources01.workers.dev/');
const data = await response.json();
console.log(data.name);  // "Micky Assistant Unlimited"
console.log(data.status); // "running"
```

### مثال Python

```python
import requests
response = requests.get('https://micky-assistant.cources01.workers.dev/')
data = response.json()
print(data['name'], data['version'])
```

---

## 3. `GET /health` — فحص الصحة

> يُستخدم للمراقبة (health checks) لمعرفة إذا كان الـ Worker يعمل بشكل صحيح.

### الطلب

```http
GET /health HTTP/1.1
Host: micky-assistant.cources01.workers.dev
```

### الرد

**الحالة:** `200 OK`

```json
{
  "status": "ok",
  "timestamp": 1731216000000,
  "version": "1.0.0"
}
```

| الحقل | النوع | الوصف |
|---|---|---|
| `status` | string | حالة الـ Worker (`ok` أو `error`) |
| `timestamp` | number | وقت الرد بالمللي ثانية (Unix epoch) |
| `version` | string | إصدار الـ Worker |

### مثال curl

```bash
# فحص بسيط:
curl https://micky-assistant.cources01.workers.dev/health

# فحص مع التحقق من الحالة:
curl -s -o /dev/null -w "%{http_code}" https://micky-assistant.cources01.workers.dev/health
# يجب أن يُرجع: 200
```

### مثال للاستخدام في مراقبة (Monitoring)

```bash
#!/bin/bash
# health-monitor.sh — شغّله كل 5 دقائق
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" https://micky-assistant.cources01.workers.dev/health)

if [ "$HEALTH" != "200" ]; then
  # إرسال تنبيه (مثلاً عبر Telegram)
  curl -X POST "https://api.telegram.org/bot<TOKEN>/sendMessage" \
    -d "chat_id=1235548782" \
    -d "text=⚠️ Micky Worker is DOWN! HTTP $HEALTH"
fi
```

### تكامل مع GitHub Actions (Prewarm)

```yaml
# .github/workflows/prewarm.yml
name: Health Check
on:
  schedule:
    - cron: "*/5 * * * *"  # كل 5 دقائق

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - name: Health check
        run: |
          RESPONSE=$(curl -s https://micky-assistant.cources01.workers.dev/health)
          STATUS=$(echo $RESPONSE | jq -r .status)
          if [ "$STATUS" != "ok" ]; then
            echo "Worker unhealthy!"
            exit 1
          fi
```

---

## 4. `POST /webhook/telegram` — Webhook تليجرام

> هذا الـ endpoint يستقبل كل تحديثات تليجرام (رسائل، أوامر، إلخ). لا تُستدعيه يدويًا — تليجرام يوجّه له الطلبات تلقائيًا.

### الطلب

```http
POST /webhook/telegram HTTP/1.1
Host: micky-assistant.cources01.workers.dev
Content-Type: application/json
```

### Body — تنسيق Telegram Update

```json
{
  "update_id": 123456789,
  "message": {
    "message_id": 42,
    "from": {
      "id": 1235548782,
      "first_name": "Michael",
      "username": "micky50000"
    },
    "chat": {
      "id": 1235548782,
      "type": "private"
    },
    "text": "/start"
  }
}
```

### الرد

**الحالة:** `200 OK`

```json
{
  "ok": true
}
```

> 📌 **مهم:** الـ Worker يُرجع `200 OK` فورًا، ثم يعالج الرسالة في الخلفية عبر `ctx.waitUntil()`. هذا يمنع تليجرام من إعادة إرسال الطلب (retry).

### الأوامر المدعومة

| الأمر | الوصف |
|---|---|
| `/start` | بدء المحادثة / عرض القائمة الرئيسية |
| `/help` | عرض كل الأوامر |
| `/text` | تفعيل Text Mode |
| `/code` | تفعيل Code Mode (BYOK) |
| `/graphics` | تفعيل Graphics Mode |
| `/montage` | تفعيل Montage Mode |
| `/projects` | قائمة المشاريع |
| `/newproject` | إنشاء مشروع جديد |
| `/stats` | إحصائيات الاستخدام |
| `/health` | حالة النظام |
| `/settings` | الإعدادات |
| `/cancel` | إلغاء المهمة الحالية |

### إعداد الـ Webhook

```bash
# ربط الـ webhook:
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://micky-assistant.cources01.workers.dev/webhook/telegram"

# حذف الـ webhook:
curl -X POST "https://api.telegram.org/bot<TOKEN>/deleteWebhook"

# فحص حالة الـ webhook:
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo" | jq .
```

---

## 5. `POST /webhook/github` — Webhook GitHub Actions

> يستقبل callbacks من GitHub Actions عند اكتمال (أو فشل) مهمة.

### الطلب

```http
POST /webhook/github HTTP/1.1
Host: micky-assistant.cources01.workers.dev
Content-Type: application/json
X-GitHub-Event: workflow_run
X-Hub-Signature-256: sha256=<HMAC_SIGNATURE>
```

### Headers

| Header | الوصف |
|---|---|
| `X-GitHub-Event` | نوع الحدث (`workflow_run`, `workflow_dispatch`, إلخ) |
| `X-Hub-Signature-256` | توقيع HMAC (للتحقق من المصدر) |

### Body — مثال workflow_run

```json
{
  "action": "completed",
  "workflow_run": {
    "id": 12345678,
    "name": "t5k3abc123",       // task_id (يُطابق ما أرسله الـ Worker)
    "status": "completed",
    "conclusion": "success",
    "html_url": "https://github.com/mickystudio/micky-infra/actions/runs/12345678"
  },
  "repository": {
    "full_name": "mickystudio/micky-infra"
  }
}
```

### الرد

**الحالة:** `200 OK`

```json
{
  "ok": true
}
```

### آلية المعالجة

```typescript
// الكود في Worker (مبسّط):
async function handleGitHubWebhook(request, env) {
  const event = request.headers.get('X-GitHub-Event');
  const signature = request.headers.get('X-Hub-Signature-256');

  // التحقق من التوقيع (HMAC with GH_WEBHOOK_SECRET)
  // TODO: implement full signature verification

  const payload = await request.json();

  if (event === 'workflow_run') {
    const action = payload.action;  // "completed" أو "requested"
    const workflowRun = payload.workflow_run;
    const taskId = workflowRun?.name;

    if (taskId) {
      // تحديث حالة المهمة في D1:
      await env.DB.prepare(
        'UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?'
      ).bind(
        action === 'completed' ? 'completed' : 'failed',
        Date.now() / 1000,
        taskId
      ).run();

      // إشعار المستخدم عبر تليجرام
      // ...
    }
  }

  return json({ ok: true });
}
```

### مثال إرسال webhook من GitHub Actions

```yaml
# .github/workflows/runner.yml
- name: Callback to Worker
  if: always()
  run: |
    curl -X POST "${{ github.event.client_payload.callback_url }}" \
      -H "Content-Type: application/json" \
      -H "X-GitHub-Event: workflow_run" \
      -d "{
        \"action\":\"${{ job.status == 'success' && 'completed' || 'failed' }}\",
        \"workflow_run\":{
          \"name\":\"${{ github.event.client_payload.task_id }}\",
          \"conclusion\":\"${{ job.status }}\"
        }
      }"
```

---

## 6. `GET /v1/models` — قائمة النماذج (BYOK)

> يُرجع قائمة النماذج المتاحة للاستخدام عبر BYOK. متوافق مع OpenAI API.

### الطلب

```http
GET /v1/models HTTP/1.1
Host: micky-assistant.cources01.workers.dev
Authorization: Bearer micky_<your_api_key>
```

> 📌 يتطلب `Authorization` header بمفتاح BYOK صالح.

### الرد

**الحالة:** `200 OK`

```json
{
  "object": "list",
  "data": [
    {
      "id": "qwen2.5-coder-32b",
      "object": "model",
      "created": 1731216000,
      "owned_by": "micky"
    },
    {
      "id": "qwen2.5-coder-14b",
      "object": "model",
      "created": 1731216000,
      "owned_by": "micky"
    },
    {
      "id": "qwen2.5-coder-7b",
      "object": "model",
      "created": 1731216000,
      "owned_by": "micky"
    }
  ]
}
```

### النماذج المتاحة

| Model ID | الاسم الكامل | الميزة |
|---|---|---|
| `qwen2.5-coder-32b` | `@cf/qwen/qwen2.5-coder-32b-instruct` | النموذج الافتراضي — أداء عالي |
| `qwen2.5-coder-14b` | `@cf/qwen/qwen2.5-coder-14b-instruct` | الأسرع — للمهام البسيطة |
| `qwen2.5-coder-7b` | `@cf/qwen/qwen2.5-coder-7b-instruct` | الأخف — للاستجابة الفورية |

### مثال curl

```bash
curl https://micky-assistant.cources01.workers.dev/v1/models \
  -H "Authorization: Bearer micky_a1b2c3d4e5f6..."
```

### مثال TypeScript

```typescript
const response = await fetch('https://micky-assistant.cources01.workers.dev/v1/models', {
  headers: { 'Authorization': 'Bearer micky_a1b2c3d4e5f6...' }
});
const { data } = await response.json();
console.log(data.map(m => m.id));
// ["qwen2.5-coder-32b", "qwen2.5-coder-14b", "qwen2.5-coder-7b"]
```

---

## 7. `POST /v1/chat/completions` — BYOK Chat Completions

> **الـ endpoint الأساسي لـ BYOK.** متوافق كاملًا مع OpenAI Chat Completions API. يُستخدم في Cline، Qoder، Roo Code، وأي أداة تدعم OpenAI.

### الطلب

```http
POST /v1/chat/completions HTTP/1.1
Host: micky-assistant.cources01.workers.dev
Content-Type: application/json
Authorization: Bearer micky_<your_api_key>
X-Project-ID: proj_a3b7c9...
X-Task-Mode: surgical
```

### Headers

| Header | مطلوب | الوصف |
|---|---|---|
| `Authorization` | ✅ | `Bearer micky_<api_key>` |
| `Content-Type` | ✅ | `application/json` |
| `X-Project-ID` | اختياري | ID المشروع المرتبط (للتنظيم) |
| `X-Task-Mode` | اختياري | `surgical` (مهام جراحية) أو `default` |
| `X-API-Key` | بديل | يمكن استخدامه بدل `Authorization` |

### Body Parameters

| Parameter | النوع | مطلوب | افتراضي | الوصف |
|---|---|---|---|---|
| `model` | string | ❌ | `qwen2.5-coder-32b` | اسم النموذج |
| `messages` | array | ✅ | — | مصفوفة الرسائل |
| `max_tokens` | number | ❌ | `4096` | الحد الأقصى للـ tokens في الرد |
| `temperature` | number | ❌ | `0.4` | حرارة النموذج (0-2) |
| `top_p` | number | ❌ | `0.8` | nucleus sampling |
| `stream` | boolean | ❌ | `false` | رد متدفق (SSE) |

### مثال Request Body

```json
{
  "model": "qwen2.5-coder-32b",
  "messages": [
    {
      "role": "system",
      "content": "You are a TypeScript expert. Reply in Arabic."
    },
    {
      "role": "user",
      "content": "Write a function to validate email addresses."
    }
  ],
  "max_tokens": 1024,
  "temperature": 0.4,
  "stream": false
}
```

### الرد — Non-Streaming

**الحالة:** `200 OK`

```json
{
  "id": "chatcmpl-a1b2c3d4-e5f6-g7h8-i9j0-k1l2m3n4o5p6",
  "object": "chat.completion",
  "created": 1731216000,
  "model": "qwen2.5-coder-32b",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "إليك دالة TypeScript للتحقق من البريد الإلكتروني:\n\n```typescript\nfunction isValidEmail(email: string): boolean {\n  const emailRegex = /^[\\w-\\.]+@([\\w-]+\\.)+[\\w-]{2,4}$/;\n  return emailRegex.test(email);\n}\n```"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 42,
    "completion_tokens": 87,
    "total_tokens": 129
  }
}
```

### الرد — Streaming (SSE)

عند `stream: true`، الرد يكون Server-Sent Events:

```
data: {"id":"chatcmpl-a1b2c3d4...","object":"chat.completion.chunk","created":1731216000,"model":"qwen2.5-coder-32b","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-a1b2c3d4...","object":"chat.completion.chunk","created":1731216000,"model":"qwen2.5-coder-32b","choices":[{"index":0,"delta":{"content":"إليك"},"finish_reason":null}]}

data: {"id":"chatcmpl-a1b2c3d4...","object":"chat.completion.chunk","created":1731216000,"model":"qwen2.5-coder-32b","choices":[{"index":0,"delta":{"content":" دالة"},"finish_reason":null}]}

...

data: {"id":"chatcmpl-a1b2c3d4...","object":"chat.completion.chunk","created":1731216000,"model":"qwen2.5-coder-32b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

### مثال curl — Non-Streaming

```bash
curl -X POST https://micky-assistant.cources01.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer micky_a1b2c3d4e5f6..." \
  -H "X-Project-ID: proj_a3b7c9..." \
  -H "X-Task-Mode: surgical" \
  -d '{
    "model": "qwen2.5-coder-32b",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Write a Python function to reverse a string."}
    ],
    "max_tokens": 500,
    "temperature": 0.4
  }'
```

### مثال curl — Streaming

```bash
curl -N -X POST https://micky-assistant.cources01.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer micky_a1b2c3d4e5f6..." \
  -d '{
    "model": "qwen2.5-coder-14b",
    "messages": [{"role": "user", "content": "Tell me a joke."}],
    "stream": true,
    "max_tokens": 200
  }'
```

### مثال TypeScript — استخدام OpenAI SDK

```typescript
// استخدم OpenAI SDK الرسمي:
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'micky_a1b2c3d4e5f6...',
  baseURL: 'https://micky-assistant.cources01.workers.dev/v1',
  defaultHeaders: {
    'X-Project-ID': 'proj_a3b7c9...',
    'X-Task-Mode': 'surgical',
  },
});

const response = await client.chat.completions.create({
  model: 'qwen2.5-coder-32b',
  messages: [
    { role: 'system', content: 'You are a TypeScript expert.' },
    { role: 'user', content: 'Write a debounce function.' },
  ],
  max_tokens: 500,
  temperature: 0.4,
});

console.log(response.choices[0].message.content);
```

### مثال Python — استخدام OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    api_key='micky_a1b2c3d4e5f6...',
    base_url='https://micky-assistant.cources01.workers.dev/v1',
    default_headers={
        'X-Project-ID': 'proj_a3b7c9...',
        'X-Task-Mode': 'surgical',
    }
)

response = client.chat.completions.create(
    model='qwen2.5-coder-32b',
    messages=[
        {'role': 'system', 'content': 'You are a Python expert.'},
        {'role': 'user', 'content': 'Write a function to read CSV file.'},
    ],
    max_tokens=500,
    temperature=0.4,
)

print(response.choices[0].message.content)
```

### مثال Streaming في Python

```python
stream = client.chat.completions.create(
    model='qwen2.5-coder-32b',
    messages=[{'role': 'user', 'content': 'Write a long essay.'}],
    stream=True,
)

for chunk in stream:
    if chunk.choices[0].delta.content is not None:
        print(chunk.choices[0].delta.content, end='', flush=True)
```

---

## 8. المصادقة (Authentication)

### أنواع المصادقة المدعومة

#### 1. Bearer Token (موصى به)

```http
Authorization: Bearer micky_a1b2c3d4e5f6...
```

#### 2. X-API-Key Header (بديل)

```http
X-API-Key: micky_a1b2c3d4e5f6...
```

### تنسيق مفتاح BYOK

```
micky_<64 حرفًا عشوائيًا (URL-safe base64)>
```

**مثال:**
```
micky_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6A7B8C9D0E1F2
```

### آلية التحقق

1. الـ Worker يستخرج المفتاح من الـ header.
2. يحسب SHA-256 hash للمفتاح.
3. يبحث في جدول `api_keys` (D1) عن الـ hash المطابق.
4. يتحقق: `revoked = 0`.
5. إذا نجح، يتم المتابعة. إذا فشل، يُرجع `401 Unauthorized`.

```typescript
// الكود الفعلي في Worker:
async function handleChatCompletions(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const apiKey = request.headers.get('X-API-Key') || authHeader.replace('Bearer ', '');

  // التحقق من التنسيق
  if (!apiKey || !apiKey.startsWith('micky_')) {
    return json({ error: 'Invalid API key', code: 'invalid_api_key' }, 401);
  }

  // حساب hash
  const keyHash = await hashApiKey(apiKey);  // SHA-256

  // البحث في D1
  const keyRecord = await env.DB.prepare(
    'SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0'
  ).bind(keyHash).first();

  if (!keyRecord) {
    return json({ error: 'API key not found or revoked', code: 'key_not_found' }, 401);
  }

  // ... المتابعة
}
```

### توليد مفتاح BYOK جديد

> 💡 المفاتيح تُولّد عبر تليجرام (الأمر `/code` → "توليد مفتاح جديد"). لكن هذه طريقة يدوية:

```bash
# توليد مفتاح عشوائي:
openssl rand -base64 48 | tr -d '\n=' | tr '+/' '-_' | awk '{print "micky_"$0}'
# مثال الناتج: micky_a1b2c3d4e5f6g7h8...

# حساب hash (لتخزينه في D1):
echo -n "micky_a1b2c3d4e5f6g7h8..." | sha256sum
# مثال الناتج: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08

# تخزينه في D1:
wrangler d1 execute micky-db --remote --command \
  "INSERT INTO api_keys (id, project_id, key_prefix, key_hash, created_at) VALUES ('key_abc123', 'proj_a3b7c9', 'micky_a1b2', '9f86d081...', unixepoch());"
```

> ⚠️ **احفظ المفتاح الأصلي في مكان آمن!** لا يمكن استرجاعه بعد التخزين.

---

## 9. الحدود (Rate Limits)

| الـ Endpoint | الحد | النافذة |
|---|---|---|
| `/v1/chat/completions` | 1,000 طلب | لكل مفتاح/يوم |
| `/v1/models` | 100 طلب | لكل مفتاح/ساعة |
| `/webhook/telegram` | لا محدود | (مستخدم واحد) |
| `/webhook/github` | لا محدود | (GitHub فقط) |
| `/health` | لا محدود | — |
| Workers AI | 10,000 Neurons/يوم | لكل حساب |

### استجابة تجاوز الحد (429 Too Many Requests)

```json
{
  "error": "Rate limit exceeded",
  "limit": 1000,
  "used": 1000,
  "reset_at": "2026-11-11T00:00:00Z"
}
```

### Headers الـ Rate Limiting

```http
HTTP/1.1 200 OK
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1731302400
```

### مثال التعامل مع Rate Limit في Python

```python
import time
from openai import OpenAI, RateLimitError

client = OpenAI(
    api_key='micky_...',
    base_url='https://micky-assistant.cources01.workers.dev/v1',
)

def safe_chat(messages, max_retries=3):
    for attempt in range(max_retries):
        try:
            return client.chat.completions.create(
                model='qwen2.5-coder-32b',
                messages=messages,
                max_tokens=500,
            )
        except RateLimitError as e:
            if attempt == max_retries - 1:
                raise
            wait_time = 60 * (attempt + 1)  # 1min, 2min, 3min
            print(f"Rate limited. Waiting {wait_time}s...")
            time.sleep(wait_time)
```

---

## 10. أكواد الأخطاء

### أكواد HTTP

| الحالة | المعنى | متى يحدث |
|---|---|---|
| `200 OK` | نجاح | كل endpoints عند النجاح |
| `204 No Content` | نجاح (لا محتوى) | استجابة CORS preflight |
| `400 Bad Request` | طلب خاطئ | body غير صالح JSON، أو حقل مفقود |
| `401 Unauthorized` | غير مصرّح | مفتاح BYOK خاطئ أو مفقود |
| `404 Not Found` | غير موجود | endpoint غير موجود |
| `429 Too Many Requests` | تجاوز الحد | تجاوز rate limit |
| `500 Internal Server Error` | خطأ داخلي | خطأ غير متوقع في الكود |

### أكواد الأخطاء الخاصة (Application Errors)

| Code | HTTP | الوصف |
|---|---|---|
| `invalid_api_key` | 401 | مفتاح لا يبدأ بـ `micky_` |
| `key_not_found` | 401 | المفتاح غير موجود أو ملغي |
| `key_revoked` | 401 | المفتاح تم إلغاؤه |
| `rate_limit_exceeded` | 429 | تجاوز حد الطلبات اليومي |
| `model_not_found` | 400 | اسم النموذج غير معروف |
| `messages_required` | 400 | حقل `messages` مفقود أو فارغ |

### أمثلة على ردود الأخطاء

#### 401 — مفتاح غير صالح

```bash
curl -X POST https://micky-assistant.cources01.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer wrong_key" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}]}'
```

```json
{
  "error": "Invalid API key",
  "code": "invalid_api_key"
}
```

#### 400 — messages فارغة

```bash
curl -X POST https://micky-assistant.cources01.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer micky_..." \
  -H "Content-Type: application/json" \
  -d '{"messages":[]}'
```

```json
{
  "error": "messages field is required and must be non-empty array"
}
```

#### 404 — endpoint غير موجود

```bash
curl https://micky-assistant.cources01.workers.dev/nonexistent
```

```json
{
  "error": "Not Found",
  "path": "/nonexistent"
}
```

#### 429 — تجاوز الحد

```json
{
  "error": "Rate limit exceeded",
  "limit": 1000,
  "used": 1000
}
```

#### 500 — خطأ داخلي

```json
{
  "error": "Internal Server Error",
  "message": "TypeError: Cannot read property 'response' of undefined"
}
```

---

## 11. أمثلة تكامل كاملة

### 11.1 تكامل مع Cline (VS Code extension)

في إعدادات Cline (`settings.json`):

```json
{
  "cline.apiProvider": "openai",
  "cline.openAiBaseUrl": "https://micky-assistant.cources01.workers.dev/v1",
  "cline.openAiApiKey": "micky_a1b2c3d4e5f6...",
  "cline.openAiModelId": "qwen2.5-coder-32b",
  "cline.openAiCustomHeaders": {
    "X-Project-ID": "proj_a3b7c9...",
    "X-Task-Mode": "surgical"
  }
}
```

### 11.2 تكامل مع Qoder

```yaml
# qoder-config.yaml
provider: openai-compatible
base_url: https://micky-assistant.cources01.workers.dev/v1
api_key: micky_a1b2c3d4e5f6...
model: qwen2.5-coder-32b
headers:
  X-Project-ID: proj_a3b7c9...
  X-Task-Mode: surgical
```

### 11.3 تكامل مع Roo Code

```json
{
  "roo.apiProvider": "openai",
  "roo.openAiBaseUrl": "https://micky-assistant.cources01.workers.dev/v1",
  "roo.openAiApiKey": "micky_a1b2c3d4e5f6...",
  "roo.openAiModelId": "qwen2.5-coder-32b"
}
```

### 11.4 تكامل Node.js كامل

```typescript
// micky-client.ts
import OpenAI from 'openai';

export class MickyClient {
  private client: OpenAI;

  constructor(apiKey: string, projectId?: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://micky-assistant.cources01.workers.dev/v1',
      defaultHeaders: projectId ? { 'X-Project-ID': projectId } : {},
    });
  }

  async chat(message: string, systemPrompt?: string): Promise<string> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: message });

    const response = await this.client.chat.completions.create({
      model: 'qwen2.5-coder-32b',
      messages,
      max_tokens: 2048,
      temperature: 0.4,
    });

    return response.choices[0].message.content || '';
  }

  async chatStream(message: string, onToken: (token: string) => void): Promise<void> {
    const stream = await this.client.chat.completions.create({
      model: 'qwen2.5-coder-32b',
      messages: [{ role: 'user', content: message }],
      stream: true,
    });

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content || '';
      onToken(token);
    }
  }

  async listModels(): Promise<string[]> {
    const response = await this.client.models.list();
    return response.data.map(m => m.id);
  }
}

// الاستخدام:
const micky = new MickyClient('micky_a1b2c3d4e5f6...', 'proj_a3b7c9...');

// chat بسيط:
const reply = await micky.chat(
  'Write a TypeScript function to validate email addresses.',
  'You are a TypeScript expert. Reply in Arabic.'
);
console.log(reply);

// streaming:
await micky.chatStream('Tell me a long story.', (token) => {
  process.stdout.write(token);
});
```

### 11.5 تكامل Python كامل

```python
# micky_client.py
from openai import OpenAI
from typing import Optional, Generator

class MickyClient:
    def __init__(self, api_key: str, project_id: Optional[str] = None):
        headers = {}
        if project_id:
            headers['X-Project-ID'] = project_id
        self.client = OpenAI(
            api_key=api_key,
            base_url='https://micky-assistant.cources01.workers.dev/v1',
            default_headers=headers,
        )

    def chat(
        self,
        message: str,
        system_prompt: Optional[str] = None,
        model: str = 'qwen2.5-coder-32b',
        max_tokens: int = 2048,
        temperature: float = 0.4,
    ) -> str:
        messages = []
        if system_prompt:
            messages.append({'role': 'system', 'content': system_prompt})
        messages.append({'role': 'user', 'content': message})

        response = self.client.chat.completions.create(
            model=model,
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature,
        )
        return response.choices[0].message.content

    def chat_stream(self, message: str, model: str = 'qwen2.5-coder-32b') -> Generator[str, None, None]:
        stream = self.client.chat.completions.create(
            model=model,
            messages=[{'role': 'user', 'content': message}],
            stream=True,
        )
        for chunk in stream:
            if chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content

    def list_models(self) -> list[str]:
        response = self.client.models.list()
        return [m.id for m in response.data]


# الاستخدام:
if __name__ == '__main__':
    micky = MickyClient('micky_a1b2c3d4e5f6...', project_id='proj_a3b7c9...')

    # chat بسيط:
    reply = micky.chat(
        'Write a Python function to validate email addresses.',
        system_prompt='You are a Python expert. Reply in Arabic.'
    )
    print(reply)

    # streaming:
    for token in micky.chat_stream('Write a long essay about AI.'):
        print(token, end='', flush=True)
```

### 11.6 تكامل Shell Script (للتنفيذ السريع)

```bash
#!/bin/bash
# micky-chat.sh — أداة CLI للدردشة مع Micky

API_KEY="${MICKY_API_KEY}"
PROJECT_ID="${MICKY_PROJECT_ID:-}"
BASE_URL="https://micky-assistant.cources01.workers.dev/v1"

if [ -z "$API_KEY" ]; then
  echo "Error: Set MICKY_API_KEY environment variable"
  exit 1
fi

# استلام الرسالة:
MESSAGE="$1"
if [ -z "$MESSAGE" ]; then
  echo "Usage: ./micky-chat.sh 'Your question here'"
  exit 1
fi

# إرسال الطلب:
curl -s -X POST "${BASE_URL}/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  ${PROJECT_ID:+-H "X-Project-ID: ${PROJECT_ID}"} \
  -d "$(jq -n \
    --arg msg "$MESSAGE" \
    '{
      model: "qwen2.5-coder-32b",
      messages: [{role: "user", content: $msg}],
      max_tokens: 2048,
      temperature: 0.4
    }'
  )" | jq -r '.choices[0].message.content'

# الاستخدام:
# ./micky-chat.sh "Write a function to reverse a string"
```

---

## 📊 ملخص الـ Endpoints

```
┌──────────────────────────────────────────────────────────────┐
│                    Micky Assistant API                        │
│           https://micky-assistant.cources01.workers.dev       │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  GET  /                    → bot info                        │
│  GET  /health              → health check                    │
│                                                              │
│  POST /webhook/telegram    → Telegram updates (auto)         │
│  POST /webhook/github      → GitHub Actions callbacks        │
│                                                              │
│  GET  /v1/models           → list models (BYOK required)     │
│  POST /v1/chat/completions → chat (BYOK required)            │
│                                                              │
│  Authentication:                                             │
│    Authorization: Bearer micky_<api_key>                      │
│    X-API-Key: micky_<api_key>                                │
│                                                              │
│  Rate Limits:                                                │
│    1,000 requests/day per API key                            │
│    100,000 requests/day Worker total                         │
│                                                              │
│  Models:                                                     │
│    - qwen2.5-coder-32b (default, full power)                 │
│    - qwen2.5-coder-14b (fast)                                │
│    - qwen2.5-coder-7b  (lightest)                            │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 🔗 روابط مفيدة

- [OpenAI API Reference](https://platform.openai.com/docs/api-reference) — مرجع متوافق معه
- [Cloudflare Workers AI Models](https://developers.cloudflare.com/workers-ai/models/) — قائمة النماذج
- [Telegram Bot API](https://core.telegram.org/bots/api) — مرجع تليجرام
- [GitHub Webhooks](https://docs.github.com/en/webhooks) — مرجع GitHub

---

**السابق:** [`troubleshooting.md`](troubleshooting.md)
**العودة للـ README:** [`../README.md`](../README.md)
