/**
 * Agent A10 — unit tests for the five new OpenAI-compatible adapters.
 *
 * Run with:  bunx vitest run src/gateway/adapters/__tests__/new_providers.test.ts
 *
 * These tests are pure (no network). `globalThis.fetch` is mocked via
 * `vi.fn()` so the full `chat()` path (URL/method/headers/body → fetch →
 * parse) is exercised end-to-end without hitting any real provider.
 *
 * Coverage:
 *   • formatRequest:        default-model fallback + body shape
 *   • parseResponse:        content / usage / provider_meta.cost extraction
 *   • extractRateLimitInfo: standard headers + per-provider quirks
 *   • chat:                 mocked fetch, verifies URL + headers + body
 *   • chatStream:           mocked SSE response, verifies chunk parsing
 *
 * Agent A10.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CerebrasAdapter } from '../cerebras';
import { CohereAdapter } from '../cohere';
import { NovitaAdapter } from '../novita';
import { SambaNovaAdapter } from '../sambanova';
import { SiliconFlowAdapter } from '../siliconflow';
import type { ChatRequest, ChatStreamChunk } from '../_types';

// ---- Shared helpers ---------------------------------------------------------

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function baseReq(model: string, content = 'hi'): ChatRequest {
  return { model, messages: [{ role: 'user', content }] };
}

/** Mock `globalThis.fetch` with a single canned `Response`. */
function mockFetchResponse(
  body: unknown,
  opts: { status?: number; headers?: Record<string, string> } = {},
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: opts.status ?? 200,
      headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
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
  extra?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: opts.model ?? 'test-model',
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
// SambaNova
// =============================================================================

describe('SambaNovaAdapter', () => {
  let a: SambaNovaAdapter;
  beforeEach(() => { a = new SambaNovaAdapter('test-key'); });

  it('formatRequest defaults the model to DeepSeek-V3.1', () => {
    const out = a.formatRequest(baseReq('')) as ChatRequest;
    expect(out.model).toBe('DeepSeek-V3.1');
    expect(out.stream).toBe(false);
  });

  it('parseResponse extracts content + usage', () => {
    const r = a.parseResponse(openaiResponse({ content: 'hello' }), 'DeepSeek-V3.1');
    expect(r.choices[0].message.content).toBe('hello');
    expect(r.usage.total_tokens).toBe(8);
    expect(r.model).toBe('test-model');
  });

  it('extractRateLimitInfo parses x-ratelimit-* headers', () => {
    const h = new Headers({
      'x-ratelimit-remaining-requests': '19',
      'x-ratelimit-limit-requests': '20',
      'x-ratelimit-remaining-tokens': '199000',
    });
    const info = a.extractRateLimitInfo(h);
    expect(info.requestsRemaining).toBe(19);
    expect(info.requestsLimit).toBe(20);
    expect(info.tokensRemaining).toBe(199000);
  });

  it('synthesizes a 3s retry-after when 429 has none', () => {
    const h = new Headers({}); // SambaNova quirk: 429 w/o Retry-After
    const info = a.extractRateLimitInfo(h);
    expect(info.retryAfterSeconds).toBe(3);
  });

  it('chat sends a POST to the right URL and parses the body', async () => {
    const fetchMock = mockFetchResponse(openaiResponse({ content: 'pong' }), {
      headers: { 'x-ratelimit-remaining-requests': '19' },
    });
    const r = await a.chat(baseReq('DeepSeek-V3.1'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.sambanova.ai/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-key');
    const body = JSON.parse(String(init.body)) as { model: string };
    expect(body.model).toBe('DeepSeek-V3.1');
    expect(r.choices[0].message.content).toBe('pong');
  });
});

// =============================================================================
// Cohere
// =============================================================================

describe('CohereAdapter', () => {
  let a: CohereAdapter;
  beforeEach(() => { a = new CohereAdapter('test-key'); });

  it('formatRequest defaults to command-a-plus-05-2026', () => {
    const out = a.formatRequest(baseReq('')) as ChatRequest;
    expect(out.model).toBe('command-a-plus-05-2026');
  });

  it('parseResponse extracts content + usage', () => {
    const r = a.parseResponse(openaiResponse({ content: 'cohere-says' }), 'command-a-plus-05-2026');
    expect(r.choices[0].message.content).toBe('cohere-says');
    expect(r.usage.total_tokens).toBe(8);
  });

  it('extractRateLimitInfo parses standard headers', () => {
    const h = new Headers({
      'x-ratelimit-remaining-requests': '19',
      'x-ratelimit-limit-requests': '20',
    });
    const info = a.extractRateLimitInfo(h);
    expect(info.requestsRemaining).toBe(19);
    expect(info.requestsLimit).toBe(20);
    expect(info.retryAfterSeconds).toBeUndefined();
  });

  it('chat POSTs to /compatibility/v1 (NOT /v1)', async () => {
    const fetchMock = mockFetchResponse(openaiResponse());
    await a.chat(baseReq('command-r-plus'));
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cohere.ai/compatibility/v1/chat/completions');
  });
});

// =============================================================================
// SiliconFlow
// =============================================================================

describe('SiliconFlowAdapter', () => {
  let a: SiliconFlowAdapter;
  beforeEach(() => { a = new SiliconFlowAdapter('test-key'); });

  it('formatRequest preserves vendor-prefixed model id', () => {
    const out = a.formatRequest(baseReq('')) as ChatRequest;
    expect(out.model).toBe('deepseek-ai/DeepSeek-V3');
  });

  it('parseResponse captures usage.cost into provider_meta.cost', () => {
    const properRaw = {
      ...openaiResponse({ content: 'sf-says' }),
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, cost: 0.000123 },
    };
    const r = a.parseResponse(properRaw, 'deepseek-ai/DeepSeek-V3');
    expect(r.choices[0].message.content).toBe('sf-says');
    expect(r.usage.total_tokens).toBe(8);
    expect(r.provider_meta?.cost).toBeCloseTo(0.000123, 6);
    // The cost must NOT leak through to the OpenAI `usage` field on the
    // normalized response (it has been detached into `provider_meta`).
    expect((r.usage as unknown as Record<string, unknown>).cost).toBeUndefined();
  });

  it('parseResponse handles top-level cost field too', () => {
    const properRaw = { ...openaiResponse(), cost: 0.0042 };
    const r = a.parseResponse(properRaw, 'deepseek-ai/DeepSeek-V3');
    expect(r.provider_meta?.cost).toBeCloseTo(0.0042, 6);
  });

  it('extractRateLimitInfo parses standard headers', () => {
    const h = new Headers({
      'x-ratelimit-remaining-requests': '49',
      'x-ratelimit-limit-requests': '100',
    });
    const info = a.extractRateLimitInfo(h);
    expect(info.requestsRemaining).toBe(49);
  });

  it('chat POSTs to /v1/chat/completions', async () => {
    const fetchMock = mockFetchResponse(openaiResponse());
    await a.chat(baseReq('Qwen/Qwen3-Coder-30B-A3B-Instruct'));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.siliconflow.com/v1/chat/completions');
    const body = JSON.parse(String(init.body)) as { model: string };
    expect(body.model).toBe('Qwen/Qwen3-Coder-30B-A3B-Instruct');
  });
});

// =============================================================================
// Cerebras
// =============================================================================

describe('CerebrasAdapter', () => {
  let a: CerebrasAdapter;
  beforeEach(() => { a = new CerebrasAdapter('test-key'); });

  it('formatRequest defaults to qwen-3.8-27b', () => {
    const out = a.formatRequest(baseReq('')) as ChatRequest;
    expect(out.model).toBe('qwen-3.8-27b');
  });

  it('parseResponse extracts content + usage', () => {
    const r = a.parseResponse(openaiResponse({ content: 'cerebras-fast' }), 'qwen-3.8-27b');
    expect(r.choices[0].message.content).toBe('cerebras-fast');
    expect(r.usage.total_tokens).toBe(8);
  });

  it('extractRateLimitInfo parses standard headers', () => {
    const h = new Headers({
      'x-ratelimit-remaining-requests': '49',
      'x-ratelimit-limit-requests': '50',
      'x-ratelimit-remaining-tokens': '999000',
      'x-ratelimit-limit-tokens': '1000000',
    });
    const info = a.extractRateLimitInfo(h);
    expect(info.requestsRemaining).toBe(49);
    expect(info.requestsLimit).toBe(50);
    expect(info.tokensRemaining).toBe(999000);
    expect(info.tokensLimit).toBe(1000000);
  });

  it('chat POSTs to /v1/chat/completions', async () => {
    const fetchMock = mockFetchResponse(openaiResponse());
    await a.chat(baseReq('gpt-oss-120b'));
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cerebras.ai/v1/chat/completions');
  });

  it('chatStream parses SSE chunks and yields them', async () => {
    const stream = sseStream([
      { data: { id: 'cc-1', model: 'qwen-3.8-27b', choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }] } },
      { data: { id: 'cc-1', model: 'qwen-3.8-27b', choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }] } },
      { data: { id: 'cc-1', model: 'qwen-3.8-27b', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
    ]);
    globalThis.fetch = vi.fn(async () => new Response(stream, {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    })) as unknown as typeof fetch;

    const out: ChatStreamChunk[] = [];
    for await (const c of a.chatStream(baseReq('qwen-3.8-27b'))) out.push(c);
    expect(out.length).toBe(3);
    expect(out[0].choices[0].delta.content).toBe('Hel');
    expect(out[1].choices[0].delta.content).toBe('lo');
    expect(out[2].choices[0].finish_reason).toBe('stop');
  });
});

// =============================================================================
// Novita
// =============================================================================

describe('NovitaAdapter', () => {
  let a: NovitaAdapter;
  beforeEach(() => { a = new NovitaAdapter('test-key'); });

  it('formatRequest defaults to deepseek/deepseek-v4.1-flash', () => {
    const out = a.formatRequest(baseReq('')) as ChatRequest;
    expect(out.model).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('parseResponse extracts content + usage', () => {
    const r = a.parseResponse(openaiResponse({ content: 'novita-says' }), 'deepseek/deepseek-v4.1-flash');
    expect(r.choices[0].message.content).toBe('novita-says');
    expect(r.usage.total_tokens).toBe(8);
  });

  it('extractRateLimitInfo parses standard headers', () => {
    const h = new Headers({
      'x-ratelimit-remaining-requests': '9',
      'x-ratelimit-limit-requests': '10',
    });
    const info = a.extractRateLimitInfo(h);
    expect(info.requestsRemaining).toBe(9);
    expect(info.requestsLimit).toBe(10);
  });

  it('chat POSTs to /openai/chat/completions', async () => {
    const fetchMock = mockFetchResponse(openaiResponse());
    await a.chat(baseReq('glm-5.3-flash'));
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.novita.ai/openai/chat/completions');
  });

  it('respects per-model base-URL overrides', async () => {
    const override = 'https://api.novita.ai/openai-finetune';
    const a2 = new NovitaAdapter('test-key', { modelBaseOverrides: { 'glm-5.3-flash': override } });
    const fetchMock = mockFetchResponse(openaiResponse());
    await a2.chat(baseReq('glm-5.3-flash'));
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${override}/chat/completions`);
  });
});
