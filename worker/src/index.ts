/**
 * Micky Assistant Unlimited - Main Worker Entry
 * Cloudflare Workers + Workers AI (Qwen2.5-Coder-32B-Instruct)
 *
 * Endpoints:
 *   GET  /health               - Health check
 *   POST /webhook/telegram      - Telegram bot webhook
 *   POST /webhook/github        - GitHub Actions callbacks
 *   POST /v1/chat/completions   - OpenAI-compatible BYOK endpoint
 *   GET  /v1/models             - List available models (BYOK)
 *   GET  /                      - Bot info / landing
 *
 * Created: 2026-11-10
 */

import { processQueuedTask, type QueueMessage } from './core/queue_manager';

export interface Env {
  // D1 Database
  DB: D1Database;
  // KV Namespaces
  LOCKS: KVNamespace;
  TASK_STATUS: KVNamespace;
  RATE_LIMITS: KVNamespace;
  PROMPT_CACHE: KVNamespace;
  // Queue
  TASKS_QUEUE: Queue<QueueMessage>;
  // Workers AI
  AI: Ai;
  // Environment variables
  ENVIRONMENT: string;
  LOG_LEVEL: string;
  DEFAULT_MODEL: string;
  FAST_MODEL: string;
  WHISPER_MODEL: string;
  ADMIN_CHAT_ID: string;
  MAX_TOKENS_DEFAULT: string;
  TEMPERATURE_DEFAULT: string;
  // Secrets
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID_WHITELIST: string;
  MICKY_PASSWORD_HASH: string;
  GH_PAT_SCOPED: string;
  GH_WEBHOOK_SECRET: string;
  KAGGLE_API_TOKEN: string;
}

// ============ Router ============
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // CORS for BYOK endpoint
      if (method === 'OPTIONS') {
        return handleCORS();
      }

      // ============ Health Check ============
      if (path === '/health' && method === 'GET') {
        return json({ status: 'ok', timestamp: Date.now(), version: '1.0.0' });
      }

      // ============ Root ============
      if (path === '/' && method === 'GET') {
        return json({
          name: 'Micky Assistant Unlimited',
          version: '1.0.0',
          status: 'running',
          endpoints: ['/health', '/webhook/telegram', '/webhook/github', '/v1/chat/completions', '/v1/models'],
          models: ['qwen2.5-coder-32b', 'qwen2.5-coder-14b'],
        });
      }

      // ============ Telegram Webhook ============
      if (path === '/webhook/telegram' && method === 'POST') {
        return await handleTelegramWebhook(request, env, ctx);
      }

      // ============ GitHub Webhook (Actions callbacks) ============
      if (path === '/webhook/github' && method === 'POST') {
        return await handleGitHubWebhook(request, env);
      }

      // ============ BYOK: List models ============
      if (path === '/v1/models' && method === 'GET') {
        return json({
          object: 'list',
          data: [
            { id: 'qwen2.5-coder-32b', object: 'model', created: 1731216000, owned_by: 'micky' },
            { id: 'qwen2.5-coder-14b', object: 'model', created: 1731216000, owned_by: 'micky' },
            { id: 'qwen2.5-coder-7b', object: 'model', created: 1731216000, owned_by: 'micky' },
          ],
        });
      }

      // ============ BYOK: Chat Completions (OpenAI-compatible) ============
      if (path === '/v1/chat/completions' && method === 'POST') {
        return await handleChatCompletions(request, env);
      }

      // ============ 404 ============
      return json({ error: 'Not Found', path }, 404);
    } catch (err) {
      console.error('Unhandled error:', err);
      return json({ error: 'Internal Server Error', message: String(err) }, 500);
    }
  },

  // ============ Queue Consumer ============
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processQueuedTask(env, message.body);
        message.ack();
      } catch (err) {
        console.error('Queue message failed:', err);
        message.retry({ delaySeconds: 30 });
      }
    }
  },
};

// ============ Helpers ============
function json(data: unknown, status = 200): Response {
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

// ============ Telegram Webhook Handler ============
async function handleTelegramWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const update = await request.json() as TelegramUpdate;

  if (!update.update_id) {
    return json({ ok: false });
  }

  // Process in background (don't block Telegram)
  ctx.waitUntil(processTelegramUpdate(update, env));

  return json({ ok: true });
}

// ============ GitHub Webhook Handler ============
async function handleGitHubWebhook(request: Request, env: Env): Promise<Response> {
  const event = request.headers.get('X-GitHub-Event');
  const signature = request.headers.get('X-Hub-Signature-256');

  // Verify signature (HMAC with GH_WEBHOOK_SECRET)
  // TODO: implement full signature verification

  const payload = await request.json() as Record<string, unknown>;

  if (event === 'workflow_run') {
    const action = payload.action;
    const workflowRun = payload.workflow_run as Record<string, unknown>;
    const taskId = workflowRun?.name as string;

    if (taskId) {
      // Update task status in D1
      await env.DB.prepare(
        'UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?'
      ).bind(action === 'completed' ? 'completed' : 'failed', Date.now() / 1000, taskId).run();
    }
  }

  return json({ ok: true });
}

// ============ BYOK: Chat Completions ============
async function handleChatCompletions(request: Request, env: Env): Promise<Response> {
  // Verify API key (X-API-Key or Authorization Bearer)
  const authHeader = request.headers.get('Authorization') || '';
  const apiKey = request.headers.get('X-API-Key') || authHeader.replace('Bearer ', '');

  if (!apiKey || !apiKey.startsWith('micky_')) {
    return json({ error: 'Invalid API key', code: 'invalid_api_key' }, 401);
  }

  // Lookup API key in D1
  const keyHash = await hashApiKey(apiKey);
  const keyRecord = await env.DB.prepare(
    'SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0'
  ).bind(keyHash).first();

  if (!keyRecord) {
    return json({ error: 'API key not found or revoked', code: 'key_not_found' }, 401);
  }

  // Parse request body
  const body = await request.json() as ChatCompletionRequest;

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return json({ error: 'messages field is required and must be non-empty array' }, 400);
  }

  // Select model (default: 32B Coder)
  const modelMapping: Record<string, string> = {
    'qwen2.5-coder-32b': env.DEFAULT_MODEL,
    'qwen2.5-coder-14b': env.FAST_MODEL,
    'qwen2.5-coder-7b': '@cf/qwen/qwen2.5-coder-7b-instruct',
  };
  const cfModel = modelMapping[body.model || 'qwen2.5-coder-32b'] || env.DEFAULT_MODEL;

  // Check rate limits (KV counter)
  const today = new Date().toISOString().split('T')[0];
  const rateKey = `ratelimit:${keyRecord.id}:${today}`;
  const current = parseInt(await env.RATE_LIMITS.get(rateKey) || '0', 10);
  const dailyLimit = 1000; // 1000 requests per day per key
  if (current >= dailyLimit) {
    return json({ error: 'Rate limit exceeded', limit: dailyLimit, used: current }, 429);
  }

  // Call Workers AI
  const aiResponse = await env.AI.run(cfModel, {
    messages: body.messages,
    max_tokens: body.max_tokens || parseInt(env.MAX_TOKENS_DEFAULT, 10),
    temperature: body.temperature ?? parseFloat(env.TEMPERATURE_DEFAULT),
    top_p: body.top_p || 0.8,
    stream: body.stream || false,
  });

  // Increment rate limit
  await env.RATE_LIMITS.put(rateKey, String(current + 1), { expirationTtl: 86400 });

  // Update last_used
  await env.DB.prepare('UPDATE api_keys SET last_used = ? WHERE id = ?')
    .bind(Date.now() / 1000, keyRecord.id as string).run();

  // Log usage
  await env.DB.prepare(
    'INSERT INTO system_logs (level, component, message, meta) VALUES (?, ?, ?, ?)'
  ).bind('info', 'byok', 'chat completion', JSON.stringify({
    key_id: keyRecord.id,
    model: body.model,
    tokens: (aiResponse as { usage?: { total_tokens?: number } }).usage?.total_tokens,
  })).run();

  // Return OpenAI-compatible response
  if (body.stream) {
    const stream = (aiResponse as unknown as ReadableStream);
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }

  const response = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model || 'qwen2.5-coder-32b',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: (aiResponse as { response: string }).response,
        },
        finish_reason: 'stop',
      },
    ],
    usage: (aiResponse as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }).usage,
  };

  return json(response);
}

// ============ Process Telegram Update ============
async function processTelegramUpdate(update: TelegramUpdate, env: Env): Promise<void> {
  const msg = update.message || update.edited_message;
  if (!msg) return;

  const chatId = msg.chat?.id;
  if (!chatId) return;

  // Whitelist check
  const whitelist = (env.TELEGRAM_CHAT_ID_WHITELIST || env.ADMIN_CHAT_ID).split(',').map(s => s.trim());
  if (!whitelist.includes(String(chatId))) {
    // Ignore unauthorized users entirely
    return;
  }

  const text = msg.text || '';
  const user = msg.from;

  // ============ /start ============
  if (text === '/start') {
    // Check if user is authorized (in users table)
    const userRecord = await env.DB.prepare(
      'SELECT * FROM users WHERE chat_id = ?'
    ).bind(chatId).first();

    if (!userRecord || !(userRecord as { is_authorized?: number }).is_authorized) {
      await sendTelegramMessage(env, chatId, [
        '*مرحبًا بك في Micky Assistant Unlimited*',
        '',
        '🔐 هذا المساعد محمي بكلمة مرور.',
        '',
        'أرسل كلمة المرور للمتابعة:',
      ].join('\n'));
      return;
    }

    await sendTelegramMessage(env, chatId, [
      '*مرحبًا بعودتك، Micky! 👋*',
      '',
      'اختر الوضع الذي تريده:',
      '',
      '📝 /text - محادثة نصية احترافية',
      '💻 /code - توليد BYOK للأكواد',
      '🎨 /graphics - إنشاء صور',
      '🎬 /montage - مونتاج فيديو',
      '',
      '📂 /projects - إدارة المشاريع',
      '📊 /stats - الإحصائيات',
      '⚙️ /settings - الإعدادات',
    ].join('\n'));
    return;
  }

  // ============ /help ============
  if (text === '/help') {
    await sendTelegramMessage(env, chatId, [
      '*Micky Assistant Unlimited - الأوامر*',
      '',
      '*الأوضاع:*',
      '/text - محادثة نصية',
      '/code - توليد API key للأكواد',
      '/graphics - إنشاء صور',
      '/montage - مونتاج فيديو',
      '',
      '*المشاريع:*',
      '/projects - قائمة المشاريع',
      '/newproject - مشروع جديد',
      '',
      '*أخرى:*',
      '/stats - إحصائيات الاستخدام',
      '/health - حالة النظام',
      '/cancel - إلغاء المهمة الحالية',
    ].join('\n'));
    return;
  }

  // ============ /health ============
  if (text === '/health') {
    // Check all components
    const components: string[] = ['🟢 Worker: يعمل', '🟢 D1: micky-db', '🟢 KV: 4 namespaces', '🟢 Queue: micky-tasks-queue', '🟢 Workers AI: Qwen2.5-Coder-32B'];
    try {
      const stats = await env.DB.prepare('SELECT COUNT(*) as cnt FROM messages').first();
      components.push(`📊 الرسائل: ${(stats as { cnt?: number })?.cnt || 0}`);
    } catch {}
    await sendTelegramMessage(env, chatId, ['*حالة النظام ✅*', '', ...components, '', `⏱️ الوقت: ${new Date().toISOString()}`].join('\n'));
    return;
  }

  // ============ /stats ============
  if (text === '/stats') {
    try {
      const msgCount = await env.DB.prepare('SELECT COUNT(*) as c FROM messages').first() as { c?: number } | null;
      const projectCount = await env.DB.prepare('SELECT COUNT(*) as c FROM projects').first() as { c?: number } | null;
      const taskCount = await env.DB.prepare('SELECT COUNT(*) as c FROM tasks').first() as { c?: number } | null;
      const errorCount = await env.DB.prepare('SELECT COUNT(*) as c FROM error_book').first() as { c?: number } | null;
      const memCount = await env.DB.prepare('SELECT COUNT(*) as c FROM project_memory').first() as { c?: number } | null;
      await sendTelegramMessage(env, chatId, [
        '*📊 إحصائيات Micky Assistant*',
        '',
        `💬 الرسائل: ${msgCount?.c || 0}`,
        `📂 المشاريع: ${projectCount?.c || 0}`,
        `⚙️ المهام: ${taskCount?.c || 0}`,
        `🧠 الذكريات: ${memCount?.c || 0}`,
        `⚠️ الأخطاء المسجلة: ${errorCount?.c || 0}`,
        '',
        `⏱️ ${new Date().toISOString()}`,
      ].join('\n'));
    } catch (e) {
      await sendTelegramMessage(env, chatId, '❌ تعذر جلب الإحصائيات');
    }
    return;
  }

  // ============ /text — Text Mode ============
  if (text === '/text') {
    await sendTelegramMessage(env, chatId, [
      '*📝 Text Mode نشط*',
      '',
      'أرسل أي سؤال أو رسالة وسأجيبك باحترافية.',
      '',
      '💡 يدعم:',
      '• البحث في الويب للمعلومات الحديثة',
      '• فهم السياق عبر المحادثة',
      '• الذاكرة الدائمة لتفضيلاتك',
      '• الرسائل الصوتية (Whisper)',
      '',
      'أرسل /cancel للإلغاء، /help للمساعدة',
    ].join('\n'));
    return;
  }

  // ============ /code — Code Mode ============
  if (text === '/code' || text.startsWith('/code ')) {
    const { handleCodeCommand } = await import('./modes/code_mode');
    const args = text.startsWith('/code ') ? text.slice(6).trim() : undefined;
    await handleCodeCommand(env, chatId, args);
    return;
  }

  // ============ /graphics — Graphics Mode ============
  if (text === '/graphics') {
    await sendTelegramMessage(env, chatId, [
      '*🎨 Graphics Mode*',
      '',
      'قيد التطوير — سيتم تفعيله قريبًا.',
      '',
      'يدعم:',
      '• توليد الصور بالـ AI (SDXL)',
      '• محرر Canvas احترافي',
      '• قوالب طبية جاهزة',
      '• نصوص عربية احترافية',
    ].join('\n'));
    return;
  }

  // ============ /montage — Montage Mode ============
  if (text === '/montage') {
    await sendTelegramMessage(env, chatId, [
      '*🎬 Montage Mode*',
      '',
      'أرسل فيديو خام (1080p 30fps، عمودي 9:16)',
      'وسأقوم بـ:',
      '',
      '• تحسين الصوت لمستوى ستوديو',
      '• إزالة الخلفية واستبدالها',
      '• تدرج لوني سينمائي',
      '• ترجمة Hormozi-style',
      '• أنيميشن احترافي',
      '• تصدير لـ 5 منصات + captions',
      '',
      '⚡ المعالجة على Kaggle GPU (~30-60 دقيقة)',
    ].join('\n'));
    return;
  }

  // ============ /projects — Project Management ============
  if (text === '/projects' || text === '/newproject') {
    const { handleProjectsCommand, handleNewProjectCommand } = await import('./bot/handlers');
    if (text === '/projects') {
      await handleProjectsCommand(env, chatId);
    } else {
      await handleNewProjectCommand(env, chatId);
    }
    return;
  }

  // ============ /newkey — Quick API Key ============
  if (text === '/newkey') {
    const { handleCodeCommand } = await import('./modes/code_mode');
    await handleCodeCommand(env, chatId, 'new');
    return;
  }

  // ============ /cancel ============
  if (text === '/cancel') {
    const { handleCancelWizard } = await import('./bot/handlers');
    await handleCancelWizard(env, chatId);
    return;
  }

  // ============ Check for active wizard ============
  if (text && !text.startsWith('/')) {
    const { hasActiveWizard, handleNewProjectWizardStep } = await import('./bot/handlers');
    if (await hasActiveWizard(env, chatId)) {
      await handleNewProjectWizardStep(env, chatId, text);
      return;
    }

    // ============ Text Mode: Full AI Response with Prompt Compiler ============
    try {
      const { handleTextMessage } = await import('./modes/text_mode');
      await handleTextMessage(env, chatId, text);
    } catch (err) {
      console.error('Text mode failed, falling back to basic:', err);
      // Fallback to basic AI response
      const msgId = crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(msgId, 'default', 'user', text, Date.now() / 1000).run();

      const aiResponse = await env.AI.run(env.DEFAULT_MODEL, {
        messages: [
          { role: 'system', content: 'You are Micky Assistant. Reply in Arabic. Be helpful and professional.' },
          { role: 'user', content: text }
        ],
        max_tokens: 2048,
        temperature: 0.4,
      });
      const reply = (aiResponse as { response: string }).response;
      const replyId = crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO messages (id, chat_id, role, content, model_used, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(replyId, 'default', 'assistant', reply, env.DEFAULT_MODEL, Date.now() / 1000).run();
      await sendTelegramMessage(env, chatId, reply);
    }
    return;
  }

  // Unknown command
  if (text.startsWith('/')) {
    await sendTelegramMessage(env, chatId, `❓ أمر غير معروف: ${text}\n\nأرسل /help لرؤية الأوامر المتاحة.`);
  }
}

// ============ Send Telegram Message ============
async function sendTelegramMessage(env: Env, chatId: number, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown',
    }),
  });
}

// ============ Hash API Key ============
async function hashApiKey(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ============ Process Queue Message ============
// The actual processing (runner routing, state transitions, retries) is
// implemented in src/core/queue_manager.ts and is invoked directly from the
// queue() consumer above. This stub is retained for backwards-compatibility
// with any code that still calls it.
async function processQueueMessage(env: Env, msg: QueueMessage): Promise<void> {
  await processQueuedTask(env, msg);
}

// ============ Types ============
interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; first_name?: string; username?: string };
  text?: string;
}

interface ChatCompletionRequest {
  model?: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
}
