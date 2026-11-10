/**
 * Micky Assistant — Model Router (cascade orchestrator) — Agent A8-retry2.
 *
 * Public API: routeChat (non-stream), routeChatStream (SSE), handleFeedback.
 *
 * Algorithm: resolve conversation_id → try sticky → classify intent → iterate
 * cascade → atomic decrementQuota via A2 QuotaLedger → adapter.chat()/
 * chatStream() with 25s AbortController timeout → on 429 record429 + open
 * circuit 5 min; on 5xx/network/timeout, if 3+ consecutive failures open
 * circuit 1h; on success recordCall + setStickyProvider → 503 if all fail.
 *
 * Streaming: pre-stream errors fall back; mid-stream errors emit
 * `data: {"error":"Provider failed: ..."}\n\n` + `data: [DONE]\n\n` then close.
 * No `any`; no Node APIs; 25s timeout per attempt; ctx.waitUntil() for metrics.
 */

import type { Env } from '../index';
import type { ChatRequest, ChatResponse, GatewayEnv, ProviderId } from './types';
import { classifyIntent, getCascadeForIntent, pickBestModel } from './utils/intent_classifier';
import type { IntentType } from './utils/intent_classifier';
import { countMessageTokens, willFitInProviderContext } from './utils/token_counter';
import { QuotaLedger } from './ledger/ledger';
import type { ProviderCall } from './ledger/ledger';
import { getProvider, getHealthyProviders } from './registry';

// === Constants ===

const CHAT_TIMEOUT_MS = 25_000;
const RATE_LIMIT_CIRCUIT_MS = 5 * 60 * 1000;
const SERVER_ERROR_CIRCUIT_MS = 60 * 60 * 1000;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Project-ID, X-Task-Mode',
};

// === Public API ===

export async function routeChat(req: ChatRequest, env: Env, ctx: ExecutionContext): Promise<Response> {
  return routeInternal(req, env, ctx, false);
}

export async function routeChatStream(req: ChatRequest, env: Env, ctx: ExecutionContext): Promise<Response> {
  return routeInternal({ ...req, stream: true }, env, ctx, true);
}

/** Record thumbs-up (+1) / thumbs-down (-1). Best-effort. Provider attribution:
 *  query provider_calls by conversation_id (= messageId in single-turn flows),
 *  fall back to the sticky-session mapping. */
export async function handleFeedback(messageId: string, rating: 1 | -1, env: Env): Promise<void> {
  if (!env.DB) return;
  try {
    const ledger = new QuotaLedger(env.DB);
    let provider: string | null = null;
    let intent: string | undefined;
    const row = await env.DB
      .prepare(
        `SELECT provider, intent FROM provider_calls
          WHERE conversation_id = ?
          ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(messageId)
      .first<{ provider: string; intent?: string }>();
    if (row?.provider) {
      provider = row.provider;
      intent = row.intent ?? undefined;
    } else {
      provider = await ledger.getStickyProvider(messageId);
    }
    if (provider) {
      await ledger.recordFeedback(provider, rating, messageId, intent);
    }
  } catch (err) {
    console.error('[gateway] handleFeedback failed:', err);
  }
}

// === Internal: shared cascade router ===

interface AttemptOutcome {
  response: Response | null;
  continueCascade: boolean;
}

async function routeInternal(
  req: ChatRequest,
  env: Env,
  ctx: ExecutionContext,
  isStream: boolean,
): Promise<Response> {
  // 1. Validate input.
  if (!req || !Array.isArray(req.messages) || req.messages.length === 0) {
    return errorResponse(
      'messages field is required and must be a non-empty array.',
      400,
      'invalid_messages',
    );
  }

  const gatewayEnv = env as unknown as GatewayEnv;
  const ledger = env.DB ? new QuotaLedger(env.DB) : null;
  const conversationId = resolveConversationId(req);
  const startedAt = Date.now();

  // 2. Try sticky session first (if ledger available).
  const sticky = ledger ? await resolveSticky(ledger, gatewayEnv, conversationId) : null;
  if (sticky !== null) {
    const outcome = await tryProvider(
      sticky.provider, sticky.model, req, gatewayEnv, ctx, ledger,
      conversationId, isStream, false, startedAt, 'simple_chat',
    );
    if (outcome.response !== null) return outcome.response;
  }

  // 3. Classify intent + build cascade.
  const intent = safeClassifyIntent(req);
  const cascade = getCascadeForIntent(intent);
  const healthy = new Set(await getHealthyProviders(gatewayEnv));
  const filtered = cascade.filter((id) => healthy.has(id));

  if (filtered.length === 0) {
    return errorResponse(
      'All providers exhausted. Please retry in a few minutes.',
      503,
      'all_providers_exhausted',
      { attempted_providers: [], intent },
    );
  }

  // 4. Try each provider in cascade order.
  const attempted: ProviderId[] = sticky ? [sticky.provider] : [];
  for (const provider of filtered) {
    if (sticky !== null && provider === sticky.provider) continue;
    const fallbackUsed = attempted.length > 0;
    const model = pickBestModel(intent, provider) || req.model || provider;
    const outcome = await tryProvider(
      provider, model, req, gatewayEnv, ctx, ledger,
      conversationId, isStream, fallbackUsed, startedAt, intent,
    );
    if (outcome.response !== null) return outcome.response;
    attempted.push(provider);
  }

  // 5. All providers exhausted.
  return errorResponse(
    'All providers exhausted. Please retry in a few minutes.',
    503,
    'all_providers_exhausted',
    { attempted_providers: attempted, intent, total_latency_ms: Date.now() - startedAt },
  );
}

// === Internal: per-provider attempt ===

async function tryProvider(
  provider: ProviderId, model: string, req: ChatRequest, env: GatewayEnv,
  ctx: ExecutionContext, ledger: QuotaLedger | null, conversationId: string,
  isStream: boolean, fallbackUsed: boolean, _cascadeStartedAt: number, intent: IntentType,
): Promise<AttemptOutcome> {
  const ledgerProv = ledgerName(provider);

  // Cast req.messages through `unknown` — adapters/types.ts allows
  // `content: ... | null`, utils/types.ts does not (structurally compatible).
  const estTokens = countMessageTokens(
    req.messages as unknown as Parameters<typeof countMessageTokens>[0],
    model,
  );
  if (!willFitInProviderContext(estTokens, provider, model)) {
    return { response: null, continueCascade: true };
  }

  // Atomic quota decrement (also gates on circuit-breaker state).
  if (ledger) {
    try {
      const dec = await ledger.decrementQuota(ledgerProv, model, estTokens);
      if (!dec.ok) {
        return { response: null, continueCascade: true };
      }
    } catch {
      // best-effort — proceed without quota gate if D1 is flaky.
    }
  }

  const adapter = getProvider(provider);
  const modifiedReq: ChatRequest = { ...req, model };
  const t0 = Date.now();

  try {
    if (isStream) {
      const stream = await withTimeout(adapter.chatStream(modifiedReq, env), CHAT_TIMEOUT_MS);
      if (ledger) {
        ctx.waitUntil(recordSuccess(
          ledger, provider, model, intent, conversationId,
          Date.now() - t0, estTokens, 0,
        ));
      }
      return {
        response: buildStreamResponse(stream, provider, model, fallbackUsed),
        continueCascade: false,
      };
    }

    const chatResponse = await withTimeout(adapter.chat(modifiedReq, env), CHAT_TIMEOUT_MS);
    const latency = Date.now() - t0;
    const inputTokens = chatResponse.usage?.prompt_tokens ?? estTokens;
    const outputTokens = chatResponse.usage?.completion_tokens ?? 0;

    if (ledger) {
      ctx.waitUntil(recordSuccess(
        ledger, provider, model, intent, conversationId,
        latency, inputTokens, outputTokens,
      ));
    }
    return {
      response: buildJsonResponse(chatResponse, provider, model, fallbackUsed),
      continueCascade: false,
    };
  } catch (err) {
    if (ledger) {
      ctx.waitUntil(handleFailure(
        ledger, provider, model, intent, conversationId,
        err, Date.now() - t0, estTokens,
      ));
    }
    return { response: null, continueCascade: true };
  }
}

// === Internal: sticky-session resolution ===

interface StickyRef { provider: ProviderId; model: string; }

/** Look up + verify the sticky provider. Returns null if not usable. */
async function resolveSticky(
  ledger: QuotaLedger,
  env: GatewayEnv,
  conversationId: string,
): Promise<StickyRef | null> {
  try {
    const stickyName = await ledger.getStickyProvider(conversationId);
    if (!stickyName) return null;
    const provider = normalizeProviderId(stickyName);
    if (provider === null) return null;
    const healthy = await getHealthyProviders(env);
    if (!healthy.includes(provider)) return null;
    const model = pickBestModel('simple_chat', provider) || '';
    if (!model) return null;
    return { provider, model };
  } catch {
    return null;
  }
}

// === Internal: success + failure recording (best-effort, via ctx.waitUntil) ===

async function recordSuccess(
  ledger: QuotaLedger,
  provider: ProviderId,
  model: string,
  intent: IntentType,
  conversationId: string,
  latencyMs: number,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  const ledgerProv = ledgerName(provider);
  try {
    await ledger.recordCall({
      provider: ledgerProv, model, conversation_id: conversationId, intent,
      input_tokens: inputTokens, output_tokens: outputTokens,
      latency_ms: latencyMs, status: 'success',
    });
    await ledger.setStickyProvider(conversationId, ledgerProv, model);
  } catch {
    // best-effort
  }
}

async function handleFailure(
  ledger: QuotaLedger,
  provider: ProviderId,
  model: string,
  intent: IntentType,
  conversationId: string,
  err: unknown,
  latencyMs: number,
  estTokens: number,
): Promise<void> {
  const ledgerProv = ledgerName(provider);
  const status = extractStatus(err);
  const errMsg = err instanceof Error ? err.message : String(err);
  const isTimeout = err instanceof Error && err.name === 'TimeoutError';
  const isNetwork = isNetworkError(err);
  const callStatus: ProviderCall['status'] =
    status === 429 ? '429' : isTimeout ? 'timeout' : '5xx';

  try {
    // record429 atomically bumps consecutive_failures (A2's API is misnamed).
    await ledger.record429(ledgerProv);

    if (status === 429) {
      await ledger.setProviderHealthy(ledgerProv, false, Date.now() + RATE_LIMIT_CIRCUIT_MS);
    } else if (status >= 500 || status === 0 || isNetwork || isTimeout) {
      const quota = await ledger.getQuota(ledgerProv, '*');
      const failures = quota?.consecutive_failures ?? 0;
      if (failures >= CIRCUIT_BREAKER_THRESHOLD) {
        await ledger.setProviderHealthy(ledgerProv, false, Date.now() + SERVER_ERROR_CIRCUIT_MS);
      }
    }

    await ledger.recordCall({
      provider: ledgerProv, model, conversation_id: conversationId, intent,
      input_tokens: estTokens, output_tokens: 0,
      latency_ms: latencyMs, status: callStatus, error: errMsg.slice(0, 500),
    });
  } catch {
    // best-effort
  }
}

// === Internal: helpers ===

function ledgerName(id: ProviderId): string {
  return id === 'workersai' ? 'workers-ai' : id;
}

function normalizeProviderId(name: string): ProviderId | null {
  const normalized = name === 'workers-ai' ? 'workersai' : name;
  const valid = ['groq1','groq2','gemini','mistral','openrouter','workersai','sambanova','cohere','siliconflow','cerebras','novita'];
  return (valid as string[]).includes(normalized) ? (normalized as ProviderId) : null;
}

function resolveConversationId(req: ChatRequest): string {
  const meta = (req as { metadata?: unknown }).metadata;
  if (meta && typeof meta === 'object') {
    const cid = (meta as { conversation_id?: unknown }).conversation_id;
    if (typeof cid === 'string' && cid.length > 0) return cid;
  }
  const firstUser = req.messages.find((m) => m.role === 'user');
  const text = firstUser && typeof firstUser.content === 'string'
    ? firstUser.content
    : JSON.stringify(firstUser?.content ?? '');
  return `cid:${simpleHash(text)}`;
}

function simpleHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

function safeClassifyIntent(req: ChatRequest): IntentType {
  try {
    // Bridge the two ChatRequest shape defs (see countMessageTokens cast above).
    return classifyIntent(req as unknown as Parameters<typeof classifyIntent>[0]);
  } catch {
    return 'simple_chat';
  }
}

function extractStatus(err: unknown): number {
  if (err && typeof err === 'object') {
    const s = (err as { status?: unknown }).status;
    if (typeof s === 'number') return s;
  }
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/\b([1-5]\d{2})\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 400 && n < 600) return n;
  }
  return 0;
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'TypeError' || err.name === 'NetworkError') return true;
  const msg = err.message.toLowerCase();
  return msg.includes('network') || msg.includes('fetch failed')
    || msg.includes('econnreset') || msg.includes('enotfound');
}

/** Race a promise against an AbortController-backed timeout. Rejects with a
 *  TimeoutError-named Error if the timeout fires first. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    ctrl.signal.addEventListener('abort', () => {
      const e = new Error(`operation timed out after ${timeoutMs}ms`);
      e.name = 'TimeoutError';
      reject(e);
    });
    timer = setTimeout(() => ctrl.abort(), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Wrap a ReadableStream<Uint8Array> so mid-stream errors surface as a final
 *  `data: {"error":"Provider failed: ..."}\n\n` event followed by the terminal
 *  `data: [DONE]\n\n` marker, then close cleanly. */
function wrapStreamWithErrorHandler(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        if (value) controller.enqueue(value);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const errorEvent = `data: ${JSON.stringify({ error: `Provider failed: ${msg}` })}\n\n`;
        const doneEvent = 'data: [DONE]\n\n';
        controller.enqueue(encoder.encode(errorEvent));
        controller.enqueue(encoder.encode(doneEvent));
        controller.close();
      }
    },
    cancel() {
      try { reader.releaseLock(); } catch { /* noop */ }
    },
  });
}

// === Internal: response builders ===

function buildJsonResponse(
  chatResponse: ChatResponse,
  provider: ProviderId,
  model: string,
  fallbackUsed: boolean,
): Response {
  const stamped = { ...chatResponse, provider } as ChatResponse & { provider: ProviderId };
  return new Response(JSON.stringify(stamped), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Provider': provider,
      'X-Model': model,
      'X-Fallback-Used': fallbackUsed ? 'true' : 'false',
      ...CORS_HEADERS,
    },
  });
}

function buildStreamResponse(
  stream: ReadableStream<Uint8Array>,
  provider: ProviderId,
  model: string,
  fallbackUsed: boolean,
): Response {
  return new Response(wrapStreamWithErrorHandler(stream), {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Provider': provider,
      'X-Model': model,
      'X-Fallback-Used': fallbackUsed ? 'true' : 'false',
      ...CORS_HEADERS,
    },
  });
}

function errorResponse(
  message: string,
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        // 5xx: surface `code` as `type` (matches spec `"type":"all_providers_exhausted"`).
        // 4xx: OpenAI canonical `invalid_request_error`.
        type: status >= 500 ? code : 'invalid_request_error',
        code, param: null, ...extra,
      },
    }),
    { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } },
  );
}
