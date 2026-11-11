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
// ============ Multi-provider LLM Gateway (Task A1-retry + A8-retry2) ============
// The gateway module exposes `routeChat` (the OpenAI-compatible multi-provider
// cascade entry point — non-stream), `routeChatStream` (the streaming variant
// — SSE), `handleProviderFeedback` (thumbs-up/down for the dashboard's
// per-provider analytics), plus the registry's `listProviders` (used by the
// /v1/providers route).
import { routeChat, routeChatStream, handleProviderFeedback, listProviders } from './gateway';
import { ProviderMonitor } from './gateway/monitoring';

export interface Env {
  // D1 Database
  DB: D1Database;
  // KV Namespaces
  LOCKS: KVNamespace;
  TASK_STATUS: KVNamespace;
  RATE_LIMITS: KVNamespace;
  PROMPT_CACHE: KVNamespace;
  // Task B13: brand-asset KV namespace.  Holds binary blobs (logos,
  // fonts, intro/outro clips, LUTs) keyed by `{userId}/{type}/{uuid}`.
  // Metadata + active-profile pointer live in the brand_profiles /
  // brand_assets D1 tables (see migration 0004_brand_assets.sql).
  BRAND_ASSETS: KVNamespace;
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
  // ============ Multi-provider LLM Gateway (Task A1-retry) ============
  // Provider API keys. Each is REQUIRED by the gateway's `ProviderKeys`
  // interface; at runtime a missing/empty key is treated as "provider
  // unconfigured" and the provider is skipped in the cascade (see
  // `gateway/registry.ts` `isProviderConfigured`).
  GROQ_KEY_1: string;
  GROQ_KEY_2: string;
  GEMINI_KEY: string;
  MISTRAL_KEY: string;
  OPENROUTER_KEY: string;
  SAMBANOVA_KEY: string;
  COHERE_KEY: string;
  SILICONFLOW_KEY: string;
  CEREBRAS_KEY: string;
  NOVITA_KEY: string;
  GIZMO_KEY: string;
  // ============ B9: HF Spaces ZeroGPU + Modal serverless ============
  // All optional — if missing, dispatchToHFSpaces / dispatchToModal throw
  // informative errors and callers fall back to Kaggle.
  HF_TOKEN?: string;
  HF_SPACE_ID?: string;
  MODAL_TOKEN_ID?: string;
  MODAL_TOKEN_SECRET?: string;
  MODAL_APP_NAME?: string;
  // ============ B16: Audio library (Jamendo + Freesound) ============
  // Optional — used by the montage pipeline's background-music selector.
  // When missing, the audio library returns an empty list and the pipeline
  // falls back to silence or a built-in cue track.
  JAMENDO_CLIENT_ID?: string;
  FREESOUND_TOKEN?: string;
  // ============ Cloudflare account-level credentials (Media Transform + R2) ============
  // Optional — used for server-side thumbnail generation + R2 storage of
  // rendered videos. When missing, the worker falls back to in-pipeline
  // ffmpeg thumbnail extraction + Telegram-hosted output URLs.
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
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

      // ============ BYOK: Chat Completions (OpenAI-compatible, multi-provider cascade) ============
      // Task A1-retry: delegates to `gateway.routeChat` which runs the
      // 11-provider cascade (groq/gemini/mistral/openrouter/workersai/sambanova/
      // cohere/siliconflow/cerebras/novita). The auth + rate-limit check stays
      // in `handleChatCompletions`; the actual inference is now the gateway's
      // job (previously Workers AI only).
      if (path === '/v1/chat/completions' && method === 'POST') {
        return await handleChatCompletions(request, env, ctx);
      }

      // ============ BYOK: Provider Feedback (Task A1-retry) ============
      // POST /v1/feedback { message_id: string, rating: 1 | -1 }
      // Records user thumbs-up/down feedback for the provider that served the
      // message. Used by the dashboard's per-provider quality metrics.
      if (path === '/v1/feedback' && method === 'POST') {
        return await handleFeedback(request, env);
      }

      // ============ BYOK: Provider List (Task A1-retry — Agent C5 addition) ============
      // GET /v1/providers — returns the list of all 11 configured providers
      // with their id / label / configured / healthy status. Read-only,
      // best-effort: D1 ledger failures degrade to healthy='unknown' for
      // every provider rather than erroring out. Useful as a lightweight
      // health probe (vs. /v1/dashboard which is the heavier ops view).
      if (path === '/v1/providers' && method === 'GET') {
        return await handleProviderList(env);
      }

      // ============ BYOK: Provider Dashboard (Task A1-retry) ============
      // GET /v1/dashboard — returns snapshot of every provider's health +
      // quota + 24h call metrics. Powered by Agent A9's `ProviderMonitor`.
      if (path === '/v1/dashboard' && method === 'GET') {
        return await handleDashboard(request, env);
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

  // ============ Cron Trigger ============
  // Routes to:
  //   '*/5 * * * *'  → handleScheduled Kaggle stale-task poll
  //   '*/30 * * * *' → gateway health-check cron (Agent A9)
  //   '0 0 * * *'    → gateway daily-quota reset (Agent A9)
  // See gateway/cron_handler.ts + cron.ts for the dispatch logic.
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduled(env, ctx, event.cron));
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
  ctx.waitUntil(processTelegramUpdate(update, env, ctx));

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
async function handleChatCompletions(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
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

  // ============ Task A1-retry: delegate to the multi-provider gateway ============
  // Previously this called `env.AI.run(cfModel, ...)` (Workers AI only).
  // Now we hand off to `gateway.routeChat(body, env, ctx)`, which runs the
  // 11-provider cascade (groq/gemini/mistral/openrouter/workersai/sambanova/
  // cohere/siliconflow/cerebras/novita) and returns an OpenAI-compatible
  // Response (JSON for non-stream, SSE for stream).
  //
  // The gateway handles:
  //   - intent detection (chat / code / vision / tools / fast / long_context)
  //   - per-intent cascade ordering
  //   - per-provider API key resolution from env
  //   - rate-limit / circuit-breaker state in D1
  //   - SSE stream normalisation to OpenAI shape
  //   - structured error responses with the list of attempted providers
  //
  // We still increment the KV rate-limit counter + update last_used + log
  // usage after a successful call. The gateway itself records the per-provider
  // call audit in `provider_calls` via its QuotaLedger.

  // Build the gateway request. We pass through unknown fields via the index
  // signature on ChatRequest; the gateway tolerates provider-specific extras.
  // `model` is required by the gateway's ChatRequest; default to a sentinel
  // when the client didn't specify one (the gateway will pick the best
  // model per (intent, provider) anyway).
  //
  // Cast through `unknown` because the gateway's `ChatMessage.role` is a
  // `ChatRole` union (`'system' | 'user' | 'assistant' | 'tool'`) but the
  // local `ChatCompletionRequest.messages[].role` is typed as `string` (we
  // validated it's one of the valid roles above, so the cast is safe).
  //
  // Default `max_tokens` to env.MAX_TOKENS_DEFAULT (4096) when the client
  // omits it. Several upstream providers (notably OpenRouter) interpret
  // `max_tokens: undefined` as "use the full model context window"
  // (e.g. 131072 for llama-3.1-8b) which exceeds free-tier credit balances
  // and triggers an HTTP 402. Capping at 4096 keeps free-tier requests
  // within budget while remaining generous for typical chat use cases.
  const defaultMaxTokens = parseInt(env.MAX_TOKENS_DEFAULT || '4096', 10);
  const gatewayReq = {
    model: body.model ?? 'auto',
    messages: body.messages,
    temperature: body.temperature,
    max_tokens: body.max_tokens ?? (isFinite(defaultMaxTokens) && defaultMaxTokens > 0 ? defaultMaxTokens : 4096),
    top_p: body.top_p,
    stream: body.stream === true,
    stop: body.stop,
  } as unknown as Parameters<typeof routeChat>[0];

  let gatewayResponse: Response;
  try {
    // Dispatch to the streaming variant when the client asked for SSE.
    // `routeChat` ignores `req.stream` and always returns a JSON response;
    // `routeChatStream` forces `stream:true` and returns an SSE stream.
    // Both share the same cascade / sticky-session / circuit-breaker code
    // path internally (see gateway/model_router.ts `routeInternal`).
    if (body.stream === true) {
      gatewayResponse = await routeChatStream(gatewayReq, env, ctx);
    } else {
      gatewayResponse = await routeChat(gatewayReq, env, ctx);
    }
  } catch (err) {
    // Defensive: routeChat should never throw (it returns an error Response
    // on any failure), but if it does we surface a 502 with the message.
    console.error('routeChat threw:', err);
    return json({
      error: 'Gateway inference failed',
      code: 'gateway_error',
      message: String(err),
      type: 'server_error',
    }, 502);
  }

  // If the gateway returned a non-2xx, propagate it unchanged — the gateway
  // has already shaped the error body into the OpenAI error format.
  if (!gatewayResponse.ok) {
    return gatewayResponse;
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

  // Log usage (best-effort). For streaming responses we can't read the body
  // without consuming it, so we skip token logging on stream — the gateway's
  // own per-provider audit row carries that information.
  if (body.stream !== true) {
    try {
      // Clone the response so we can read the body for logging without
      // consuming the stream we're about to return to the client.
      const logClone = gatewayResponse.clone();
      const parsed = await logClone.json() as { usage?: { total_tokens?: number }; provider?: string };
      await env.DB.prepare(
        'INSERT INTO system_logs (level, component, message, meta) VALUES (?, ?, ?, ?)'
      ).bind('info', 'byok', 'chat completion', JSON.stringify({
        key_id: (keyRecord as { id: string }).id,
        model: body.model,
        provider: parsed.provider,
        tokens: parsed.usage?.total_tokens,
      })).run();
    } catch (e) {
      console.error('system_logs insert failed:', e);
    }
  }

  return gatewayResponse;
}

// ============ Provider Feedback Handler (Task A1-retry) ============
// POST /v1/feedback { message_id: string, rating: 1 | -1 }
// Records user thumbs-up/down feedback for the provider that served a given
// message id. Best-effort: D1 failures return 200 with a warning so the
// client UX (a thumbs-up/down button click) never errors.
async function handleFeedback(request: Request, env: Env): Promise<Response> {
  let body: { message_id?: string; rating?: number };
  try {
    body = await request.json() as { message_id?: string; rating?: number };
  } catch {
    return json({ error: 'Invalid JSON in request body', code: 'invalid_json' }, 400);
  }

  if (!body.message_id || typeof body.message_id !== 'string') {
    return json({ error: 'message_id is required and must be a string', code: 'invalid_message_id' }, 400);
  }
  if (body.rating !== 1 && body.rating !== -1) {
    return json({ error: 'rating must be 1 (thumbs-up) or -1 (thumbs-down)', code: 'invalid_rating' }, 400);
  }

  try {
    await handleProviderFeedback(body.message_id, body.rating as 1 | -1, env);
  } catch (err) {
    console.error('handleProviderFeedback failed:', err);
    // Still return 200 — feedback is best-effort.
  }
  return json({ ok: true, message_id: body.message_id, rating: body.rating });
}

// ============ Provider Dashboard Handler (Task A1-retry) ============
// GET /v1/dashboard — returns a snapshot of every provider's health + quota
// + 24h call metrics. Powered by Agent A9's `ProviderMonitor.getDashboardData`.
async function handleDashboard(request: Request, env: Env): Promise<Response> {
  try {
    const monitor = new ProviderMonitor(env);
    const data = await monitor.getDashboardData(env);
    return json(data);
  } catch (err) {
    console.error('Dashboard query failed:', err);
    return json({ error: 'Dashboard query failed', message: String(err) }, 500);
  }
}

// ============ Provider List Handler (Task A1-retry — Agent C5 + C1) ============
// GET /v1/providers — returns a lightweight list of all 11 cascade providers
// with their id / label / configured / status (healthy|degraded|down) and
// remaining quota. The richer per-provider snapshot comes from Agent A9's
// `ProviderMonitor.getDashboardData(env)` — we call it once, then merge in
// the registry's `isConfigured` flag so callers can tell "not set up"
// providers apart from "configured but circuit-open" providers.
//
// Best-effort: D1 ledger failures degrade to status='unknown' for every
// provider rather than erroring out. Useful as a lightweight health probe
// (vs. /v1/dashboard which is the heavier ops view).
async function handleProviderList(env: Env): Promise<Response> {
  // Lazy import: avoids pulling the registry into the cold-start path for
  // every non-/v1/providers request.
  const { PROVIDERS, listProviders } = await import('./gateway/registry');
  const ids = listProviders();

  // Pull the dashboard data (best-effort: D1 failures degrade gracefully
  // — ProviderMonitor.getDashboardData returns a row per provider with
  // status='unknown' if D1 is unreachable).
  let dashboardRows: Array<{
    provider: string;
    status: 'healthy' | 'degraded' | 'down' | 'unknown';
    quota_remaining: { rpd: number; tpd: number };
    calls_today: number;
    success_rate: number;
    circuit_open_until: number;
  }> = [];
  try {
    const monitor = new ProviderMonitor(env);
    const data = await monitor.getDashboardData(env);
    dashboardRows = data.providers.map((p) => ({
      provider: p.provider,
      status: p.status,
      quota_remaining: p.quota_remaining,
      calls_today: p.calls_today,
      success_rate: p.success_rate,
      circuit_open_until: p.circuit_open_until,
    }));
  } catch (err) {
    console.error('ProviderMonitor.getDashboardData failed:', err);
  }
  const dashboardByProvider = new Map(dashboardRows.map((r) => [r.provider, r]));

  const providers = ids.map((id) => {
    const adapter = PROVIDERS[id];
    // Dashboard uses the 5-provider routing-layer granularity
    // ('workers-ai', 'groq', 'mistral', 'openrouter', 'gemini'); the
    // registry uses 11-provider per-key granularity ('groq1', 'groq2',
    // 'workersai', …). Map our id to the dashboard's id so we can join.
    const dashboardId = id === 'workersai' ? 'workers-ai'
      : id === 'groq1' || id === 'groq2' ? 'groq'
      : id;
    const dashboard = dashboardByProvider.get(dashboardId);
    const configured = adapter.isConfigured(env);
    // Status precedence: unconfigured → 'down'; else use dashboard's view
    // (which already accounts for circuit_open_until + consecutive_failures
    // + is_healthy — see monitoring.ts `deriveStatus`); else 'unknown'.
    const status: 'healthy' | 'degraded' | 'down' | 'unknown' = !configured
      ? 'down'
      : dashboard?.status ?? 'unknown';
    // Backward-compat alias: clients that read the legacy `healthy` field
    // expect only 'healthy' | 'down' | 'unknown'. Map 'degraded' to 'down'
    // so the legacy contract is preserved (a degraded provider has had
    // recent failures, so 'down' is the honest approximation).
    const healthy: 'healthy' | 'down' | 'unknown' =
      status === 'healthy' ? 'healthy'
      : status === 'down' || status === 'degraded' ? 'down'
      : 'unknown';
    return {
      id,
      label: adapter.label,
      configured,
      status,
      healthy,
      quota_remaining: dashboard?.quota_remaining ?? { rpd: Number.POSITIVE_INFINITY, tpd: Number.POSITIVE_INFINITY },
      calls_today: dashboard?.calls_today ?? 0,
      success_rate: dashboard?.success_rate ?? 0,
      circuit_open_until: dashboard?.circuit_open_until ?? 0,
    };
  });
  const configuredCount = providers.filter((p) => p.configured).length;
  const healthyCount = providers.filter((p) => p.status === 'healthy').length;
  const degradedCount = providers.filter((p) => p.status === 'degraded').length;
  const downCount = providers.filter((p) => p.status === 'down').length;
  return json({
    generated_at: Date.now(),
    total: providers.length,
    configured: configuredCount,
    healthy: healthyCount,
    degraded: degradedCount,
    down: downCount,
    providers,
  });
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
    const videoUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;
    const filename = caption || `video_${msg.message_id}.mp4`;

    // B15: multi-cam detection. If the user has sent (or is about to send)
    // multiple videos within a 60s window, prompt for sync method instead
    // of immediately starting a single-cam montage task.
    try {
      const { handleMulticamVideoUpload } = await import('./bot/handlers');
      const triggeredMulticam = await handleMulticamVideoUpload(
        env, chatId, videoUrl, filename, fileSize, duration, msg.message_id,
      );
      if (triggeredMulticam) {
        // The user will pick a sync + switch mode in the next step.
        // Don't enqueue a single-cam task now — handleMulticamSwitchModeChoice
        // (called when the user picks a switch mode) will enqueue the proper
        // multi-cam task.
        return;
      }
    } catch (e) {
      console.error('Multi-cam detection failed (non-fatal):', e);
      // Fall through to the single-cam path below.
    }

    // Persist file URL reference in D1 (so the queue consumer can fetch it)
    const fileId2 = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO project_files (id, project_id, type, filename, storage_url, storage_type, size_bytes, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      fileId2,
      'proj_test_001', // default project for admin testing
      'video',
      filename,
      videoUrl,
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
        file_url: videoUrl,
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
          file_url: videoUrl,
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
async function processTelegramUpdate(update: TelegramUpdate, env: Env, ctx: ExecutionContext): Promise<void> {
  // Task B11/B13/B15: dispatch callback_query (inline keyboard) for the
  // brand setup wizard, the storyboard approval flow, and the multi-cam
  // sync / switching-mode picker. Each branch acks the callback itself
  // (or delegates to the matching handler that does so).
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat?.id;
    const data = cq.data ?? '';
    if (chatId && data.startsWith('brand:setup:')) {
      try {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: cq.id }),
        });
      } catch (err) {
        console.warn('[callback] answerCallbackQuery failed:', err);
      }
      const { handleBrandSetupCallback } = await import('./bot/brand_setup');
      await handleBrandSetupCallback(env, undefined, chatId, data);
    } else if (chatId && data.startsWith('sb:')) {
      // Task B11: storyboard approval flow (approve / edit / regen / cancel).
      const { routeCallbackQuery } = await import('./bot/handlers');
      await routeCallbackQuery(env, ctx, cq as Parameters<typeof routeCallbackQuery>[2]);
    } else if (chatId && data.startsWith('multicam:sync:')) {
      // Task B15: multi-cam alignment-method choice
      // (auto | clap_detection | manual | skip). Ack the callback so
      // Telegram stops showing the loading spinner, then dispatch to
      // handleMulticamSyncChoice which routes to the manual-offset
      // prompt or the switch-mode picker.
      try {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: cq.id }),
        });
      } catch (err) {
        console.warn('[callback] answerCallbackQuery failed:', err);
      }
      const method = data.slice('multicam:sync:'.length);
      const { handleMulticamSyncChoice } = await import('./bot/handlers');
      await handleMulticamSyncChoice(env, chatId, method);
    } else if (chatId && data.startsWith('multicam:mode:')) {
      // Task B15: multi-cam switching-mode choice
      // (smart | round_robin | beat_sync | speaker). Enqueues the
      // multi-cam montage task with the chosen sync + switching mode.
      try {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: cq.id }),
        });
      } catch (err) {
        console.warn('[callback] answerCallbackQuery failed:', err);
      }
      const switchMode = data.slice('multicam:mode:'.length);
      const { handleMulticamSwitchModeChoice } = await import('./bot/handlers');
      await handleMulticamSwitchModeChoice(env, chatId, switchMode);
    }
    return;
  }

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

  // ============ Task B13: brand wizard + logo photo interception ============
  // If a brand setup wizard is in progress (step=logo) OR the user has a
  // pending logo-upload state (from `/brand logo`), intercept photos
  // before the generic media handler so they go to the brand manager.
  if (msg.photo && msg.photo.length > 0) {
    const { hasActiveBrandWizard } = await import('./bot/handlers');
    const wizardActive = await hasActiveBrandWizard(env, chatId);
    let logoPending = false;
    if (!wizardActive) {
      const { getBrandLogoPending } = await import('./bot/handlers');
      logoPending = (await getBrandLogoPending(env, chatId)) !== null;
    }
    if (wizardActive) {
      const { handleBrandSetupPhoto } = await import('./bot/brand_setup');
      await handleBrandSetupPhoto(env, undefined, chatId, msg.photo);
      return;
    }
    if (logoPending) {
      const { handleBrandLogoPhoto } = await import('./bot/handlers');
      const consumed = await handleBrandLogoPhoto(env, chatId, msg.photo);
      if (consumed) return;
    }
  }

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
      '🎨 /brand - هوية بصرية (شعار/ألوان/خطوط)',
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
      '/brand - إدارة الهوية البصرية (شعار/ألوان/خطوط)',
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

  // ============ /brand — Brand profile management (Task B13) ============
  // Routes to handleBrandCommand which itself dispatches to:
  //   set / logo / font / color / profile / list / new / delete
  if (text === '/brand' || text.startsWith('/brand ')) {
    const { handleBrandCommand } = await import('./bot/handlers');
    const args = text.startsWith('/brand ') ? text.slice(7).trim() : '';
    await handleBrandCommand(env, chatId, args);
    return;
  }

  // ============ /skip — Brand setup wizard skip (Task B13) ============
  // Only meaningful inside the brand setup wizard's logo step.  Outside
  // of the wizard it falls through to the "unknown command" message.
  if (text === '/skip') {
    const { hasActiveBrandWizard } = await import('./bot/handlers');
    if (await hasActiveBrandWizard(env, chatId)) {
      const { handleBrandSetupSkip } = await import('./bot/brand_setup');
      await handleBrandSetupSkip(env, chatId);
      return;
    }
    // No active wizard → fall through to unknown-command handler.
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

  // ============ /storyboard — Storyboard approval (Task B11) ============
  if (text === '/storyboard' || text.startsWith('/storyboard ')) {
    const { handleStoryboardCommand } = await import('./bot/handlers');
    const taskId = text.startsWith('/storyboard ')
      ? text.slice('/storyboard '.length).trim() || undefined
      : undefined;
    await handleStoryboardCommand(env, chatId, taskId);
    return;
  }

  // ============ /approve — Approve pending storyboard (Task B11) ============
  if (text === '/approve') {
    const { handleApproveCommand } = await import('./bot/handlers');
    await handleApproveCommand(env, chatId);
    return;
  }

  // ============ /edit — Edit a take (Task B11) ============
  // Syntax: /edit <take#> <free-text description>
  if (text.startsWith('/edit ')) {
    const { handleEditCommand } = await import('./bot/handlers');
    await handleEditCommand(env, chatId, text.slice('/edit '.length));
    return;
  }

  // ============ Check for active wizard ============
  if (text && !text.startsWith('/')) {
    const { hasActiveWizard, handleNewProjectWizardStep,
            hasActiveStoryboardEdit, getActiveStoryboardEdit,
            handleStoryboardEdit,
            handleMulticamManualOffsetText } = await import('./bot/handlers');
    if (await hasActiveWizard(env, chatId)) {
      await handleNewProjectWizardStep(env, chatId, text);
      return;
    }
    // Task B11: storyboard take-edit wizard — free-text message becomes
    // the edit description for the take the user just selected.
    if (await hasActiveStoryboardEdit(env, chatId)) {
      const state = await getActiveStoryboardEdit(env, chatId);
      if (state) {
        await handleStoryboardEdit(env, ctx, chatId, state.take_idx, text);
        return;
      }
    }
    // Task B15: multi-cam manual-offset wizard — free-text message
    // "cam1:+2.5 cam2:-1.0" becomes the per-camera offset list (only
    // consulted when the user just picked `multicam:sync:manual`).
    // Returns true if consumed; false otherwise (fall through to text mode).
    const consumedMulticam = await handleMulticamManualOffsetText(env, chatId, text);
    if (consumedMulticam) return;

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
  // Task B13: brand setup wizard callback query support.
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number; first_name?: string; username?: string };
    message?: { message_id: number; chat: { id: number; type: string } };
  };
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
  stop?: string | string[];
}
