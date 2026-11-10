/**
 * Micky Assistant — Multi-provider LLM Gateway (cascade layer)
 * ----------------------------------------------------------------------------
 * Shared types for the cascade router + SSE normalizer + error handler.
 *
 * This module is intentionally self-contained: it does NOT depend on the
 * parallel `gateway/types.ts` / `gateway/adapters/types.ts` modules (which
 * belong to other agents and target a different provider set). The cascade
 * layer owns its own minimal, OpenAI-compatible shape so the router, the SSE
 * normalizer and the circuit-breaker can all import from one place.
 *
 * Edge-only: every type here is a pure structural type. No runtime APIs are
 * referenced — the file is safe to import from any Workers entry point.
 *
 * Created: 2026-11-10  (Agent A8)
 */

// ============================================================================
// Provider registry
// ============================================================================

/**
 * Canonical provider ids the cascade router knows how to dispatch to.
 *
 * - `workers-ai`   — Cloudflare Workers AI binding (env.AI), in-process.
 * - `groq`         — OpenAI-compatible, very low latency.
 * - `mistral`      — OpenAI-compatible, monthly free quota.
 * - `openrouter`   — OpenAI-compatible aggregator, many models.
 * - `gemini`       — Native Google format (system_instruction / parts).
 *
 * Add a new provider here AND in {@link isProviderId} AND in the cascade
 * table in `model_router.ts`.
 */
export type ProviderId =
  | 'workers-ai'
  | 'groq'
  | 'mistral'
  | 'openrouter'
  | 'gemini';

/** Runtime guard for {@link ProviderId}. */
export function isProviderId(value: string): value is ProviderId {
  return (
    value === 'workers-ai' ||
    value === 'groq' ||
    value === 'mistral' ||
    value === 'openrouter' ||
    value === 'gemini'
  );
}

/** Human-readable provider labels (for logs / dashboards). */
export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = Object.freeze({
  'workers-ai': 'Cloudflare Workers AI',
  groq: 'Groq',
  mistral: 'Mistral AI',
  openrouter: 'OpenRouter',
  gemini: 'Google Gemini',
});

// ============================================================================
// Chat types (OpenAI-compatible subset)
// ============================================================================

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  tool_call_id?: string;
}

/**
 * Request shape accepted by the gateway. This is a strict superset of the
 * OpenAI `/v1/chat/completions` body: the extra `metadata` block drives the
 * cascade (sticky session id, project / user attribution, intent override).
 *
 * Adapters MUST tolerate unknown fields (forward-compatibility).
 */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string | string[];
  tools?: unknown[];
  tool_choice?: unknown;
  provider_options?: Record<string, unknown>;
  metadata?: ChatRequestMetadata;
}

export interface ChatRequestMetadata {
  /** Stable conversation id (sticky-session key). If absent, router derives one. */
  conversation_id?: string;
  /** Project / user attribution (logged in D1). */
  project_id?: string;
  user_id?: string;
  /** Outbound message id (used for feedback correlation). */
  message_id?: string;
  /** API key id (for per-key rate limiting / audit). */
  api_key_id?: string;
  /** Force a cascade intent; otherwise router classifies. */
  intent_override?: Intent;
  /** Force a specific provider (skips cascade + sticky; admin / debug only). */
  provider_override?: ProviderId;
}

/**
 * Intent classification drives the cascade order. See {@link classifyIntent}
 * in `model_router.ts` for the heuristics.
 */
export type Intent = 'code' | 'reasoning' | 'fast' | 'multimodal' | 'default';

// ============================================================================
// Normalized streaming chunk (OpenAI chat.completion.chunk shape)
// ============================================================================

/**
 * One OpenAI-shaped streaming delta. The SSE normalizer produces this shape
 * regardless of which provider emitted the underlying bytes.
 *
 * The shape is intentionally narrower than the full OpenAI schema: only the
 * fields the gateway actually emits are typed. Unknown fields are tolerated
 * by the OpenAI SDK clients we target.
 */
export interface DeltaChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | null;
  }>;
  /** Optional usage block carried by the final chunk (when known). */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ============================================================================
// Cascade errors + circuit-breaker state
// ============================================================================

/**
 * Classified cascade error. The error handler turns a raw HTTP / network
 * failure into one of these so the router can decide whether to retry, open
 * the circuit, or surface to the client.
 */
export interface CascadeError {
  kind: 'rate_limit' | 'server_error' | 'network' | 'client_error' | 'timeout';
  /** HTTP status (0 for network errors / timeouts). */
  status: number;
  message: string;
  provider: ProviderId;
  /** Seconds the provider asked us to wait (from `Retry-After`). */
  retryAfterSeconds?: number;
}

/**
 * Per-provider circuit-breaker / health snapshot, persisted in D1.
 *
 *   - `isHealthy = false`              → circuit open; skip provider.
 *   - `circuitOpenUntil > now`         → circuit open until epoch-ms.
 *   - `consecutiveFailures >= N`       → open the circuit (see thresholds).
 */
export interface ProviderHealthState {
  provider: ProviderId;
  isHealthy: boolean;
  consecutiveFailures: number;
  circuitOpenUntil: number; // epoch ms; 0 = not open
  lastFailureAt: number; // epoch ms
  lastErrorKind?: CascadeError['kind'];
  lastErrorStatus?: number;
  totalCalls: number;
  totalFailures: number;
  updatedAt: number; // epoch ms
}

/** Successful / failed call record (persisted in D1 for SLO + feedback baseline). */
export interface ProviderCallRecord {
  provider: ProviderId;
  intent: Intent;
  conversationId: string;
  messageId: string;
  statusCode: number;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  success: boolean;
  errorKind?: CascadeError['kind'];
  errorMessage?: string;
}

// ============================================================================
// Quota ledger (D1-backed; abstracted for testability)
// ============================================================================

/**
 * D1-backed ledger for per-provider daily quota + circuit-breaker state +
 * sticky-session storage.
 *
 * The router depends only on this interface so tests can inject an in-memory
 * implementation. Production wires up {@link D1QuotaLedger}.
 *
 * All quota mutations MUST be atomic (single-statement
 * `UPDATE ... WHERE remaining > 0 RETURNING`) so concurrent requests can't
 * oversell the same provider's daily budget.
 */
export interface QuotaLedger {
  /** Ensure today's row exists for `provider` (idempotent). */
  ensureDay(provider: ProviderId, day: string, limit: number): Promise<void>;

  /**
   * Atomically decrement today's quota by 1.
   * Returns the new `remaining` value, or `null` if the provider is exhausted.
   */
  checkAndDecrement(provider: ProviderId, day: string): Promise<number | null>;

  /** Refund `count` units to today's quota (call failed before consuming). */
  refund(provider: ProviderId, day: string, count?: number): Promise<void>;

  /** Mark today's quota as exhausted (e.g. on a 429 from the provider). */
  zeroOut(provider: ProviderId, day: string): Promise<void>;

  /** Read current health/circuit-breaker state. */
  getHealth(provider: ProviderId): Promise<ProviderHealthState>;

  /** Persist updated health/circuit-breaker state. */
  saveHealth(state: ProviderHealthState): Promise<void>;

  /** Record a call (latency, tokens, success/failure) for telemetry / SLO. */
  recordCall(record: ProviderCallRecord): Promise<void>;

  /** Read sticky-session provider for `conversationId`, or null. */
  getStickyProvider(conversationId: string): Promise<ProviderId | null>;

  /** Set / refresh the sticky-session provider (default TTL 1h). */
  setStickyProvider(
    conversationId: string,
    provider: ProviderId,
    ttlMs?: number,
  ): Promise<void>;

  /** Record a thumbs-up / thumbs-down on a message (feedback baseline). */
  recordFeedback(
    messageId: string,
    rating: 1 | -1,
    provider?: ProviderId,
    intent?: Intent,
  ): Promise<void>;
}

// ============================================================================
// Adapter contract
// ============================================================================

/**
 * Result of a non-streaming chat call. Adapters normalize the provider's
 * native response shape into this so the router can treat all providers
 * uniformly.
 */
export interface ChatResult {
  content: string;
  finishReason: 'stop' | 'length' | 'tool_calls' | null;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  modelUsed: string;
  providerUsed: ProviderId;
}

/**
 * Minimal adapter contract. The router calls `chat` for non-streaming and
 * `chatStream` for streaming. The stream returned by `chatStream` is the
 * RAW provider stream — the router pipes it through {@link SSENormalizer}
 * before returning to the client.
 */
export interface ChatAdapter {
  readonly provider: ProviderId;

  /**
   * Non-streaming chat. Throws {@link CascadeError}-shaped `Error` on failure
   * (the router catches and inspects `.status` / `.name`).
   */
  chat(req: ChatRequest, apiKey: string): Promise<ChatResult>;

  /**
   * Streaming chat. Returns the raw provider stream (bytes). The router is
   * responsible for piping through the SSE normalizer.
   *
   * Throws on non-2xx (before any bytes are emitted).
   */
  chatStream(req: ChatRequest, apiKey: string): Promise<ReadableStream<Uint8Array>>;
}

// ============================================================================
// Env augmentation (provider keys + cascade config)
// ============================================================================
//
// TypeScript declaration merging: these optional fields are added to the Env
// interface exported from `src/index.ts`. We don't modify `index.ts` itself
// — this keeps the gateway self-contained while letting the router read
// provider keys off the same `env` object the rest of the worker uses.

import type { Env } from '../index';

declare module '../index' {
  interface Env {
    // Provider API keys (all optional; absence → provider disabled).
    GROQ_API_KEY?: string;
    MISTRAL_API_KEY?: string;
    OPENROUTER_API_KEY?: string;
    GEMINI_API_KEY?: string;

    // Provider base URLs (optional overrides).
    GROQ_BASE_URL?: string;
    MISTRAL_BASE_URL?: string;
    OPENROUTER_BASE_URL?: string;
    GEMINI_BASE_URL?: string;

    // Default model ids per provider.
    GROQ_DEFAULT_MODEL?: string;
    MISTRAL_DEFAULT_MODEL?: string;
    OPENROUTER_DEFAULT_MODEL?: string;
    GEMINI_DEFAULT_MODEL?: string;

    // Cascade tunables (all optional; sensible defaults in model_router.ts).
    GATEWAY_STICKY_TTL_MS?: string;
    GATEWAY_CB_FAILURE_THRESHOLD?: string;
    GATEWAY_CB_OPEN_MS?: string;
    GATEWAY_CB_RATE_LIMIT_OPEN_MS?: string;
    GATEWAY_DAILY_QUOTA_DEFAULT?: string;
  }
}

/** Re-export Env so callers can import everything from one place. */
export type { Env } from '../index';
