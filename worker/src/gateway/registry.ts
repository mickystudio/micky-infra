/**
 * Micky Assistant — Provider Registry (Task A1-retry)
 *
 * Central registry of all 11 LLM providers, exposed through a UNIFORM
 * runtime `ProviderAdapter` interface (defined in `./types.ts`).
 *
 * Exports:
 *   • `PROVIDERS`         — `Record<ProviderId, ProviderAdapter>` for all 11.
 *   • `getProvider(id)`   — lookup by id (throws on unknown id).
 *   • `listProviders()`   — all 11 ids in declaration order.
 *   • `isProviderConfigured(id, env)` — true if the API key / binding is set.
 *   • `getHealthyProviders(env)` — uses `QuotaLedger.getHealthyProviders()`.
 *
 * Adapter wrapping strategy
 * -------------------------
 * The 11 underlying adapters were built by sibling agents with THREE
 * different `chat()` calling conventions:
 *   1. BaseOpenAICompatibleAdapter subclasses (OpenRouter / SambaNova /
 *      Cohere / SiliconFlow / Cerebras / Novita) — env captured at
 *      construction; chat method is `chat(req)` (no env). Lazily built.
 *   2. Groq / WorkersAI — env passed at call time; `chat(req, env)`.
 *   3. Gemini — apiKey string passed at call time; `chat(req, apiKey)`.
 *   4. Mistral — no chat method, only shape methods (we do fetch ourselves).
 *
 * Each is wrapped in a Handle class that satisfies the runtime ProviderAdapter
 * interface, so the cascade in `index.ts` can call them uniformly:
 * `await adapter.chat(req, env)`.
 *
 * Edge-only. Created: 2026-11-10 — Task A1-retry
 */

import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ProviderAdapter,
  ProviderId,
  GatewayEnv,
} from './types';

// Pre-built singletons (siblings A3/A4/A6).
import { groq1Adapter, groq2Adapter, GroqAdapter } from './adapters/groq';
import { geminiAdapter, GeminiAdapter } from './adapters/gemini';
import { mistralAdapter, MistralAdapter } from './adapters/mistral';
import { workersaiAdapter, WorkersAIAdapter } from './adapters/workersai';

// Factory-built (siblings A6/A10). Constructed lazily from env.
import { OpenRouterAdapter } from './adapters/openrouter';
import { SambaNovaAdapter } from './adapters/sambanova';
import { CohereAdapter } from './adapters/cohere';
import { SiliconFlowAdapter } from './adapters/siliconflow';
import { CerebrasAdapter } from './adapters/cerebras';
import { NovitaAdapter } from './adapters/novita';

import { QuotaLedger } from './ledger/ledger';
import type { DeltaChunk } from './adapters/types';

// ============================================================================
// Helpers — env key lookup
// ============================================================================

/** Read a string env var, returning '' if absent (treat as unconfigured). */
function envStr(env: GatewayEnv, key: string): string {
  const v = (env as unknown as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : '';
}

/** True if a string env var is set (non-empty). */
function envConfigured(env: GatewayEnv, key: string): boolean {
  return envStr(env, key).length > 0;
}

// ============================================================================
// SSE stream helpers
// ============================================================================
// Convert AsyncIterable<ChatStreamChunk> or raw SSE byte stream into a
// ReadableStream<Uint8Array> of OpenAI-shaped SSE bytes
// (`data: {...}\n\n` + terminal `data: [DONE]\n\n`).

const encoder = new TextEncoder();

/** Convert an AsyncIterable<ChatStreamChunk> into OpenAI SSE bytes. */
function chunksToSSEStream(
  iterable: AsyncIterable<ChatStreamChunk>,
  model: string,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of iterable) {
          if (!chunk.model) chunk.model = model;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/**
 * Convert a raw upstream SSE byte stream into OpenAI SSE bytes by piping
 * each `data:` line through `parseLine`. Null return = skip (comment,
 * [DONE], unparseable). The terminal `data: [DONE]\n\n` is appended by us.
 */
function rawSSEToOpenAIStream(
  upstream: ReadableStream<Uint8Array>,
  parseLine: (line: string) => DeltaChunk | null,
  model: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const reader = upstream.getReader();
  let buf = '';
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (buf.length > 0) {
            const chunk = parseLine(buf);
            if (chunk) {
              if (!chunk.model) chunk.model = model;
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
            buf = '';
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }
        buf += decoder.decode(value, { stream: true });
        let nl = buf.indexOf('\n');
        while (nl !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const chunk = parseLine(line);
          if (chunk) {
            if (!chunk.model) chunk.model = model;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
          nl = buf.indexOf('\n');
        }
      } catch (err) {
        try { reader.releaseLock(); } catch { /* noop */ }
        controller.error(err);
      }
    },
    cancel() {
      try { reader.releaseLock(); } catch { /* noop */ }
    },
  });
}

// ============================================================================
// Handle: BaseOpenAICompatibleAdapter subclass (env-captured at construction)
// ============================================================================
// Used by: openrouter, sambanova, cohere, siliconflow, cerebras, novita.
// These adapters require an apiKey at construction time. We build one
// instance per apiKey and cache it.

interface BaseCompatInstance {
  chat(req: unknown): Promise<unknown>;
  chatStream(req: unknown): AsyncIterable<unknown>;
  healthCheck(): Promise<{ healthy?: boolean } | unknown>;
}
interface BaseCompatCtor {
  new (apiKey: string): BaseCompatInstance;
}

class BaseCompatHandle implements ProviderAdapter {
  private cache: { key: string; adapter: BaseCompatInstance } | null = null;

  constructor(
    readonly id: ProviderId,
    readonly label: string,
    private readonly keyEnv: string,
    private readonly Ctor: BaseCompatCtor,
  ) {}

  private getAdapter(env: GatewayEnv): BaseCompatInstance {
    const key = envStr(env, this.keyEnv);
    if (key.length === 0) {
      throw new Error(`${this.id}: ${this.keyEnv} is not configured`);
    }
    if (this.cache && this.cache.key === key) return this.cache.adapter;
    const adapter = new this.Ctor(key);
    this.cache = { key, adapter };
    return adapter;
  }

  async chat(req: ChatRequest, env: GatewayEnv): Promise<ChatResponse> {
    const adapter = this.getAdapter(env);
    const result = await adapter.chat(req);
    // Cast through unknown — the underlying adapter returns its own
    // `ChatResponse` shape (from `./adapters/_types.ts`), which is
    // structurally compatible with ours at runtime (both are OpenAI-shaped).
    return result as unknown as ChatResponse;
  }

  async chatStream(req: ChatRequest, env: GatewayEnv): Promise<ReadableStream<Uint8Array>> {
    const adapter = this.getAdapter(env);
    const iterable = adapter.chatStream(req) as AsyncIterable<ChatStreamChunk>;
    return chunksToSSEStream(iterable, req.model ?? '');
  }

  async healthCheck(env: GatewayEnv): Promise<boolean> {
    if (!this.isConfigured(env)) return false;
    try {
      const adapter = this.getAdapter(env);
      const status = await adapter.healthCheck() as { healthy?: boolean };
      return Boolean(status?.healthy);
    } catch {
      return false;
    }
  }

  isConfigured(env: GatewayEnv): boolean {
    return envConfigured(env, this.keyEnv);
  }
}


class GroqHandle implements ProviderAdapter {
  constructor(
    readonly id: 'groq1' | 'groq2',
    readonly label: string,
    private readonly adapter: GroqAdapter,
    private readonly keyEnv: 'GROQ_KEY_1' | 'GROQ_KEY_2',
  ) {}

  async chat(req: ChatRequest, env: GatewayEnv): Promise<ChatResponse> {
    const groqEnv = { GROQ_KEY_1: env.GROQ_KEY_1, GROQ_KEY_2: env.GROQ_KEY_2 };
    const { response } = await this.adapter.chat(req, groqEnv);
    return response;
  }

  async chatStream(req: ChatRequest, env: GatewayEnv): Promise<ReadableStream<Uint8Array>> {
    const groqEnv = { GROQ_KEY_1: env.GROQ_KEY_1, GROQ_KEY_2: env.GROQ_KEY_2 };
    return await this.adapter.chatStream(req, groqEnv);
  }

  async healthCheck(env: GatewayEnv): Promise<boolean> {
    if (!this.isConfigured(env)) return false;
    try {
      const groqEnv = { GROQ_KEY_1: env.GROQ_KEY_1, GROQ_KEY_2: env.GROQ_KEY_2 };
      return await this.adapter.healthCheck(groqEnv);
    } catch {
      return false;
    }
  }

  isConfigured(env: GatewayEnv): boolean {
    return envConfigured(env, this.keyEnv);
  }
}

class GeminiHandle implements ProviderAdapter {
  constructor(
    readonly id: 'gemini',
    readonly label: string,
    private readonly adapter: GeminiAdapter,
  ) {}

  async chat(req: ChatRequest, env: GatewayEnv): Promise<ChatResponse> {
    const apiKey = envStr(env, 'GEMINI_KEY');
    if (!apiKey) throw new Error('gemini: GEMINI_KEY is not configured');
    return await this.adapter.chat(req, apiKey);
  }

  async chatStream(req: ChatRequest, env: GatewayEnv): Promise<ReadableStream<Uint8Array>> {
    const apiKey = envStr(env, 'GEMINI_KEY');
    if (!apiKey) throw new Error('gemini: GEMINI_KEY is not configured');
    const iterable = this.adapter.chatStream(req, apiKey);
    return chunksToSSEStream(
      iterable as AsyncIterable<ChatStreamChunk>,
      req.model ?? '',
    );
  }

  async healthCheck(env: GatewayEnv): Promise<boolean> {
    if (!this.isConfigured(env)) return false;
    try {
      return await this.adapter.healthCheck(envStr(env, 'GEMINI_KEY'));
    } catch {
      return false;
    }
  }

  isConfigured(env: GatewayEnv): boolean {
    return envConfigured(env, 'GEMINI_KEY');
  }
}

class MistralHandle implements ProviderAdapter {
  constructor(
    readonly id: 'mistral',
    readonly label: string,
    private readonly adapter: MistralAdapter,
  ) {}

  private headers(env: GatewayEnv): HeadersInit {
    const apiKey = envStr(env, 'MISTRAL_KEY');
    if (!apiKey) throw new Error('mistral: MISTRAL_KEY is not configured');
    return this.adapter.getHeaders(apiKey);
  }

  async chat(req: ChatRequest, env: GatewayEnv): Promise<ChatResponse> {
    const body = JSON.stringify(this.adapter.formatRequest({ ...req, stream: false }));
    const url = `${this.adapter.getBaseUrl()}${this.adapter.getChatCompletionsPath()}`;
    const res = await fetch(url, { method: 'POST', headers: this.headers(env), body });
    if (res.status === 429 || res.status >= 500) {
      const text = await res.text().catch(() => '');
      throw new Error(`mistral upstream ${res.status}: ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`mistral ${res.status}: ${text.slice(0, 200)}`);
    }
    return this.adapter.parseResponse(await res.json());
  }

  async chatStream(req: ChatRequest, env: GatewayEnv): Promise<ReadableStream<Uint8Array>> {
    const body = JSON.stringify(this.adapter.formatRequest({ ...req, stream: true }));
    const url = `${this.adapter.getBaseUrl()}${this.adapter.getChatCompletionsPath()}`;
    const res = await fetch(url, { method: 'POST', headers: this.headers(env), body });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`mistral stream ${res.status}: ${text.slice(0, 200)}`);
    }
    const parser = (line: string): DeltaChunk | null =>
      this.adapter.parseStreamChunk(line);
    return rawSSEToOpenAIStream(res.body, parser, req.model ?? '');
  }

  async healthCheck(env: GatewayEnv): Promise<boolean> {
    if (!this.isConfigured(env)) return false;
    try {
      const res = await fetch(`${this.adapter.getBaseUrl()}/models`, {
        method: 'GET',
        headers: this.headers(env),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  isConfigured(env: GatewayEnv): boolean {
    return envConfigured(env, 'MISTRAL_KEY');
  }
}

class WorkersAIHandle implements ProviderAdapter {
  constructor(
    readonly id: 'workersai',
    readonly label: string,
    private readonly adapter: WorkersAIAdapter,
  ) {}

  async chat(req: ChatRequest, env: GatewayEnv): Promise<ChatResponse> {
    if (!req.model) throw new Error('workersai: req.model is required');
    // Cast req + result through `unknown` — the underlying adapter uses
    // `_types.ts`'s ChatRequest/ChatResponse shapes, which are structurally
    // compatible at runtime (both OpenAI-shaped) but not directly assignable
    // to our `./types.ts` re-exports.
    const result = await this.adapter.chat(
      req as unknown as Parameters<typeof this.adapter.chat>[0],
      env as unknown as Parameters<typeof this.adapter.chat>[1],
    );
    return result as unknown as ChatResponse;
  }

  async chatStream(req: ChatRequest, env: GatewayEnv): Promise<ReadableStream<Uint8Array>> {
    if (!req.model) throw new Error('workersai: req.model is required');
    const iterable = this.adapter.chatStream(
      req as unknown as Parameters<typeof this.adapter.chatStream>[0],
      env as unknown as Parameters<typeof this.adapter.chatStream>[1],
    ) as AsyncIterable<ChatStreamChunk>;
    return chunksToSSEStream(iterable, req.model ?? '');
  }

  async healthCheck(env: GatewayEnv): Promise<boolean> {
    if (!this.isConfigured(env)) return false;
    try {
      const status = await this.adapter.healthCheck(
        env as unknown as Parameters<typeof this.adapter.healthCheck>[0],
      ) as { healthy?: boolean };
      return Boolean(status?.healthy);
    } catch {
      return false;
    }
  }

  isConfigured(env: GatewayEnv): boolean {
    return Boolean((env as unknown as { AI?: unknown }).AI);
  }
}

// ============================================================================
// The 11 handles
// ============================================================================
// Pre-built singletons (no env at construction): groq1, groq2, gemini,
// mistral, workersai.
// Lazily-built (env-captured at first chat call): openrouter, sambanova,
// cohere, siliconflow, cerebras, novita.

const HANDLES: Record<ProviderId, ProviderAdapter> = {
  groq1: new GroqHandle('groq1', 'Groq (Account 1)', groq1Adapter, 'GROQ_KEY_1'),
  groq2: new GroqHandle('groq2', 'Groq (Account 2)', groq2Adapter, 'GROQ_KEY_2'),
  gemini: new GeminiHandle('gemini', 'Google Gemini', geminiAdapter),
  mistral: new MistralHandle('mistral', 'Mistral AI', mistralAdapter),
  workersai: new WorkersAIHandle('workersai', 'Cloudflare Workers AI', workersaiAdapter),

  openrouter: new BaseCompatHandle(
    'openrouter', 'OpenRouter', 'OPENROUTER_KEY',
    OpenRouterAdapter as unknown as BaseCompatCtor,
  ),
  sambanova: new BaseCompatHandle(
    'sambanova', 'SambaNova Cloud', 'SAMBANOVA_KEY',
    SambaNovaAdapter as unknown as BaseCompatCtor,
  ),
  cohere: new BaseCompatHandle(
    'cohere', 'Cohere', 'COHERE_KEY',
    CohereAdapter as unknown as BaseCompatCtor,
  ),
  siliconflow: new BaseCompatHandle(
    'siliconflow', 'SiliconFlow', 'SILICONFLOW_KEY',
    SiliconFlowAdapter as unknown as BaseCompatCtor,
  ),
  cerebras: new BaseCompatHandle(
    'cerebras', 'Cerebras Cloud', 'CEREBRAS_KEY',
    CerebrasAdapter as unknown as BaseCompatCtor,
  ),
  novita: new BaseCompatHandle(
    'novita', 'Novita AI', 'NOVITA_KEY',
    NovitaAdapter as unknown as BaseCompatCtor,
  ),
};

// ============================================================================
// Public API
// ============================================================================

/** The complete provider registry — one `ProviderAdapter` per id. */
export const PROVIDERS: Record<ProviderId, ProviderAdapter> = HANDLES;

/** Lookup by id. Throws on unknown id. */
export function getProvider(id: ProviderId): ProviderAdapter {
  const h = HANDLES[id];
  if (!h) throw new Error(`Unknown provider id: ${id}`);
  return h;
}

/** All 11 provider ids in declaration order. */
export function listProviders(): ProviderId[] {
  return Object.keys(HANDLES) as ProviderId[];
}

/** True if the provider's API key / binding is set in env. */
export function isProviderConfigured(id: ProviderId, env: GatewayEnv): boolean {
  return getProvider(id).isConfigured(env);
}

/**
 * Returns the subset of providers that are BOTH configured (key/binding
 * present) AND marked healthy by the D1 ledger's circuit-breaker state.
 * Best-effort: if D1 is unreachable, returns ALL configured providers.
 */
export async function getHealthyProviders(
  env: GatewayEnv,
  _intent?: string,
): Promise<ProviderId[]> {
  const all = listProviders();
  const configured = all.filter((id) => isProviderConfigured(id, env));
  if (!env.DB) return configured; // fail-open when D1 unavailable
  try {
    const ledger = new QuotaLedger(env.DB);
    const healthy = new Set(await ledger.getHealthyProviders());
    return configured.filter((id) => {
      // QuotaLedger uses 'workers-ai' but our ProviderId uses 'workersai'.
      const ledgerName = id === 'workersai' ? 'workers-ai' : id;
      return healthy.has(ledgerName);
    });
  } catch {
    return configured; // D1 read failed — fail-open.
  }
}

// Re-export underlying adapter classes for tests / direct callers.
export {
  groq1Adapter, groq2Adapter, GroqAdapter, geminiAdapter, GeminiAdapter,
  mistralAdapter, MistralAdapter, workersaiAdapter, WorkersAIAdapter,
  OpenRouterAdapter, SambaNovaAdapter, CohereAdapter,
  SiliconFlowAdapter, CerebrasAdapter, NovitaAdapter,
};
