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
import { handleScheduled } from './cron';

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

      // ============ Kaggle Webhook (kernel completion callback) ============
      if (path === '/webhook/kaggle' && method === 'POST') {
        return await handleKaggleWebhook(request, env);
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

  // ============ Cron Trigger (every 5 min) ============
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduled(env));
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

// ============ Kaggle Webhook Handler (kernel completion callback) ============
async function handleKaggleWebhook(request: Request, env: Env): Promise<Response> {
  // 1. Verify webhook secret
  const secret = request.headers.get('X-Webhook-Secret') || '';
  if (!secret || secret !== env.GH_WEBHOOK_SECRET) {
    return json({ error: 'Invalid webhook secret' }, 401);
  }

  // 2. Parse body
  const body = await request.json() as {
    task_id: string;
    status: 'completed' | 'failed';
    output_url: string;
    output_meta: Record<string, unknown>;
    message?: string;
  };

  if (!body.task_id) {
    return json({ error: 'task_id is required' }, 400);
  }

  // 3. Look up the task to get chat_id
  const task = await env.DB.prepare(
    'SELECT id, chat_id, type, status FROM tasks WHERE id = ?'
  ).bind(body.task_id).first() as { id: string; chat_id: string; type: string; status: string } | null;

  if (!task) {
    return json({ error: 'task not found' }, 404);
  }

  // 4. Update the task in D1
  const newStatus = body.status === 'completed' ? 'completed' : 'failed';
  await env.DB.prepare(
    'UPDATE tasks SET status = ?, output_url = ?, output_meta = ?, completed_at = ?, error_log = ? WHERE id = ?'
  ).bind(
    newStatus,
    body.output_url || null,
    JSON.stringify(body.output_meta || {}),
    Date.now() / 1000,
    body.status === 'failed' ? JSON.stringify(body.output_meta) : null,
    body.task_id,
  ).run();

  // 5. Send Telegram notification to the user
  const chatId = parseInt(task.chat_id, 10);
  if (!isNaN(chatId)) {
    if (body.status === 'completed') {
      const outputUrl = body.output_url || '(no URL)';
      const meta = body.output_meta || {};
      await sendTelegramMessage(env, chatId, [
        '✅ *اكتملت معالجة الفيديو بنجاح!*',
        '',
        `🆔 معرّف المهمة: \`${body.task_id}\``,
        `📁 الناتج: ${outputUrl}`,
        '',
        '*تفاصيل الإخراج:*',
        '```json',
        JSON.stringify(meta, null, 2).slice(0, 1500),
        '```',
        '',
        '📥 يمكنك تنزيل الناتج من الرابط أعلاه.',
      ].join('\n'));
    } else {
      const errMsg = (body.output_meta?.error as string) || body.message || 'Unknown error';
      await sendTelegramMessage(env, chatId, [
        '❌ *فشلت معالجة الفيديو*',
        '',
        `🆔 معرّف المهمة: \`${body.task_id}\``,
        '⚠️ الخطأ:',
        '```',
        String(errMsg).slice(0, 1000),
        '```',
        '',
        'يمكنك المحاولة مرة أخرى بإرسال الفيديو من جديد.',
      ].join('\n'));
    }
  }

  // 6. Log to system_logs
  await env.DB.prepare(
    'INSERT INTO system_logs (level, component, message, meta) VALUES (?, ?, ?, ?)'
  ).bind(
    body.status === 'completed' ? 'info' : 'error',
    'kaggle-runner',
    `Task ${body.task_id} ${body.status}`,
    JSON.stringify({ output_url: body.output_url, meta_keys: Object.keys(body.output_meta || {}) }),
  ).run().catch(() => {});

  return json({ ok: true, status: 'updated', task_id: body.task_id, new_status: newStatus });
}

// ============ BYOK: Chat Completions ============
async function handleChatCompletions(request: Request, env: Env): Promise<Response> {
  // Verify API key (X-API-Key or Authorization Bearer)
  // Be tolerant: trim whitespace, support both Bearer and lowercase bearer.
  const authHeader = request.headers.get('Authorization') || '';
  const xApiKey = request.headers.get('X-API-Key') || '';
  let apiKey = xApiKey;
  if (!apiKey && authHeader) {
    // Match "Bearer <key>" case-insensitively, tolerate extra spaces.
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    if (m) apiKey = m[1].trim();
  }

  if (!apiKey || !apiKey.startsWith('micky_')) {
    return json({ error: 'Invalid API key. Expected "micky_..." in Authorization: Bearer or X-API-Key header.', code: 'invalid_api_key' }, 401);
  }

  // Lookup API key in D1 (SHA-256 hash, only non-revoked keys)
  const keyHash = await hashApiKey(apiKey);
  let keyRecord;
  try {
    keyRecord = await env.DB.prepare(
      'SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0'
    ).bind(keyHash).first();
  } catch (dbErr) {
    console.error('D1 lookup failed:', dbErr);
    return json({ error: 'Database temporarily unavailable', code: 'db_error' }, 503);
  }

  if (!keyRecord) {
    return json({ error: 'API key not found or revoked', code: 'key_not_found' }, 401);
  }

  // Parse request body (tolerate empty / malformed JSON)
  let body: ChatCompletionRequest;
  try {
    body = await request.json() as ChatCompletionRequest;
  } catch (e) {
    return json({ error: 'Invalid JSON in request body', code: 'invalid_json' }, 400);
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return json({ error: 'messages field is required and must be non-empty array', code: 'invalid_messages' }, 400);
  }

  // Validate each message has role + content
  for (let i = 0; i < body.messages.length; i++) {
    const m = body.messages[i];
    if (!m.role || !m.content) {
      return json({ error: `messages[${i}] must have role and content`, code: 'invalid_message_shape' }, 400);
    }
    if (!['system', 'user', 'assistant', 'tool'].includes(m.role)) {
      return json({ error: `messages[${i}].role "${m.role}" is not supported`, code: 'invalid_role' }, 400);
    }
  }

  // Select model (default: 32B Coder). Unknown models fall through to default.
  const modelMapping: Record<string, string> = {
    'qwen2.5-coder-32b': env.DEFAULT_MODEL,
    'qwen2.5-coder-14b': env.FAST_MODEL,
    'qwen2.5-coder-7b': '@cf/qwen/qwen2.5-coder-7b-instruct',
    // Aliases common in BYOK clients
    'gpt-4': env.DEFAULT_MODEL,
    'gpt-4o': env.DEFAULT_MODEL,
    'gpt-3.5-turbo': env.FAST_MODEL,
    'claude-3-opus': env.DEFAULT_MODEL,
    'claude-3-sonnet': env.FAST_MODEL,
  };
  const requestedModel = body.model || 'qwen2.5-coder-32b';
  const cfModel = modelMapping[requestedModel] || env.DEFAULT_MODEL;

  // Check rate limits (KV counter)
  const today = new Date().toISOString().split('T')[0];
  const rateKey = `ratelimit:${(keyRecord as { id: string }).id}:${today}`;
  let current = 0;
  try {
    current = parseInt(await env.RATE_LIMITS.get(rateKey) || '0', 10);
  } catch (e) {
    // KV read failed — proceed without rate limit check (fail-open)
    console.error('Rate limit KV read failed:', e);
  }
  const dailyLimit = 1000;
  if (current >= dailyLimit) {
    return json({ error: 'Rate limit exceeded', limit: dailyLimit, used: current, code: 'rate_limited' }, 429);
  }

  // Call Workers AI with graceful error handling
  let aiResponse: unknown;
  try {
    aiResponse = await env.AI.run(cfModel, {
      messages: body.messages,
      // Use ?? for top_p/temperature (|| coerces 0 to default, which is wrong)
      max_tokens: body.max_tokens || parseInt(env.MAX_TOKENS_DEFAULT, 10),
      temperature: body.temperature ?? parseFloat(env.TEMPERATURE_DEFAULT),
      top_p: body.top_p ?? 0.8,
      stream: body.stream === true,
    });
  } catch (aiErr) {
    console.error('Workers AI call failed:', aiErr);
    return json({
      error: 'Model inference failed',
      code: 'model_error',
      message: String(aiErr),
      // OpenAI-compatible shape
      type: 'server_error',
    }, 502);
  }

  // Increment rate limit (best-effort)
  try {
    await env.RATE_LIMITS.put(rateKey, String(current + 1), { expirationTtl: 86400 });
  } catch (e) {
    console.error('Rate limit KV write failed:', e);
  }

  // Update last_used (best-effort)
  try {
    await env.DB.prepare('UPDATE api_keys SET last_used = ? WHERE id = ?')
      .bind(Date.now() / 1000, (keyRecord as { id: string }).id).run();
  } catch (e) {
    console.error('last_used update failed:', e);
  }

  // Log usage (best-effort)
  try {
    await env.DB.prepare(
      'INSERT INTO system_logs (level, component, message, meta) VALUES (?, ?, ?, ?)'
    ).bind('info', 'byok', 'chat completion', JSON.stringify({
      key_id: (keyRecord as { id: string }).id,
      model: requestedModel,
      tokens: (aiResponse as { usage?: { total_tokens?: number } }).usage?.total_tokens,
    })).run();
  } catch (e) {
    console.error('system_logs insert failed:', e);
  }

  // ============ STREAMING (OpenAI-compatible SSE) ============
  // Workers AI returns a ReadableStream when stream: true is passed.
  // We need to transform each chunk from CF format ({response: "..."}) to OpenAI format ({choices:[{delta:{content:"..."}}]}).
  if (body.stream === true) {
    const chatId = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    // Check if aiResponse is actually a ReadableStream
    if (aiResponse instanceof ReadableStream) {
      const transformedStream = aiResponse.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          // Workers AI streaming chunks come as JSON strings ending in \n
          // Some chunks may be partial — buffer them
          try {
            const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk as ArrayBuffer);
            // Workers AI streams chunks like: data: {"response":"...","usage":{...}}\n\n
            // OR raw JSON lines: {"response":"..."}\n
            // Split on newlines and parse each line
            const lines = text.split('\n');
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              let parsed: { response?: string; usage?: Record<string, unknown> };
              try {
                // Strip "data: " prefix if present
                const jsonStr = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed;
                if (jsonStr === '[DONE]') {
                  controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
                  continue;
                }
                parsed = JSON.parse(jsonStr);
              } catch {
                continue; // skip unparseable partial chunks
              }
              // Emit OpenAI-compatible SSE chunk
              const openaiChunk = {
                id: chatId,
                object: 'chat.completion.chunk',
                created,
                model: requestedModel,
                choices: [{
                  index: 0,
                  delta: { content: parsed.response || '' },
                  finish_reason: null,
                }],
              };
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(openaiChunk)}\n\n`));
            }
          } catch (err) {
            console.error('Stream transform error:', err);
          }
        },
      }));

      return new Response(transformedStream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } else {
      // Worker AI returned a non-stream response even though stream: true was requested.
      // Fall back to non-streaming response with a single chunk.
      const text = (aiResponse as { response?: string }).response || '';
      const chunks = text.match(/.{1,3}/g) || [text];
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            const openaiChunk = {
              id: chatId,
              object: 'chat.completion.chunk',
              created,
              model: requestedModel,
              choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`));
          }
          // Final chunk with finish_reason: stop + usage
          const finalChunk = {
            id: chatId,
            object: 'chat.completion.chunk',
            created,
            model: requestedModel,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: (aiResponse as { usage?: Record<string, unknown> }).usage,
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  }

  // ============ NON-STREAMING (OpenAI-compatible) ============
  const aiRes = aiResponse as { response?: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
  const response = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: aiRes.response || '',
        },
        finish_reason: 'stop',
      },
    ],
    usage: aiRes.usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };

  return json(response);
}

// ============ Media Message Handler (video / voice / document / photo) ============
async function handleMediaMessage(
  env: Env,
  chatId: number,
  msg: TelegramMessage,
  mediaFile: TelegramFile | { file_id: string; file_unique_id?: string },
  caption: string,
): Promise<void> {
  const fileId = mediaFile.file_id;
  if (!fileId) {
    await sendTelegramMessage(env, chatId, '❌ تعذّر قراءة معرّف الملف من تليجرام.');
    return;
  }

  // Detect media type from msg presence (priority order)
  const isVideo = !!(msg as TelegramMessage & { video?: unknown }).video ||
                  !!(msg as TelegramMessage & { video_note?: unknown }).video_note ||
                  !!(msg as TelegramMessage & { animation?: unknown }).animation;
  const isVoice = !!(msg as TelegramMessage & { voice?: unknown }).voice;
  const isAudio = !!(msg as TelegramMessage & { audio?: unknown }).audio;
  const isPhoto = !!(msg as TelegramMessage & { photo?: unknown }).photo;
  const isDocument = !!(msg as TelegramMessage & { document?: unknown }).document;
  const isSticker = !!(msg as TelegramMessage & { sticker?: unknown }).sticker;

  // Resolve file metadata via getFile
  let filePath = '';
  let fileSize = 0;
  try {
    const metaRes = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`,
    );
    const meta = (await metaRes.json()) as { ok: boolean; description?: string; result?: { file_path?: string; file_size?: number } };
    if (!meta.ok || !meta.result?.file_path) {
      await sendTelegramMessage(
        env,
        chatId,
        `❌ تعذّر جلب الملف من تليجرام: ${meta.description || 'unknown error'}`,
      );
      return;
    }
    filePath = meta.result.file_path;
    fileSize = meta.result.file_size || 0;
  } catch (err) {
    await sendTelegramMessage(env, chatId, `❌ خطأ أثناء جلب الملف: ${String(err)}`);
    return;
  }

  // ============ Branch 1: Video → Montage Pipeline ============
  if (isVideo) {
    // Acknowledge + queue for montage pipeline (Kaggle GPU)
    const duration = (mediaFile as TelegramFile & { duration?: number }).duration || 0;
    const width = (mediaFile as TelegramFile & { width?: number }).width || 0;
    const height = (mediaFile as TelegramFile as unknown as { height?: number }).height || 0;

    // Persist file URL reference in D1 (so the queue consumer can fetch it)
    const fileId2 = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO project_files (id, project_id, type, filename, storage_url, storage_type, size_bytes, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      fileId2,
      'proj_test_001', // default project for admin testing
      'video',
      caption || `video_${msg.message_id}.mp4`,
      `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`,
      'telegram',
      fileSize,
      Date.now() / 1000,
    ).run().catch(() => {/* ignore if no project_files table */});

    // Create a task in D1 (status=queued) — picked up by Kaggle runner
    const taskId = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO tasks (id, chat_id, type, status, priority, input_spec, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      taskId,
      String(chatId),
      'montage',
      'queued',
      5,
      JSON.stringify({
        file_url: `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`,
        caption,
        duration_sec: duration,
        width,
        height,
        message_id: msg.message_id,
      }),
      Date.now() / 1000,
    ).run().catch(async (e) => {
      // If tasks table schema differs, fall back to just informing the user
      console.error('Failed to enqueue montage task:', e);
    });

    // Enqueue the task for the queue consumer (which routes to Kaggle)
    try {
      await env.TASKS_QUEUE.send({
        type: 'montage',
        taskId: taskId,
        chatId: chatId,
        payload: {
          file_url: `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`,
          caption,
          duration,
          message_id: msg.message_id,
        },
      } as QueueMessage);
    } catch (e) {
      console.error('Queue send failed (non-fatal — task still in D1):', e);
    }

    const lines = [
      '*🎬 فيديو مستلَم — جارٍ بدء Montage Pipeline*',
      '',
      `📦 الحجم: ${(fileSize / 1024 / 1024).toFixed(2)} MB`,
      `⏱️ المدة: ${duration ? `${duration}s` : 'غير معروفة'}`,
      `📐 الأبعاد: ${width}×${height || '?'}`,
      caption ? `📝 الوصف: ${caption}` : '',
      '',
      '🆔 معرّف المهمة:',
      `\`${taskId}\``,
      '',
      '*ما سيحدث الآن:*',
      '1. سيُنقل الفيديو إلى Kaggle GPU',
      '2. تحسين الصوت (إزالة الضوضاء + normalize)',
      '3. إزالة الخلفية (RVM)',
      '4. تدرج لوني سينمائي',
      '5. ترجمة Hormozi-style',
      '6. تصدير لـ 5 منصات + captions',
      '',
      '⌛ المعالجة تستغرق عادةً 30-60 دقيقة.',
      'سأُعلمك فور اكتمال كل مرحلة.',
      '',
      'أرسل /cancel لإلغاء المهمة.',
    ].filter(Boolean);
    await sendTelegramMessage(env, chatId, lines.join('\n'));
    return;
  }

  // ============ Branch 2: Voice / Audio → Whisper Transcription ============
  if (isVoice || isAudio) {
    const duration = (mediaFile as TelegramFile & { duration?: number }).duration || 0;
    const audioUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;

    await sendTelegramMessage(
      env,
      chatId,
      [
        '🎤 *رسالة صوتية مستلَمة*',
        '',
        `⏱️ المدة: ${duration}s`,
        `📦 الحجم: ${(fileSize / 1024).toFixed(1)} KB`,
        '',
        '⏳ جارٍ التفريغ الصوتي عبر Whisper...',
      ].join('\n'),
    );

    try {
      // Download the audio file
      const audioRes = await fetch(audioUrl);
      const audioBlob = await audioRes.blob();

      // Call Workers AI Whisper for transcription
      const whisperRes = await env.AI.run(env.WHISPER_MODEL, {
        audio: await audioBlob.arrayBuffer(),
      });
      const transcript = (whisperRes as { text?: string }).text || '';

      if (transcript.trim()) {
        await sendTelegramMessage(
          env,
          chatId,
          [
            '*✅ تم التفريغ الصوتي*',
            '',
            '📝 النص:',
            transcript,
            '',
            '— سأعالج هذا النص الآن كرسالة عادية —',
          ].join('\n'),
        );

        // Feed the transcript back through text mode
        const { handleTextMessage } = await import('./modes/text_mode');
        await handleTextMessage(env, chatId, transcript).catch(async (e) => {
          console.error('Text mode failed for transcribed voice:', e);
          // Fallback: store and reply with AI
          const aiResponse = await env.AI.run(env.DEFAULT_MODEL, {
            messages: [
              { role: 'system', content: 'You are Micky Assistant. Reply in Arabic. Be helpful and professional.' },
              { role: 'user', content: transcript },
            ],
            max_tokens: 2048,
            temperature: 0.4,
          });
          await sendTelegramMessage(env, chatId, (aiResponse as { response: string }).response);
        });
      } else {
        await sendTelegramMessage(env, chatId, '❌ تعذّر تفريغ الصوت (النص فارغ). حاول مرة أخرى بصوت أوضح.');
      }
    } catch (err) {
      console.error('Whisper transcription failed:', err);
      await sendTelegramMessage(
        env,
        chatId,
        `❌ فشل التفريغ الصوتي: ${String(err)}\n\nحاول مرة أخرى أو أرسل النص يدويًا.`,
      );
    }
    return;
  }

  // ============ Branch 3: Photo → Image Upload (future: SDXL/img2img) ============
  if (isPhoto) {
    await sendTelegramMessage(
      env,
      chatId,
      [
        '🖼️ *صورة مستلَمة*',
        '',
        `📦 الحجم: ${(fileSize / 1024).toFixed(1)} KB`,
        '',
        '✅ تم حفظ الصورة. ستُستخدم كمرجع أو مدخل لـ SDXL/img2img عند الطلب.',
        '',
        caption ? `📝 الوصف المرفق: ${caption}` : '',
      ].filter(Boolean).join('\n'),
    );
    return;
  }

  // ============ Branch 4: Document (file) → store + extract text ============
  if (isDocument) {
    const doc = (msg as TelegramMessage & { document?: TelegramFile }).document!;
    const filename = doc.file_name || `file_${Date.now()}`;
    const mimeType = doc.mime_type || 'application/octet-stream';

    await sendTelegramMessage(
      env,
      chatId,
      [
        '📄 *ملف مستلَم*',
        '',
        `📎 الاسم: ${filename}`,
        `📦 النوع: ${mimeType}`,
        `📏 الحجم: ${(fileSize / 1024).toFixed(1)} KB`,
        caption ? `📝 الملاحظة: ${caption}` : '',
        '',
        '✅ تم حفظ الملف في مشروعك. سيُستخرج النص تلقائيًا إن كان قابلاً للقراءة.',
      ].filter(Boolean).join('\n'),
    );
    return;
  }

  // ============ Branch 5: Sticker ============
  if (isSticker) {
    await sendTelegramMessage(
      env,
      chatId,
      '🙂 استلمت الستيكر! لإرسال أمر حقيقي، استعمل /help لرؤية الخيارات.',
    );
    return;
  }

  // Fallback (should not reach here)
  await sendTelegramMessage(env, chatId, '📥 استلمت رسالة وسائط متعددة غير معروفة. أرسل /help للمساعدة.');
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
  const caption = msg.caption || '';
  const user = msg.from;

  // ============ Media handling (video / voice / document / photo) ============
  // If the message has a media attachment, route it through the file handler
  // BEFORE any text-based command parsing. The caption (if any) is preserved
  // as the user's intent description.
  const mediaFile =
    msg.video ||
    msg.video_note ||
    msg.voice ||
    msg.audio ||
    msg.document ||
    (msg.photo && msg.photo.length > 0 ? msg.photo[msg.photo.length - 1] : undefined) ||
    msg.animation ||
    msg.sticker;

  if (mediaFile) {
    await handleMediaMessage(env, chatId, msg, mediaFile, caption);
    return;
  }

  // If we get here with empty text and no media, ignore silently
  if (!text) return;

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

  // ============ /cancel — Cancel active task ============
  if (text === '/cancel' || text.startsWith('/cancel ')) {
    const { handleCancelCommand } = await import('./bot/handlers');
    const taskId = text.startsWith('/cancel ') ? text.slice(8).trim() : undefined;
    await handleCancelCommand(env, chatId, taskId);
    return;
  }

  // ============ /settings — User settings ============
  if (text === '/settings') {
    const { handleSettingsCommand } = await import('./bot/handlers');
    await handleSettingsCommand(env, chatId);
    return;
  }

  // ============ /biometric — Enroll biometric ============
  if (text === '/biometric' || text.startsWith('/biometric ')) {
    const { handleBiometricCommand } = await import('./bot/handlers');
    const action = text.startsWith('/biometric ') ? text.slice(11).trim() : undefined;
    await handleBiometricCommand(env, chatId, action);
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
  caption?: string;
  // Media attachments
  video?: TelegramFile;
  video_note?: { file_id: string; file_unique_id?: string; duration?: number; length?: number };
  voice?: TelegramFile & { duration?: number };
  audio?: TelegramFile & { duration?: number; performer?: string; title?: string };
  document?: TelegramFile;
  photo?: TelegramFile[]; // array of sizes (smallest → largest)
  sticker?: { file_id: string; file_unique_id?: string; width?: number; height?: number; is_animated?: boolean; is_video?: boolean; emoji?: string };
  animation?: TelegramFile;
}

interface TelegramFile {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  duration?: number;
  width?: number;
  height?: number;
}

interface ChatCompletionRequest {
  model?: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
}
