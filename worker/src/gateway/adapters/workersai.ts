/**
 * Micky Assistant — Cloudflare Workers AI Provider Adapter (Agent A6-retry).
 *
 * Workers AI is reached via the `env.AI` binding (a typed RPC stub), NOT
 * plain HTTP fetch, for non-streaming inference. The binding returns
 * `{ response, usage }` (NOT OpenAI shape). For streaming we use the REST
 * endpoint `POST /accounts/{id}/ai/run/{model}?stream=true`, which returns
 * SSE in CF's `data: {"response":"…"}` shape; a TransformStream re-shapes
 * each frame into an OpenAI-shaped {@link ChatStreamChunk} on the fly.
 *
 * Why the adapter does NOT extend {@link BaseOpenAICompatibleAdapter}:
 *   • Non-streaming chat uses `env.AI.run()` (a binding call), not `fetch()`.
 *   • The CF response shape (`{ response }`) and SSE shape
 *     (`data: {"response":"…"}`) are both non-OpenAI.
 *   • No `x-ratelimit-*` headers exist on CF responses.
 *
 * Implements the {@link ProviderAdapter} contract from `./_types` directly.
 * Wiring: `env.AI` (binding), `env.CF_ACCOUNT_ID` + `env.CF_API_TOKEN` (REST).
 * Edge-only. Created: 2026-11-10 (Agent A6-retry)
 */

import type {
  ChatRequest, ChatResponse, ChatStreamChunk, ChatUsage,
  HealthStatus, ModelInfo, ProviderAdapter, ProviderId, RateLimitInfo,
  StreamParseContext,
} from './_types';
import { ProviderError, NetworkError } from './_types';

// ---- Constants (env-var names, base URL, health probe config) ----

/** CF REST API root. Streaming path appends `/accounts/{id}/ai/run/{model}`. */
export const WORKERSAI_BASE_URL = 'https://api.cloudflare.com/client/v4';
export const CF_ACCOUNT_ID_ENV = 'CF_ACCOUNT_ID';
export const CF_API_TOKEN_ENV = 'CF_API_TOKEN';
export const WORKERSAI_HEALTH_MODEL = '@cf/qwen/qwen2.5-coder-7b-instruct';
export const WORKERSAI_HEALTH_TIMEOUT_MS = 5_000;

/**
 * Static curated model list. The adapter does NOT reject unknown `@cf/*`
 * ids — it passes them straight to `env.AI.run()` so newly released models
 * work without an adapter release. This set is documentation +
 * `listModels()` surface only.
 */
export const WORKERSAI_MODELS: ModelInfo[] = [
  { id: '@cf/qwen/qwen2.5-coder-32b-instruct', object: 'model', created: 0, owned_by: 'cloudflare', label: 'Qwen2.5 Coder 32B Instruct' },
  { id: '@cf/qwen/qwen2.5-coder-14b-instruct', object: 'model', created: 0, owned_by: 'cloudflare', label: 'Qwen2.5 Coder 14B Instruct' },
  { id: '@cf/qwen/qwen2.5-coder-7b-instruct', object: 'model', created: 0, owned_by: 'cloudflare', label: 'Qwen2.5 Coder 7B Instruct (default)' },
  { id: '@cf/meta/llama-3.1-8b-instruct', object: 'model', created: 0, owned_by: 'cloudflare', label: 'Llama 3.1 8B Instruct' },
];

/** Env shape required by the WorkersAI adapter's I/O methods. */
export interface WorkersAIEnv {
  /** Workers AI binding (configured in wrangler.toml: `[ai] binding = "AI"`). */
  AI: Ai;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  [key: string]: unknown;
}

// ---- Raw response shapes (module-private) ----

interface WorkersAIRawResponse {
  response?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  errors?: Array<{ code?: number; message?: string }>;
  success?: boolean;
  /** CF REST responses wrap the output in `result`. */
  result?: { response?: string };
}

interface CFStreamLine {
  response?: string;
  delta?: string;    // older models
  content?: string;  // some third-party shapes
}

// ---- Adapter ----

export class WorkersAIAdapter implements ProviderAdapter {
  readonly PROVIDER_ID: ProviderId = 'workersai';

  getBaseUrl(): string {
    return WORKERSAI_BASE_URL;
  }

  /**
   * Headers for the REST streaming path. Per the task brief, accepts an
   * explicit `apiToken` argument; throws when called bare. The
   * non-streaming `chat` path uses the `env.AI` binding directly and
   * never calls this.
   */
  getHeaders(apiToken?: string): Record<string, string> {
    if (typeof apiToken !== 'string' || apiToken.length === 0) {
      throw new ProviderError(this.PROVIDER_ID, 401,
        `${CF_API_TOKEN_ENV} is not configured (required for WorkersAI streaming)`,
        { retryable: false });
    }
    return { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' };
  }

  /** Workers AI is OpenAI-compatible at the message level — pass through. */
  formatRequest(req: ChatRequest): unknown {
    return { ...req };
  }

  /**
   * Convert the Workers AI response shape (`{ response }`) into the OpenAI
   * `chat.completion` shape. Workers AI is single-choice (no `n` parameter),
   * so we always emit one choice with `finish_reason: "stop"`.
   */
  parseResponse(raw: unknown, requestedModel: string): ChatResponse {
    const r = (raw ?? {}) as WorkersAIRawResponse;
    if (Array.isArray(r.errors) && r.errors.length > 0) {
      const msg = r.errors.map((e) => `[${e.code ?? '?'}] ${e.message ?? 'unknown error'}`).join('; ');
      throw new ProviderError(this.PROVIDER_ID, 502, `WorkersAI returned errors: ${msg}`,
        { retryable: false, upstreamBody: JSON.stringify(raw).slice(0, 500) });
    }
    const responseText =
      typeof r.response === 'string'
        ? r.response
        : typeof r.result?.response === 'string'
          ? r.result.response
          : '';
    const usage: ChatUsage = {
      prompt_tokens: r.usage?.prompt_tokens ?? 0,
      completion_tokens: r.usage?.completion_tokens ?? 0,
      total_tokens: r.usage?.total_tokens
        ?? ((r.usage?.prompt_tokens ?? 0) + (r.usage?.completion_tokens ?? 0)),
    };
    return {
      id: `cfchat-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: responseText },
        finish_reason: 'stop',
      }],
      usage,
    };
  }

  /**
   * CF streaming SSE is shaped differently from OpenAI SSE:
   *   `data: {"response":"Hello"}\n\n`
   * (no `choices` array, no `delta` object — just a bare `response` string
   * per frame). We translate each frame into an OpenAI-shaped
   * {@link ChatStreamChunk}. Returns `null` for blank / comment / `[DONE]`
   * / event: / non-data / unparseable lines.
   */
  parseStreamChunk(line: string, ctx: StreamParseContext): ChatStreamChunk | null {
    const t = line.trim();
    if (t.length === 0) return null;
    if (t === 'data: [DONE]') return null;
    if (t.startsWith(':') || t.startsWith('event:')) return null; // SSE comment / event marker
    if (!t.startsWith('data:')) return null;
    const payload = t.slice(5).trim();
    if (payload.length === 0 || payload === '[DONE]' || !payload.startsWith('{')) return null;
    let parsed: CFStreamLine;
    try {
      parsed = JSON.parse(payload) as CFStreamLine;
    } catch {
      return null;
    }
    const token = parsed.response ?? parsed.delta ?? parsed.content ?? '';
    return {
      id: ctx.id,
      object: 'chat.completion.chunk',
      created: ctx.created,
      model: ctx.model,
      choices: [{
        index: 0,
        delta: token ? { content: token } : {},
        finish_reason: null,
      }],
    };
  }

  /**
   * Workers AI exposes no per-request rate-limit headers. Neuron accounting
   * is account-level (visible in the CF dashboard, not on inference
   * responses). We return a typed-but-empty `RateLimitInfo` so the gateway
   * can call this uniformly without special-casing.
   */
  extractRateLimitInfo(_headers: Headers): RateLimitInfo {
    return { provider: this.PROVIDER_ID, rawHeaders: {} };
  }

  // ---- I/O: chat (non-streaming, via env.AI binding) ----

  /**
   * NON-STREAMING inference via the `env.AI` binding. No HTTP `fetch` — the
   * binding handles auth + transport. This is the special path that bypasses
   * the gateway's default HTTP machinery.
   */
  async chat(req: ChatRequest, env?: WorkersAIEnv): Promise<ChatResponse> {
    const ai = this.requireBinding(env);
    const model = req.model;
    if (!model)
      throw new ProviderError(this.PROVIDER_ID, 400, 'WorkersAI.chat: req.model is required', { retryable: false });
    let raw: unknown;
    try {
      raw = await ai.run(model, buildBindingInput(req));
    } catch (err) {
      throw new NetworkError(this.PROVIDER_ID, `WorkersAI binding error: ${errMsg(err)}`, err);
    }
    return this.parseResponse(raw, model);
  }

  // ---- I/O: chatStream (streaming, via REST + TransformStream) ----

  /**
   * STREAMING inference via the CF REST endpoint. Yields OpenAI-shaped
   * {@link ChatStreamChunk}s (converted from CF's `data: {"response":"…"}`
   * frames via {@link parseStreamChunk}). A `TransformStream` reassembles
   * frames split across chunk boundaries before parsing each line.
   */
  async *chatStream(req: ChatRequest, env?: WorkersAIEnv): AsyncIterable<ChatStreamChunk> {
    const { accountId, apiToken } = this.requireRestEnv(env);
    const model = req.model;
    if (!model)
      throw new ProviderError(this.PROVIDER_ID, 400, 'WorkersAI.chatStream: req.model is required', { retryable: false });
    const url = `${WORKERSAI_BASE_URL}/accounts/${accountId}/ai/run/${model}?stream=true`;
    const body = JSON.stringify({
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      ...(req.max_tokens !== undefined ? { max_tokens: req.max_tokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
    });
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers: this.getHeaders(apiToken), body });
    } catch (err) {
      throw new NetworkError(this.PROVIDER_ID, `WorkersAI stream network error: ${errMsg(err)}`, err);
    }
    if (!res.ok || !res.body) {
      const text = await safeReadText(res);
      if (res.status === 429)
        throw new ProviderError(this.PROVIDER_ID, 429, `WorkersAI rate-limited: ${truncate(text, 200)}`, { retryable: true, upstreamBody: text });
      if (res.status >= 500)
        throw new ProviderError(this.PROVIDER_ID, res.status, `WorkersAI stream HTTP ${res.status}`, { retryable: true, upstreamBody: text });
      throw new ProviderError(this.PROVIDER_ID, res.status, `WorkersAI stream HTTP ${res.status}: ${truncate(text, 300)}`, { retryable: false, upstreamBody: text });
    }

    const ctx: StreamParseContext = {
      model,
      id: `cfchat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      created: Math.floor(Date.now() / 1000),
    };

    // TransformStream: bytes → ChatStreamChunk. Arrow callbacks capture `this`.
    const decoder = new TextDecoder();
    let lineBuf = '';
    const cfToOpenAI = new TransformStream<Uint8Array, ChatStreamChunk>({
      transform: (chunk, controller) => {
        lineBuf += decoder.decode(chunk, { stream: true });
        let nl = lineBuf.indexOf('\n');
        while (nl !== -1) {
          const line = lineBuf.slice(0, nl);
          lineBuf = lineBuf.slice(nl + 1);
          const parsed = this.parseStreamChunk(line, ctx);
          if (parsed) controller.enqueue(parsed);
          nl = lineBuf.indexOf('\n');
        }
      },
      flush: (controller) => {
        if (lineBuf.trim()) {
          const parsed = this.parseStreamChunk(lineBuf, ctx);
          if (parsed) controller.enqueue(parsed);
        }
        controller.terminate();
      },
    });

    const reader = res.body.pipeThrough(cfToOpenAI).getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield value;
      }
    } catch (err) {
      throw new NetworkError(this.PROVIDER_ID, `WorkersAI stream read failed: ${errMsg(err)}`, err);
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }

  // ---- I/O: listModels (static) ----

  /** Static model list (Workers AI has no public /models endpoint via binding). */
  async listModels(_env?: WorkersAIEnv): Promise<ModelInfo[]> {
    return WORKERSAI_MODELS.slice();
  }

  // ---- I/O: healthCheck (via env.AI binding) ----

  /**
   * Light health probe: 1-token inference on the smallest supported model,
   * with a 5s `AbortController` timeout so a wedged binding doesn't cascade
   * into gateway request timeouts. `env.AI.run` does not accept an
   * `AbortSignal` directly, so we race it against a timeout promise.
   */
  async healthCheck(env?: WorkersAIEnv): Promise<HealthStatus> {
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WORKERSAI_HEALTH_TIMEOUT_MS);
    try {
      const ai = this.requireBinding(env);
      const result = await Promise.race([
        ai.run(WORKERSAI_HEALTH_MODEL, {
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => {
            reject(new Error('WorkersAI.healthCheck: timed out'));
          });
        }),
      ]);
      return {
        provider: this.PROVIDER_ID,
        healthy: Boolean(result),
        status: result ? 200 : 503,
        latencyMs: Date.now() - t0,
        message: result ? 'ok' : 'empty response from env.AI.run',
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        provider: this.PROVIDER_ID,
        healthy: false,
        status: 0,
        latencyMs: Date.now() - t0,
        message: `binding error: ${errMsg(err)}`,
        checkedAt: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- Internal: env validation ----

  private requireBinding(env?: WorkersAIEnv): Ai {
    if (!env || !env.AI) {
      throw new ProviderError(this.PROVIDER_ID, 503,
        'WorkersAI: env.AI binding is not configured. Add `[ai] binding = "AI"` in wrangler.toml.',
        { retryable: false });
    }
    return env.AI;
  }

  private requireRestEnv(env?: WorkersAIEnv): { accountId: string; apiToken: string } {
    if (!env) throw new ProviderError(this.PROVIDER_ID, 503, 'WorkersAI: env is required for streaming', { retryable: false });
    const accountId = env.CF_ACCOUNT_ID;
    if (typeof accountId !== 'string' || accountId.length === 0) {
      throw new ProviderError(this.PROVIDER_ID, 503,
        `${CF_ACCOUNT_ID_ENV} is not configured (required for WorkersAI streaming)`, { retryable: false });
    }
    const apiToken = env.CF_API_TOKEN;
    if (typeof apiToken !== 'string' || apiToken.length === 0) {
      throw new ProviderError(this.PROVIDER_ID, 503,
        `${CF_API_TOKEN_ENV} is not configured (required for WorkersAI streaming)`, { retryable: false });
    }
    return { accountId, apiToken };
  }
}

// Pre-wired singleton — import this from the registry.
export const workersaiAdapter = new WorkersAIAdapter();

// ---- Helpers (module-private) ----

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
async function safeReadText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ''; }
}
function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Build the `env.AI.run` input. Strips `undefined` optional fields because
 *  some SDK versions reject unknown keys with `undefined` values. */
function buildBindingInput(req: ChatRequest): Record<string, unknown> {
  const input: Record<string, unknown> = {
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (req.max_tokens !== undefined) input.max_tokens = req.max_tokens;
  if (req.temperature !== undefined) input.temperature = req.temperature;
  if (req.top_p !== undefined) input.top_p = req.top_p;
  if (req.stop !== undefined) input.stop = req.stop;
  return input;
}
