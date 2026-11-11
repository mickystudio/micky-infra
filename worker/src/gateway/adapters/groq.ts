/**
 * Micky Assistant — Groq Adapter (multi-account, OpenAI-compatible).
 *
 * Groq's API is OpenAI-compatible, so shaping/parsing are identity transforms.
 *   1. Two-account fan-out: one class, instantiated twice (accountId 1/2),
 *      each reading its own env key (`GROQ_KEY_1` / `GROQ_KEY_2`). The gateway
 *      registry owns account selection + sticky-session routing.
 *   2. Self-contained I/O: ships its own `chat` / `chatStream` / `listModels` /
 *      `healthCheck`. `chatStream` is a raw byte pass-through wrapped in a
 *      pull-based ReadableStream for explicit backpressure.
 *   3. Rate-limit telemetry: `extractRateLimitInfo` harvests `x-ratelimit-*`.
 *
 * Edge-only (fetch, ReadableStream, Headers, TextEncoder, Date).
 * Created: 2026-11-10  (Agent A3)
 */

import type {
  ChatRequest,
  ChatResponse,
  DeltaChunk,
  ProviderAdapter,
  RateLimitInfo,
} from './types';

// ---- Local types (A3 task spec) ----

/** Groq account identifiers (one per API key in the env). */
export type ProviderId = 'groq1' | 'groq2';

/** Env shape required by the Groq adapter. The worker `Env` must be extended
 * with `GROQ_KEY_1` / `GROQ_KEY_2` secrets (`wrangler secret put`). */
export interface Env {
  GROQ_KEY_1: string;
  GROQ_KEY_2: string;
}

/** OpenAI-shaped model object returned by `GET /models`. */
export interface Model {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  [key: string]: unknown;
}

/** Groq rate-limit snapshot. Aliased to the shared `RateLimitInfo` (all fields
 * optional) so the same object satisfies both the `ProviderAdapter` contract
 * and this adapter's task-spec return type `Partial<QuotaState>`. */
export type QuotaState = RateLimitInfo;

/** Error thrown by the Groq adapter. Carries upstream HTTP status + body so the
 * router can decide (retry 5xx, circuit-break 429, surface 4xx) and the original
 * message reaches the caller unmodified. */
export class GroqError extends Error {
  readonly providerId: ProviderId;
  readonly status: number;
  readonly retryable: boolean;
  readonly upstreamBody?: string;
  readonly cause?: unknown;

  constructor(
    providerId: ProviderId,
    status: number,
    message: string,
    opts: { retryable?: boolean; upstreamBody?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'GroqError';
    this.providerId = providerId;
    this.status = status;
    this.retryable = opts.retryable ?? (status >= 500 || status === 429);
    this.upstreamBody = opts.upstreamBody;
    this.cause = opts.cause;
  }
}

// ---- Constants ----

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const GROQ_CHAT_PATH = '/chat/completions';

/** Models advertised by the adapter (free-tier, no credit card). */
const SUPPORTED_MODELS: readonly string[] = [
  'qwen3-32b',
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-120b',
  'allam-2-7b',
] as const;

// ---- GroqAdapter ----

export class GroqAdapter implements ProviderAdapter {
  /** Static family id for registry lookups (canonical `'groq1'`). Per-instance
   * account is resolved via {@link GroqAdapter.getAccountId}. */
  static get PROVIDER_ID(): ProviderId {
    return 'groq1';
  }

  private readonly accountId: 1 | 2;

  constructor(accountId: 1 | 2) {
    this.accountId = accountId;
  }

  // ---- Identity ----

  /** Account-specific provider id (`'groq1'` or `'groq2'`). */
  get provider(): string {
    return this.accountId === 1 ? 'groq1' : 'groq2';
  }

  getAccountId(): 1 | 2 {
    return this.accountId;
  }

  getProviderId(): ProviderId {
    return this.accountId === 1 ? 'groq1' : 'groq2';
  }

  getBaseUrl(): string {
    return GROQ_BASE_URL;
  }

  getChatCompletionsPath(): string {
    return GROQ_CHAT_PATH;
  }

  getSupportedModels(): readonly string[] {
    return SUPPORTED_MODELS;
  }

  getHeaders(apiKey: string): HeadersInit {
    return {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  /** Resolve the API key for this account from env, throwing on misconfig. */
  private getApiKey(env: Env): string {
    const key = this.accountId === 1 ? env.GROQ_KEY_1 : env.GROQ_KEY_2;
    if (!key || key.trim().length === 0) {
      throw new GroqError(
        this.getProviderId(),
        401,
        `GROQ_KEY_${this.accountId} is not configured (set it via \`wrangler secret put GROQ_KEY_${this.accountId}\`)`,
        { retryable: false },
      );
    }
    return key;
  }

  // ---- Shaping ----

  /** Identity transform: Groq is OpenAI-compatible. Strips gateway-internal
   * keys (e.g. `provider_options`) that Groq does not understand. */
  formatRequest(req: ChatRequest): Record<string, unknown> {
    const out: Record<string, unknown> = { ...req };
    delete out.provider_options;
    return out;
  }

  /** Validate + return a non-streaming response. Groq returns the OpenAI
   * `chat.completion` shape verbatim; structural guard throws on malformed. */
  parseResponse(raw: unknown): ChatResponse {
    if (typeof raw !== 'object' || raw === null) {
      throw new GroqError(this.getProviderId(), 502, 'Malformed Groq response: not an object');
    }
    const obj = raw as Record<string, unknown>;
    if (typeof obj.id !== 'string' || !Array.isArray(obj.choices)) {
      throw new GroqError(this.getProviderId(), 502, 'Malformed Groq response: missing id/choices');
    }
    return raw as ChatResponse;
  }

  /** Parse one SSE chunk (`data: {...}\n\n`) into a `DeltaChunk`, or `null` for:
   * empty input; SSE comment/keep-alive (`: ping`); the terminal `[DONE]`
   * sentinel (the caller detects end-of-stream from the raw token — this parser
   * only yields JSON deltas); chunks without a `data:` field; incomplete JSON
   * (the caller buffers more bytes). Multi-event chunks return the first event. */
  parseStreamChunk(chunk: string): DeltaChunk | null {
    if (typeof chunk !== 'string' || chunk.length === 0) return null;
    const trimmed = chunk.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.startsWith(':')) return null; // SSE comment / keep-alive

    const dataIdx = trimmed.indexOf('data:');
    if (dataIdx === -1) return null;

    // Payload = text after `data:` up to the next `\n\n` boundary (first event).
    let payload = trimmed.slice(dataIdx + 5);
    const boundary = payload.indexOf('\n\n');
    if (boundary !== -1) payload = payload.slice(0, boundary);
    payload = payload.trim();
    if (payload.length === 0) return null;
    if (payload === '[DONE]') return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return null; // Partial JSON — caller buffers more bytes.
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.choices)) return null; // minimum shape guard
    return parsed as DeltaChunk;
  }

  /** Harvest Groq's `x-ratelimit-*` headers into a `QuotaState` (= RateLimitInfo).
   * Missing headers are omitted (absent = "unknown"); a `raw` snapshot is
   * attached for dashboards. Mapping: x-ratelimit-{limit,remaining}-{requests,
   * tokens} → {requests,tokens}{Limit,Remaining}; x-ratelimit-reset-{requests,
   * tokens} → reset{Requests,Tokens}In; retry-after → retryAfter (s, on 429). */
  extractRateLimitInfo(headers: Headers): Partial<QuotaState> {
    const num = (name: string): number | undefined => {
      const v = headers.get(name);
      if (v === null || v === '') return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const str = (name: string): string | undefined => {
      const v = headers.get(name);
      return v === null ? undefined : v;
    };

    const info: RateLimitInfo = {
      requestsRemaining: num('x-ratelimit-remaining-requests'),
      tokensRemaining: num('x-ratelimit-remaining-tokens'),
      requestsLimit: num('x-ratelimit-limit-requests'),
      tokensLimit: num('x-ratelimit-limit-tokens'),
      retryAfter: num('retry-after'),
      resetRequestsIn: str('x-ratelimit-reset-requests'),
      resetTokensIn: str('x-ratelimit-reset-tokens'),
    };

    const raw: Record<string, string> = {};
    const tracked = [
      'x-ratelimit-limit-requests',
      'x-ratelimit-remaining-requests',
      'x-ratelimit-reset-requests',
      'x-ratelimit-limit-tokens',
      'x-ratelimit-remaining-tokens',
      'x-ratelimit-reset-tokens',
      'retry-after',
    ];
    for (const k of tracked) {
      const v = headers.get(k);
      if (v !== null) raw[k] = v;
    }
    if (Object.keys(raw).length > 0) info.raw = raw;

    return info;
  }

  // ---- I/O ----

  /** Non-streaming chat completion. Returns parsed body + raw response. */
  async chat(req: ChatRequest, env: Env): Promise<{ response: ChatResponse; raw: Response }> {
    const apiKey = this.getApiKey(env);
    const body = JSON.stringify(this.formatRequest({ ...req, stream: false }));
    const res = await this.doFetch(GROQ_CHAT_PATH, apiKey, body);
    const json: unknown = await res.json();
    return { response: this.parseResponse(json), raw: res };
  }

  /** Streaming chat completion. Returns a pull-based `ReadableStream<Uint8Array>`
   * that passes Groq's OpenAI-shaped SSE through verbatim. Backpressure is
   * explicit (upstream read only on consumer pull). */
  async chatStream(req: ChatRequest, env: Env): Promise<ReadableStream<Uint8Array>> {
    const apiKey = this.getApiKey(env);
    const body = JSON.stringify(this.formatRequest({ ...req, stream: true }));
    const res = await this.doFetch(GROQ_CHAT_PATH, apiKey, body);
    if (!res.body) {
      throw new GroqError(this.getProviderId(), 502, 'Groq stream response has no body');
    }
    return wrapStream(res.body, this.getProviderId());
  }

  /** `GET /models` — returns Groq's model list (OpenAI-shaped). */
  async listModels(env: Env): Promise<Model[]> {
    const apiKey = this.getApiKey(env);
    const res = await this.doFetch('/models', apiKey, null);
    const json: unknown = await res.json();
    if (typeof json !== 'object' || json === null || !Array.isArray((json as Record<string, unknown>).data)) {
      throw new GroqError(this.getProviderId(), 502, 'Malformed Groq /models response');
    }
    return (json as { data: Model[] }).data;
  }

  /** Lightweight probe — succeeds if `GET /models` returns a non-empty list. */
  async healthCheck(env: Env): Promise<boolean> {
    try {
      const models = await this.listModels(env);
      return Array.isArray(models) && models.length > 0;
    } catch {
      return false;
    }
  }

  // ---- Internal ----

  /** Shared fetch wrapper with unified network/HTTP error handling. */
  private async doFetch(path: string, apiKey: string, body: string | null): Promise<Response> {
    const init: RequestInit = { method: body === null ? 'GET' : 'POST', headers: this.getHeaders(apiKey) };
    if (body !== null) init.body = body;
    let res: Response;
    try {
      res = await fetch(`${GROQ_BASE_URL}${path}`, init);
    } catch (err) {
      throw new GroqError(this.getProviderId(), 0, `Groq network error: ${(err as Error).message}`, {
        retryable: true, cause: err,
      });
    }
    if (!res.ok) {
      const text = await safeReadText(res);
      throw new GroqError(this.getProviderId(), res.status, `Groq HTTP ${res.status}: ${truncate(text, 512)}`, {
        upstreamBody: text, retryable: res.status >= 500 || res.status === 429,
      });
    }
    return res;
  }
}

// Pre-wired instances (one per account) — import these from the registry.
export const groq1Adapter = new GroqAdapter(1);
export const groq2Adapter = new GroqAdapter(2);

// ---- Helpers (module-private) ----

/** Read the response body as text without throwing on empty/invalid bodies. */
async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** Clamp a string to `max` chars for compact error messages. */
function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Wrap the upstream byte stream in a pull-based `ReadableStream<Uint8Array>`.
 * `highWaterMark: 0` → `pull` is invoked exactly once per consumer `read()`,
 * giving precise backpressure (when the consumer pauses, no bytes are read from
 * Groq, so the TCP window backpressures the chain). `cancel` propagates
 * downstream cancellation to the upstream reader (saves quota); errors surface
 * as stream errors.
 */
function wrapStream(
  source: ReadableStream<Uint8Array>,
  providerId: ProviderId,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let closed = false;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (closed) return;
        try {
          const { done, value } = await reader.read();
          if (done) {
            closed = true;
            controller.close();
            return;
          }
          if (value) controller.enqueue(value);
        } catch (err) {
          closed = true;
          controller.error(
            new GroqError(
              providerId,
              0,
              `Groq stream read error: ${(err as Error).message}`,
              { retryable: true, cause: err },
            ),
          );
        }
      },
      cancel(reason) {
        closed = true;
        return reader.cancel(reason).catch(() => undefined);
      },
    },
    { highWaterMark: 0, size: () => 1 },
  );
}
