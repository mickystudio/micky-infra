/**
 * Tests for the Gemini provider adapter.
 *
 * Run via vitest:
 *   cd worker && bunx vitest run src/gateway/adapters/gemini.test.ts
 *
 * All tests are pure (no live network). `globalThis.fetch` is mocked with
 * `vi.fn()` so the request-shaping and response-parsing paths can be
 * exercised end-to-end without hitting Google's real Generative Language API.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GeminiAdapter,
  GeminiApiError,
  GeminiRateLimitError,
  geminiAdapter,
} from './gemini';
import type { ChatRequest, ChatResponse, DeltaChunk } from './types';

// ─── Helpers ────────────────────────────────────────────────────────────────

function baseReq(model: string, userText = 'Hi'): ChatRequest {
  return {
    model,
    messages: [{ role: 'user', content: userText }],
    temperature: 0.5,
    max_tokens: 100,
  };
}

/** Build a Gemini generateContent-style response object. */
function geminiResponse(opts: {
  text?: string;
  finishReason?: string;
  functionCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  promptTokens?: number;
  candidatesTokens?: number;
  totalTokens?: number;
}): unknown {
  const parts: unknown[] = [];
  if (typeof opts.text === 'string') parts.push({ text: opts.text });
  for (const fc of opts.functionCalls ?? []) parts.push({ functionCall: fc });
  return {
    candidates: [
      {
        content: { role: 'model', parts },
        finishReason: opts.finishReason ?? 'STOP',
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: opts.promptTokens ?? 10,
      candidatesTokenCount: opts.candidatesTokens ?? 5,
      totalTokenCount: opts.totalTokens ?? 15,
    },
    modelVersion: 'gemini-1.5-flash',
  };
}

/** Build a Response that resolves to `body`. */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** Build a streaming Response whose body yields `chunks` as SSE. */
function sseResponse(chunks: unknown[], status = 200, headers: Record<string, string> = {}): Response {
  const payload = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream', ...headers } });
}

/** Cast the result of `formatRequest` to a typed view for assertions. */
interface GeminiRequestBodyView {
  contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  system_instruction?: { parts: Array<{ text: string }> };
  tools?: Array<{ functionDeclarations: Array<{ name: string; description?: string }> }>;
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    stopSequences?: string[];
  };
}
function asBody(out: Record<string, unknown>): GeminiRequestBodyView {
  return out as unknown as GeminiRequestBodyView;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GeminiAdapter — formatRequest', () => {
  it('converts a simple user message to contents[user].parts[{text}]', () => {
    const out = asBody(geminiAdapter.formatRequest(baseReq('gemini-1.5-flash', 'Hello')));
    expect(out.contents).toHaveLength(1);
    expect(out.contents[0].role).toBe('user');
    expect(out.contents[0].parts[0]).toEqual({ text: 'Hello' });
    expect(out.system_instruction).toBeUndefined();
  });

  it('extracts system message into system_instruction (NOT into contents)', () => {
    const req: ChatRequest = {
      model: 'gemini-1.5-flash',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hi' },
      ],
    };
    const out = asBody(geminiAdapter.formatRequest(req));
    expect(out.contents).toHaveLength(1);
    expect(out.contents[0].role).toBe('user');
    expect(out.system_instruction).toEqual({ parts: [{ text: 'You are a helpful assistant.' }] });
  });

  it('accumulates multiple system messages into one system_instruction', () => {
    const req: ChatRequest = {
      model: 'gemini-1.5-flash',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'system', content: 'Use Arabic.' },
        { role: 'user', content: 'Hi' },
      ],
    };
    const out = asBody(geminiAdapter.formatRequest(req));
    expect(out.system_instruction?.parts[0].text).toBe('Be concise.\n\nUse Arabic.');
  });

  it('maps assistant role to model in multi-turn conversation', () => {
    const req: ChatRequest = {
      model: 'gemini-1.5-flash',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'How are you?' },
      ],
    };
    const out = asBody(geminiAdapter.formatRequest(req));
    expect(out.contents).toHaveLength(3);
    expect(out.contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    expect(out.contents[1].parts[0]).toEqual({ text: 'Hi there' });
  });

  it('converts OpenAI tools to Gemini functionDeclarations', () => {
    const req: ChatRequest = {
      model: 'gemini-1.5-flash',
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather for a city',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ],
    };
    const out = asBody(geminiAdapter.formatRequest(req));
    expect(out.tools).toHaveLength(1);
    expect(out.tools?.[0].functionDeclarations[0].name).toBe('get_weather');
    expect(out.tools?.[0].functionDeclarations[0].description).toBe('Get weather for a city');
  });

  it('maps max_tokens → maxOutputTokens, temperature, stop sequences', () => {
    const req: ChatRequest = {
      model: 'gemini-1.5-flash',
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0.7,
      max_tokens: 256,
      top_p: 0.9,
      stop: ['END', 'STOP'],
    };
    const out = asBody(geminiAdapter.formatRequest(req));
    expect(out.generationConfig).toEqual({
      temperature: 0.7,
      maxOutputTokens: 256,
      topP: 0.9,
      stopSequences: ['END', 'STOP'],
    });
  });

  it('converts assistant tool_calls to functionCall parts', () => {
    const req: ChatRequest = {
      model: 'gemini-1.5-flash',
      messages: [
        { role: 'user', content: 'weather in Cairo?' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Cairo"}' },
            },
          ],
        },
      ],
    };
    const out = asBody(geminiAdapter.formatRequest(req));
    expect(out.contents[1].role).toBe('model');
    expect(out.contents[1].parts[0]).toEqual({
      functionCall: { name: 'get_weather', args: { city: 'Cairo' } },
    });
  });

  it('converts tool result messages to functionResponse under user role', () => {
    const req: ChatRequest = {
      model: 'gemini-1.5-flash',
      messages: [
        { role: 'user', content: 'weather in Cairo?' },
        { role: 'assistant', content: '', tool_call_id: 'call_1' },
        {
          role: 'tool',
          content: '{"temperature":25}',
          tool_call_id: 'call_1',
          name: 'get_weather',
        },
      ],
    };
    const out = asBody(geminiAdapter.formatRequest(req));
    const toolMsg = out.contents[2];
    expect(toolMsg.role).toBe('user');
    expect(toolMsg.parts[0]).toEqual({
      functionResponse: { name: 'get_weather', response: { temperature: 25 } },
    });
  });
});

describe('GeminiAdapter — parseResponse', () => {
  it('converts text content + STOP finishReason to OpenAI choice', () => {
    const raw = geminiResponse({ text: 'Hello back', finishReason: 'STOP' });
    const res = geminiAdapter.parseResponse(raw) as ChatResponse;
    expect(res.object).toBe('chat.completion');
    expect(res.choices[0].message.content).toBe('Hello back');
    expect(res.choices[0].finish_reason).toBe('stop');
    expect(res.choices[0].message.role).toBe('assistant');
  });

  it('maps MAX_TOKENS → length', () => {
    const res = geminiAdapter.parseResponse(geminiResponse({ text: 'cut', finishReason: 'MAX_TOKENS' }));
    expect(res.choices[0].finish_reason).toBe('length');
  });

  it('maps SAFETY / RECITATION → content_filter', () => {
    for (const reason of ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT']) {
      const res = geminiAdapter.parseResponse(geminiResponse({ finishReason: reason }));
      expect(res.choices[0].finish_reason).toBe('content_filter');
    }
  });

  it('maps usageMetadata → usage (prompt/completion/total tokens)', () => {
    const res = geminiAdapter.parseResponse(
      geminiResponse({ text: 'x', promptTokens: 12, candidatesTokens: 7, totalTokens: 19 }),
    );
    expect(res.usage).toEqual({ prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 });
  });

  it('converts functionCall parts to OpenAI tool_calls + sets finish_reason=tool_calls', () => {
    const raw = geminiResponse({
      text: undefined,
      finishReason: 'STOP',
      functionCalls: [{ name: 'get_weather', args: { city: 'Cairo' } }],
    });
    const res = geminiAdapter.parseResponse(raw) as ChatResponse;
    expect(res.choices[0].finish_reason).toBe('tool_calls');
    expect(res.choices[0].message.tool_calls).toHaveLength(1);
    expect(res.choices[0].message.tool_calls?.[0].function.name).toBe('get_weather');
    expect(JSON.parse(res.choices[0].message.tool_calls?.[0].function.arguments ?? '{}')).toEqual({ city: 'Cairo' });
  });

  it('returns empty content when candidates array is missing', () => {
    const res = geminiAdapter.parseResponse({}) as ChatResponse;
    expect(res.choices[0].message.content).toBe('');
    expect(res.choices[0].finish_reason).toBe('stop');
    expect(res.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });
});

describe('GeminiAdapter — parseStreamChunk', () => {
  it('parses a data: {json} line and returns a DeltaChunk with content', () => {
    const line = 'data: ' + JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: 'Hel' }] }, finishReason: 'STOP' }],
      modelVersion: 'gemini-1.5-flash',
    });
    const delta = geminiAdapter.parseStreamChunk(line) as DeltaChunk;
    expect(delta).not.toBeNull();
    expect(delta.choices[0].delta.content).toBe('Hel');
    expect(delta.model).toBe('gemini-1.5-flash');
  });

  it('parses a chunk WITHOUT the data: prefix', () => {
    const line = JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: 'lo' }] } }],
    });
    const delta = geminiAdapter.parseStreamChunk(line) as DeltaChunk;
    expect(delta.choices[0].delta.content).toBe('lo');
  });

  it('returns null for [DONE]', () => {
    expect(geminiAdapter.parseStreamChunk('data: [DONE]')).toBeNull();
    expect(geminiAdapter.parseStreamChunk('[DONE]')).toBeNull();
  });

  it('returns null for empty / non-JSON lines', () => {
    expect(geminiAdapter.parseStreamChunk('')).toBeNull();
    expect(geminiAdapter.parseStreamChunk(': keep-alive')).toBeNull();
    expect(geminiAdapter.parseStreamChunk('data: not-json')).toBeNull();
  });

  it('returns null for chunks with no candidates (e.g. usageMetadata-only)', () => {
    const line = 'data: ' + JSON.stringify({ usageMetadata: { totalTokenCount: 42 } });
    expect(geminiAdapter.parseStreamChunk(line)).toBeNull();
  });

  it('emits tool_calls deltas when a functionCall part arrives mid-stream', () => {
    const line = 'data: ' + JSON.stringify({
      candidates: [{
        content: { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'NYC' } } }] },
        finishReason: 'STOP',
      }],
    });
    const delta = geminiAdapter.parseStreamChunk(line) as DeltaChunk;
    expect(delta.choices[0].delta.tool_calls).toHaveLength(1);
    expect(delta.choices[0].delta.tool_calls?.[0]?.function?.name).toBe('get_weather');
  });
});

describe('GeminiAdapter — extractRateLimitInfo', () => {
  it('returns empty object when Gemini omits rate-limit headers', () => {
    const headers = new Headers({ 'content-type': 'application/json' });
    const info = geminiAdapter.extractRateLimitInfo(headers);
    expect(info.retryAfter).toBeUndefined();
    expect(info.raw).toBeUndefined();
  });

  it('parses retry-after (seconds) when present (429 case)', () => {
    const headers = new Headers({ 'retry-after': '30' });
    const info = geminiAdapter.extractRateLimitInfo(headers);
    expect(info.retryAfter).toBe(30);
    expect(info.raw?.['retry-after']).toBe('30');
  });
});

describe('GeminiAdapter — chat (mocked fetch)', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('POSTs to generateContent with x-goog-api-key header and parses response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(geminiResponse({ text: 'Hi from Gemini', finishReason: 'STOP' })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await geminiAdapter.chat(baseReq('gemini-1.5-flash', 'Hi'), 'TEST_KEY');
    expect(res.choices[0].message.content).toBe('Hi from Gemini');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/models/gemini-1.5-flash:generateContent');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('TEST_KEY');

    // Body should be Gemini-shaped (contents, no top-level messages).
    const body = JSON.parse(init.body as string) as { contents: unknown[] };
    expect(Array.isArray(body.contents)).toBe(true);
  });

  it('throws GeminiRateLimitError on 429 RESOURCE_EXHAUSTED', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ error: { code: 429, message: 'RESOURCE_EXHAUSTED' } }, 429, { 'retry-after': '15' }),
    ) as unknown as typeof fetch;

    await expect(geminiAdapter.chat(baseReq('gemini-1.5-flash'), 'K')).rejects.toMatchObject({
      name: 'GeminiRateLimitError',
      status: 429,
      retryAfter: 15,
    });
    await expect(geminiAdapter.chat(baseReq('gemini-1.5-flash'), 'K')).rejects.toBeInstanceOf(GeminiRateLimitError);
  });

  it('throws GeminiApiError on non-429 non-2xx status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'bad request' } }, 400),
    ) as unknown as typeof fetch;

    await expect(geminiAdapter.chat(baseReq('gemini-1.5-flash'), 'K')).rejects.toMatchObject({
      name: 'GeminiApiError',
      status: 400,
    });
  });

  it('chatStream yields parsed delta chunks in order and resolves on [DONE]', async () => {
    const chunks = [
      { candidates: [{ content: { role: 'model', parts: [{ text: 'Hello' }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: ' world' }] } }] },
      { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }] },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(sseResponse(chunks)) as unknown as typeof fetch;

    const deltas: DeltaChunk[] = [];
    for await (const d of geminiAdapter.chatStream(baseReq('gemini-1.5-flash'), 'K')) {
      deltas.push(d);
    }
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas[0].choices[0].delta.content).toBe('Hello');
    expect(deltas[1].choices[0].delta.content).toBe(' world');
  });

  it('chatStream throws GeminiRateLimitError on 429', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ error: 'RESOURCE_EXHAUSTED' }, 429, { 'retry-after': '5' }),
    ) as unknown as typeof fetch;

    await expect(async () => {
      for await (const _ of geminiAdapter.chatStream(baseReq('gemini-1.5-flash'), 'K')) {
        void _;
      }
    }).rejects.toBeInstanceOf(GeminiRateLimitError);
  });
});

describe('GeminiAdapter — listModels / healthCheck (mocked fetch)', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('listModels strips the models/ prefix from each name', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ models: [{ name: 'models/gemini-1.5-flash' }, { name: 'models/gemini-1.5-pro' }] }),
    ) as unknown as typeof fetch;

    const models = await geminiAdapter.listModels('K');
    expect(models).toEqual(['gemini-1.5-flash', 'gemini-1.5-pro']);
  });

  it('healthCheck returns true when listModels succeeds', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ models: [{ name: 'models/gemini-1.5-flash' }] })) as unknown as typeof fetch;
    expect(await geminiAdapter.healthCheck('K')).toBe(true);
  });

  it('healthCheck returns false when listModels throws', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ error: 'unauth' }, 401)) as unknown as typeof fetch;
    expect(await geminiAdapter.healthCheck('BAD_KEY')).toBe(false);
  });
});

describe('GeminiAdapter — identity & URL builders', () => {
  it('exposes provider id and base url', () => {
    expect(geminiAdapter.provider).toBe('gemini');
    expect(geminiAdapter.getBaseUrl()).toBe('https://generativelanguage.googleapis.com/v1beta');
  });

  it('builds non-stream URL with generateContent method', () => {
    expect(geminiAdapter.buildChatUrl('gemini-1.5-flash')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',
    );
  });

  it('builds stream URL with streamGenerateContent?alt=sse', () => {
    const url = geminiAdapter.buildStreamUrl('gemini-1.5-flash');
    expect(url).toContain(':streamGenerateContent');
    expect(url).toContain('alt=sse');
  });

  it('instantiable as a fresh class (no shared state)', () => {
    const a = new GeminiAdapter();
    expect(a).toBeInstanceOf(GeminiAdapter);
    expect(a.provider).toBe('gemini');
  });
});
