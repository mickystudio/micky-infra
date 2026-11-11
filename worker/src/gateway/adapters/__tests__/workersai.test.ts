/**
 * WorkersAIAdapter — unit tests (Agent A6-retry).
 *
 * Run with:  bunx vitest run src/gateway/adapters/__tests__/workersai.test.ts
 *
 * These tests are pure (no real Workers AI binding, no real network):
 *   • formatRequest: pass-through
 *   • parseResponse: CF { response } → OpenAI { choices[0].message.content }
 *   • parseStreamChunk: CF SSE → OpenAI ChatStreamChunk translation
 *   • chat:        mocked env.AI binding returns { response }
 *   • chatStream:  mocked global fetch returns CF-shaped SSE frames → OpenAI ChatStreamChunks
 *                  (exercises the TransformStream conversion)
 *   • healthCheck: mocked env.AI.run success / failure
 *
 * Agent A6-retry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WorkersAIAdapter,
  WORKERSAI_BASE_URL,
  WORKERSAI_HEALTH_MODEL,
  WORKERSAI_HEALTH_TIMEOUT_MS,
  WORKERSAI_MODELS,
  CF_ACCOUNT_ID_ENV,
  CF_API_TOKEN_ENV,
  workersaiAdapter,
  type WorkersAIEnv,
} from '../workersai';
import type { ChatRequest, ChatStreamChunk } from '../_types';

// ---- helpers ---------------------------------------------------------------

/**
 * Build a fake `env.AI` binding whose `run` method delegates to `impl`.
 * Typed as `Ai & { run: MockFn }` so `ai.run(model, input)` satisfies the
 * real `Ai` overload AND `ai.run.mock` is accessible for assertions.
 */
type AiMock = Ai & { run: ReturnType<typeof vi.fn> };

function mockAi(
  impl: (model: string, inputs: Record<string, unknown>) => unknown | Promise<unknown>,
): AiMock {
  return { run: vi.fn(impl) } as unknown as AiMock;
}

/** Encode `s` as a Uint8Array. */
function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Build a minimal chat request. */
function chatReq(
  model = '@cf/qwen/qwen2.5-coder-7b-instruct',
  content = 'ping',
): ChatRequest {
  return { model, messages: [{ role: 'user', content }] };
}

/** Build a ReadableStream from an array of Uint8Array chunks. */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

/** Shape a fake `fetch` Response with a streaming body. */
function fakeStreamResponse(body: ReadableStream<Uint8Array> | string, init: { status?: number; ok?: boolean } = {}): Response {
  const isOk = init.ok ?? true;
  const status = init.status ?? 200;
  const bodyStream =
    typeof body === 'string'
      ? new ReadableStream({
          start(controller) {
            controller.enqueue(enc(body));
            controller.close();
          },
        })
      : body;
  return new Response(bodyStream, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// =============================================================================

describe('WorkersAIAdapter', () => {
  let a: WorkersAIAdapter;

  beforeEach(() => {
    a = new WorkersAIAdapter();
  });

  // ---------- identity & constants ----------

  describe('identity & constants', () => {
    it('exposes PROVIDER_ID = "workersai" and the documented CF REST base URL', () => {
      expect(a.PROVIDER_ID).toBe('workersai');
      expect(a.getBaseUrl()).toBe(WORKERSAI_BASE_URL);
      expect(a.getBaseUrl()).toBe('https://api.cloudflare.com/client/v4');
    });

    it('exports the documented env-var names, health model + timeout, and static model list', () => {
      expect(CF_ACCOUNT_ID_ENV).toBe('CF_ACCOUNT_ID');
      expect(CF_API_TOKEN_ENV).toBe('CF_API_TOKEN');
      expect(WORKERSAI_HEALTH_MODEL).toBe('@cf/qwen/qwen2.5-coder-7b-instruct');
      expect(WORKERSAI_HEALTH_TIMEOUT_MS).toBe(5_000);
      expect(WORKERSAI_MODELS.length).toBe(4);
      expect(WORKERSAI_MODELS.map((m) => m.id)).toContain('@cf/qwen/qwen2.5-coder-32b-instruct');
      expect(WORKERSAI_MODELS.map((m) => m.id)).toContain('@cf/meta/llama-3.1-8b-instruct');
    });
  });

  // ---------- getHeaders ----------

  describe('getHeaders', () => {
    it('emits Bearer + Content-Type when given an apiToken', () => {
      const h = a.getHeaders('tok-123');
      expect(h.Authorization).toBe('Bearer tok-123');
      expect(h['Content-Type']).toBe('application/json');
    });

    it('throws ProviderError when the apiToken is missing', () => {
      expect(() => a.getHeaders('')).toThrowError(/CF_API_TOKEN/);
      expect(() => a.getHeaders()).toThrowError(/CF_API_TOKEN/);
    });
  });

  // ---------- formatRequest ----------

  describe('formatRequest', () => {
    it('passes the request through unchanged (OpenAI shape is already correct)', () => {
      const req: ChatRequest = {
        model: '@cf/qwen/qwen2.5-coder-32b-instruct',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 100,
        temperature: 0.5,
        top_p: 0.8,
      };
      expect(a.formatRequest(req)).toEqual(req);
    });
  });

  // ---------- parseResponse ----------

  describe('parseResponse', () => {
    it('converts CF { response } into OpenAI choices[0].message.content with finish_reason=stop', () => {
      const r = a.parseResponse(
        { response: 'Hello from Workers AI', usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } },
        '@cf/qwen/qwen2.5-coder-7b-instruct',
      );
      expect(r.object).toBe('chat.completion');
      expect(r.choices).toHaveLength(1);
      expect(r.choices[0].message.content).toBe('Hello from Workers AI');
      expect(r.choices[0].message.role).toBe('assistant');
      expect(r.choices[0].finish_reason).toBe('stop');
      expect(r.usage.total_tokens).toBe(8);
      expect(r.model).toBe('@cf/qwen/qwen2.5-coder-7b-instruct');
    });

    it('reads nested result.response when present (REST shape)', () => {
      const r = a.parseResponse({ result: { response: 'nested' } }, 'm');
      expect(r.choices[0].message.content).toBe('nested');
    });

    it('returns an empty content string when response field is absent', () => {
      const r = a.parseResponse({}, 'm');
      expect(r.choices[0].message.content).toBe('');
      expect(r.usage.total_tokens).toBe(0);
    });

    it('throws ProviderError when the CF response carries embedded errors', () => {
      expect(() =>
        a.parseResponse({ errors: [{ code: 7003, message: 'neuron budget exhausted' }] }, 'm'),
      ).toThrowError(/neuron budget exhausted/);
    });

    it('synthesises a stable id (cfchat-<ts>) and created timestamp', () => {
      const r = a.parseResponse({ response: 'x' }, 'm');
      expect(r.id).toMatch(/^cfchat-\d+$/);
      expect(r.created).toBeGreaterThan(0);
    });

    it('falls back to (prompt_tokens + completion_tokens) when total_tokens is absent', () => {
      const r = a.parseResponse(
        { response: 'x', usage: { prompt_tokens: 4, completion_tokens: 6 } },
        'm',
      );
      expect(r.usage.total_tokens).toBe(10);
    });
  });

  // ---------- parseStreamChunk ----------

  describe('parseStreamChunk', () => {
    const ctx = { model: '@cf/qwen/qwen2.5-coder-7b-instruct', id: 'cfchat-test', created: 1_700_000_000 };

    it('translates a CF data:{"response":"…"} frame to an OpenAI delta chunk', () => {
      const r = a.parseStreamChunk('data: {"response":"Hello"}', ctx);
      expect(r).not.toBeNull();
      expect(r?.object).toBe('chat.completion.chunk');
      expect(r?.choices[0].delta.content).toBe('Hello');
      expect(r?.choices[0].finish_reason).toBeNull();
      expect(r?.model).toBe('@cf/qwen/qwen2.5-coder-7b-instruct');
    });

    it('returns null for [DONE]', () => {
      expect(a.parseStreamChunk('data: [DONE]', ctx)).toBeNull();
    });

    it('returns null for empty lines', () => {
      expect(a.parseStreamChunk('', ctx)).toBeNull();
      expect(a.parseStreamChunk('   ', ctx)).toBeNull();
    });

    it('returns null for SSE comment / event: / non-data lines', () => {
      expect(a.parseStreamChunk(': keep-alive', ctx)).toBeNull();
      expect(a.parseStreamChunk('event: ping', ctx)).toBeNull();
      expect(a.parseStreamChunk('id: 42', ctx)).toBeNull();
    });

    it('returns null on malformed JSON (does not throw)', () => {
      expect(a.parseStreamChunk('data: {broken', ctx)).toBeNull();
    });

    it('falls back to `delta` / `content` fields for older model shapes', () => {
      expect(a.parseStreamChunk('data: {"delta":"x"}', ctx)?.choices[0].delta.content).toBe('x');
      expect(a.parseStreamChunk('data: {"content":"y"}', ctx)?.choices[0].delta.content).toBe('y');
    });

    it('emits an empty delta for an empty `response` field', () => {
      const r = a.parseStreamChunk('data: {"response":""}', ctx);
      expect(r).not.toBeNull();
      expect(r?.choices[0].delta.content).toBeUndefined();
    });
  });

  // ---------- extractRateLimitInfo ----------

  describe('extractRateLimitInfo', () => {
    it('returns a provider-tagged empty RateLimitInfo (Workers AI exposes no rate-limit headers)', () => {
      const h = new Headers({ 'content-type': 'application/json' });
      const info = a.extractRateLimitInfo(h);
      expect(info.provider).toBe('workersai');
      expect(info.requestsLimit).toBeUndefined();
      expect(info.requestsRemaining).toBeUndefined();
      expect(info.rawHeaders).toEqual({});
    });
  });

  // ---------- chat (env.AI binding) ----------

  describe('chat (env.AI binding)', () => {
    it('calls env.AI.run with model + messages and converts the result to OpenAI shape', async () => {
      const ai = mockAi(async (_model, inputs) => {
        const i = inputs as { messages: Array<{ content: string }> };
        return {
          response: `echo:${i.messages[0]?.content ?? ''}`,
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      });
      const env: WorkersAIEnv = { AI: ai, CF_ACCOUNT_ID: 'acct', CF_API_TOKEN: 'tok' };

      const out = await a.chat(chatReq('@cf/qwen/qwen2.5-coder-7b-instruct', 'ping'), env);

      expect(out.choices[0].message.content).toBe('echo:ping');
      expect(out.usage.total_tokens).toBe(2);
      expect(out.model).toBe('@cf/qwen/qwen2.5-coder-7b-instruct');
      expect(ai.run).toHaveBeenCalledTimes(1);
      expect(ai.run).toHaveBeenCalledWith(
        '@cf/qwen/qwen2.5-coder-7b-instruct',
        expect.objectContaining({
          messages: [{ role: 'user', content: 'ping' }],
        }),
      );
    });

    it('forwards optional decoding params (max_tokens, temperature, top_p, stop) to env.AI.run', async () => {
      const ai = mockAi(async () => ({ response: 'ok' }));
      const env: WorkersAIEnv = { AI: ai, CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't' };
      await a.chat(
        {
          model: '@cf/qwen/qwen2.5-coder-7b-instruct',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 50,
          temperature: 0.3,
          top_p: 0.9,
          stop: ['\n'],
        },
        env,
      );
      const passedInputs = ai.run.mock.calls[0][1] as Record<string, unknown>;
      expect(passedInputs.max_tokens).toBe(50);
      expect(passedInputs.temperature).toBe(0.3);
      expect(passedInputs.top_p).toBe(0.9);
      expect(passedInputs.stop).toEqual(['\n']);
    });

    it('omits undefined optional params (keeps the binding happy)', async () => {
      const ai = mockAi(async () => ({ response: 'ok' }));
      const env: WorkersAIEnv = { AI: ai, CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't' };
      await a.chat(chatReq(), env);
      const passedInputs = ai.run.mock.calls[0][1] as Record<string, unknown>;
      expect(passedInputs.max_tokens).toBeUndefined();
      expect(passedInputs.temperature).toBeUndefined();
      expect(passedInputs.messages).toEqual([{ role: 'user', content: 'ping' }]);
    });

    it('throws ProviderError when env.AI binding is missing', async () => {
      await expect(
        a.chat(chatReq(), { CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't' } as unknown as WorkersAIEnv),
      ).rejects.toThrowError(/env\.AI/);
    });

    it('wraps binding-level exceptions as NetworkError (retryable)', async () => {
      const ai = mockAi(async () => {
        throw new Error('binding unavailable');
      });
      const env: WorkersAIEnv = { AI: ai, CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't' };
      await expect(a.chat(chatReq(), env)).rejects.toThrowError(/binding error/);
    });

    it('propagates embedded CF errors as ProviderError', async () => {
      const ai = mockAi(async () => ({
        errors: [{ code: 7003, message: 'neuron budget exhausted' }],
      }));
      const env: WorkersAIEnv = { AI: ai, CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't' };
      await expect(a.chat(chatReq(), env)).rejects.toThrowError(/neuron budget exhausted/);
    });
  });

  // ---------- chatStream (REST SSE → OpenAI ChatStreamChunk via TransformStream) ----------

  describe('chatStream (REST SSE → OpenAI ChatStreamChunk)', () => {
    it('parses CF SSE frames and yields OpenAI-shaped ChatStreamChunks', async () => {
      const sseBody =
        'data: {"response":"Hello"}\n\ndata: {"response":" world"}\n\ndata: [DONE]\n\n';
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(fakeStreamResponse(sseBody));

      const env: WorkersAIEnv = {
        AI: mockAi(async () => ({})),
        CF_ACCOUNT_ID: 'acct123',
        CF_API_TOKEN: 'tok-xyz',
      };

      const out: ChatStreamChunk[] = [];
      for await (const c of a.chatStream(chatReq(), env)) out.push(c);

      // The CF-shaped frames should now be OpenAI-shaped ChatStreamChunks.
      expect(out.length).toBeGreaterThanOrEqual(2);
      expect(out[0].object).toBe('chat.completion.chunk');
      expect(out[0].choices[0].delta.content).toBe('Hello');
      expect(out[1].choices[0].delta.content).toBe(' world');

      // [DONE] should NOT yield a chunk (parseStreamChunk returns null for it).
      expect(out.every((c) => c.choices[0].delta.content !== '[DONE]')).toBe(true);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/@cf/qwen/qwen2.5-coder-7b-instruct?stream=true',
      );
      expect(init.method).toBe('POST');
      const headers = new Headers(init.headers);
      expect(headers.get('Authorization')).toBe('Bearer tok-xyz');
      const body = JSON.parse(String(init.body)) as { stream: boolean; messages: unknown };
      expect(body.stream).toBe(true);
    });

    it('handles chunk boundaries that split a CF SSE frame across reads', async () => {
      const chunks = [
        enc('data: {"response":"Hel'),
        enc('lo"}\n\ndata: {"response":"!"}\n\ndata: [DONE]\n\n'),
      ];
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(fakeStreamResponse(streamOf(chunks)));
      const env: WorkersAIEnv = {
        AI: mockAi(async () => ({})),
        CF_ACCOUNT_ID: 'a',
        CF_API_TOKEN: 't',
      };
      const out: ChatStreamChunk[] = [];
      for await (const c of a.chatStream(chatReq(), env)) out.push(c);
      const contents = out.map((c) => c.choices[0].delta.content).join('');
      expect(contents).toBe('Hello!');
    });

    it('throws ProviderError on a non-2xx HTTP response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        fakeStreamResponse('unauthorized', { status: 401, ok: false }),
      );
      const env: WorkersAIEnv = {
        AI: mockAi(async () => ({})),
        CF_ACCOUNT_ID: 'a',
        CF_API_TOKEN: 'bad',
      };
      // `chatStream` is an async generator — the error is surfaced when
      // iteration starts, not when the generator is called. Wrap in an
      // async IIFE so `expect().rejects` sees a Promise.
      await expect(async () => {
        for await (const _ of a.chatStream(chatReq(), env)) {
          void _;
        }
      }).rejects.toThrowError(/401/);
    });

    it('throws ProviderError when CF_ACCOUNT_ID / CF_API_TOKEN are missing', async () => {
      const env: WorkersAIEnv = { AI: mockAi(async () => ({})) };
      await expect(async () => {
        for await (const _ of a.chatStream(chatReq(), env)) {
          void _;
        }
      }).rejects.toThrowError(/CF_ACCOUNT_ID/);
      await expect(async () => {
        for await (const _ of a.chatStream(chatReq(), { AI: mockAi(async () => ({})), CF_ACCOUNT_ID: 'a' })) {
          void _;
        }
      }).rejects.toThrowError(/CF_API_TOKEN/);
    });
  });

  // ---------- listModels ----------

  describe('listModels', () => {
    it('returns the static curated list without calling fetch', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const models = await a.listModels();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(models.length).toBe(4);
      expect(models[0].id).toBe('@cf/qwen/qwen2.5-coder-32b-instruct');
      expect(models.every((m) => m.owned_by === 'cloudflare')).toBe(true);
    });
  });

  // ---------- healthCheck ----------

  describe('healthCheck', () => {
    it('returns a HealthStatus with healthy=true when env.AI.run resolves', async () => {
      const ai = mockAi(async () => ({ response: '' }));
      const env: WorkersAIEnv = { AI: ai, CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't' };
      const h = await a.healthCheck(env);
      expect(h.provider).toBe('workersai');
      expect(h.healthy).toBe(true);
      expect(h.status).toBe(200);
      expect(h.latencyMs).toBeGreaterThanOrEqual(0);
      expect(h.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(ai.run).toHaveBeenCalledWith(
        WORKERSAI_HEALTH_MODEL,
        expect.objectContaining({
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
      );
    });

    it('returns healthy=false with status=0 when env.AI.run rejects', async () => {
      const ai = mockAi(async () => {
        throw new Error('binding down');
      });
      const env: WorkersAIEnv = { AI: ai, CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't' };
      const h = await a.healthCheck(env);
      expect(h.healthy).toBe(false);
      expect(h.status).toBe(0);
      expect(h.message).toMatch(/binding error/);
    });

    it('returns healthy=false when env is misconfigured (no AI binding)', async () => {
      const h = await a.healthCheck({} as WorkersAIEnv);
      expect(h.healthy).toBe(false);
      expect(h.message).toMatch(/env\.AI/);
    });

    it('times out after WORKERSAI_HEALTH_TIMEOUT_MS when env.AI.run hangs', async () => {
      const ai = mockAi(
        () =>
          new Promise((resolve) => {
            // Never resolves — health check must time out and return healthy=false.
            setTimeout(() => resolve({ response: 'late' }), WORKERSAI_HEALTH_TIMEOUT_MS + 2_000);
          }),
      );
      const env: WorkersAIEnv = { AI: ai, CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't' };
      const t0 = Date.now();
      const h = await a.healthCheck(env);
      const elapsed = Date.now() - t0;
      expect(h.healthy).toBe(false);
      expect(h.message).toMatch(/timed out|abort/i);
      // Should complete in ~5s + small overhead, NOT the 7s the mock takes.
      expect(elapsed).toBeLessThan(WORKERSAI_HEALTH_TIMEOUT_MS + 1_500);
    });
  });

  // ---------- singleton ----------

  describe('singleton', () => {
    it('the exported singleton is a WorkersAIAdapter instance', () => {
      expect(workersaiAdapter).toBeInstanceOf(WorkersAIAdapter);
      expect(workersaiAdapter.PROVIDER_ID).toBe('workersai');
    });
  });
});
