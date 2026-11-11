/**
 * Tests for the Mistral adapter.
 *
 * Run via vitest:
 *   cd worker && bunx vitest run src/gateway/adapters/mistral.test.ts
 *
 * These tests are pure (no live network). Where fetch is needed, we install
 * a `vi.fn()` mock on `globalThis.fetch` so the request-shape and the
 * response-parsing paths can be exercised end-to-end without hitting
 * Mistral's real API.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MistralAdapter, mistralAdapter } from './mistral';
import type {
  ChatRequest,
  ChatResponse,
  DeltaChunk,
  RateLimitInfo,
} from './types';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal chat request. */
function baseReq(model: string, system?: string, userText = 'Hi'): ChatRequest {
  const messages = system
    ? [
        { role: 'system' as const, content: system },
        { role: 'user' as const, content: userText },
      ]
    : [{ role: 'user' as const, content: userText }];
  return { model, messages, temperature: 0.5, max_tokens: 100 };
}

/** Cast a record into the wire-shape request that formatRequest returns. */
function asReq(out: Record<string, unknown>): {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  safe_prompt: boolean;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: unknown[];
  stop?: string | string[];
  random_seed?: number;
  response_format?: { type: 'json_object' | 'text' };
} {
  return out as unknown as ReturnType<typeof asReq>;
}

/** Build a Mistral-style JSON response object. */
function mistralResponse(opts: {
  model?: string;
  content?: string;
  warnings?: Array<{ type?: string; message?: string }>;
}): Record<string, unknown> {
  const id = 'cmpl-' + Math.random().toString(36).slice(2, 10);
  return {
    id,
    object: 'chat.completion',
    created: 1_700_000_000,
    model: opts.model ?? 'mistral-small-latest',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: opts.content ?? 'Hello!' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    ...(opts.warnings !== undefined && { warnings: opts.warnings }),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('MistralAdapter — identity & wiring', () => {
  it('exposes provider id, base URL, and path', () => {
    expect(mistralAdapter.provider).toBe('mistral');
    expect(mistralAdapter.getBaseUrl()).toBe('https://api.mistral.ai/v1');
    expect(mistralAdapter.getChatCompletionsPath()).toBe('/chat/completions');
  });

  it('lists the expected supported models', () => {
    const models = mistralAdapter.getSupportedModels();
    expect(models).toContain('mistral-large-latest');
    expect(models).toContain('open-mixtral-8x7b');
    expect(models).toContain('codestral-latest');
    expect(models).toContain('open-mistral-7b');
  });

  it('builds Bearer auth + JSON content headers', () => {
    const h = new Headers(mistralAdapter.getHeaders('test-key-123'));
    expect(h.get('Authorization')).toBe('Bearer test-key-123');
    expect(h.get('Content-Type')).toBe('application/json');
    expect(h.get('Accept')).toBe('application/json');
  });
});

// ─── formatRequest — system message handling ─────────────────────────────────

describe('MistralAdapter.formatRequest — system message handling', () => {
  it('preserves system role for new models (mistral-large-latest)', () => {
    const out = asReq(mistralAdapter.formatRequest(
      baseReq('mistral-large-latest', 'Be terse.', 'Hi'),
    ));
    expect(out.model).toBe('mistral-large-latest');
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0].role).toBe('system');
    expect(out.messages[0].content).toBe('Be terse.');
    expect(out.messages[1].role).toBe('user');
    expect(out.messages[1].content).toBe('Hi');
  });

  it('preserves system role for open-mixtral-8x22b (newer Mixtral)', () => {
    const out = asReq(mistralAdapter.formatRequest(
      baseReq('open-mixtral-8x22b', 'Be terse.', 'Hi'),
    ));
    expect(out.messages[0].role).toBe('system');
    expect(out.messages[1].role).toBe('user');
  });

  it('FOLDS the leading system message into the first user message for open-mixtral-8x7b', () => {
    const out = asReq(mistralAdapter.formatRequest(
      baseReq('open-mixtral-8x7b', 'You are a pirate.', 'Ahoy'),
    ));
    // System message is GONE — only the user message remains.
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].role).toBe('user');
    // System content prepended with blank-line separator.
    expect(out.messages[0].content).toBe('You are a pirate.\n\nAhoy');
  });

  it('FOLDS system message for open-mistral-7b too', () => {
    const out = asReq(mistralAdapter.formatRequest(
      baseReq('open-mistral-7b', 'S', 'U'),
    ));
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].role).toBe('user');
    expect(out.messages[0].content).toBe('S\n\nU');
  });

  it('drops the system message with no user message to fold into', () => {
    const req: ChatRequest = {
      model: 'open-mistral-7b',
      messages: [
        { role: 'system', content: 'system-only' },
        { role: 'assistant', content: 'previous' },
      ],
    };
    const out = asReq(mistralAdapter.formatRequest(req));
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].role).toBe('assistant');
  });

  it('passes through when no system message is present on old models', () => {
    const out = asReq(mistralAdapter.formatRequest(
      baseReq('open-mistral-7b'),
    ));
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].role).toBe('user');
    expect(out.messages[0].content).toBe('Hi');
  });

  it('default safe_prompt to false when unspecified', () => {
    const out = asReq(mistralAdapter.formatRequest(baseReq('mistral-small-latest')));
    expect(out.safe_prompt).toBe(false);
  });

  it('honors an explicit safe_prompt: true', () => {
    const req = baseReq('mistral-small-latest');
    req.safe_prompt = true;
    const out = asReq(mistralAdapter.formatRequest(req));
    expect(out.safe_prompt).toBe(true);
  });

  it('forwards optional params only when set', () => {
    const req: ChatRequest = {
      model: 'mistral-large-latest',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.1,
      max_tokens: 50,
      top_p: 0.9,
      stream: true,
      stop: ['END'],
      random_seed: 42,
      response_format: { type: 'json_object' },
    };
    const out = asReq(mistralAdapter.formatRequest(req));
    expect(out.temperature).toBe(0.1);
    expect(out.max_tokens).toBe(50);
    expect(out.stream).toBe(true);
    expect(out.stop).toEqual(['END']);
    expect(out.random_seed).toBe(42);
    expect(out.response_format).toEqual({ type: 'json_object' });
  });

  it('omits optional params entirely when unset (Mistral 400s on unknown fields)', () => {
    // Minimal request — no temperature / max_tokens / stream / stop / etc.
    const out = asReq(mistralAdapter.formatRequest({
      model: 'mistral-small-latest',
      messages: [{ role: 'user', content: 'Hi' }],
    }));
    expect(out.temperature).toBeUndefined();
    expect(out.max_tokens).toBeUndefined();
    expect(out.stream).toBeUndefined();
    expect(out.stop).toBeUndefined();
    expect(out.random_seed).toBeUndefined();
    expect(out.response_format).toBeUndefined();
  });
});

// ─── parseStreamChunk ─────────────────────────────────────────────────────────

describe('MistralAdapter.parseStreamChunk — OpenAI SSE shape', () => {
  it('parses a normal data: line into a DeltaChunk', () => {
    const chunk =
      'data: {"id":"x","object":"chat.completion.chunk","created":1,' +
      '"model":"mistral-small-latest","choices":[{"index":0,' +
      '"delta":{"content":"Hello"},"finish_reason":null}]}\n\n';
    const parsed = mistralAdapter.parseStreamChunk(chunk) as DeltaChunk;
    expect(parsed).not.toBeNull();
    expect(parsed.id).toBe('x');
    expect(parsed.object).toBe('chat.completion.chunk');
    expect(parsed.choices).toHaveLength(1);
    expect(parsed.choices[0].delta.content).toBe('Hello');
    expect(parsed.choices[0].finish_reason).toBeNull();
  });

  it('returns a done marker on [DONE]', () => {
    const parsed = mistralAdapter.parseStreamChunk('data: [DONE]\n\n') as DeltaChunk;
    expect(parsed).not.toBeNull();
    expect(parsed.done).toBe(true);
  });

  it('returns null for keep-alive / empty chunks', () => {
    expect(mistralAdapter.parseStreamChunk('')).toBeNull();
    expect(mistralAdapter.parseStreamChunk(': keep-alive\n\n')).toBeNull();
    expect(mistralAdapter.parseStreamChunk('\n\n')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(
      mistralAdapter.parseStreamChunk('data: {not json}\n\n'),
    ).toBeNull();
  });

  it('handles multiple data: lines, returning the first parseable one', () => {
    const chunk =
      'data: {"id":"a","choices":[{"index":0,"delta":{"content":"A"},"finish_reason":null}]}\n' +
      'data: {"id":"b","choices":[{"index":0,"delta":{"content":"B"},"finish_reason":null}]}\n\n';
    const parsed = mistralAdapter.parseStreamChunk(chunk) as DeltaChunk;
    expect(parsed.id).toBe('a');
    expect(parsed.choices[0].delta.content).toBe('A');
  });

  it('tolerates \\r\\n line endings', () => {
    const chunk = 'data: {"id":"y","choices":[{"index":0,"delta":{"content":"x"},"finish_reason":null}]}\r\n\r\n';
    const parsed = mistralAdapter.parseStreamChunk(chunk) as DeltaChunk;
    expect(parsed.id).toBe('y');
    expect(parsed.choices[0].delta.content).toBe('x');
  });
});

// ─── parseResponse — warning capture ────────────────────────────────────────

describe('MistralAdapter.parseResponse — warnings', () => {
  it('passes through standard OpenAI-shape responses', () => {
    const raw = mistralResponse({ content: 'Hi there' });
    const rawId = raw.id as string;
    const res = mistralAdapter.parseResponse(raw) as ChatResponse;
    expect(res.id).toBe(rawId);
    expect(res.choices[0].message.content).toBe('Hi there');
    expect(res.usage?.total_tokens).toBe(7);
    expect(res.warnings).toBeUndefined();
  });

  it('captures the warnings field when Mistral returns one', () => {
    const raw = mistralResponse({
      content: 'ok',
      warnings: [
        { type: 'unsupported_param', message: 'tool_choice not supported for this model' },
      ],
    });
    const res = mistralAdapter.parseResponse(raw) as ChatResponse;
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings?.[0].message).toBe(
      'tool_choice not supported for this model',
    );
    expect(res.warnings?.[0].type).toBe('unsupported_param');
  });

  it('captures multiple warnings', () => {
    const raw = mistralResponse({
      warnings: [
        { message: 'a' },
        { message: 'b' },
      ],
    });
    const res = mistralAdapter.parseResponse(raw) as ChatResponse;
    expect(res.warnings).toHaveLength(2);
  });

  it('throws on non-object input', () => {
    expect(() => mistralAdapter.parseResponse('not-an-object')).toThrow();
    expect(() => mistralAdapter.parseResponse(null)).toThrow();
  });
});

// ─── extractRateLimitInfo — including the 429 case ────────────────────────────

describe('MistralAdapter.extractRateLimitInfo — including 429 retry-after', () => {
  it('reads x-ratelimit-* headers when present', () => {
    const h = new Headers({
      'x-ratelimit-remaining-requests': '12',
      'x-ratelimit-remaining-tokens': '8400',
      'x-ratelimit-limit-requests': '50',
      'x-ratelimit-limit-tokens': '10000',
      'x-ratelimit-reset-requests': '8s',
    });
    const info = mistralAdapter.extractRateLimitInfo(h) as RateLimitInfo;
    expect(info.requestsRemaining).toBe(12);
    expect(info.tokensRemaining).toBe(8400);
    expect(info.requestsLimit).toBe(50);
    expect(info.tokensLimit).toBe(10000);
    expect(info.resetRequestsIn).toBe('8s');
    expect(info.retryAfter).toBeUndefined();
  });

  it('reads retry-after on a 429 response', () => {
    // This is the canonical 429-from-Mistral header set.
    const h = new Headers({
      'content-type': 'application/json',
      'retry-after': '30',
      'x-ratelimit-remaining-requests': '0',
      'x-ratelimit-remaining-tokens': '0',
    });
    const info = mistralAdapter.extractRateLimitInfo(h) as RateLimitInfo;
    expect(info.retryAfter).toBe(30);
    expect(info.requestsRemaining).toBe(0);
    expect(info.tokensRemaining).toBe(0);
    // raw snapshot includes the headers we saw.
    expect(info.raw?.['retry-after']).toBe('30');
  });

  it('handles a missing-retry-after 429 gracefully', () => {
    const h = new Headers({
      'x-ratelimit-remaining-requests': '0',
    });
    const info = mistralAdapter.extractRateLimitInfo(h) as RateLimitInfo;
    expect(info.retryAfter).toBeUndefined();
    expect(info.requestsRemaining).toBe(0);
  });

  it('returns an empty object when no rate-limit headers are present', () => {
    const h = new Headers({ 'content-type': 'application/json' });
    const info = mistralAdapter.extractRateLimitInfo(h) as RateLimitInfo;
    expect(info.requestsRemaining).toBeUndefined();
    expect(info.tokensRemaining).toBeUndefined();
    expect(info.retryAfter).toBeUndefined();
    expect(info.raw).toBeUndefined();
  });

  it('ignores non-numeric header values without throwing', () => {
    const h = new Headers({
      'retry-after': 'not-a-number',
      'x-ratelimit-remaining-requests': 'abc',
    });
    const info = mistralAdapter.extractRateLimitInfo(h) as RateLimitInfo;
    expect(info.retryAfter).toBeUndefined();
    expect(info.requestsRemaining).toBeUndefined();
  });
});

// ─── Mocked-fetch integration: end-to-end via adapter ──────────────────────

/**
 * The adapter itself never calls fetch — the gateway layer does. These tests
 * demonstrate the intended usage: format request with the adapter, mock fetch,
 * parse the returned body with the adapter. Verifies request shape + a 429.
 */
describe('MistralAdapter — mocked fetch integration', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends a correctly-shaped POST and parses a 200 response', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      // Verify the adapter-shaped request that the gateway would send.
      expect(String(url)).toBe('https://api.mistral.ai/v1/chat/completions');
      expect(init?.method).toBe('POST');
      const auth = new Headers(init?.headers).get('Authorization');
      expect(auth).toBe('Bearer test-key');

      const body = JSON.parse(String(init?.body)) as { model: string; safe_prompt: boolean };
      expect(body.model).toBe('mistral-small-latest');
      expect(body.safe_prompt).toBe(false);

      return new Response(JSON.stringify(mistralResponse({ content: 'pong' })), {
        status: 200,
        headers: {
          'x-ratelimit-remaining-requests': '49',
          'x-ratelimit-remaining-tokens': '9990',
          'content-type': 'application/json',
        },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Simulate the gateway path: format → fetch → parse.
    const req = baseReq('mistral-small-latest', 'system', 'ping');
    const wire = mistralAdapter.formatRequest(req);
    const res = await fetch(
      mistralAdapter.getBaseUrl() + mistralAdapter.getChatCompletionsPath(),
      {
        method: 'POST',
        headers: mistralAdapter.getHeaders('test-key'),
        body: JSON.stringify(wire),
      },
    );
    const parsed = mistralAdapter.parseResponse(await res.json()) as ChatResponse;
    expect(parsed.choices[0].message.content).toBe('pong');
    const rl = mistralAdapter.extractRateLimitInfo(res.headers);
    expect(rl.requestsRemaining).toBe(49);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('parses a 429 response and extracts retry-after', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ message: 'Too many requests', type: 'rate_limit_exceeded' }),
        {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'retry-after': '45',
            'x-ratelimit-remaining-requests': '0',
            'x-ratelimit-remaining-tokens': '0',
            'x-ratelimit-reset-requests': '45s',
          },
        },
      );
    }) as unknown as typeof fetch;

    const res = await fetch(
      mistralAdapter.getBaseUrl() + mistralAdapter.getChatCompletionsPath(),
      {
        method: 'POST',
        headers: mistralAdapter.getHeaders('test-key'),
        body: JSON.stringify(
          mistralAdapter.formatRequest(baseReq('mistral-small-latest')),
        ),
      },
    );

    expect(res.status).toBe(429);
    const rl = mistralAdapter.extractRateLimitInfo(res.headers);
    expect(rl.retryAfter).toBe(45);
    expect(rl.requestsRemaining).toBe(0);
    expect(rl.tokensRemaining).toBe(0);
    expect(rl.resetRequestsIn).toBe('45s');
  });
});
