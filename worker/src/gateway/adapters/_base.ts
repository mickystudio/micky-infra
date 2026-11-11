/**
 * Micky Assistant — Shared base for OpenAI-compatible adapters.
 *
 * The five new providers (SambaNova, Cohere, SiliconFlow, Cerebras, Novita)
 * all speak an OpenAI-shaped `/v1/chat/completions` wire format. Rather than
 * copy/paste fetch-retry-stream-parse boilerplate five times, we centralize
 * it here. Subclasses override only the quirks: PROVIDER_ID, endpoint paths,
 * mutateRequest/mutateRawResponse, rateLimitHeaderMap.
 *
 * Edge-only: `fetch`/`Headers`/`ReadableStream`/`TextDecoder`/
 * `AbortController`/`setTimeout` — all on the CF Workers runtime.
 * Created: 2026-11-10 (Agent A10)
 */

import {
  type ChatRequest, type ChatResponse, type ChatStreamChunk, type ChatUsage,
  type HealthStatus, type ModelInfo, type ProviderAdapter, type ProviderId,
  type RateLimitInfo, type StreamParseContext,
  NetworkError, ProviderError, RateLimitError,
} from './_types';

export interface BaseAdapterConfig {
  apiKey: string;
  baseUrl: string;       // no trailing slash
  defaultModel: string;
  staticModels: ModelInfo[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with jitter: 250ms · 500ms · 1s … ±20%. */
export function backoffMs(attempt: number): number {
  const base = Math.min(250 * 2 ** attempt, 4_000);
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const safeStringify = (v: unknown): string => {
  try { return JSON.stringify(v).slice(0, 500); } catch { return '[unserializable]'; }
};
const safeText = async (res: Response): Promise<string> => {
  try { return await res.text(); } catch { return ''; }
};

/** Canonical rate-limit field names that headers may map to. */
export type RateLimitField =
  | 'requestsRemaining' | 'requestsLimit'
  | 'tokensRemaining' | 'tokensLimit'
  | 'resetAfterSeconds' | 'retryAfterSeconds';

export abstract class BaseOpenAICompatibleAdapter implements ProviderAdapter {
  protected readonly apiKey: string;
  protected readonly baseUrl: string;
  protected readonly defaultModel: string;
  protected readonly staticModels: ModelInfo[];

  constructor(config: BaseAdapterConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.defaultModel = config.defaultModel;
    this.staticModels = config.staticModels;
  }

  abstract readonly PROVIDER_ID: ProviderId;

  // ---- Hook points (OpenAI-compatible defaults; override for quirks) ----
  protected getChatEndpoint(): string { return '/chat/completions'; }
  protected getModelsEndpoint(): string { return '/models'; }
  protected mutateRequest(req: ChatRequest): unknown { return req; }
  protected mutateRawResponse(raw: unknown): unknown { return raw; }
  /** Map non-standard header names → canonical {@link RateLimitField}s. */
  protected rateLimitHeaderMap(): Record<string, RateLimitField> { return {}; }
  /**
   * Per-model base-URL override (default: this.baseUrl). Novita (and some
   * other providers) host a few models on alternate base URLs; overriding
   * this lets a subclass route to the right host without reimplementing
   * the fetch loop.
   */
  protected resolveBaseUrl(_model: string): string { return this.baseUrl; }

  getBaseUrl(): string { return this.baseUrl; }

  getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      'User-Agent': 'micky-gateway/1.0',
    };
  }

  // ---- Shaping ----
  formatRequest(req: ChatRequest): unknown {
    const body: ChatRequest = { ...req, model: req.model || this.defaultModel };
    if (!body.stream) body.stream = false;
    return this.mutateRequest(body);
  }

  parseResponse(raw: unknown, requestedModel: string): ChatResponse {
    const s = this.mutateRawResponse(raw) as {
      id?: string; created?: number; model?: string;
      choices?: unknown[]; usage?: Partial<ChatUsage>; system_fingerprint?: string;
    };
    if (!Array.isArray(s.choices) || s.choices.length === 0) {
      throw new ProviderError(this.PROVIDER_ID, 502, 'Malformed upstream response: missing choices', {
        upstreamBody: safeStringify(raw),
      });
    }
    const choices = s.choices.map((c, i) => {
      const ch = c as { index?: number; message?: unknown; finish_reason?: string | null; tool_calls?: unknown[] };
      const msg = ch.message as { role?: string; content?: string; tool_calls?: unknown[] };
      return {
        index: ch.index ?? i,
        message: {
          role: (msg.role ?? 'assistant') as 'assistant',
          content: msg.content ?? '',
          ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
        },
        finish_reason: ch.finish_reason ?? null,
        ...(ch.tool_calls ? { tool_calls: ch.tool_calls as never } : {}),
      };
    });
    const usage: ChatUsage = {
      prompt_tokens: s.usage?.prompt_tokens ?? 0,
      completion_tokens: s.usage?.completion_tokens ?? 0,
      total_tokens: s.usage?.total_tokens ?? 0,
    };
    return {
      id: s.id ?? `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: s.created ?? Math.floor(Date.now() / 1000),
      model: s.model ?? requestedModel,
      choices, usage,
      ...(s.system_fingerprint ? { system_fingerprint: s.system_fingerprint } : {}),
    };
  }

  parseStreamChunk(line: string, ctx: StreamParseContext): ChatStreamChunk | null {
    const t = line.trim();
    if (!t || t === 'data: [DONE]' || !t.startsWith('data:')) return null;
    const payload = t.slice(5).trim();
    if (!payload.startsWith('{')) return null;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(payload) as Record<string, unknown>; }
    catch { return null; }
    parsed = this.mutateRawResponse(parsed) as Record<string, unknown>;
    const choices = (parsed.choices as Array<Record<string, unknown>>) ?? [];
    return {
      id: (parsed.id as string) ?? ctx.id,
      object: 'chat.completion.chunk',
      created: (parsed.created as number) ?? ctx.created,
      model: (parsed.model as string) ?? ctx.model,
      choices: choices.map((c, i) => ({
        index: (c.index as number) ?? i,
        delta: (c.delta as Record<string, unknown>) ?? {},
        finish_reason: (c.finish_reason as string | null) ?? null,
      })),
      ...(parsed.usage ? { usage: parsed.usage as ChatUsage } : {}),
    };
  }

  // ---- Telemetry ----
  extractRateLimitInfo(headers: Headers): RateLimitInfo {
    const info: RateLimitInfo = { provider: this.PROVIDER_ID, rawHeaders: {} };
    const custom = this.rateLimitHeaderMap();
    const setNum = (field: RateLimitField, val: string | null): void => {
      if (val === null) return;
      const n = parseInt(val, 10);
      if (Number.isFinite(n)) (info as unknown as Record<string, unknown>)[field] = n;
    };
    const stdMap: Record<string, RateLimitField> = {
      'x-ratelimit-remaining-requests': 'requestsRemaining',
      'x-ratelimit-limit-requests': 'requestsLimit',
      'x-ratelimit-remaining-tokens': 'tokensRemaining',
      'x-ratelimit-limit-tokens': 'tokensLimit',
      'x-ratelimit-reset-requests': 'resetAfterSeconds',
      'x-ratelimit-reset-tokens': 'resetAfterSeconds',
      'retry-after': 'retryAfterSeconds',
    };
    headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      (info.rawHeaders as Record<string, string>)[lower] = value;
      const field = stdMap[lower] ?? custom[lower];
      if (field) setNum(field, value);
      if (lower === 'x-ratelimit-reset' || lower === 'date') {
        const t = Date.parse(value);
        if (Number.isFinite(t)) info.resetAt = t;
      }
    });
    return info;
  }

  // ---- I/O: chat (non-streaming) ----
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = req.model || this.defaultModel;
    const url = `${this.resolveBaseUrl(model)}${this.getChatEndpoint()}`;
    const body = JSON.stringify(this.formatRequest(req));
    return this.fetchWithRetry<ChatResponse>(url, body, (raw) => this.parseResponse(raw, model));
  }

  // ---- I/O: chatStream ----
  async *chatStream(req: ChatRequest): AsyncIterable<ChatStreamChunk> {
    const model = req.model || this.defaultModel;
    const url = `${this.resolveBaseUrl(model)}${this.getChatEndpoint()}`;
    const body = JSON.stringify(this.formatRequest({ ...req, stream: true }));
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers: this.getHeaders(), body });
    } catch (err) {
      throw new NetworkError(this.PROVIDER_ID, `Stream connect failed: ${errMsg(err)}`, err);
    }
    if (!res.ok) {
      const text = await safeText(res);
      if (res.status === 429) throw new RateLimitError(this.PROVIDER_ID, this.extractRateLimitInfo(res.headers));
      if (res.status >= 500) {
        throw new ProviderError(this.PROVIDER_ID, res.status, `Upstream ${res.status} on stream`, { retryable: true, upstreamBody: text });
      }
      throw new ProviderError(this.PROVIDER_ID, res.status, `Upstream ${res.status}: ${text.slice(0, 200)}`, { retryable: false, upstreamBody: text });
    }
    if (!res.body) throw new ProviderError(this.PROVIDER_ID, 502, 'Stream response had no body');

    const ctx: StreamParseContext = {
      model,
      id: `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      created: Math.floor(Date.now() / 1000),
    };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const chunk = this.parseStreamChunk(line, ctx);
          if (chunk) yield chunk;
        }
      }
      if (buf.trim()) {
        const chunk = this.parseStreamChunk(buf, ctx);
        if (chunk) yield chunk;
      }
    } catch (err) {
      throw new NetworkError(this.PROVIDER_ID, `Stream read failed: ${errMsg(err)}`, err);
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }

  // ---- I/O: listModels ----
  async listModels(): Promise<ModelInfo[]> {
    const url = `${this.baseUrl}${this.getModelsEndpoint()}`;
    try {
      const res = await fetch(url, { method: 'GET', headers: this.getHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data?: unknown[] };
      const data = Array.isArray(json.data) ? json.data : [];
      return data.map((m) => {
        const mo = m as { id?: string; created?: number; owned_by?: string };
        return {
          id: mo.id ?? 'unknown',
          object: 'model' as const,
          created: mo.created ?? 0,
          owned_by: mo.owned_by ?? this.PROVIDER_ID,
        };
      });
    } catch {
      return this.staticModels.slice(); // fall back to curated static list
    }
  }

  // ---- I/O: healthCheck ----
  async healthCheck(): Promise<HealthStatus> {
    const url = `${this.baseUrl}${this.getModelsEndpoint()}`;
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch(url, { method: 'GET', headers: this.getHeaders(), signal: controller.signal });
      return {
        provider: this.PROVIDER_ID,
        healthy: res.ok, status: res.status, latencyMs: Date.now() - t0,
        message: res.ok ? 'ok' : `HTTP ${res.status}`,
        rateLimit: this.extractRateLimitInfo(res.headers),
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        provider: this.PROVIDER_ID, healthy: false, status: 0, latencyMs: Date.now() - t0,
        message: `network error: ${errMsg(err)}`, checkedAt: new Date().toISOString(),
      };
    } finally { clearTimeout(timer); }
  }

  // ---- Internal: fetch with retry (1 initial + 2 retries) ----
  protected async fetchWithRetry<T>(url: string, body: string, parse: (raw: unknown) => T): Promise<T> {
    const maxAttempts = 3;
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) await sleep(backoffMs(attempt - 1));
      try {
        const res = await fetch(url, { method: 'POST', headers: this.getHeaders(), body });
        if (res.status === 429) {
          const err = new RateLimitError(this.PROVIDER_ID, this.extractRateLimitInfo(res.headers));
          if (attempt === maxAttempts - 1) throw err;
          lastErr = err; continue;
        }
        if (res.status >= 500) {
          const text = await safeText(res);
          const err = new ProviderError(this.PROVIDER_ID, res.status, `Upstream ${res.status}`, { retryable: true, upstreamBody: text });
          if (attempt === maxAttempts - 1) throw err;
          lastErr = err; continue;
        }
        if (!res.ok) {
          const text = await safeText(res);
          throw new ProviderError(this.PROVIDER_ID, res.status, `Upstream ${res.status}: ${text.slice(0, 200)}`, { retryable: false, upstreamBody: text });
        }
        return parse(await res.json());
      } catch (err) {
        if (err instanceof ProviderError && !err.retryable) throw err;
        if (err instanceof RateLimitError && attempt === maxAttempts - 1) throw err;
        lastErr = err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new NetworkError(this.PROVIDER_ID, 'Exhausted retries with unknown error');
  }
}
