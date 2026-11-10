/**
 * OpenRouterAdapter — unit tests (Agent A6-retry).
 *
 * Run with:  bunx vitest run src/gateway/adapters/__tests__/openrouter.test.ts
 *
 * These tests are pure (no network). `globalThis.fetch` is mocked via
 * `vi.fn()` so the full `chat()` path (URL/method/headers/body → fetch →
 * parse) is exercised end-to-end without hitting the real OpenRouter API.
 *
 * Coverage:
 *   • PROVIDER_ID + getBaseUrl
 *   • mutateRequest:    :free suffix auto-append rules
 *   • getHeaders:       auth + Referer + X-Title; honors explicit apiKey arg
 *   • parseResponse:    content + usage.cost → provider_meta.cost extraction
 *   • chat:             mocked fetch; verifies URL + headers + body model field
 *   • chatStream:       mocked SSE response; verifies chunk parsing
 *   • listModels / healthCheck: mocked fetch
 *
 * Agent A6-retry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OpenRouterAdapter,
  OPENROUTER_BASE_URL,
  OPENROUTER_DEFAULT_MODEL,
  OPENROUTER_DEFAULT_REFERER,
  OPENROUTER_DEFAULT_TITLE,
  OPENROUTER_KEY_ENV,
  OPENROUTER_FREE_TIER_RPD,
  createOpenRouterAdapter,
  openrouterAdapter,
} from '../openrouter';
import type { ChatRequest, ChatStreamChunk } from '../_types';

// ---- Shared helpers --------------------------------------------------------

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function baseReq(model: string, content = 'hi'): ChatRequest {
  return { model, messages: [{ role: 'user', content }] };
}

/** Mock `globalThis.fetch` with a single canned `Response`. */
function mockFetchResponse(
  body: unknown,
  opts: { status?: number; headers?: Record<string, string> } = {},
): ReturnType<typeof vi.fn> {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const fetchMock = vi.fn(async () =>
    new Response(text, {
      status: opts.status ?? 200,
      headers: { 'content-type': typeof body === 'string' ? 'text/event-stream' : 'application/json', ...(opts.headers ?? {}) },
    }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** Standard OpenAI-shaped non-streaming response body. */
function openaiResponse(opts: {
  model?: string;
  content?: string;
  promptTokens?: number;
  completionTokens?: number;
  cost?: number;
  extra?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  return {
    id: 'chatcmpl-or-test',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: opts.model ?? 'meta-llama/llama-3.1-8b-instruct:free',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: opts.content ?? 'pong' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: opts.promptTokens ?? 5,
      completion_tokens: opts.completionTokens ?? 3,
      total_tokens: (opts.promptTokens ?? 5) + (opts.completionTokens ?? 3),
      ...(opts.cost !== undefined ? { cost: opts.cost } : {}),
    },
    ...(opts.extra ?? {}),
  };
}

/** Build a ReadableStream that yields SSE-formatted lines. */
function sseStream(chunks: Array<string | { data: unknown }>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const lines = chunks.map((c) => {
    if (typeof c === 'string') return c.endsWith('\n') ? c : `${c}\n`;
    return `data: ${JSON.stringify(c.data)}\n\n`;
  });
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(enc.encode(line));
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

// =============================================================================

describe('OpenRouterAdapter', () => {
  let a: OpenRouterAdapter;
  beforeEach(() => {
    a = new OpenRouterAdapter('test-key');
  });

  // ---------- identity & constants ----------

  describe('identity & constants', () => {
    it('exposes PROVIDER_ID = "openrouter" and the documented base URL', () => {
      expect(a.PROVIDER_ID).toBe('openrouter');
      expect(a.getBaseUrl()).toBe(OPENROUTER_BASE_URL);
      expect(a.getBaseUrl()).toBe('https://openrouter.ai/api/v1');
    });

    it('exports the documented constants (env var, referer, title, RPD)', () => {
      expect(OPENROUTER_KEY_ENV).toBe('OPENROUTER_KEY');
      expect(OPENROUTER_DEFAULT_REFERER).toBe('https://micky-assistant.workers.dev');
      expect(OPENROUTER_DEFAULT_TITLE).toBe('Micky Assistant');
      expect(OPENROUTER_FREE_TIER_RPD).toBe(50);
      expect(OPENROUTER_DEFAULT_MODEL).toBe('meta-llama/llama-3.1-8b-instruct:free');
    });
  });

  // ---------- mutateRequest (:free suffix logic) ----------

  describe('mutateRequest (:free suffix)', () => {
    it('auto-appends :free to a known free model when caller omits the suffix', () => {
      const out = a.formatRequest(baseReq('meta-llama/llama-3.1-8b-instruct')) as ChatRequest;
      expect(out.model).toBe('meta-llama/llama-3.1-8b-instruct:free');
    });

    it('auto-appends :free to google/gemini-flash-1.5 and qwen/qwen-2-7b-instruct', () => {
      expect((a.formatRequest(baseReq('google/gemini-flash-1.5')) as ChatRequest).model).toBe(
        'google/gemini-flash-1.5:free',
      );
      expect((a.formatRequest(baseReq('qwen/qwen-2-7b-instruct')) as ChatRequest).model).toBe(
        'qwen/qwen-2-7b-instruct:free',
      );
    });

    it('preserves an explicit :free suffix (no double-appending)', () => {
      const out = a.formatRequest(baseReq('meta-llama/llama-3.1-8b-instruct:free')) as ChatRequest;
      expect(out.model).toBe('meta-llama/llama-3.1-8b-instruct:free');
    });

    it('leaves paid models untouched (anthropic/claude-3.5-sonnet)', () => {
      const out = a.formatRequest(baseReq('anthropic/claude-3.5-sonnet')) as ChatRequest;
      expect(out.model).toBe('anthropic/claude-3.5-sonnet');
    });

    it('preserves the rest of the request body (temperature, max_tokens, top_p)', () => {
      const out = a.formatRequest({
        ...baseReq('meta-llama/llama-3.1-8b-instruct'),
        temperature: 0.7,
        max_tokens: 100,
        top_p: 0.9,
      }) as ChatRequest;
      expect(out.temperature).toBe(0.7);
      expect(out.max_tokens).toBe(100);
      expect(out.top_p).toBe(0.9);
    });
  });

  // ---------- getHeaders ----------

  describe('getHeaders', () => {
    it('emits Authorization, Content-Type, HTTP-Referer, X-Title when called with an explicit apiKey', () => {
      const h = a.getHeaders('sk-explicit-123');
      expect(h.Authorization).toBe('Bearer sk-explicit-123');
      expect(h['Content-Type']).toBe('application/json');
      expect(h['HTTP-Referer']).toBe('https://micky-assistant.workers.dev');
      expect(h['X-Title']).toBe('Micky Assistant');
    });

    it('falls back to the constructor-captured apiKey when called with no args (base-class flow)', () => {
      const h = a.getHeaders();
      expect(h.Authorization).toBe('Bearer test-key');
    });

    it('throws a clear error when no apiKey is available (singleton with no key)', () => {
      const empty = new OpenRouterAdapter();
      expect(() => empty.getHeaders()).toThrowError(/OPENROUTER_KEY/);
    });

    it('honours custom referer and title from the constructor', () => {
      const custom = new OpenRouterAdapter('k', {
        referer: 'https://example.com',
        title: 'Example',
      });
      const h = custom.getHeaders();
      expect(h['HTTP-Referer']).toBe('https://example.com');
      expect(h['X-Title']).toBe('Example');
    });
  });

  // ---------- parseResponse (cost extraction) ----------

  describe('parseResponse', () => {
    it('extracts content, role, finish_reason, and usage from a standard OpenAI body', () => {
      const r = a.parseResponse(openaiResponse({ content: 'Hello!' }), 'meta-llama/llama-3.1-8b-instruct:free');
      expect(r.object).toBe('chat.completion');
      expect(r.choices[0].message.content).toBe('Hello!');
      expect(r.choices[0].message.role).toBe('assistant');
      expect(r.choices[0].finish_reason).toBe('stop');
      expect(r.usage.total_tokens).toBe(8);
    });

    it('lifts usage.cost into provider_meta.cost (does not leak into OpenAI usage)', () => {
      const r = a.parseResponse(openaiResponse({ cost: 0.00042 }), 'meta-llama/llama-3.1-8b-instruct:free');
      expect(r.provider_meta?.cost).toBeCloseTo(0.00042, 6);
      // The cost must NOT leak through to the OpenAI `usage` field.
      expect((r.usage as unknown as Record<string, unknown>).cost).toBeUndefined();
    });

    it('handles a top-level `cost` field as a fallback when usage.cost is absent', () => {
      const raw = {
        ...openaiResponse({ content: 'x' }),
        cost: 0.0042,
      };
      // Strip usage.cost so we test the top-level fallback path.
      const rawWithoutUsageCost = { ...raw, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
      const r = a.parseResponse(rawWithoutUsageCost, 'm');
      expect(r.provider_meta?.cost).toBeCloseTo(0.0042, 6);
    });

    it('omits provider_meta.cost entirely when no cost is present', () => {
      const r = a.parseResponse(openaiResponse({ content: 'x' }), 'm');
      expect(r.provider_meta).toBeUndefined();
    });
  });

  // ---------- chat (mocked fetch) ----------

  describe('chat (mocked fetch)', () => {
    it('POSTs the :free-suffixed body to /chat/completions with Bearer + Referer + Title', async () => {
      const fetchMock = mockFetchResponse(openaiResponse({ content: 'pong' }));
      const r = await a.chat(baseReq('meta-llama/llama-3.1-8b-instruct'));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(init.method).toBe('POST');
      const headers = new Headers(init.headers);
      expect(headers.get('Authorization')).toBe('Bearer test-key');
      expect(headers.get('HTTP-Referer')).toBe('https://micky-assistant.workers.dev');
      expect(headers.get('X-Title')).toBe('Micky Assistant');
      const body = JSON.parse(String(init.body)) as { model: string; stream: boolean };
      expect(body.model).toBe('meta-llama/llama-3.1-8b-instruct:free');
      expect(body.stream).toBe(false);
      expect(r.choices[0].message.content).toBe('pong');
    });

    it('extracts usage.cost into provider_meta.cost on the real chat path', async () => {
      mockFetchResponse(openaiResponse({ content: 'x', cost: 0.001 }));
      const r = await a.chat(baseReq('meta-llama/llama-3.1-8b-instruct'));
      expect(r.provider_meta?.cost).toBeCloseTo(0.001, 6);
    });

    it('throws ProviderError on a 429 (rate-limited by OpenRouter)', async () => {
      mockFetchResponse('rate limited', { status: 429 });
      await expect(a.chat(baseReq('meta-llama/llama-3.1-8b-instruct'))).rejects.toThrowError(/429|rate/i);
    });
  });

  // ---------- chatStream (mocked SSE) ----------

  describe('chatStream (mocked SSE)', () => {
    it('parses OpenAI-shaped SSE chunks and yields them as ChatStreamChunks', async () => {
      const stream = sseStream([
        { data: { id: 'or-1', model: 'meta-llama/llama-3.1-8b-instruct:free', choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }] } },
        { data: { id: 'or-1', model: 'meta-llama/llama-3.1-8b-instruct:free', choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }] } },
        { data: { id: 'or-1', model: 'meta-llama/llama-3.1-8b-instruct:free', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
      ]);
      globalThis.fetch = vi.fn(async () => new Response(stream, {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch;

      const out: ChatStreamChunk[] = [];
      for await (const c of a.chatStream(baseReq('meta-llama/llama-3.1-8b-instruct'))) out.push(c);
      expect(out.length).toBe(3);
      expect(out[0].choices[0].delta.content).toBe('Hel');
      expect(out[1].choices[0].delta.content).toBe('lo');
      expect(out[2].choices[0].finish_reason).toBe('stop');
    });
  });

  // ---------- listModels / healthCheck (mocked fetch) ----------

  describe('listModels / healthCheck (mocked fetch)', () => {
    it('listModels parses the OpenAI-shaped /models response', async () => {
      const fetchMock = mockFetchResponse({
        data: [
          { id: 'm1', object: 'model', created: 1, owned_by: 'openrouter' },
          { id: 'm2', object: 'model', created: 2, owned_by: 'openrouter' },
        ],
      });
      const models = await a.listModels();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://openrouter.ai/api/v1/models');
      expect(models.length).toBe(2);
      expect(models[0].id).toBe('m1');
    });

    it('listModels falls back to the static list when /models 5xx\'s', async () => {
      mockFetchResponse('boom', { status: 500 });
      const models = await a.listModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models.every((m) => m.id.endsWith(':free'))).toBe(true);
    });

    it('healthCheck returns healthy=true with a 200 from /models', async () => {
      mockFetchResponse({ data: [{ id: 'm1' }] });
      const h = await a.healthCheck();
      expect(h.provider).toBe('openrouter');
      expect(h.healthy).toBe(true);
      expect(h.status).toBe(200);
      expect(h.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('healthCheck returns healthy=false with a 500 from /models', async () => {
      mockFetchResponse('boom', { status: 500 });
      const h = await a.healthCheck();
      expect(h.healthy).toBe(false);
      expect(h.status).toBe(500);
    });
  });

  // ---------- factory + singleton ----------

  describe('factory + singleton', () => {
    it('createOpenRouterAdapter(env) builds an adapter wired with the env key', async () => {
      const env = { OPENROUTER_KEY: 'sk-from-env' };
      const wired = createOpenRouterAdapter(env);
      const fetchMock = mockFetchResponse(openaiResponse({ content: 'ok' }));
      await wired.chat(baseReq('meta-llama/llama-3.1-8b-instruct'));
      const headers = new Headers((fetchMock.mock.calls[0] as [string, RequestInit])[1].headers);
      expect(headers.get('Authorization')).toBe('Bearer sk-from-env');
    });

    it('createOpenRouterAdapter(env) throws a clear error when OPENROUTER_KEY is missing', () => {
      expect(() => createOpenRouterAdapter({})).toThrowError(/OPENROUTER_KEY/);
      expect(() => createOpenRouterAdapter({ OPENROUTER_KEY: '' })).toThrowError(/OPENROUTER_KEY/);
    });

    it('the exported singleton is an OpenRouterAdapter instance with no key', () => {
      expect(openrouterAdapter).toBeInstanceOf(OpenRouterAdapter);
      expect(openrouterAdapter.PROVIDER_ID).toBe('openrouter');
      // The singleton has no captured key — calling getHeaders() bare throws.
      expect(() => openrouterAdapter.getHeaders()).toThrowError(/OPENROUTER_KEY/);
      // But passing an explicit apiKey works (the singleton is shape-only).
      const h = openrouterAdapter.getHeaders('sk-explicit');
      expect(h.Authorization).toBe('Bearer sk-explicit');
    });
  });
});
