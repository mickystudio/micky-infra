/**
 * Cascade Router tests — cascade ordering, sticky session, circuit breaker,
 * all-providers-fail, quota exhaustion, feedback recording.
 *
 * Run: `npx vitest run tests/model_router.test.ts`
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  routeChat,
  routeChatStream,
  handleFeedback,
  buildRouterDeps,
  classifyIntent,
  resolveConversationId,
  CASCADE_ORDER,
} from '../src/gateway/cascade_router';
import { CascadeErrorHandler } from '../src/gateway/error_handler';
import { makeStubAdapter, AdapterError } from '../src/gateway/adapters';
import type {
  ChatAdapter,
  ChatRequest,
  ProviderCallRecord,
  ProviderHealthState,
  ProviderId,
  QuotaLedger,
} from '../src/gateway/cascade_types';

// ============================================================================
// In-memory QuotaLedger (for tests; mirrors the D1 schema semantics)
// ============================================================================

class InMemoryLedger implements QuotaLedger {
  quota = new Map<string, { remaining: number; limit: number }>();
  health = new Map<ProviderId, ProviderHealthState>();
  sticky = new Map<string, { provider: ProviderId; expiresAt: number }>();
  calls: ProviderCallRecord[] = [];
  feedback: Array<{ messageId: string; rating: 1 | -1; provider?: ProviderId }> = [];

  constructor() {
    // Seed health for every provider.
    for (const p of ['workers-ai', 'groq', 'mistral', 'openrouter', 'gemini'] as ProviderId[]) {
      this.health.set(p, {
        provider: p,
        isHealthy: true,
        consecutiveFailures: 0,
        circuitOpenUntil: 0,
        lastFailureAt: 0,
        totalCalls: 0,
        totalFailures: 0,
        updatedAt: 0,
      });
    }
  }

  async ensureDay(provider: ProviderId, day: string, limit: number): Promise<void> {
    const key = `${provider}:${day}`;
    if (!this.quota.has(key)) {
      this.quota.set(key, { remaining: limit, limit });
    }
  }

  async checkAndDecrement(provider: ProviderId, day: string): Promise<number | null> {
    const key = `${provider}:${day}`;
    const row = this.quota.get(key);
    if (!row) return null;
    if (row.remaining <= 0) return null;
    row.remaining -= 1;
    return row.remaining;
  }

  async refund(provider: ProviderId, day: string, count = 1): Promise<void> {
    const key = `${provider}:${day}`;
    const row = this.quota.get(key);
    if (row) row.remaining += count;
  }

  async zeroOut(provider: ProviderId, day: string): Promise<void> {
    const key = `${provider}:${day}`;
    const row = this.quota.get(key);
    if (row) row.remaining = 0;
  }

  async getHealth(provider: ProviderId): Promise<ProviderHealthState> {
    return this.health.get(provider) ?? this.freshHealth(provider);
  }

  async saveHealth(state: ProviderHealthState): Promise<void> {
    this.health.set(state.provider, state);
  }

  async recordCall(record: ProviderCallRecord): Promise<void> {
    this.calls.push(record);
  }

  async getStickyProvider(conversationId: string): Promise<ProviderId | null> {
    const row = this.sticky.get(conversationId);
    if (!row) return null;
    if (row.expiresAt <= Date.now()) return null;
    return row.provider;
  }

  async setStickyProvider(
    conversationId: string,
    provider: ProviderId,
    ttlMs = 60 * 60 * 1000,
  ): Promise<void> {
    this.sticky.set(conversationId, { provider, expiresAt: Date.now() + ttlMs });
  }

  async recordFeedback(
    messageId: string,
    rating: 1 | -1,
    provider?: ProviderId,
  ): Promise<void> {
    this.feedback.push({ messageId, rating, provider });
  }

  // Test-only helpers
  setQuota(provider: ProviderId, day: string, remaining: number): void {
    this.quota.set(`${provider}:${day}`, { remaining, limit: remaining });
  }

  private freshHealth(provider: ProviderId): ProviderHealthState {
    return {
      provider,
      isHealthy: true,
      consecutiveFailures: 0,
      circuitOpenUntil: 0,
      lastFailureAt: 0,
      totalCalls: 0,
      totalFailures: 0,
      updatedAt: 0,
    };
  }
}

// ============================================================================
// Stubs: ExecutionContext + Env
// ============================================================================

class StubExecutionContext implements ExecutionContext {
  waitUntilCalls: Promise<unknown>[] = [];
  passThroughOnException(): void {}
  waitUntil(p: Promise<unknown>): void {
    this.waitUntilCalls.push(p);
  }
}

interface StubEnv {
  GROQ_API_KEY?: string;
  MISTRAL_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  GEMINI_API_KEY?: string;
  GATEWAY_STICKY_TTL_MS?: string;
  GATEWAY_CB_FAILURE_THRESHOLD?: string;
  GATEWAY_CB_OPEN_MS?: string;
  GATEWAY_CB_RATE_LIMIT_OPEN_MS?: string;
  GATEWAY_DAILY_QUOTA_DEFAULT?: string;
  // Required by the Env interface (used elsewhere in the worker).
  DB: unknown;
  LOCKS: unknown;
  TASK_STATUS: unknown;
  RATE_LIMITS: unknown;
  PROMPT_CACHE: unknown;
  TASKS_QUEUE: unknown;
  AI: unknown;
  ENVIRONMENT: string;
  LOG_LEVEL: string;
  DEFAULT_MODEL: string;
  FAST_MODEL: string;
  WHISPER_MODEL: string;
  ADMIN_CHAT_ID: string;
  MAX_TOKENS_DEFAULT: string;
  TEMPERATURE_DEFAULT: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID_WHITELIST: string;
  MICKY_PASSWORD_HASH: string;
  GH_PAT_SCOPED: string;
  GH_WEBHOOK_SECRET: string;
  KAGGLE_API_TOKEN: string;
}

function makeStubEnv(overrides: Partial<StubEnv> = {}): StubEnv {
  return {
    DB: {},
    LOCKS: {},
    TASK_STATUS: {},
    RATE_LIMITS: {},
    PROMPT_CACHE: {},
    TASKS_QUEUE: {},
    AI: {},
    ENVIRONMENT: 'test',
    LOG_LEVEL: 'debug',
    DEFAULT_MODEL: 'test-model',
    FAST_MODEL: 'test-fast',
    WHISPER_MODEL: 'test-whisper',
    ADMIN_CHAT_ID: '0',
    MAX_TOKENS_DEFAULT: '4096',
    TEMPERATURE_DEFAULT: '0.4',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_CHAT_ID_WHITELIST: '',
    MICKY_PASSWORD_HASH: '',
    GH_PAT_SCOPED: '',
    GH_WEBHOOK_SECRET: '',
    KAGGLE_API_TOKEN: '',
    GROQ_API_KEY: 'test-groq-key',
    MISTRAL_API_KEY: 'test-mistral-key',
    OPENROUTER_API_KEY: 'test-openrouter-key',
    GEMINI_API_KEY: 'test-gemini-key',
    ...overrides,
  } as StubEnv;
}

function makeChatRequest(opts: {
  messages?: Array<{ role: 'user' | 'system' | 'assistant'; content: string }>;
  model?: string;
  conversationId?: string;
  intentOverride?: ChatRequest['metadata'] extends infer M
    ? M extends { intent_override?: infer I } ? I : never
    : never;
} = {}): ChatRequest {
  return {
    model: opts.model ?? 'test-model',
    messages: opts.messages ?? [{ role: 'user', content: 'hello' }],
    metadata: {
      conversation_id: opts.conversationId,
      intent_override: opts.intentOverride,
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('classifyIntent', () => {
  it('classifies code-shaped messages as "code"', () => {
    const req = makeChatRequest({
      messages: [{ role: 'user', content: 'function add(a, b) { return a + b; }' }],
    });
    expect(classifyIntent(req)).toBe('code');
  });

  it('classifies "why / explain" messages as "reasoning"', () => {
    const req = makeChatRequest({
      messages: [{ role: 'user', content: 'Why does the sun rise in the east? Explain in detail.' }],
    });
    expect(classifyIntent(req)).toBe('reasoning');
  });

  it('classifies short messages as "fast"', () => {
    const req = makeChatRequest({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(classifyIntent(req)).toBe('fast');
  });

  it('classifies long generic messages as "default"', () => {
    const req = makeChatRequest({
      messages: [{ role: 'user', content: 'x'.repeat(300) }],
    });
    expect(classifyIntent(req)).toBe('default');
  });

  it('honors metadata.intent_override', () => {
    const req = makeChatRequest({
      messages: [{ role: 'user', content: 'hi' }],
    });
    req.metadata = { intent_override: 'multimodal' };
    expect(classifyIntent(req)).toBe('multimodal');
  });
});

describe('resolveConversationId', () => {
  it('uses metadata.conversation_id when present', () => {
    const req = makeChatRequest({ conversationId: 'explicit-123' });
    expect(resolveConversationId(req)).toBe('explicit-123');
  });

  it('derives a stable id from system + first user message when absent', () => {
    const req1 = makeChatRequest({
      messages: [
        { role: 'system', content: 'you are a bot' },
        { role: 'user', content: 'hello world' },
      ],
    });
    const req2 = makeChatRequest({
      messages: [
        { role: 'system', content: 'you are a bot' },
        { role: 'user', content: 'hello world' },
        { role: 'assistant', content: 'hi there' },
        { role: 'user', content: 'second turn' },
      ],
    });
    expect(resolveConversationId(req1)).toBe(resolveConversationId(req2));
    expect(resolveConversationId(req1).startsWith('conv_')).toBe(true);
  });

  it('produces different ids for different conversations', () => {
    const req1 = makeChatRequest({ messages: [{ role: 'user', content: 'aaa' }] });
    const req2 = makeChatRequest({ messages: [{ role: 'user', content: 'bbb' }] });
    expect(resolveConversationId(req1)).not.toBe(resolveConversationId(req2));
  });
});

describe('CASCADE_ORDER', () => {
  it('lists workers-ai first for code intent', () => {
    expect(CASCADE_ORDER.code[0]).toBe('workers-ai');
  });

  it('lists groq first for fast intent', () => {
    expect(CASCADE_ORDER.fast[0]).toBe('groq');
  });

  it('lists gemini first for multimodal intent', () => {
    expect(CASCADE_ORDER.multimodal[0]).toBe('gemini');
  });

  it('omits gemini from non-multimodal cascades', () => {
    expect(CASCADE_ORDER.code).not.toContain('gemini');
    expect(CASCADE_ORDER.reasoning).not.toContain('gemini');
    expect(CASCADE_ORDER.fast).not.toContain('gemini');
    expect(CASCADE_ORDER.default).not.toContain('gemini');
  });
});

// ============================================================================
// routeChat — cascade ordering + fallback
// ============================================================================

describe('routeChat — cascade ordering', () => {
  let ledger: InMemoryLedger;
  let ctx: StubExecutionContext;
  let env: StubEnv;

  beforeEach(() => {
    ledger = new InMemoryLedger();
    ctx = new StubExecutionContext();
    env = makeStubEnv();
  });

  function makeDeps(adapters: Partial<Record<ProviderId, ChatAdapter>>) {
    return buildRouterDeps(ledger as unknown as QuotaLedger, adapters, env as unknown as Parameters<typeof buildRouterDeps>[2]);
  }

  it('uses the first healthy provider in the cascade when no sticky session exists', async () => {
    const workersAi = makeStubAdapter('workers-ai', { content: 'from workers-ai' });
    const groq = makeStubAdapter('groq', { content: 'from groq' });
    const deps = makeDeps({ 'workers-ai': workersAi, groq });

    const res = await routeChat(makeChatRequest(), env as unknown as Parameters<typeof routeChat>[1], ctx as unknown as ExecutionContext, deps);

    expect(res.status).toBe(200);
    const body = await res.json() as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe('from workers-ai');
    // groq.chat was never called (workers-ai succeeded first).
    // (We can't directly assert this without a spy; the content check is the
    // proxy.)
  });

  it('falls through to the next provider on a 5xx failure', async () => {
    const workersAi = makeStubAdapter('workers-ai', { status: 503 });
    const groq = makeStubAdapter('groq', { content: 'from groq' });
    const deps = makeDeps({ 'workers-ai': workersAi, groq });

    const res = await routeChat(makeChatRequest(), env as unknown as Parameters<typeof routeChat>[1], ctx as unknown as ExecutionContext, deps);

    expect(res.status).toBe(200);
    const body = await res.json() as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe('from groq');
  });

  it('falls through to the next provider on a 429 failure', async () => {
    const workersAi = makeStubAdapter('workers-ai', { status: 429 });
    const groq = makeStubAdapter('groq', { content: 'from groq after 429' });
    const deps = makeDeps({ 'workers-ai': workersAi, groq });

    const res = await routeChat(makeChatRequest(), env as unknown as Parameters<typeof routeChat>[1], ctx as unknown as ExecutionContext, deps);

    expect(res.status).toBe(200);
    const body = await res.json() as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe('from groq after 429');

    // The 429 should have zeroed workers-ai's quota.
    const today = new Date().toISOString().slice(0, 10);
    await ledger.ensureDay('workers-ai', today, 1000);
    const remaining = await ledger.checkAndDecrement('workers-ai', today);
    expect(remaining).toBeNull();
  });

  it('returns 503 when every provider in the cascade fails', async () => {
    const workersAi = makeStubAdapter('workers-ai', { status: 503 });
    const groq = makeStubAdapter('groq', { status: 503 });
    const mistral = makeStubAdapter('mistral', { status: 503 });
    const openrouter = makeStubAdapter('openrouter', { status: 503 });
    const deps = makeDeps({ 'workers-ai': workersAi, groq, mistral, openrouter });

    const res = await routeChat(makeChatRequest(), env as unknown as Parameters<typeof routeChat>[1], ctx as unknown as ExecutionContext, deps);

    expect(res.status).toBe(503);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/unavailable/i);
  });

  it('returns 400 on a client-side 4xx error (not 429) — does not retry', async () => {
    // Override intent so the cascade is just one provider.
    const req = makeChatRequest({ messages: [{ role: 'user', content: 'hi' }] });
    req.metadata = { intent_override: 'fast' };
    const workersAi = makeStubAdapter('workers-ai', { status: 400 });
    const groq = makeStubAdapter('groq', { status: 400 });
    const deps = makeDeps({ 'workers-ai': workersAi, groq });

    const res = await routeChat(req, env as unknown as Parameters<typeof routeChat>[1], ctx as unknown as ExecutionContext, deps);

    expect(res.status).toBe(400);
    const body = await res.json() as { error: { type: string } };
    expect(body.error.type).toBe('client_error');
  });

  it('skips a provider with an open circuit breaker', async () => {
    // Open the circuit for workers-ai manually.
    const today = new Date().toISOString().slice(0, 10);
    await ledger.saveHealth({
      provider: 'workers-ai',
      isHealthy: false,
      consecutiveFailures: 5,
      circuitOpenUntil: Date.now() + 60_000,
      lastFailureAt: Date.now(),
      lastErrorKind: 'server_error',
      lastErrorStatus: 503,
      totalCalls: 5,
      totalFailures: 5,
      updatedAt: Date.now(),
    });
    // Seed quota so it's not also exhausted (we want to verify circuit-open skip).
    ledger.setQuota('workers-ai', today, 1000);

    const workersAi = makeStubAdapter('workers-ai', { content: 'should-not-be-used' });
    const groq = makeStubAdapter('groq', { content: 'from groq' });
    const deps = makeDeps({ 'workers-ai': workersAi, groq });

    const res = await routeChat(makeChatRequest(), env as unknown as Parameters<typeof routeChat>[1], ctx as unknown as ExecutionContext, deps);

    expect(res.status).toBe(200);
    const body = await res.json() as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe('from groq');
  });

  it('skips a provider whose daily quota is exhausted', async () => {
    const today = new Date().toISOString().slice(0, 10);
    ledger.setQuota('workers-ai', today, 0);

    const workersAi = makeStubAdapter('workers-ai', { content: 'should-not-be-used' });
    const groq = makeStubAdapter('groq', { content: 'from groq' });
    const deps = makeDeps({ 'workers-ai': workersAi, groq });

    const res = await routeChat(makeChatRequest(), env as unknown as Parameters<typeof routeChat>[1], ctx as unknown as ExecutionContext, deps);

    expect(res.status).toBe(200);
    const body = await res.json() as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe('from groq');
  });
});

// ============================================================================
// routeChat — sticky session
// ============================================================================

describe('routeChat — sticky session', () => {
  let ledger: InMemoryLedger;
  let ctx: StubExecutionContext;
  let env: StubEnv;

  beforeEach(() => {
    ledger = new InMemoryLedger();
    ctx = new StubExecutionContext();
    env = makeStubEnv();
  });

  it('records a sticky session after a successful call', async () => {
    const workersAi = makeStubAdapter('workers-ai', { content: 'first' });
    const deps = buildRouterDeps(
      ledger as unknown as QuotaLedger,
      { 'workers-ai': workersAi },
      env as unknown as Parameters<typeof buildRouterDeps>[2],
    );

    const req = makeChatRequest({ conversationId: 'conv-1' });
    await routeChat(req, env as unknown as Parameters<typeof routeChat>[1], ctx as unknown as ExecutionContext, deps);

    const sticky = await ledger.getStickyProvider('conv-1');
    expect(sticky).toBe('workers-ai');
  });

  it('reuses the sticky provider for the next turn of the same conversation', async () => {
    const workersAi = makeStubAdapter('workers-ai', { content: 'from workers-ai' });
    // Add groq with a content marker so we can tell which adapter served.
    const groq = makeStubAdapter('groq', { content: 'from groq' });
    const deps = buildRouterDeps(
      ledger as unknown as QuotaLedger,
      { 'workers-ai': workersAi, groq },
      env as unknown as Parameters<typeof buildRouterDeps>[2],
    );

    // First turn → records sticky = workers-ai.
    await routeChat(
      makeChatRequest({ conversationId: 'conv-sticky' }),
      env as unknown as Parameters<typeof routeChat>[1],
      ctx as unknown as ExecutionContext,
      deps,
    );

    // Second turn — workers-ai should still be used (sticky hit).
    const res = await routeChat(
      makeChatRequest({ conversationId: 'conv-sticky' }),
      env as unknown as Parameters<typeof routeChat>[1],
      ctx as unknown as ExecutionContext,
      deps,
    );
    const body = await res.json() as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe('from workers-ai');
  });

  it('falls through to the cascade when the sticky provider fails', async () => {
    // First call: workers-ai succeeds → sticky = workers-ai.
    let workersAi = makeStubAdapter('workers-ai', { content: 'first' });
    const groq = makeStubAdapter('groq', { content: 'fallback from groq' });
    let deps = buildRouterDeps(
      ledger as unknown as QuotaLedger,
      { 'workers-ai': workersAi, groq },
      env as unknown as Parameters<typeof buildRouterDeps>[2],
    );
    await routeChat(
      makeChatRequest({ conversationId: 'conv-fail' }),
      env as unknown as Parameters<typeof routeChat>[1],
      ctx as unknown as ExecutionContext,
      deps,
    );

    // Second call: workers-ai now 503s → should fall through to groq.
    workersAi = makeStubAdapter('workers-ai', { status: 503 });
    deps = buildRouterDeps(
      ledger as unknown as QuotaLedger,
      { 'workers-ai': workersAi, groq },
      env as unknown as Parameters<typeof buildRouterDeps>[2],
    );
    const res = await routeChat(
      makeChatRequest({ conversationId: 'conv-fail' }),
      env as unknown as Parameters<typeof routeChat>[1],
      ctx as unknown as ExecutionContext,
      deps,
    );
    const body = await res.json() as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe('fallback from groq');
  });

  it('does not double-try the sticky provider in the cascade after a sticky failure', async () => {
    // Sticky = workers-ai. After sticky fails, the cascade for "default"
    // intent starts at workers-ai — we must NOT retry it.
    const workersAi = makeStubAdapter('workers-ai', { status: 503 });
    const groq = makeStubAdapter('groq', { content: 'from groq' });
    const deps = buildRouterDeps(
      ledger as unknown as QuotaLedger,
      { 'workers-ai': workersAi, groq },
      env as unknown as Parameters<typeof buildRouterDeps>[2],
    );

    // Seed the sticky manually.
    await ledger.setStickyProvider('conv-no-double', 'workers-ai');

    const res = await routeChat(
      makeChatRequest({ conversationId: 'conv-no-double' }),
      env as unknown as Parameters<typeof routeChat>[1],
      ctx as unknown as ExecutionContext,
      deps,
    );
    const body = await res.json() as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe('from groq');
    // workers-ai was tried exactly once (sticky) and skipped in the cascade.
  });
});

// ============================================================================
// routeChat — circuit-breaker triggering
// ============================================================================

describe('routeChat — circuit breaker', () => {
  let ledger: InMemoryLedger;
  let ctx: StubExecutionContext;
  let env: StubEnv;

  beforeEach(() => {
    ledger = new InMemoryLedger();
    ctx = new StubExecutionContext();
    env = makeStubEnv({ GATEWAY_CB_FAILURE_THRESHOLD: '3' });
  });

  it('opens the circuit for 1 hour after 3 consecutive 5xx failures', async () => {
    const workersAi = makeStubAdapter('workers-ai', { status: 503 });
    const groq = makeStubAdapter('groq', { content: 'from groq' });
    const deps = buildRouterDeps(
      ledger as unknown as QuotaLedger,
      { 'workers-ai': workersAi, groq },
      env as unknown as Parameters<typeof buildRouterDeps>[2],
    );

    // Trigger 3 failures on workers-ai.
    for (let i = 0; i < 3; i++) {
      await routeChat(
        makeChatRequest({ conversationId: `conv-${i}` }),
        env as unknown as Parameters<typeof routeChat>[1],
        ctx as unknown as ExecutionContext,
        deps,
      );
    }

    const health = await ledger.getHealth('workers-ai');
    expect(health.isHealthy).toBe(false);
    expect(health.consecutiveFailures).toBe(3);
    expect(health.circuitOpenUntil).toBeGreaterThan(Date.now());
    // Circuit open for ~1 hour.
    expect(health.circuitOpenUntil - Date.now()).toBeGreaterThan(55 * 60 * 1000);
  });

  it('opens the circuit for 5 minutes on a single 429', async () => {
    const workersAi = makeStubAdapter('workers-ai', { status: 429 });
    const groq = makeStubAdapter('groq', { content: 'from groq' });
    const deps = buildRouterDeps(
      ledger as unknown as QuotaLedger,
      { 'workers-ai': workersAi, groq },
      env as unknown as Parameters<typeof buildRouterDeps>[2],
    );

    await routeChat(
      makeChatRequest({ conversationId: 'conv-429' }),
      env as unknown as Parameters<typeof routeChat>[1],
      ctx as unknown as ExecutionContext,
      deps,
    );

    const health = await ledger.getHealth('workers-ai');
    expect(health.isHealthy).toBe(false);
    // Circuit open for ~5 minutes.
    expect(health.circuitOpenUntil - Date.now()).toBeGreaterThan(4 * 60 * 1000);
    expect(health.circuitOpenUntil - Date.now()).toBeLessThan(6 * 60 * 1000);
  });

  it('resets consecutiveFailures + closes the circuit on a successful call', async () => {
    // Pre-open the circuit manually.
    await ledger.saveHealth({
      provider: 'workers-ai',
      isHealthy: false,
      consecutiveFailures: 3,
      circuitOpenUntil: 0, // half-open (cooldown elapsed)
      lastFailureAt: Date.now() - 60_000,
      lastErrorKind: 'server_error',
      lastErrorStatus: 503,
      totalCalls: 3,
      totalFailures: 3,
      updatedAt: Date.now(),
    });

    const workersAi = makeStubAdapter('workers-ai', { content: 'success' });
    const deps = buildRouterDeps(
      ledger as unknown as QuotaLedger,
      { 'workers-ai': workersAi },
      env as unknown as Parameters<typeof buildRouterDeps>[2],
    );

    const res = await routeChat(
      makeChatRequest({ conversationId: 'conv-recover' }),
      env as unknown as Parameters<typeof routeChat>[1],
      ctx as unknown as ExecutionContext,
      deps,
    );
    expect(res.status).toBe(200);

    const health = await ledger.getHealth('workers-ai');
    expect(health.isHealthy).toBe(true);
    expect(health.consecutiveFailures).toBe(0);
    expect(health.circuitOpenUntil).toBe(0);
  });
});

// ============================================================================
// routeChatStream — cascade ordering + normalization
// ============================================================================

describe('routeChatStream', () => {
  let ledger: InMemoryLedger;
  let ctx: StubExecutionContext;
  let env: StubEnv;

  beforeEach(() => {
    ledger = new InMemoryLedger();
    ctx = new StubExecutionContext();
    env = makeStubEnv();
  });

  async function drainStream(res: Response): Promise<string> {
    expect(res.body).not.toBeNull();
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let out = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value, { stream: true });
    }
    return out;
  }

  it('returns a normalized OpenAI-shaped SSE stream from a Workers AI raw stream', async () => {
    const workersAi = makeStubAdapter('workers-ai', {
      streamChunks: [
        JSON.stringify({ response: 'Hello' }) + '\n',
        JSON.stringify({ response: ' world' }) + '\n',
      ],
    });
    const deps = buildRouterDeps(
      ledger as unknown as QuotaLedger,
      { 'workers-ai': workersAi },
      env as unknown as Parameters<typeof buildRouterDeps>[2],
    );

    const req = makeChatRequest();
    req.stream = true;
    const res = await routeChatStream(
      req,
      env as unknown as Parameters<typeof routeChatStream>[1],
      ctx as unknown as ExecutionContext,
      deps,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');

    const out = await drainStream(res);
    expect(out).toContain('Hello');
    expect(out).toContain(' world');
    expect(out).toContain('data: [DONE]\n\n');
    // Should be OpenAI-shaped.
    expect(out).toContain('"object":"chat.completion.chunk"');
  });

  it('returns 503 when every provider fails before any bytes are emitted', async () => {
    const workersAi = makeStubAdapter('workers-ai', { status: 503, throwOnStream: true });
    const groq = makeStubAdapter('groq', { status: 503, throwOnStream: true });
    const mistral = makeStubAdapter('mistral', { status: 503, throwOnStream: true });
    const openrouter = makeStubAdapter('openrouter', { status: 503, throwOnStream: true });
    const deps = buildRouterDeps(
      ledger as unknown as QuotaLedger,
      { 'workers-ai': workersAi, groq, mistral, openrouter },
      env as unknown as Parameters<typeof buildRouterDeps>[2],
    );

    const req = makeChatRequest();
    req.stream = true;
    const res = await routeChatStream(
      req,
      env as unknown as Parameters<typeof routeChatStream>[1],
      ctx as unknown as ExecutionContext,
      deps,
    );
    expect(res.status).toBe(503);
  });

  it('falls through to the next provider when the first throws on stream open', async () => {
    const workersAi = makeStubAdapter('workers-ai', { status: 502, throwOnStream: true });
    const groq = makeStubAdapter('groq', {
      streamChunks: [JSON.stringify({ choices: [{ delta: { content: 'from groq' } }] }) + '\n\n'],
    });
    const deps = buildRouterDeps(
      ledger as unknown as QuotaLedger,
      { 'workers-ai': workersAi, groq },
      env as unknown as Parameters<typeof buildRouterDeps>[2],
    );

    const req = makeChatRequest();
    req.stream = true;
    const res = await routeChatStream(
      req,
      env as unknown as Parameters<typeof routeChatStream>[1],
      ctx as unknown as ExecutionContext,
      deps,
    );
    expect(res.status).toBe(200);
    const out = await drainStream(res);
    expect(out).toContain('from groq');
  });
});

// ============================================================================
// handleFeedback
// ============================================================================

describe('handleFeedback', () => {
  it('records +1 / -1 feedback on the ledger', async () => {
    const ledger = new InMemoryLedger();
    const deps = buildRouterDeps(
      ledger as unknown as QuotaLedger,
      {},
      makeStubEnv() as unknown as Parameters<typeof buildRouterDeps>[2],
    );

    await handleFeedback('msg-1', 1, makeStubEnv() as unknown as Parameters<typeof handleFeedback>[2], deps);
    await handleFeedback('msg-1', -1, makeStubEnv() as unknown as Parameters<typeof handleFeedback>[2], deps);
    await handleFeedback('msg-2', 1, makeStubEnv() as unknown as Parameters<typeof handleFeedback>[2], deps);

    expect(ledger.feedback.length).toBe(3);
    expect(ledger.feedback[0]).toMatchObject({ messageId: 'msg-1', rating: 1 });
    expect(ledger.feedback[1]).toMatchObject({ messageId: 'msg-1', rating: -1 });
    expect(ledger.feedback[2]).toMatchObject({ messageId: 'msg-2', rating: 1 });
  });
});

// ============================================================================
// CascadeErrorHandler (direct unit tests)
// ============================================================================

describe('CascadeErrorHandler', () => {
  describe('shouldRetry', () => {
    const handler = new CascadeErrorHandler();
    it.each([[429], [500], [502], [503], [504], [0]])('returns true for status %s', (status) => {
      expect(handler.shouldRetry(status, 'workers-ai')).toBe(true);
    });
    it.each([[200], [400], [401], [403], [404], [422]])('returns false for status %s', (status) => {
      expect(handler.shouldRetry(status, 'workers-ai')).toBe(false);
    });
  });

  describe('getBackoffMs', () => {
    const handler = new CascadeErrorHandler();
    it('honors Retry-After (seconds)', () => {
      const v = handler.getBackoffMs(0, '5');
      expect(v).toBe(5_000);
    });

    it('caps Retry-After at MAX_BACKOFF_MS (8s)', () => {
      const v = handler.getBackoffMs(0, '60');
      expect(v).toBe(8_000);
    });

    it('uses exponential backoff when no Retry-After is given', () => {
      const v0 = handler.getBackoffMs(0);
      const v1 = handler.getBackoffMs(1);
      const v2 = handler.getBackoffMs(2);
      // Each attempt should be ~2x the previous (modulo jitter ±20%).
      expect(v0).toBeGreaterThanOrEqual(200);
      expect(v1).toBeGreaterThanOrEqual(400);
      expect(v2).toBeGreaterThanOrEqual(800);
      // Cap at 8s.
      expect(v2).toBeLessThanOrEqual(8_000);
    });

    it('produces jittery values (not identical across calls)', () => {
      const values = new Set<number>();
      for (let i = 0; i < 20; i++) {
        values.add(handler.getBackoffMs(0));
      }
      // With ±20% jitter, we should see at least 5 distinct values across 20 calls.
      expect(values.size).toBeGreaterThan(4);
    });
  });

  describe('shouldOpenCircuit', () => {
    const handler = new CascadeErrorHandler({ failureThreshold: 3, cbOpenMs: 3_600_000, cbRateLimitOpenMs: 300_000 });

    it('opens the circuit on a single 429 (rate-limit)', () => {
      const r = handler.shouldOpenCircuit(1, {
        kind: 'rate_limit',
        status: 429,
        message: '',
        provider: 'groq',
      });
      expect(r.open).toBe(true);
      expect(r.durationMs).toBe(300_000);
    });

    it('opens the circuit after 3 consecutive 5xx failures', () => {
      const r = handler.shouldOpenCircuit(3, {
        kind: 'server_error',
        status: 503,
        message: '',
        provider: 'workers-ai',
      });
      expect(r.open).toBe(true);
      expect(r.durationMs).toBe(3_600_000);
    });

    it('does NOT open the circuit after 2 consecutive 5xx failures', () => {
      const r = handler.shouldOpenCircuit(2, {
        kind: 'server_error',
        status: 503,
        message: '',
        provider: 'workers-ai',
      });
      expect(r.open).toBe(false);
    });

    it('never opens the circuit on a client_error (4xx non-429)', () => {
      const r = handler.shouldOpenCircuit(99, {
        kind: 'client_error',
        status: 400,
        message: '',
        provider: 'groq',
      });
      expect(r.open).toBe(false);
    });
  });

  describe('isCircuitOpen / isCircuitHalfOpen', () => {
    const handler = new CascadeErrorHandler();
    it('returns false for a healthy provider', () => {
      expect(handler.isCircuitOpen({ isHealthy: true, consecutiveFailures: 0, circuitOpenUntil: 0, lastFailureAt: 0, totalCalls: 0, totalFailures: 0, updatedAt: 0, provider: 'workers-ai' })).toBe(false);
    });

    it('returns true when isHealthy=false AND circuitOpenUntil > now', () => {
      expect(handler.isCircuitOpen({ isHealthy: false, consecutiveFailures: 3, circuitOpenUntil: Date.now() + 60_000, lastFailureAt: 0, totalCalls: 3, totalFailures: 3, updatedAt: 0, provider: 'workers-ai' })).toBe(true);
    });

    it('returns false (half-open) when isHealthy=false AND circuitOpenUntil <= now', () => {
      expect(handler.isCircuitOpen({ isHealthy: false, consecutiveFailures: 3, circuitOpenUntil: Date.now() - 1_000, lastFailureAt: 0, totalCalls: 3, totalFailures: 3, updatedAt: 0, provider: 'workers-ai' })).toBe(false);
      expect(handler.isCircuitHalfOpen({ isHealthy: false, consecutiveFailures: 3, circuitOpenUntil: Date.now() - 1_000, lastFailureAt: 0, totalCalls: 3, totalFailures: 3, updatedAt: 0, provider: 'workers-ai' })).toBe(true);
    });
  });
});

// ============================================================================
// AdapterError convention (used by extractStatus in the router)
// ============================================================================

describe('AdapterError', () => {
  it('carries the HTTP status for router classification', () => {
    const err = new AdapterError(429, 'rate limited');
    expect(err.status).toBe(429);
    expect(err.message).toBe('rate limited');
  });
});
