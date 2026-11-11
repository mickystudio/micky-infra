/**
 * Model Router tests — Agent A8-retry2.
 *
 * Covers the 10 required scenarios from the task spec:
 *   1. Sticky session hit (skip cascade)
 *   2. Sticky session miss (use cascade)
 *   3. 429 → next provider
 *   4. All providers exhausted → 503
 *   5. Successful call records metrics + sets sticky
 *   6. Circuit breaker opens after 3 failures
 *   7. Token budget check skips provider
 *   8. Streaming success
 *   9. Streaming pre-stream error → fallback
 *  10. handleFeedback updates ledger
 *
 * Uses `vi.mock()` to replace QuotaLedger / registry / intent_classifier /
 * token_counter with in-memory stubs so routing logic is verified in
 * isolation (no real D1 database, no real LLM calls).
 *
 * Run: `bun run test src/gateway/__tests__/model_router.test.ts`
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Env } from '../../index';

// ============================================================================
// Mocks — must be hoisted before the import of model_router.ts
// ============================================================================

// --- In-memory QuotaLedger stub ---------------------------------------------

const ledgerMock = {
  decrementQuota: vi.fn(),
  getStickyProvider: vi.fn(),
  setStickyProvider: vi.fn(),
  record429: vi.fn(),
  recordCall: vi.fn(),
  recordFeedback: vi.fn(),
  setProviderHealthy: vi.fn(),
  getHealthyProviders: vi.fn(),
  getQuota: vi.fn(),
};

vi.mock('../ledger/ledger', () => ({
  QuotaLedger: vi.fn(() => ledgerMock),
}));

// --- Registry stub -----------------------------------------------------------

const fakeAdapter = {
  id: 'groq1' as const,
  label: 'Groq (fake)',
  chat: vi.fn(),
  chatStream: vi.fn(),
  healthCheck: vi.fn().mockResolvedValue(true),
  isConfigured: vi.fn().mockReturnValue(true),
};

vi.mock('../registry', () => ({
  getProvider: vi.fn(() => fakeAdapter),
  getHealthyProviders: vi.fn(),
}));

// --- Intent classifier stub -------------------------------------------------

vi.mock('../utils/intent_classifier', () => ({
  classifyIntent: vi.fn(() => 'simple_chat'),
  getCascadeForIntent: vi.fn((intent: string) => {
    if (intent === 'simple_chat') return ['groq1', 'mistral'];
    if (intent === 'code') return ['groq1'];
    return ['groq1', 'mistral'];
  }),
  pickBestModel: vi.fn((intent: string, provider: string) => {
    if (provider === 'groq1') return 'llama-3.1-8b-instant';
    if (provider === 'mistral') return 'mistral-small-latest';
    return 'unknown-model';
  }),
}));

// --- Token counter stub ------------------------------------------------------

vi.mock('../utils/token_counter', () => ({
  countMessageTokens: vi.fn(() => 100),
  willFitInProviderContext: vi.fn(() => true),
  getProviderContextLimit: vi.fn(() => 32768),
}));

// ============================================================================
// Imports (after mocks are hoisted)
// ============================================================================

import { routeChat, routeChatStream, handleFeedback } from '../model_router';
import { getProvider, getHealthyProviders } from '../registry';
import { classifyIntent, getCascadeForIntent, pickBestModel } from '../utils/intent_classifier';
import { countMessageTokens, willFitInProviderContext } from '../utils/token_counter';
import { QuotaLedger } from '../ledger/ledger';

// ============================================================================
// Test fixtures
// ============================================================================

const fakeEnv = {
  DB: {} as unknown as D1Database, // truthy so ledger is constructed
  GROQ_KEY_1: 'k1', GROQ_KEY_2: 'k2', GEMINI_KEY: 'k3', MISTRAL_KEY: 'k4',
  OPENROUTER_KEY: 'k5', SAMBANOVA_KEY: 'k6', COHERE_KEY: 'k7',
  SILICONFLOW_KEY: 'k8', CEREBRAS_KEY: 'k9', NOVITA_KEY: 'k10',
  AI: {} as unknown as Ai,
} as unknown as Env;

// Collect ctx.waitUntil promises so tests can flush them.
const pending: Promise<unknown>[] = [];
const fakeCtx = {
  waitUntil: vi.fn((p: Promise<unknown>) => {
    pending.push(p.catch(() => {}));
  }),
} as unknown as ExecutionContext;

async function flush(): Promise<void> {
  await Promise.all(pending.splice(0));
}

function makeReq(messages: Array<{ role: string; content: string }> = [
  { role: 'user', content: 'Hello world' },
]): Parameters<typeof routeChat>[0] {
  return {
    model: 'llama-3.1-8b-instant',
    messages: messages as never,
    stream: false,
  } as never;
}

function makeChatResponse(): unknown {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1731400000,
    model: 'llama-3.1-8b-instant',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'Hi!' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function makeSSEStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

// ============================================================================
// Test setup
// ============================================================================

beforeEach(async () => {
  vi.clearAllMocks();
  pending.length = 0;

  // Default: every provider is healthy with abundant quota.
  vi.mocked(getHealthyProviders).mockResolvedValue(['groq1', 'mistral']);
  ledgerMock.getStickyProvider.mockResolvedValue(null);
  ledgerMock.decrementQuota.mockResolvedValue({ ok: true, remaining: 1000 });
  ledgerMock.getQuota.mockResolvedValue({
    consecutive_failures: 0, is_healthy: 1, circuit_open_until: 0,
    remaining_rpd: 1000, remaining_tpd: 100000,
  } as never);
  ledgerMock.recordCall.mockResolvedValue(undefined);
  ledgerMock.setStickyProvider.mockResolvedValue(undefined);
  ledgerMock.record429.mockResolvedValue(undefined);
  ledgerMock.setProviderHealthy.mockResolvedValue(undefined);
  ledgerMock.recordFeedback.mockResolvedValue(undefined);

  // Reset classifier / counter mocks to defaults.
  vi.mocked(classifyIntent).mockReturnValue('simple_chat');
  vi.mocked(getCascadeForIntent).mockReturnValue(['groq1', 'mistral']);
  vi.mocked(pickBestModel).mockImplementation(
    (_intent: string, provider: string) =>
      provider === 'groq1' ? 'llama-3.1-8b-instant' : 'mistral-small-latest',
  );
  vi.mocked(countMessageTokens).mockReturnValue(100);
  vi.mocked(willFitInProviderContext).mockReturnValue(true);

  // Reset fakeAdapter.chat / chatStream.
  fakeAdapter.chat.mockResolvedValue(makeChatResponse() as never);
  fakeAdapter.chatStream.mockResolvedValue(makeSSEStream());
});

// ============================================================================
// Tests
// ============================================================================

describe('model_router — routeChat', () => {

  // Test 1: Sticky session hit (skip cascade)
  it('uses sticky provider when set, healthy, and quota available', async () => {
    ledgerMock.getStickyProvider.mockResolvedValue('groq1');

    const res = await routeChat(makeReq(), fakeEnv, fakeCtx);
    await flush();

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Provider')).toBe('groq1');
    expect(fakeAdapter.chat).toHaveBeenCalledTimes(1);
    // Cascade was NOT built (sticky succeeded → classifyIntent never called).
    expect(classifyIntent).not.toHaveBeenCalled();
    expect(getCascadeForIntent).not.toHaveBeenCalled();
  });

  // Test 2: Sticky session miss (use cascade)
  it('builds the cascade when no sticky mapping exists', async () => {
    ledgerMock.getStickyProvider.mockResolvedValue(null);

    const res = await routeChat(makeReq(), fakeEnv, fakeCtx);
    await flush();

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Provider')).toBe('groq1');
    expect(classifyIntent).toHaveBeenCalledTimes(1);
    expect(getCascadeForIntent).toHaveBeenCalledTimes(1);
  });

  // Test 3: 429 → next provider
  it('falls back to the next provider when the first returns 429', async () => {
    const err = Object.assign(new Error('upstream 429'), { status: 429 });
    fakeAdapter.chat
      .mockResolvedValueOnce(Promise.reject(err))
      .mockResolvedValueOnce(makeChatResponse() as never);

    const res = await routeChat(makeReq(), fakeEnv, fakeCtx);
    await flush();

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Provider')).toBe('mistral');
    expect(res.headers.get('X-Fallback-Used')).toBe('true');
    expect(ledgerMock.record429).toHaveBeenCalledWith('groq1');
    // 429 opens a 5-minute circuit.
    expect(ledgerMock.setProviderHealthy).toHaveBeenCalledWith(
      'groq1', false, expect.any(Number),
    );
    expect(fakeAdapter.chat).toHaveBeenCalledTimes(2);
  });

  // Test 4: All providers exhausted → 503
  it('returns 503 all_providers_exhausted when every provider fails', async () => {
    const err5xx = Object.assign(new Error('upstream 503'), { status: 503 });
    fakeAdapter.chat.mockRejectedValue(err5xx);
    // consecutive_failures < 3 → no circuit opens, just records + continues.
    ledgerMock.getQuota.mockResolvedValue({
      consecutive_failures: 0, is_healthy: 1, circuit_open_until: 0,
      remaining_rpd: 1000, remaining_tpd: 100000,
    } as never);

    const res = await routeChat(makeReq(), fakeEnv, fakeCtx);
    await flush();

    expect(res.status).toBe(503);
    const body = await res.json() as { error: { type: string; attempted_providers: string[] } };
    expect(body.error.type).toBe('all_providers_exhausted');
    expect(body.error.attempted_providers).toEqual(['groq1', 'mistral']);
  });

  // Test 5: Successful call records metrics + sets sticky
  it('records a success call audit + sets the sticky provider', async () => {
    const res = await routeChat(makeReq(), fakeEnv, fakeCtx);
    await flush();

    expect(res.status).toBe(200);

    // recordCall was invoked with provider='groq1', status='success',
    // input_tokens=10, output_tokens=5 (from the chatResponse.usage).
    expect(ledgerMock.recordCall).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'groq1',
      status: 'success',
      input_tokens: 10,
      output_tokens: 5,
    }));
    // setStickyProvider was called with the conversation_id + provider + model.
    expect(ledgerMock.setStickyProvider).toHaveBeenCalledWith(
      expect.any(String), 'groq1', 'llama-3.1-8b-instant',
    );
  });

  // Test 6: Circuit breaker opens after 3 failures
  it('opens the 1-hour circuit when consecutive_failures reaches the threshold', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const err5xx = Object.assign(new Error('upstream 500'), { status: 500 });
    fakeAdapter.chat.mockRejectedValue(err5xx);
    vi.mocked(getCascadeForIntent).mockReturnValue(['groq1']);

    // After record429 the consecutive_failures count is bumped to 3.
    ledgerMock.getQuota.mockResolvedValue({
      consecutive_failures: 3, is_healthy: 1, circuit_open_until: 0,
      remaining_rpd: 1000, remaining_tpd: 100000,
    } as never);

    await routeChat(makeReq(), fakeEnv, fakeCtx);
    await flush();

    const expectedCircuitUntil = Date.now() + 60 * 60 * 1000; // +1h
    expect(ledgerMock.setProviderHealthy).toHaveBeenCalledWith(
      'groq1', false, expectedCircuitUntil,
    );

    vi.useRealTimers();
  });

  // Test 7: Token budget check skips provider
  it('skips providers whose context window is too small', async () => {
    // groq1 doesn't fit; mistral does.
    vi.mocked(willFitInProviderContext).mockImplementation(
      (_tokens: number, provider: string) => provider !== 'groq1',
    );

    const res = await routeChat(makeReq(), fakeEnv, fakeCtx);
    await flush();

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Provider')).toBe('mistral');
    // Only mistral's chat() was actually called.
    expect(fakeAdapter.chat).toHaveBeenCalledTimes(1);
    // decrementQuota was NOT called for groq1 (skipped before decrement).
    expect(ledgerMock.decrementQuota).toHaveBeenCalledWith('mistral', expect.any(String), expect.any(Number));
    expect(ledgerMock.decrementQuota).not.toHaveBeenCalledWith('groq1', expect.any(String), expect.any(Number));
  });
});

// ============================================================================
// Streaming tests
// ============================================================================

describe('model_router — routeChatStream', () => {

  // Test 8: Streaming success
  it('returns a 200 SSE response with the provider headers', async () => {
    const res = await routeChatStream(makeReq(), fakeEnv, fakeCtx);
    await flush();

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    expect(res.headers.get('X-Provider')).toBe('groq1');
    expect(res.headers.get('X-Model')).toBe('llama-3.1-8b-instant');
    // Sticky was set (success path).
    expect(ledgerMock.setStickyProvider).toHaveBeenCalledWith(
      expect.any(String), 'groq1', 'llama-3.1-8b-instant',
    );

    // Body is the wrapped SSE stream — read it.
    const body = await res.text();
    expect(body).toContain('data: {"choices"');
    expect(body).toContain('data: [DONE]');
  });

  // Test 9: Streaming pre-stream error → fallback
  it('falls back to the next provider when chatStream() rejects', async () => {
    const err = Object.assign(new Error('upstream 429'), { status: 429 });
    fakeAdapter.chatStream
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce(makeSSEStream());

    const res = await routeChatStream(makeReq(), fakeEnv, fakeCtx);
    await flush();

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Provider')).toBe('mistral');
    expect(res.headers.get('X-Fallback-Used')).toBe('true');
    expect(fakeAdapter.chatStream).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// handleFeedback tests
// ============================================================================

describe('model_router — handleFeedback', () => {

  // Test 10: handleFeedback updates ledger
  it('looks up the provider via D1 + records feedback with the provider + intent', async () => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue({ provider: 'groq1', intent: 'simple_chat' }),
      all: vi.fn(),
      run: vi.fn(),
    };
    const fakeDB = { prepare: vi.fn(() => stmt) } as unknown as D1Database;
    const envWithDB = { ...fakeEnv, DB: fakeDB } as unknown as Env;

    await handleFeedback('msg-123', 1, envWithDB);

    expect(fakeDB.prepare).toHaveBeenCalledWith(expect.stringContaining('FROM provider_calls'));
    expect(stmt.bind).toHaveBeenCalledWith('msg-123');
    expect(ledgerMock.recordFeedback).toHaveBeenCalledWith('groq1', 1, 'msg-123', 'simple_chat');
  });

  it('falls back to sticky-session lookup when D1 returns no row', async () => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn(),
      run: vi.fn(),
    };
    const fakeDB = { prepare: vi.fn(() => stmt) } as unknown as D1Database;
    const envWithDB = { ...fakeEnv, DB: fakeDB } as unknown as Env;
    ledgerMock.getStickyProvider.mockResolvedValue('mistral');

    await handleFeedback('msg-456', -1, envWithDB);

    expect(ledgerMock.getStickyProvider).toHaveBeenCalledWith('msg-456');
    expect(ledgerMock.recordFeedback).toHaveBeenCalledWith('mistral', -1, 'msg-456', undefined);
  });

  it('records no feedback when the provider cannot be attributed', async () => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn(),
      run: vi.fn(),
    };
    const fakeDB = { prepare: vi.fn(() => stmt) } as unknown as D1Database;
    const envWithDB = { ...fakeEnv, DB: fakeDB } as unknown as Env;
    ledgerMock.getStickyProvider.mockResolvedValue(null);

    await handleFeedback('msg-789', 1, envWithDB);

    expect(ledgerMock.recordFeedback).not.toHaveBeenCalled();
  });

  it('returns silently when env.DB is not configured', async () => {
    const envNoDB = { ...fakeEnv, DB: undefined } as unknown as Env;
    await expect(handleFeedback('msg', 1, envNoDB)).resolves.toBeUndefined();
    expect(QuotaLedger).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Misc edge-case tests (bonus coverage)
// ============================================================================

describe('model_router — edge cases', () => {

  it('returns 400 when messages is empty', async () => {
    const res = await routeChat({ model: 'x', messages: [] } as never, fakeEnv, fakeCtx);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('invalid_messages');
  });

  it('returns 503 when no providers are healthy', async () => {
    vi.mocked(getHealthyProviders).mockResolvedValue([]);
    const res = await routeChat(makeReq(), fakeEnv, fakeCtx);
    expect(res.status).toBe(503);
    const body = await res.json() as { error: { code: string; attempted_providers: unknown[] } };
    expect(body.error.code).toBe('all_providers_exhausted');
    expect(body.error.attempted_providers).toEqual([]);
  });

  it('skips a provider whose decrementQuota returns ok=false', async () => {
    // groq1 quota exhausted, mistral has quota.
    ledgerMock.decrementQuota.mockImplementation((provider: string) =>
      Promise.resolve(provider === 'groq1' ? { ok: false, remaining: 0 } : { ok: true, remaining: 500 }),
    );

    const res = await routeChat(makeReq(), fakeEnv, fakeCtx);
    await flush();

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Provider')).toBe('mistral');
    // groq1 was NOT actually called (decrement returned ok=false).
    expect(fakeAdapter.chat).toHaveBeenCalledTimes(1);
  });

  it('derives conversation_id from the first user message when metadata is absent', async () => {
    const req = makeReq([{ role: 'user', content: 'first user turn' }]);
    await routeChat(req, fakeEnv, fakeCtx);
    await flush();

    // setStickyProvider was called with a conversation_id derived from the
    // message hash (prefix 'cid:'), proving the fallback hash path was used.
    expect(ledgerMock.setStickyProvider).toHaveBeenCalledWith(
      expect.stringMatching(/^cid:/), 'groq1', 'llama-3.1-8b-instant',
    );
  });

  it('uses the explicit conversation_id from metadata when provided', async () => {
    const req = makeReq();
    (req as { metadata?: unknown }).metadata = { conversation_id: 'conv-explicit-123' };
    await routeChat(req, fakeEnv, fakeCtx);
    await flush();

    expect(ledgerMock.setStickyProvider).toHaveBeenCalledWith(
      'conv-explicit-123', 'groq1', 'llama-3.1-8b-instant',
    );
  });

  it('records a 429 call audit with status="429" on rate-limit failures', async () => {
    const err = Object.assign(new Error('upstream 429'), { status: 429 });
    fakeAdapter.chat
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce(makeChatResponse() as never);

    await routeChat(makeReq(), fakeEnv, fakeCtx);
    await flush();

    expect(ledgerMock.recordCall).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'groq1',
      status: '429',
    }));
  });
});
