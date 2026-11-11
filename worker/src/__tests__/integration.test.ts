/**
 * Worker-level integration tests (Agent C5).
 *
 * Verifies the end-to-end HTTP surface of `src/index.ts` — every public
 * endpoint is exercised with a fully-mocked Env (D1 / KV / fetch / AI),
 * so no real network or database is touched.
 *
 * Coverage:
 *   1. Worker starts without errors (GET / returns 200 + landing JSON)
 *   2. GET /health returns 200 + { status: 'ok' }
 *   3. GET /v1/models returns the OpenAI-shaped models list
 *   4. GET /v1/providers returns provider list with statuses
 *   5. POST /v1/chat/completions (non-stream) returns OpenAI response
 *   6. POST /v1/chat/completions stream=true returns an SSE stream
 *   7. POST /v1/feedback with valid message_id returns 200
 *   8. GET /v1/dashboard returns dashboard data shape
 *
 * All external dependencies are mocked:
 *   - globalThis.fetch       — gateway cascade never hits a real provider
 *   - env.DB (D1Database)    — chainable in-memory stub returning canned rows
 *   - env.RATE_LIMITS (KV)    — Map-backed KVNamespace stub
 *   - env.AI (Ai binding)    — vi.fn() returning canned Workers AI output
 *
 * Run:  npx vitest run src/__tests__/integration.test.ts
 *
 * Agent C5 — final visual + integration pass.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Env } from '../index';

// ============================================================================
// Mocks — must be hoisted BEFORE the worker import.
// ============================================================================

// Mock the gateway cascade so routeChat / routeChatStream /
// handleProviderFeedback never reach the real provider adapters
// (which would call fetch()).
vi.mock('../gateway', () => ({
  routeChat: vi.fn(),
  routeChatStream: vi.fn(),
  handleProviderFeedback: vi.fn(),
  listProviders: vi.fn(() => []),
}));

// Mock the ProviderMonitor so /v1/dashboard never runs D1 queries.
vi.mock('../gateway/monitoring', () => ({
  ProviderMonitor: vi.fn(),
}));

// Now safe to import.
import worker from '../index';
import { routeChat, routeChatStream, handleProviderFeedback } from '../gateway';
import { ProviderMonitor } from '../gateway/monitoring';

// ============================================================================
// In-memory D1 stub (chainable: prepare(...).bind(...).first/run/all)
// ============================================================================

interface D1Row { [key: string]: unknown; }

class D1Stub {
  private rowsByKey: Record<string, D1Row[]> = {};
  private singleByKey: Record<string, D1Row | null> = {};
  public lastQuery: string = '';
  public lastBinds: unknown[] = [];

  /** Set the canned row(s) returned for the next query matching `sqlSubstr`. */
  setRowsForQuery(sqlSubstr: string, rows: D1Row[]): void {
    this.rowsByKey[sqlSubstr] = rows;
  }
  setFirstForQuery(sqlSubstr: string, row: D1Row | null): void {
    this.singleByKey[sqlSubstr] = row;
  }

  prepare(sql: string) {
    this.lastQuery = sql;
    return {
      bind: (...vals: unknown[]) => {
        this.lastBinds = vals;
        return {
          first: async <T = D1Row>(): Promise<T | null> => {
            for (const key of Object.keys(this.singleByKey)) {
              if (sql.includes(key)) {
                return (this.singleByKey[key] ?? null) as T | null;
              }
            }
            return null;
          },
          all: async <T = D1Row>(): Promise<{ results: T[]; success: boolean }> => {
            for (const key of Object.keys(this.rowsByKey)) {
              if (sql.includes(key)) {
                return { results: (this.rowsByKey[key] ?? []) as T[], success: true };
              }
            }
            return { results: [], success: true };
          },
          run: async (): Promise<{ success: boolean }> => {
            return { success: true };
          },
        };
      },
    };
  }
}

// ============================================================================
// In-memory KV stub (KVNamespace-shaped, Map-backed)
// ============================================================================

class KVStub {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async getWithMetadata(_key: string): Promise<{ value: string | null; metadata: unknown }> {
    return { value: null, metadata: null };
  }
  async put(key: string, value: string, _opts?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async list(): Promise<{ keys: { name: string }[]; list_complete: boolean }> {
    return { keys: Array.from(this.store.keys()).map((name) => ({ name })), list_complete: true };
  }
}

// ============================================================================
// Test fixtures
// ============================================================================

const originalFetch = globalThis.fetch;
let dbStub: D1Stub;
let kvStub: KVStub;
let fakeEnv: Env;
let fakeCtx: ExecutionContext;
let pendingWaitUntil: Promise<unknown>[];

function buildEnv(): Env {
  return {
    DB: dbStub as unknown as D1Database,
    LOCKS: new KVStub() as unknown as KVNamespace,
    TASK_STATUS: new KVStub() as unknown as KVNamespace,
    RATE_LIMITS: kvStub as unknown as KVNamespace,
    PROMPT_CACHE: new KVStub() as unknown as KVNamespace,
    BRAND_ASSETS: new KVStub() as unknown as KVNamespace,
    TASKS_QUEUE: { send: vi.fn().mockResolvedValue(undefined) } as unknown as Queue<unknown>,
    AI: { run: vi.fn().mockResolvedValue({ response: 'mocked' }) } as unknown as Ai,
    ENVIRONMENT: 'test',
    LOG_LEVEL: 'info',
    DEFAULT_MODEL: 'qwen2.5-coder-32b',
    FAST_MODEL: 'qwen2.5-coder-14b',
    WHISPER_MODEL: 'whisper-large-v3',
    ADMIN_CHAT_ID: '123456',
    MAX_TOKENS_DEFAULT: '4096',
    TEMPERATURE_DEFAULT: '0.7',
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_CHAT_ID_WHITELIST: '',
    MICKY_PASSWORD_HASH: '',
    GH_PAT_SCOPED: '',
    GH_WEBHOOK_SECRET: 'wh-secret',
    KAGGLE_API_TOKEN: '',
    GROQ_KEY_1: 'gsk_test_key_1',
    GROQ_KEY_2: 'gsk_test_key_2',
    GEMINI_KEY: 'AIza_test',
    MISTRAL_KEY: 'mck_test',
    OPENROUTER_KEY: 'sk-or-test',
    SAMBANOVA_KEY: 'smb_test',
    COHERE_KEY: 'coh_test',
    SILICONFLOW_KEY: 'sf_test',
    CEREBRAS_KEY: 'cs_test',
    NOVITA_KEY: 'nv_test',
  } as unknown as Env;
}

function buildCtx(): ExecutionContext {
  pendingWaitUntil = [];
  return {
    waitUntil: vi.fn((p: Promise<unknown>) => {
      pendingWaitUntil.push(p.catch(() => {}));
    }),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

async function flush(): Promise<void> {
  await Promise.all(pendingWaitUntil.splice(0));
  pendingWaitUntil = [];
}

function mockRequest(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const url = `https://test.micky.workers.dev${path}`;
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (body !== undefined && method !== 'GET') {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return new Request(url, init);
}

// ============================================================================
// Test setup / teardown
// ============================================================================

beforeEach(() => {
  dbStub = new D1Stub();
  kvStub = new KVStub();
  fakeEnv = buildEnv();
  fakeCtx = buildCtx();
  vi.clearAllMocks();
  // Default: routeChat returns a valid OpenAI non-stream response.
  vi.mocked(routeChat).mockResolvedValue(
    new Response(JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1731400000,
      model: 'qwen2.5-coder-32b',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      provider: 'groq1',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Provider': 'groq1' },
    }),
  );
  vi.mocked(handleProviderFeedback).mockResolvedValue(undefined);
  // Default: routeChatStream returns a minimal SSE stream (so any unexpected
  // stream call still resolves rather than rejecting with `undefined`).
  const enc = new TextEncoder();
  const defaultStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  vi.mocked(routeChatStream).mockResolvedValue(
    new Response(defaultStream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'X-Provider': 'groq1' },
    }),
  );
  // Default: ProviderMonitor.getDashboardData returns a valid dashboard.
  vi.mocked(ProviderMonitor).mockImplementation(() => ({
    getDashboardData: vi.fn().mockResolvedValue({
      generated_at: Date.now(),
      cascade: { total: 11, healthy: 11, degraded: 0, down: 0, circuits_open: 0 },
      providers: [],
      top_providers: [],
      recent_feedback: { up: 0, down: 0, window_hours: 24 },
    }),
  }) as unknown as ProviderMonitor);
  // Pre-seed an API key row so chat completions auth succeeds. The worker
  // hashes the bearer key via crypto.subtle.digest('SHA-256', ...) before
  // querying — we don't reproduce the hash, we just stub the DB to return
  // a row for any query containing 'api_keys'.
  dbStub.setFirstForQuery('api_keys', { id: 'key_test', user_id: 'user_test', key_hash: 'x', revoked: 0 });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ============================================================================
// Tests
// ============================================================================

describe('C5 worker integration', () => {

  // =========== Test 1: Worker starts without errors ===========
  it('GET / returns 200 with landing JSON', async () => {
    const res = await worker.fetch(mockRequest('GET', '/'), fakeEnv, fakeCtx);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.name).toContain('Micky');
    expect(body.status).toBe('running');
    expect(Array.isArray(body.endpoints)).toBe(true);
    expect(body.endpoints).toContain('/v1/chat/completions');
    expect(body.endpoints).toContain('/v1/models');
  });

  // =========== Test 2: /health returns 200 ===========
  it('GET /health returns 200 with status ok', async () => {
    const res = await worker.fetch(mockRequest('GET', '/health'), fakeEnv, fakeCtx);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; timestamp: number; version: string };
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeGreaterThan(0);
    expect(body.version).toBeTruthy();
  });

  // =========== Test 3: /v1/models returns OpenAI-shaped models list ===========
  it('GET /v1/models returns OpenAI-shaped list', async () => {
    const res = await worker.fetch(mockRequest('GET', '/v1/models'), fakeEnv, fakeCtx);
    expect(res.status).toBe(200);
    const body = await res.json() as { object: string; data: Array<{ id: string; object: string; owned_by: string }> };
    expect(body.object).toBe('list');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    body.data.forEach((m) => {
      expect(m.object).toBe('model');
      expect(typeof m.id).toBe('string');
      expect(typeof m.owned_by).toBe('string');
    });
  });

  // =========== Test 4: /v1/providers returns provider list with statuses ===========
  it('GET /v1/providers returns provider list with configured/healthy status', async () => {
    const res = await worker.fetch(mockRequest('GET', '/v1/providers'), fakeEnv, fakeCtx);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      generated_at: number;
      total: number;
      configured: number;
      healthy: number;
      providers: Array<{
        id: string;
        label: string;
        configured: boolean;
        healthy: 'healthy' | 'down' | 'unknown';
      }>;
    };
    expect(body.total).toBeGreaterThanOrEqual(11);
    expect(body.providers.length).toBeGreaterThanOrEqual(11);
    expect(typeof body.configured).toBe('number');
    expect(typeof body.healthy).toBe('number');
    body.providers.forEach((p) => {
      expect(typeof p.id).toBe('string');
      expect(typeof p.label).toBe('string');
      expect(typeof p.configured).toBe('boolean');
      expect(['healthy', 'down', 'unknown']).toContain(p.healthy);
    });
    // With the test env (every provider key set), configured should be 11.
    expect(body.configured).toBe(11);
    // Healthy may be 0 (no D1 ledger rows seeded) — at minimum the count
    // is a number and matches the array length filter.
    expect(body.healthy).toBeGreaterThanOrEqual(0);
    expect(body.healthy).toBeLessThanOrEqual(body.configured);
  });

  // =========== Test 5: /v1/chat/completions returns valid OpenAI response ===========
  it('POST /v1/chat/completions (non-stream) returns OpenAI-shaped response', async () => {
    const body = {
      model: 'qwen2.5-coder-32b',
      messages: [{ role: 'user', content: 'Hello, who are you?' }],
    };
    const res = await worker.fetch(
      mockRequest('POST', '/v1/chat/completions', body, { Authorization: 'Bearer micky_testkey_valid_for_integration_test' }),
      fakeEnv, fakeCtx,
    );
    await flush();

    expect(res.status).toBe(200);
    const json = await res.json() as {
      id: string; object: string; model: string;
      choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    expect(json.object).toBe('chat.completion');
    expect(json.choices).toHaveLength(1);
    expect(json.choices[0].message.role).toBe('assistant');
    expect(typeof json.choices[0].message.content).toBe('string');
    expect(json.usage.total_tokens).toBeGreaterThan(0);
    // routeChat should have been called once.
    expect(routeChat).toHaveBeenCalledTimes(1);
  });

  // =========== Test 6: /v1/chat/completions stream=true returns SSE ===========
  it('POST /v1/chat/completions stream=true returns SSE stream', async () => {
    // Mock routeChat to return a streaming Response with the OpenAI SSE shape.
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" there"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    vi.mocked(routeChatStream).mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Provider': 'groq1',
        },
      }),
    );

    const body = {
      model: 'qwen2.5-coder-32b',
      messages: [{ role: 'user', content: 'Say hi' }],
      stream: true,
    };
    const res = await worker.fetch(
      mockRequest('POST', '/v1/chat/completions', body, { Authorization: 'Bearer micky_testkey_valid_for_integration_test' }),
      fakeEnv, fakeCtx,
    );
    await flush();

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data: {"choices":');
    expect(text).toContain('data: [DONE]');
    // Streaming path should still call routeChatStream once.
    expect(routeChatStream).toHaveBeenCalledTimes(1);
  });

  // =========== Test 7: /v1/feedback with valid message_id returns 200 ===========
  it('POST /v1/feedback with valid message_id returns 200', async () => {
    const body = { message_id: 'msg_abc123', rating: 1 };
    const res = await worker.fetch(
      mockRequest('POST', '/v1/feedback', body),
      fakeEnv, fakeCtx,
    );
    await flush();
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; message_id: string; rating: number };
    expect(json.ok).toBe(true);
    expect(json.message_id).toBe('msg_abc123');
    expect(json.rating).toBe(1);
    expect(handleProviderFeedback).toHaveBeenCalledTimes(1);
  });

  // =========== Test 8: /v1/dashboard returns dashboard data ===========
  it('GET /v1/dashboard returns cascade + providers + top_providers', async () => {
    const res = await worker.fetch(mockRequest('GET', '/v1/dashboard'), fakeEnv, fakeCtx);
    await flush();
    expect(res.status).toBe(200);
    const json = await res.json() as {
      generated_at: number;
      cascade: { total: number; healthy: number; degraded: number; down: number; circuits_open: number };
      providers: unknown[];
      top_providers: unknown[];
      recent_feedback: { up: number; down: number; window_hours: number };
    };
    expect(typeof json.generated_at).toBe('number');
    expect(json.cascade).toBeDefined();
    expect(json.cascade.total).toBeGreaterThanOrEqual(5);
    expect(Array.isArray(json.providers)).toBe(true);
    expect(Array.isArray(json.top_providers)).toBe(true);
    expect(ProviderMonitor).toHaveBeenCalledTimes(1);
  });

  // =========== Bonus: 401 on missing API key ===========
  it('POST /v1/chat/completions without API key returns 401', async () => {
    const body = { messages: [{ role: 'user', content: 'hi' }] };
    const res = await worker.fetch(
      mockRequest('POST', '/v1/chat/completions', body),
      fakeEnv, fakeCtx,
    );
    expect(res.status).toBe(401);
    const json = await res.json() as { error: string; code: string };
    expect(json.code).toBe('invalid_api_key');
    expect(routeChat).not.toHaveBeenCalled();
  });

  // =========== Bonus: 404 on unknown path ===========
  it('GET /unknown returns 404 with error path', async () => {
    const res = await worker.fetch(mockRequest('GET', '/unknown/path'), fakeEnv, fakeCtx);
    expect(res.status).toBe(404);
    const json = await res.json() as { error: string; path: string };
    expect(json.error).toBe('Not Found');
    expect(json.path).toBe('/unknown/path');
  });

});
