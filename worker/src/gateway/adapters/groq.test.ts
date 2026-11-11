/**
 * Tests for the Groq adapter (multi-account, OpenAI-compatible).
 *
 * Run via vitest:
 *   cd worker && bunx vitest run src/gateway/adapters/groq.test.ts
 *
 * Pure (no live network): `globalThis.fetch` is replaced with a `vi.fn()` mock
 * so the request-shaping, response-parsing, streaming, backpressure and error
 * paths can all be exercised without hitting Groq's real API.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GroqAdapter,
  GroqError,
  type Env,
  type ProviderId,
} from './groq';

// ─── Test fixtures ──────────────────────────────────────────────────────────

const ENV: Env = {
  GROQ_KEY_1: 'gsk_test_key_1_AAAA',
  GROQ_KEY_2: 'gsk_test_key_2_BBBB',
};

/** A minimal OpenAI-shaped chat request. */
function baseReq(): Parameters<GroqAdapter['chat']>[0] {
  return {
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: 'Say hi.' },
    ],
    temperature: 0.5,
    max_tokens: 64,
    stream: false,
    // Gateway-internal field — must be stripped before reaching Groq.
    provider_options: { tag: 'test-session-42' },
  };
}

/** Build a Groq-shaped non-streaming response object. */
function groqResponse(content = 'Hello!'): Record<string, unknown> {
  return {
    id: 'chatcmpl-' + Math.random().toString(36).slice(2, 10),
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'llama-3.3-70b-versatile',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
    system_fingerprint: 'fp_groq_test',
    x_groq: { id: 'req_abc' },
  };
}

/** All Groq rate-limit headers populated. */
function fullRateLimitHeaders(): Headers {
  return new Headers({
    'x-ratelimit-limit-requests': '1000',
    'x-ratelimit-remaining-requests': '999',
    'x-ratelimit-reset-requests': '1m0s',
    'x-ratelimit-limit-tokens': '6000',
    'x-ratelimit-remaining-tokens': '5900',
    'x-ratelimit-reset-tokens': '23h59m59s',
  });
}

/** JSON response body as a Response object. */
function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

/** Encode a string into a Uint8Array (SSE bytes). */
function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ─── Mock setup ─────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GroqAdapter — identity & construction', () => {
  it('exposes a static PROVIDER_ID getter returning the canonical family id', () => {
    expect(GroqAdapter.PROVIDER_ID).toBe('groq1');
  });

  it('constructs two account-aware instances with distinct ids', () => {
    const a1 = new GroqAdapter(1);
    const a2 = new GroqAdapter(2);
    expect(a1.getAccountId()).toBe(1);
    expect(a2.getAccountId()).toBe(2);
    expect(a1.getProviderId()).toBe('groq1');
    expect(a2.getProviderId()).toBe('groq2');
    expect(a1.provider).toBe('groq1');
    expect(a2.provider).toBe('groq2');
  });

  it('reports the OpenAI-compatible base URL and chat path', () => {
    const a = new GroqAdapter(1);
    expect(a.getBaseUrl()).toBe('https://api.groq.com/openai/v1');
    expect(a.getChatCompletionsPath()).toBe('/chat/completions');
  });

  it('advertises the free-tier model list', () => {
    const models = new GroqAdapter(1).getSupportedModels();
    expect(models).toContain('qwen3-32b');
    expect(models).toContain('llama-3.3-70b-versatile');
    expect(models).toContain('openai/gpt-oss-120b');
    expect(models.length).toBeGreaterThanOrEqual(5);
  });

  it('builds Bearer auth + JSON content-type headers from the api key', () => {
    const h = new Headers(new GroqAdapter(1).getHeaders('gsk_xyz') as HeadersInit);
    expect(h.get('Authorization')).toBe('Bearer gsk_xyz');
    expect(h.get('Content-Type')).toBe('application/json');
    expect(h.get('Accept')).toBe('application/json');
  });
});

describe('GroqAdapter — formatRequest', () => {
  it('passes through OpenAI fields unchanged', () => {
    const out = new GroqAdapter(1).formatRequest(baseReq()) as Record<string, unknown>;
    expect(out.model).toBe('llama-3.3-70b-versatile');
    expect(out.temperature).toBe(0.5);
    expect(out.max_tokens).toBe(64);
    expect(Array.isArray(out.messages)).toBe(true);
    expect((out.messages as unknown[]).length).toBe(2);
  });

  it('strips the gateway-internal provider_options field', () => {
    const out = new GroqAdapter(1).formatRequest(baseReq()) as Record<string, unknown>;
    expect(out.provider_options).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(out, 'provider_options')).toBe(false);
  });

  it('does not explode on a request without provider_options', () => {
    const req = baseReq();
    delete req.provider_options;
    const out = new GroqAdapter(1).formatRequest(req) as Record<string, unknown>;
    expect(out.model).toBe('llama-3.3-70b-versatile');
  });
});

describe('GroqAdapter — parseResponse', () => {
  it('returns a valid Groq response unchanged (identity)', () => {
    const raw = groqResponse('Hi back');
    const parsed = new GroqAdapter(1).parseResponse(raw);
    expect(parsed.id).toBe(raw.id);
    expect(parsed.object).toBe('chat.completion');
    expect(parsed.choices[0].message.content).toBe('Hi back');
    expect(parsed.usage?.total_tokens).toBe(10);
  });

  it('throws GroqError 502 on a non-object body', () => {
    expect(() => new GroqAdapter(1).parseResponse(null)).toThrow(GroqError);
    expect(() => new GroqAdapter(1).parseResponse('not-an-object')).toThrow(GroqError);
    try {
      new GroqAdapter(1).parseResponse(42);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as GroqError).status).toBe(502);
      expect((e as GroqError).providerId).toBe('groq1');
    }
  });

  it('throws GroqError 502 when id or choices are missing', () => {
    expect(() => new GroqAdapter(1).parseResponse({ object: 'chat.completion' })).toThrow(GroqError);
    expect(() =>
      new GroqAdapter(1).parseResponse({ id: 'x', choices: 'nope' }),
    ).toThrow(GroqError);
  });
});

describe('GroqAdapter — parseStreamChunk edge cases', () => {
  const a = new GroqAdapter(1);
  const validChunk = 'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n';

  it('returns null for empty / whitespace input', () => {
    expect(a.parseStreamChunk('')).toBeNull();
    expect(a.parseStreamChunk('   ')).toBeNull();
    expect(a.parseStreamChunk('\n\n')).toBeNull();
  });

  it('returns null for SSE comment / keep-alive lines', () => {
    expect(a.parseStreamChunk(': ping\n\n')).toBeNull();
    expect(a.parseStreamChunk(': \n')).toBeNull();
  });

  it('returns null for the terminal [DONE] sentinel', () => {
    expect(a.parseStreamChunk('data: [DONE]\n\n')).toBeNull();
  });

  it('parses a valid data: {...} event into a DeltaChunk', () => {
    const d = a.parseStreamChunk(validChunk);
    expect(d).not.toBeNull();
    expect(d?.id).toBe('c1');
    expect(d?.object).toBe('chat.completion.chunk');
    expect(d?.choices[0].delta.content).toBe('Hi');
  });

  it('returns the FIRST event when a chunk contains multiple data: lines', () => {
    const multi = validChunk + validChunk.replace('"c1"', '"c2"');
    const d = a.parseStreamChunk(multi);
    expect(d).not.toBeNull();
    expect(d?.id).toBe('c1'); // first event wins
  });

  it('returns null for partial JSON (caller should buffer more bytes)', () => {
    const partial = 'data: {"id":"c1","object":"chat.completion.chu';
    expect(a.parseStreamChunk(partial)).toBeNull();
  });

  it('returns null when there is no data: field', () => {
    expect(a.parseStreamChunk('event: ping\nid: 1\n')).toBeNull();
  });

  it('returns null for invalid JSON payloads', () => {
    expect(a.parseStreamChunk('data: not-json\n\n')).toBeNull();
    expect(a.parseStreamChunk('data: {broken\n\n')).toBeNull();
  });

  it('returns null when payload is not a chunk-shaped object (no choices)', () => {
    expect(a.parseStreamChunk('data: {"id":"x"}\n\n')).toBeNull();
    expect(a.parseStreamChunk('data: [1,2,3]\n\n')).toBeNull();
  });

  it('tolerates leading whitespace and the data: token appearing mid-line', () => {
    const d = a.parseStreamChunk('   \r\n  data: {"id":"c9","choices":[]}\n\n');
    expect(d).not.toBeNull();
    expect(d?.id).toBe('c9');
  });
});

describe('GroqAdapter — extractRateLimitInfo', () => {
  it('reads all x-ratelimit-* headers into the QuotaState', () => {
    const info = new GroqAdapter(1).extractRateLimitInfo(fullRateLimitHeaders());
    expect(info.requestsLimit).toBe(1000);
    expect(info.requestsRemaining).toBe(999);
    expect(info.resetRequestsIn).toBe('1m0s');
    expect(info.tokensLimit).toBe(6000);
    expect(info.tokensRemaining).toBe(5900);
    expect(info.resetTokensIn).toBe('23h59m59s');
  });

  it('captures a raw header snapshot for observability', () => {
    const info = new GroqAdapter(2).extractRateLimitInfo(fullRateLimitHeaders());
    expect(info.raw).toBeDefined();
    expect(info.raw?.['x-ratelimit-remaining-requests']).toBe('999');
    expect(info.raw?.['x-ratelimit-reset-tokens']).toBe('23h59m59s');
  });

  it('leaves fields undefined when headers are absent', () => {
    const info = new GroqAdapter(1).extractRateLimitInfo(new Headers());
    expect(info.requestsRemaining).toBeUndefined();
    expect(info.tokensLimit).toBeUndefined();
    expect(info.retryAfter).toBeUndefined();
    expect(info.raw).toBeUndefined();
  });

  it('ignores non-numeric limit/remaining values gracefully', () => {
    const h = new Headers({
      'x-ratelimit-remaining-requests': 'not-a-number',
      'x-ratelimit-limit-requests': '',
    });
    const info = new GroqAdapter(1).extractRateLimitInfo(h);
    expect(info.requestsRemaining).toBeUndefined();
    expect(info.requestsLimit).toBeUndefined();
  });

  it('picks up retry-after on a 429-style header set', () => {
    const h = new Headers({ 'retry-after': '12' });
    const info = new GroqAdapter(1).extractRateLimitInfo(h);
    expect(info.retryAfter).toBe(12);
    expect(info.raw?.['retry-after']).toBe('12');
  });
});

describe('GroqAdapter — chat (non-streaming I/O)', () => {
  it('POSTs to /chat/completions with the account-1 key and stream:false', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(groqResponse('Hi!')));
    const a = new GroqAdapter(1);
    const { response, raw } = await a.chat(baseReq(), ENV);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${ENV.GROQ_KEY_1}`);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.stream).toBe(false);
    expect(body.provider_options).toBeUndefined();
    expect(body.model).toBe('llama-3.3-70b-versatile');

    expect(response.choices[0].message.content).toBe('Hi!');
    expect(raw).toBeInstanceOf(Response);
  });

  it('uses GROQ_KEY_2 for the account-2 instance', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(groqResponse()));
    await new GroqAdapter(2).chat(baseReq(), ENV);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${ENV.GROQ_KEY_2}`);
  });

  it('preserves rate-limit headers on the returned raw Response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(groqResponse()), {
        status: 200,
        headers: fullRateLimitHeaders(),
      }),
    );
    const a = new GroqAdapter(1);
    const { raw } = await a.chat(baseReq(), ENV);
    const info = a.extractRateLimitInfo(raw.headers);
    expect(info.requestsRemaining).toBe(999);
    expect(info.tokensLimit).toBe(6000);
  });
});

describe('GroqAdapter — chatStream (raw byte pass-through + backpressure)', () => {
  /** Build a pull-counted source stream emitting the given SSE strings.
   * `highWaterMark: 0` disables the ReadableStream's eager pull-on-construction
   * so the counter stays at 0 until something actually reads the stream — this
   * is what makes the backpressure assertion precise. */
  function countedSource(chunks: string[]): {
    stream: ReadableStream<Uint8Array>;
    pulls: { count: number };
  } {
    const pulls = { count: 0 };
    const queue = chunks.map(enc);
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls.count += 1;
          if (queue.length === 0) {
            controller.close();
            return;
          }
          controller.enqueue(queue.shift() as Uint8Array);
        },
      },
      { highWaterMark: 0, size: () => 1 },
    );
    return { stream, pulls };
  }

  /** Read every byte from a stream into a single string. */
  async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    let out = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    return out;
  }

  it('passes Groq SSE bytes through verbatim', async () => {
    const sse =
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}\n\n' +
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n' +
      'data: [DONE]\n\n';
    const { stream } = countedSource([sse]);
    fetchMock.mockResolvedValueOnce(new Response(stream, { status: 200 }));

    const out = new GroqAdapter(1).chatStream({ ...baseReq(), stream: true }, ENV);
    const readable = await out;
    expect(readable).toBeInstanceOf(ReadableStream);

    const text = await drain(readable);
    expect(text).toContain('"content":"Hel"');
    expect(text).toContain('"content":"lo"');
    expect(text).toContain('[DONE]');
  });

  it('applies backpressure: the upstream is NOT read until the consumer pulls', async () => {
    const sse = ['data: {"id":"a","choices":[]}\n\n', 'data: {"id":"b","choices":[]}\n\n'];
    const { stream, pulls } = countedSource(sse);
    fetchMock.mockResolvedValueOnce(new Response(stream, { status: 200 }));

    const readable = await new GroqAdapter(1).chatStream({ ...baseReq(), stream: true }, ENV);

    // No consumer read yet → source must not have been pulled at all.
    expect(pulls.count).toBe(0);

    const reader = readable.getReader();
    const r1 = await reader.read();
    expect(pulls.count).toBe(1); // exactly one pull per consumer read
    expect(new TextDecoder().decode(r1.value as Uint8Array)).toContain('"id":"a"');

    const r2 = await reader.read();
    expect(pulls.count).toBe(2);
    expect(new TextDecoder().decode(r2.value as Uint8Array)).toContain('"id":"b"');

    const r3 = await reader.read();
    expect(r3.done).toBe(true);
    expect(pulls.count).toBe(3); // third pull closes the stream
  });

  it('propagates downstream cancellation to the upstream reader', async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(enc('data: {"id":"x","choices":[]}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(source, { status: 200 }));

    const readable = await new GroqAdapter(1).chatStream({ ...baseReq(), stream: true }, ENV);
    const reader = readable.getReader();
    await reader.read(); // one chunk
    await reader.cancel('client navigated away');

    expect(cancelled).toBe(true);
  });
});

describe('GroqAdapter — listModels & healthCheck', () => {
  it('GETs /models and returns the data array', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        object: 'list',
        data: [
          { id: 'llama-3.3-70b-versatile', object: 'model', created: 1, owned_by: 'Meta' },
          { id: 'qwen3-32b', object: 'model', created: 2, owned_by: 'Alibaba' },
        ],
      }),
    );
    const models = await new GroqAdapter(1).listModels(ENV);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/models');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(models.length).toBe(2);
    expect(models[0].id).toBe('llama-3.3-70b-versatile');
  });

  it('throws GroqError 502 on a malformed /models body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ object: 'list' }));
    await expect(new GroqAdapter(1).listModels(ENV)).rejects.toMatchObject({
      name: 'GroqError',
      status: 502,
    });
  });

  it('healthCheck returns true when /models returns a non-empty list', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ object: 'list', data: [{ id: 'm1', object: 'model', created: 1, owned_by: 'x' }] }),
    );
    expect(await new GroqAdapter(1).healthCheck(ENV)).toBe(true);
  });

  it('healthCheck returns false (and swallows errors) when /models fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('up', { status: 500 }));
    expect(await new GroqAdapter(1).healthCheck(ENV)).toBe(false);
  });

  it('healthCheck returns false when the list is empty', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ object: 'list', data: [] }));
    expect(await new GroqAdapter(1).healthCheck(ENV)).toBe(false);
  });
});

describe('GroqAdapter — error handling (status + message preserved)', () => {
  it('surfaces a 429 with the upstream body and marks it retryable', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'retry-after': '30' },
      }),
    );
    try {
      await new GroqAdapter(1).chat(baseReq(), ENV);
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as GroqError;
      expect(err).toBeInstanceOf(GroqError);
      expect(err.status).toBe(429);
      expect(err.retryable).toBe(true);
      expect(err.providerId).toBe('groq1');
      expect(err.upstreamBody).toContain('Rate limit exceeded');
      expect(err.message).toContain('429');
    }
  });

  it('surfaces a 5xx as retryable', async () => {
    fetchMock.mockResolvedValueOnce(new Response('internal groq error', { status: 503 }));
    try {
      await new GroqAdapter(2).chat(baseReq(), ENV);
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as GroqError;
      expect(err.status).toBe(503);
      expect(err.retryable).toBe(true);
      expect(err.providerId).toBe('groq2');
      expect(err.upstreamBody).toBe('internal groq error');
    }
  });

  it('surfaces a 4xx (non-429) as non-retryable', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad model', { status: 400 }));
    try {
      await new GroqAdapter(1).listModels(ENV);
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as GroqError;
      expect(err.status).toBe(400);
      expect(err.retryable).toBe(false);
    }
  });

  it('wraps network failures (fetch throws) as GroqError status 0 / retryable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('failed to fetch (DNS)'));
    try {
      await new GroqAdapter(1).chatStream({ ...baseReq(), stream: true }, ENV);
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as GroqError;
      expect(err.status).toBe(0);
      expect(err.retryable).toBe(true);
      expect(err.message).toContain('network error');
    }
  });

  it('throws a non-retryable 401 GroqError when the account key is missing', async () => {
    const env: Env = { GROQ_KEY_1: '', GROQ_KEY_2: ENV.GROQ_KEY_2 };
    try {
      await new GroqAdapter(1).chat(baseReq(), env);
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as GroqError;
      expect(err.status).toBe(401);
      expect(err.retryable).toBe(false);
      expect(err.message).toContain('GROQ_KEY_1');
    }
  });

  it('throws a non-retryable 401 GroqError when the account key is whitespace', async () => {
    const env: Env = { GROQ_KEY_1: ENV.GROQ_KEY_1, GROQ_KEY_2: '   ' };
    try {
      await new GroqAdapter(2).listModels(env);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as GroqError).status).toBe(401);
      expect((e as GroqError).message).toContain('GROQ_KEY_2');
    }
  });
});

describe('GroqAdapter — type guards', () => {
  it('GroqError is an Error subclass carrying all metadata', () => {
    const err = new GroqError('groq1', 500, 'boom', {
      upstreamBody: 'body',
      cause: new Error('root'),
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.providerId).toBe('groq1');
    expect(err.status).toBe(500);
    expect(err.retryable).toBe(true);
    expect(err.upstreamBody).toBe('body');
    expect(err.cause).toBeInstanceOf(Error);
    expect(err.name).toBe('GroqError');
  });

  it('default retryable is false for 4xx and true for 5xx/429', () => {
    expect(new GroqError('groq1', 400, 'x').retryable).toBe(false);
    expect(new GroqError('groq1', 404, 'x').retryable).toBe(false);
    expect(new GroqError('groq1', 429, 'x').retryable).toBe(true);
    expect(new GroqError('groq1', 500, 'x').retryable).toBe(true);
    expect(new GroqError('groq1', 503, 'x').retryable).toBe(true);
  });
});
