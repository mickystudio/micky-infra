# 🚀 دليل النشر الكامل — Micky Assistant Unlimited

> دليل خطوة بخطوة لنشر Micky Assistant Unlimited من الصفر حتى التشغيل الكامل. مصمّم لـ Micky (طبيب أسنان) — كل المصطلحات التقنية مشروحة.

---

## 📑 جدول المحتويات

1. [المتطلبات المسبقة (Prerequisites)](#1-المتطلبات-المسبقة)
2. [Phase 0: إعداد Cloudflare (D1 + KV + Queue + Worker)](#phase-0-إعداد-cloudflare)
3. [Phase 1: نشر الـ Worker عبر Wrangler](#phase-1-نشر-ال-worker)
4. [Phase 2: إعداد مستودعات GitHub](#phase-2-إعداد-github)
5. [Phase 3: إعداد Kaggle للأصول الثقيلة](#phase-3-إعداد-kaggle)
6. [Phase 4: ربط Telegram Bot Webhook](#phase-4-ربط-telegram-webhook)
7. [Phase 5: قائمة الاختبار الشاملة (Testing Checklist)](#phase-5-قائمة-الاختبار)
8. [مرجع متغيرات البيئة](#مرجع-متغيرات-البيئة)
9. [إدارة الأسرار (Secret Management)](#إدارة-الأسرار)

---

## 1. المتطلبات المسبقة

> 💡 **ملاحظة لـ Micky:** لا تحتاج أي خبرة برمجية. كل خطوة مكتوبة بشكل واضح، فقط انسخ الأوامر كما هي.

### 1.1 الحسابات المطلوبة (كلها مجانية بلا بطاقة)

| الحساب | الرابط | ما الذي ستحصل عليه |
|---|---|---|
| **Cloudflare** | https://dash.cloudflare.com/sign-up | Account ID +_workers.dev subdomain |
| **GitHub** | https://github.com/signup | حسابان: مستودعان |
| **Kaggle** | https://www.kaggle.com/account/login | API token + 30h GPU/أسبوع |
| **Telegram** | https://web.telegram.org | Bot Token من BotFather |

### 1.2 الأدوات على جهازك (Local Tools)

#### تثبيت Node.js (الإصدار 20+)

```bash
# على Ubuntu/Debian:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# على macOS (مع Homebrew):
brew install node@20

# التحقق:
node --version  # يجب أن يُظهر v20.x.x
npm --version
```

#### تثبيت Wrangler (CLI الخاص بـ Cloudflare)

```bash
# تثبيت عالمي:
npm install -g wrangler@3.85.0

# التحقق:
wrangler --version
# يجب أن يُظهر: ⛅️ wrangler 3.85.0
```

#### تثبيت Git + GitHub CLI

```bash
# Git:
sudo apt install -y git   # Linux
brew install git           # macOS

# GitHub CLI:
# Linux: https://github.com/cli/cli/blob/trunk/docs/install-linux.md
# macOS: brew install gh

# تسجيل الدخول:
gh auth login
```

### 1.3 التحقق من المتطلبات

بعد التثبيت، شغّل هذا للتحقق:

```bash
echo "Node.js: $(node --version)"
echo "npm: $(npm --version)"
echo "wrangler: $(wrangler --version)"
echo "git: $(git --version)"
echo "gh: $(gh --version)"
```

> ✅ كلها يجب أن تعرض رقم الإصدار بلا أخطاء.

---

## Phase 0: إعداد Cloudflare

### الخطوة 0.1: تسجيل الدخول إلى Wrangler

```bash
cd /home/z/my-project/download/micky-assistant/worker
wrangler login
```

سيفتح المتصفح. اضغط "Allow" لمنح Wrangler صلاحية الوصول لحسابك.

```bash
# التحقق:
wrangler whoami
# يجب أن يُظهر:
# Getting User settings...
# 👋 You are logged in with an OAuth Token, associated with the email ...
# +----------------------------------+--------------------------------------+
# | Account Name                     | Account ID                           |
# +----------------------------------+--------------------------------------+
# | Your Account Name                | ec3166d8714c7d9bb5d47c11145a1522     |
# +----------------------------------+--------------------------------------+
```

### الخطوة 0.2: إنشاء workers.dev subdomain

> ⚠️ **هذه الخطوة يدوية** — لا يمكن فعلها عبر CLI.

1. افتح https://dash.cloudflare.com/
2. اذهب إلى **Workers & Pages** من القائمة الجانبية.
3. إذا رأيت رسالة "Setup a workers.dev subdomain"، اضغط عليها.
4. اختر الـ subdomain الذي تريده. **في حالتنا: `cources01`**
5. اضغط "Set up".

> 📌 **بعد هذه الخطوة،** كل Workers ستكون على `https://<worker-name>.cources01.workers.dev`.

### الخطوة 0.3: إنشاء D1 Database

```bash
wrangler d1 create micky-db
```

**المخرج المتوقع:**

```
✅ Successfully created DB 'micky-db' in region APAC
Created your new D1 database.

[[d1_databases]]
binding = "DB"
database_name = "micky-db"
database_id = "3ef44fc8-fdfd-4844-9708-2ee4f923ece9"   # ← انسخ هذا!
```

> 📌 انسخ `database_id` والصقه في `wrangler.toml` (موجود مسبقًا لكن تحقق منه).

### الخطوة 0.4: تنفيذ الهجرات (Migrations)

```bash
# تنفيذ ملف الـ migration الأول:
wrangler d1 execute micky-db --remote --file=migrations/0001_init.sql

# التحقق من النجاح:
wrangler d1 execute micky-db --remote --command "SELECT name FROM sqlite_master WHERE type='table';"
```

**المخرج المتوقع:**

```
┌─────────────────┬────────────┬──────────┬──────────┐
│ name            │ tbl_name   │ rootpage │ sql      │
├─────────────────┼────────────┼──────────┼──────────┤
│ users           │ users      │ ...      │ ...      │
│ projects        │ projects   │ ...      │ ...      │
│ project_files   │ ...        │ ...      │ ...      │
│ chats           │ ...        │ ...      │ ...      │
│ messages        │ ...        │ ...      │ ...      │
│ chat_summaries  │ ...        │ ...      │ ...      │
│ project_memory  │ ...        │ ...      │ ...      │
│ tasks           │ ...        │ ...      │ ...      │
│ file_locks      │ ...        │ ...      │ ...      │
│ error_book      │ ...        │ ...      │ ...      │
│ api_keys        │ ...        │ ...      │ ...      │
│ system_logs     │ ...        │ ...      │ ...      │
│ settings        │ ...        │ ...      │ ...      │
│ sqlite_sequence │ ...        │ ...      │ ...      │
└─────────────────┴────────────┴──────────┴──────────┘
```

> ✅ يجب أن ترى 13 جدولًا (12 جدول تطبيقي + `sqlite_sequence` داخلي).

### الخطوة 0.5: إنشاء KV Namespaces (4)

```bash
# إنشاء 4 namespaces:
wrangler kv:namespace create LOCKS
wrangler kv:namespace create TASK_STATUS
wrangler kv:namespace create RATE_LIMITS
wrangler kv:namespace create PROMPT_CACHE
```

**المخرج المتوقع لكل أمر:**

```
🌀 Creating namespace with title "LOCKS"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
[[kv_namespaces]]
binding = "LOCKS"
id = "84e47e8307464e2aa936d99a3f9dcfec"   # ← انسخ هذا!
```

> 📌 حدّث `wrangler.toml` بالـ IDs الصحيحة لكل namespace. (موجودة مسبقًا في الـ config الحالي، لكن تحقق منها.)

### الخطوة 0.6: إنشاء Queue

```bash
wrangler queues create micky-tasks-queue
```

**المخرج المتوقع:**

```
🌀 Creating queue micky-tasks-queue
✨ Success!
```

### الخطوة 0.7: (اختياري) إنشاء R2 Bucket

```bash
# R2 يحتاج تفعيل يدوي أول مرة (زيارة dashboard)
wrangler r2 bucket create micky-storage
```

> إذا رأيت خطأ "R2 not enabled" — افتح https://dash.cloudflare.com/r2 واتبع تعليمات التفعيل.

---

## Phase 1: نشر الـ Worker

### الخطوة 1.1: تثبيت Dependencies

```bash
cd /home/z/my-project/download/micky-assistant/worker

# تثبيت حزم npm:
npm install
```

### الخطوة 1.2: فحص TypeScript

```bash
# فحص الأخطاء قبل النشر:
npm run type-check
# يجب ألا يُظهر أي خطأ
```

### الخطوة 1.3: إعداد Secrets

> 💡 **الـ Secrets لا تُكتب في wrangler.toml** — تُحقن منفصلة مشفّرة.

```bash
# 1) Telegram Bot Token (من BotFather):
wrangler secret put TELEGRAM_BOT_TOKEN
# سيطلب منك لصق القيمة. الصق: 1234567890:ABC-DEF... (مثالك الفعلي)

# 2) Telegram chat_id whitelist:
wrangler secret put TELEGRAM_CHAT_ID_WHITELIST
# الصق: 1235548782

# 3) Micky password hash (bcrypt):
# لتوليد hash من كلمة مرورك:
node -e "console.log(require('bcryptjs').hashSync('your_password_here', 10))"
# انسخ الناتج، ثم:
wrangler secret put MICKY_PASSWORD_HASH
# الصق الـ hash.

# 4) GitHub PAT:
# أنشئ PAT من https://github.com/settings/tokens (scoped: repo, workflow)
wrangler secret put GH_PAT_SCOPED

# 5) GitHub Webhook Secret (سلسلة عشوائية):
openssl rand -hex 32
# انسخ الناتج (مثلاً: a1b2c3d4...)
wrangler secret put GH_WEBHOOK_SECRET
# الصق القيمة.

# 6) Kaggle API Token:
# من https://www.kaggle.com/<username>/account → Create New API Token
# يُنزّل ملف kaggle.json. خذ محتواه base64-encoded:
cat kaggle.json | base64
wrangler secret put KAGGLE_API_TOKEN
# الصق الناتج.
```

### الخطوة 1.4: النشر

```bash
wrangler deploy
```

**المخرج المتوقع:**

```
Total Upload: 25.47 KiB / gzip: 8.91 KiB
Worker Startup Time: 12 ms
Uploaded micky-assistant (2.50 sec)
✨ Deployed micky-assistant triggers (sec)
  https://micky-assistant.cources01.workers.dev
  Current Version ID: a1b2c3d4-...
```

### الخطوة 1.5: اختبار النشر

```bash
# فحص الـ health endpoint:
curl https://micky-assistant.cources01.workers.dev/health
# المتوقع: {"status":"ok","timestamp":1731216000000,"version":"1.0.0"}

# فحص الـ root endpoint:
curl https://micky-assistant.cources01.workers.dev/
# المتوقع: {"name":"Micky Assistant Unlimited", ...}

# فحص /v1/models:
curl https://micky-assistant.cources01.workers.dev/v1/models
# المتوقع: {"object":"list","data":[{"id":"qwen2.5-coder-32b",...}]}
```

> ✅ إذا حصلت على الردود أعلاه، الـ Worker يعمل بنجاح!

### الخطوة 1.6: مراقبة السجلات المباشرة

في نافذة طرفية منفصلة:

```bash
wrangler tail
```

سيظهر لك كل طلب وارد للـ Worker لحظيًا — مفيد للتنقيح.

---

## Phase 2: إعداد GitHub

### الخطوة 2.1: إنشاء المستودع العام (micky-infra)

```bash
# عبر GitHub CLI:
gh repo create mickystudio/micky-infra --public --description "Micky Assistant Unlimited - Infra & Workflows"

# أو عبر المتصفح: https://github.com/new
# - Owner: mickystudio
# - Repository name: micky-infra
# - Visibility: Public
# - Initialize with README: ✅
```

### الخطوة 2.2: إنشاء المستودع الخاص (micky-vault)

```bash
gh repo create mickystudio/micky-vault --private --description "Micky Assistant - Vault (secrets, specs, sensitive)"
```

> 📌 **السبب:** المستودع العام يسمح بدقائق GitHub Actions غير محدودة. المستودع الخاص يحفظ الـ specs الحساسة.

### الخطوة 2.3: إضافة Workflows إلى micky-infra

```bash
cd /tmp
git clone https://github.com/mickystudio/micky-infra.git
cd micky-infra

mkdir -p .github/workflows
```

أنشئ الملف `.github/workflows/runner.yml`:

```yaml
name: Micky Runner

on:
  repository_dispatch:
    types: [micky_task]

jobs:
  run-task:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup
        run: |
          echo "Task ID: ${{ github.event.client_payload.task_id }}"
          echo "Spec URL: ${{ github.event.client_payload.spec_url }}"

      - name: Run task
        run: |
          # تنفيذ المهمة بناءً على spec
          echo "Executing task..."

      - name: Callback to Worker
        if: always()
        run: |
          curl -X POST "${{ github.event.client_payload.callback_url }}" \
            -H "Content-Type: application/json" \
            -H "X-GitHub-Event: workflow_run" \
            -d "{\"action\":\"$([ '${{ job.status }}' = 'success' ] && echo completed || echo failed)\",\"workflow_run\":{\"name\":\"${{ github.event.client_payload.task_id }}\"}}"
```

أنشئ الملف `.github/workflows/prewarm.yml`:

```yaml
name: Prewarm Cache

on:
  schedule:
    - cron: "0 */4 * * *"  # كل 4 ساعات

jobs:
  prewarm:
    runs-on: ubuntu-latest
    steps:
      - name: Ping Worker
        run: curl https://micky-assistant.cources01.workers.dev/health
```

أنشئ الملف `.github/workflows/backup.yml`:

```yaml
name: Daily Backup

on:
  schedule:
    - cron: "0 2 * * *"  # يوميًا 2:00 صباحًا UTC

jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - name: Export D1
        run: |
          # تنفيذ النسخ الاحتياطي
          wrangler d1 export micky-db --remote --output=backup.sql
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}

      - name: Upload to Release
        uses: softprops/action-gh-release@v1
        with:
          files: backup.sql
          tag_name: backup-${{ github.run_id }}
```

### الخطوة 2.4: رفع الـ Workflows

```bash
git add .github/workflows/
git commit -m "Add Micky workflows (runner, prewarm, backup)"
git push origin main
```

### الخطوة 2.5: إضافة PAT كـ Secret في micky-vault

```bash
# إضافة PAT للاستخدام داخل Actions:
gh secret set GH_PAT --repo mickystudio/micky-vault
# الصق قيمة PAT
```

---

## Phase 3: إعداد Kaggle

### الخطوة 3.1: الحصول على API Token

1. اذهب إلى https://www.kaggle.com/dentistmichaelnabil/account
2. اضغط **"Create New API Token"**.
3. يُنزّل ملف `kaggle.json` يحوي:
   ```json
   {"username":"dentistmichaelnabil","key":"a1b2c3d4e5f6..."}
   ```

### الخطوة 3.2: رفع Notebooks

```bash
# تثبيت Kaggle CLI:
pip install kaggle

# إعداد الـ credentials:
mkdir -p ~/.kaggle
mv kaggle.json ~/.kaggle/kaggle.json
chmod 600 ~/.kaggle/kaggle.json

# رفع notebook:
kaggle kernels push -p /home/z/my-project/download/micky-assistant/kaggle/montage_pipeline/
```

### الخطوة 3.3: رفع الأصول (Assets)

الأصول = ملفات LUTs، خطوط عربية (Cairo-Bold)، خلفيات احترافية.

```bash
# إنشاء dataset للأصول:
cd /home/z/my-project/download/micky-assistant/kaggle-src/assets/
zip -r micky-assets.zip luts/ backgrounds/ fonts/

# رفع:
kaggle datasets create -p .  # أول مرة
# أو:
kaggle datasets version -p . # للتحديثات
```

### الخطوة 3.4: التحقق من GPU Quota

```bash
# فحص الحصة المتبقية (يوميًا):
kaggle kernels status dentistmichaelnabil/montage_pipeline
```

> 📌 **الحد:** 30 ساعة GPU/أسبوع + 12 ساعة/جلسة. كافٍ لـ ~20-25 فيديو أسبوعيًا.

---

## Phase 4: ربط Telegram Webhook

### الخطوة 4.1: الحصول على chat_id الخاص بـ Micky

> 💡 الـ chat_id الرسمي: `1235548782`. للتحقق:

1. افتح تليجرام، ابحث عن `@userinfobot`.
2. أرسل `/start`.
3. سيُجيب بـ `Your chat ID: 1235548782`.

### الخطوة 4.2: ربط Webhook

```bash
# المتغيرات:
BOT_TOKEN="<telegram_bot_token>"
WORKER_URL="https://micky-assistant.cources01.workers.dev"

# ضبط الـ webhook:
curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -d "url=${WORKER_URL}/webhook/telegram" \
  -d "max_connections=10" \
  -d "allowed_updates=[\"message\",\"edited_message\"]" | jq .

# المتوقع:
# {
#   "ok": true,
#   "result": true,
#   "description": "Webhook was set"
# }
```

### الخطوة 4.3: التحقق من إعداد الـ Webhook

```bash
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo" | jq .

# المتوقع:
# {
#   "ok": true,
#   "result": {
#     "url": "https://micky-assistant.cources01.workers.dev/webhook/telegram",
#     "has_custom_certificate": false,
#     "pending_update_count": 0,
#     "max_connections": 10
#   }
# }
```

> ⚠️ إذا رأيت `"last_error_message"`، فهناك مشكلة. راجع [troubleshooting.md](troubleshooting.md).

### الخطوة 4.4: اختبار البوت

افتح تليجرام، ابحث عن `@micky_assistant_unlimited_bot`، اضغط **Start**.

**المتوقع:** رسالة ترحيب تطلب كلمة المرور.

أرسل كلمة المرور الصحيحة → يجب أن ترى القائمة الرئيسية مع الأوضاع الأربعة.

---

## Phase 5: قائمة الاختبار

### ✅ قائمة الاختبار الشاملة (End-to-End Testing)

استخدم هذه القائمة بعد كل نشر للتأكد من عمل كل شيء:

#### A. الفحوصات الأساسية

| # | الاختبار | الأمر المتوقع | النتيجة |
|---|---|---|---|
| 1 | Health endpoint | `curl /health` يُرجع `{"status":"ok"}` | ☐ |
| 2 | Root endpoint | `curl /` يُرجع bot info | ☐ |
| 3 | Models endpoint | `curl /v1/models` يُرجع 3 نماذج | ☐ |
| 4 | 404 handling | `curl /notexist` يُرجع 404 | ☐ |
| 5 | CORS preflight | `OPTIONS /v1/chat/completions` يُرجع 204 | ☐ |

#### B. فحوصات Telegram Bot

| # | الاختبار | المتوقع | النتيجة |
|---|---|---|---|
| 6 | `/start` من Micky | طلب كلمة المرور أو قائمة الرئيسية | ☐ |
| 7 | `/start` من chat_id غير مصرّح | لا رد (تجاهل صامت) | ☐ |
| 8 | كلمة مرور خاطئة (3 مرات) | حظر 24 ساعة | ☐ |
| 9 | كلمة مرور صحيحة | القائمة الرئيسية تظهر | ☐ |
| 10 | رسالة نص عشوائي | رد من Workers AI | ☐ |
| 11 | `/help` | قائمة الأوامر | ☐ |
| 12 | `/health` | حالة النظام | ☐ |

#### C. فحوصات BYOK

| # | الاختبار | المتوقع | النتيجة |
|---|---|---|---|
| 13 | `/v1/chat/completions` بلا Authorization | 401 Unauthorized | ☐ |
| 14 | `/v1/chat/completions` بمفتاح غير صالح | 401 key_not_found | ☐ |
| 15 | `/v1/chat/completions` بمفتاح صالح | 200 + OpenAI-compatible response | ☐ |
| 16 | Rate limit (1000 طلب) | 429 بعد 1000 | ☐ |

#### D. فحوصات قاعدة البيانات

| # | الاختبار | المتوقع | النتيجة |
|---|---|---|---|
| 17 | `SELECT * FROM users` | صف واحد (Micky) | ☐ |
| 18 | `SELECT * FROM messages LIMIT 5` | آخر 5 رسائل | ☐ |
| 19 | `SELECT * FROM settings` | 7 صفوف افتراضية | ☐ |
| 20 | `SELECT COUNT(*) FROM tasks` | 0 أو أكثر | ☐ |

#### E. فحوصات Queue

| # | الاختبار | المتوقع | النتيجة |
|---|---|---|---|
| 21 | إرسال رسالة للـ Queue | يستلمها الـ consumer | ☐ |
| 22 | فشل معالجة → retry | إعادة محاولة بعد 30s | ☐ |

#### F. فحوصات GitHub Actions

| # | الاختبار | المتوقع | النتيجة |
|---|---|---|---|
| 23 | `repository_dispatch` يصل | Workflow يبدأ | ☐ |
| 24 | Workflow يُرجع callback | Worker يستلم webhook | ☐ |
| 25 | `prewarm.yml` يعمل على cron | فحص كل 4 ساعات | ☐ |

#### G. فحوصات Kaggle

| # | الاختبار | المتوقع | النتيجة |
|---|---|---|---|
| 26 | Kaggle API تعمل | `kaggle kernels list --user dentistmichaelnabil` | ☐ |
| 27 | Notebook يبدأ | status=running | ☐ |
| 28 | Notebook ينتهي + webhook | Worker يستلم callback | ☐ |

### 🏁 نتيجة الاختبار النهائية

إذا نجحت كل الاختبارات (28/28)، فالمشروع جاهز للإنتاج (Production-ready)! 🎉

---

## مرجع متغيرات البيئة

### متغيرات البيئة (Vars — غير سرية)

تُكتب في `wrangler.toml` تحت `[vars]`:

| المتغير | القيمة الافتراضية | الوصف |
|---|---|---|
| `ENVIRONMENT` | `production` | البيئة الحالية |
| `LOG_LEVEL` | `info` | مستوى التسجيل (debug/info/warn/error) |
| `DEFAULT_MODEL` | `@cf/qwen/qwen2.5-coder-32b-instruct` | النموذج الافتراضي |
| `FAST_MODEL` | `@cf/qwen/qwen2.5-coder-14b-instruct` | النموذج السريع |
| `WHISPER_MODEL` | `@cf/openai/whisper-tiny-en` | نموذج Whisper للصوت |
| `ADMIN_CHAT_ID` | `1235548782` | chat_id الخاص بـ Micky |
| `MAX_TOKENS_DEFAULT` | `4096` | الحد الأقصى للـ tokens في الرد |
| `TEMPERATURE_DEFAULT` | `0.4` | حرارة النموذج (0=دقيق، 1=إبداعي) |

### الأسرار (Secrets — مشفّرة)

تُحقن عبر `wrangler secret put`:

| الـ Secret | مطلوب | مثال قيمة | الوصف |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | `7890123:ABC-DEF...` | من BotFather |
| `TELEGRAM_CHAT_ID_WHITELIST` | ✅ | `1235548782` | مفصول بفواصل |
| `MICKY_PASSWORD_HASH` | ✅ | `$2a$10$N9qo8uLOickgx2...` | bcrypt hash |
| `GH_PAT_SCOPED` | ✅ | `ghp_a1b2c3d4...` | Personal Access Token |
| `GH_WEBHOOK_SECRET` | ✅ | `a1b2c3d4...` (32 hex) | للتحقق من توقيع GitHub |
| `KAGGLE_API_TOKEN` | ✅ | `eyJ1c2VybmFtZSI6...` | base64-encoded JSON |

---

## إدارة الأسرار (Secret Management)

### إضافة سر جديد

```bash
wrangler secret put SECRET_NAME
# سيطلب منك لصق القيمة
```

### عرض قائمة الأسرار

```bash
wrangler secret list
```

> ⚠️ **لا يمكن عرض القيم** — فقط الأسماء. القيم مشفّرة ولا يمكن استرجاعها.

### حذف سر

```bash
wrangler secret delete SECRET_NAME
```

### تحديث سر

```bash
# نفس الأمر يُستخدم للتحديث:
wrangler secret put TELEGRAM_BOT_TOKEN
# الصق القيمة الجديدة
```

### تدوير PAT (Rotation)

> 📌 **يُنصح بتدوير PAT كل 30 يومًا لأمان إضافي.**

```bash
# 1) إنشاء PAT جديد من GitHub:
# https://github.com/settings/tokens → Generate new token (classic)
# - Scope: repo, workflow
# - Expiration: 30 days

# 2) تحديث السر:
wrangler secret put GH_PAT_SCOPED
# الصق PAT الجديد

# 3) تحديث PAT في micky-vault:
gh secret set GH_PAT --repo mickystudio/micky-vault
# الصق نفس القيمة

# 4) حذف PAT القديم من GitHub:
# https://github.com/settings/tokens → Delete old token
```

### النسخ الاحتياطي للأسرار

> ⚠️ **مهم:** الأسرار لا تُصدّر تلقائيًا. احتفظ بنسخة آمنة محليًا.

```bash
# ملف مشفّر محليًا (لا ترفعه لـ Git!):
cat > /home/z/my-project/scripts/.secrets-backup << 'EOF'
TELEGRAM_BOT_TOKEN=7890123:ABC-DEF...
TELEGRAM_CHAT_ID_WHITELIST=1235548782
MICKY_PASSWORD_HASH=$2a$10$N9qo8uLOickgx2...
GH_PAT_SCOPED=ghp_a1b2c3d4...
GH_WEBHOOK_SECRET=a1b2c3d4e5f6...
KAGGLE_API_TOKEN=eyJ1c2VybmFtZSI6...
EOF

# تشفير الملف بـ GPG:
gpg --symmetric --cipher-algo AES256 /home/z/my-project/scripts/.secrets-backup
rm /home/z/my-project/scripts/.secrets-backup
# يبقى الملف المشفّر: .secrets-backup.gpg
```

---

## 🆘 استكشاف الأخطاء

إذا واجهت أي مشكلة أثناء النشر، راجع [`troubleshooting.md`](troubleshooting.md).

أو افحص السجلات المباشرة:

```bash
# سجلات الـ Worker:
wrangler tail

# سجلات D1:
wrangler d1 execute micky-db --remote --command "SELECT * FROM system_logs ORDER BY id DESC LIMIT 20;"

# حالة الـ webhook:
curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo | jq .
```

---

## 📞 الدعم

- **المسؤول:** Micky (`chat_id: 1235548782`)
- **الـ Plan المرجعي:** [`/home/z/my-project/download/plan.md`](../plan.md)
- **استكشاف الأخطاء:** [`troubleshooting.md`](troubleshooting.md)
- **مرجع API:** [`api_reference.md`](api_reference.md)

---

**التالي:** [`troubleshooting.md`](troubleshooting.md) — حل المشكلات الشائعة.
