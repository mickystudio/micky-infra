/**
 * Micky Assistant — Multi-provider LLM Gateway: Unified Canonical Types
 * ----------------------------------------------------------------------------
 * Task A1-retry (gateway entry point + provider registry)
 *
 * This file is the **single canonical import path** for the gateway module:
 *
 *   import { ChatRequest, ProviderId, GatewayEnv, ProviderAdapter }
 *     from '../gateway/types';
 *
 * Why this exists
 * ---------------
 * Sibling agents (A3/A4/A6/A8/A10) built adapter files in parallel; each
 * ended up defining its own `ProviderId` union, `ProviderAdapter` interface,
 * or `ChatRequest` shape — five different incompatible copies across the
 * `gateway/` folder. This file consolidates them:
 *
 *   1. Re-exports the OpenAI-compatible SHAPE types (ChatRequest, ChatResponse,
 *      DeltaChunk, etc.) from `./adapters/types.ts` — the adapter shape
 *      contract used by every adapter file in `./adapters/`.
 *   2. Defines the canonical 11-provider `ProviderId` union.
 *   3. Defines `GatewayEnv` — the worker `Env` extended with the 10 provider
 *      API keys (required strings, per task A1-retry spec).
 *   4. Defines the RUNTIME `ProviderAdapter` interface — what the registry
 *      stores and what `routeChat` calls. This is intentionally distinct from
 *      the SHAPE `ProviderAdapter` in `./adapters/types.ts` (which has no
 *      `chat()` method). The registry wraps each adapter singleton/factory in
 *      a uniform runtime handle that satisfies this interface.
 *
 * Edge-runtime-safe: pure structural types + the standard `Env` import from
 * the worker entry point. No Node-only APIs.
 *
 * Created: 2026-11-10 — Task A1-retry
 */

import type { Env } from '../index';

// ============================================================================
// Re-exports: OpenAI-compatible shape types from the adapter layer
// ============================================================================
//
// These are the wire-shape types every adapter in `./adapters/` already
// implements. Re-exporting them here means callers have ONE import path
// (`../gateway/types`) for both the shape types and the runtime types.
//
// NOTE: we deliberately do NOT re-export the SHAPE `ProviderAdapter`
// interface from `./adapters/types.ts` — it conflicts with the runtime
// `ProviderAdapter` we define below. Adapter files import their shape
// contract directly from `./adapters/types`; gateway files import the
// runtime contract from here. The two never cross.

export type {
  ChatRole,
  ChatMessage,
  ChatMessageContentPart,
  ChatTool,
  ChatToolCall,
  ChatToolChoice,
  ChatRequest,
  ChatResponse,
  ChatResponseChoice,
  ChatUsage,
  Delta,
  DeltaChoice,
  DeltaChunk,
  RateLimitInfo,
  ResponseWarning,
} from './adapters/types';

// Re-export the SHAPE ProviderAdapter under an alias for callers that need
// the shape contract (e.g. the adapter files themselves when they want to
// reference the shape type from the canonical path).
export type { ProviderAdapter as ShapeProviderAdapter } from './adapters/types';

// Convenience: pull the two most-used shape types into local namespace so
// the runtime interface below can reference them without qualified imports.
import type { ChatRequest, ChatResponse } from './adapters/types';

// Re-export the streaming chunk type used by BaseOpenAICompatibleAdapter
// subclasses (SambaNova / Cohere / SiliconFlow / Cerebras / Novita /
// OpenRouter). This lives in `./adapters/_types.ts` (separate from the
// shape `DeltaChunk` in `./adapters/types.ts`) — both are exported here so
// callers can pick the right one. The registry uses `ChatStreamChunk` for
// the AsyncIterable<ChatStreamChunk> returned by `adapter.chatStream()`.
//
// `ModelInfo` and `HealthStatus` are also re-exported from `_types.ts`
// (these are the types used by `BaseOpenAICompatibleAdapter.listModels`
// and `healthCheck`). The legacy `ModelInfo` alias (== OpenAIModel) is
// defined separately below.
export type {
  ChatStreamChunk,
  HealthStatus,
  StreamParseContext,
  ProviderError,
  RateLimitError,
  NetworkError,
} from './adapters/_types';
// Re-export ModelInfo from _types — overrides the legacy alias below.
// The legacy `ModelInfo = OpenAIModel` alias is intentionally omitted here;
// callers that need the legacy alias can import OpenAIModel directly.
export type { ModelInfo } from './adapters/_types';

// ============================================================================
// Provider identity — the canonical 11-provider union
// ============================================================================
//
// Stable string identifier for each registered provider. Used as the
// `provider` field on every `ChatResponse` / `DeltaChunk` so callers can
// tell which upstream served a given request (useful for the dashboard,
// /health, and per-provider analytics).
//
// Adding a new provider:
//   1. Add the id to this union.
//   2. Add a `ProviderKeys` entry for the new API key env var.
//   3. Add a row in `registry.ts`'s `PROVIDERS` map.

export type ProviderId =
  | 'groq1'
  | 'groq2'
  | 'gemini'
  | 'mistral'
  | 'openrouter'
  | 'workersai'
  | 'sambanova'
  | 'cohere'
  | 'siliconflow'
  | 'cerebras'
  | 'novita';

/** Runtime guard for {@link ProviderId}. */
export function isProviderId(value: string): value is ProviderId {
  return (
    value === 'groq1' ||
    value === 'groq2' ||
    value === 'gemini' ||
    value === 'mistral' ||
    value === 'openrouter' ||
    value === 'workersai' ||
    value === 'sambanova' ||
    value === 'cohere' ||
    value === 'siliconflow' ||
    value === 'cerebras' ||
    value === 'novita'
  );
}

/** Human-readable provider labels (for logs / dashboards). */
export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = Object.freeze({
  groq1: 'Groq (Account 1)',
  groq2: 'Groq (Account 2)',
  gemini: 'Google Gemini',
  mistral: 'Mistral AI',
  openrouter: 'OpenRouter',
  workersai: 'Cloudflare Workers AI',
  sambanova: 'SambaNova Cloud',
  cohere: 'Cohere',
  siliconflow: 'SiliconFlow',
  cerebras: 'Cerebras Cloud',
  novita: 'Novita AI',
});

// ============================================================================
// Env extension — provider API keys
// ============================================================================
//
// The 10 provider API keys, declared as REQUIRED strings per the A1-retry
// task spec. Workers that haven't yet had `wrangler secret put` for a given
// key will have the env var as `undefined` at runtime — the gateway treats
// that as "provider unconfigured" and skips it in the cascade (see
// `registry.isProviderConfigured`).
//
// `GatewayEnv = Env & ProviderKeys`. The cast in `routeChat`
// (`env as GatewayEnv`) is safe because the existing worker `Env` is
// structurally assignable to `Env & ProviderKeys` when the keys are present
// (and the gateway handles their absence at runtime).

export interface ProviderKeys {
  GROQ_KEY_1: string;
  GROQ_KEY_2: string;
  GEMINI_KEY: string;
  MISTRAL_KEY: string;
  OPENROUTER_KEY: string;
  SAMBANOVA_KEY: string;
  COHERE_KEY: string;
  SILICONFLOW_KEY: string;
  CEREBRAS_KEY: string;
  NOVITA_KEY: string;
}

/** Env shape every gateway function accepts. */
export type GatewayEnv = Env & ProviderKeys;

// ============================================================================
// Runtime ProviderAdapter contract
// ============================================================================
//
// What the registry stores and what `routeChat` calls. Each adapter
// singleton/factory in `./adapters/` has its own ad-hoc `chat(req, env?)`
// signature; the registry wraps each one in a uniform handle that satisfies
// THIS interface so the cascade loop can call them generically.
//
// Design:
//   - `id`            — the canonical ProviderId.
//   - `chat(req,env)` — non-streaming. Returns a parsed `ChatResponse` or
//                       throws (the cascade catches).
//   - `chatStream`    — streaming. Returns a `ReadableStream<Uint8Array>`
//                       already formatted as OpenAI SSE bytes
//                       (`data: {...}\n\n` + terminal `data: [DONE]\n\n`).
//   - `healthCheck`   — best-effort liveness probe.
//   - `isConfigured`  — true if the provider's API key / binding is present
//                       in env. Unconfigured providers are skipped in the
//                       cascade without throwing.

export interface ProviderAdapter {
  /** Canonical provider id. */
  readonly id: ProviderId;
  /** Human-readable label (mirrors PROVIDER_LABELS[id]). */
  readonly label: string;

  /** Non-streaming chat completion. Throws on any failure. */
  chat(req: ChatRequest, env: GatewayEnv): Promise<ChatResponse>;

  /**
   * Streaming chat completion. Returns a ReadableStream of OpenAI SSE bytes.
   * Throws only on pre-stream failure (e.g. 429 on the initial HTTP request);
   * mid-stream upstream errors surface as stream termination.
   */
  chatStream(req: ChatRequest, env: GatewayEnv): Promise<ReadableStream<Uint8Array>>;

  /** Liveness probe. Returns true if the provider is reachable. */
  healthCheck(env: GatewayEnv): Promise<boolean>;

  /** True if the provider's API key (or AI binding) is set in env. */
  isConfigured(env: GatewayEnv): boolean;
}

// ============================================================================
// Cascade results (for logging / dashboard / OpenAI-compatible errors)
// ============================================================================

/** Record of one provider attempt inside a cascade. */
export interface CascadeAttempt {
  provider: ProviderId;
  model: string;
  success: boolean;
  error?: {
    code: string;
    message: string;
    status: number;
    retriable: boolean;
  };
  latency_ms: number;
}

/** Outcome of a `routeChat()` call (internal — the HTTP Response is built from this). */
export interface CascadeResult {
  success: boolean;
  provider: ProviderId | null;
  model: string | null;
  response: ChatResponse | ReadableStream<Uint8Array> | null;
  error: { code: string; message: string } | null;
  fallback_used: boolean;
  attempted: CascadeAttempt[];
  total_latency_ms: number;
}

// ============================================================================
// Intent type (re-exported from utils/intent_classifier for convenience)
// ============================================================================
//
// The intent classifier (Agent A7) lives in `./utils/intent_classifier.ts`
// and exports its own `IntentType` union. We re-export it here so gateway
// callers can import everything from one path.

export type { IntentType } from './utils/intent_classifier';

// ============================================================================
// Legacy compatibility aliases
// ============================================================================
//
// The earlier A1 scaffold (and A8's cascade_router) imported a few extra
// type names from `./types` that the unified types above don't define.
// We re-add them here as minimal aliases so those legacy files keep
// type-checking until their owners reconcile them with the new shape.
// New code SHOULD NOT use these — they'll be removed once the legacy
// `provider_adapters.ts` / `model_router.ts` / `cascade_router.ts` are
// migrated.

/** Legacy: a provider's static config (base URL, rate limits, capability flags). */
export interface ProviderConfig {
  id: ProviderId;
  display_name: string;
  base_url: string | null;
  models: readonly string[];
  default_model: string;
  api_key_env: string;
  rpm: number;
  rpd: number;
  tpm: number;
  tpd: number;
  supports_streaming: boolean;
  supports_tools: boolean;
  supports_vision: boolean;
  max_context_tokens: number;
  extra_headers?: Record<string, string>;
}

/** Legacy: an OpenAI-shaped /v1/models entry. */
export interface OpenAIModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

/** Legacy: outcome of a single adapter.chat() call (pre-cascade). */
export interface ChatResult {
  success: boolean;
  provider: ProviderId;
  model: string;
  chatResponse?: ChatResponse;
  stream?: ReadableStream<Uint8Array>;
  error?: {
    code: string;
    message: string;
    status: number;
    retriable: boolean;
  };
  latency_ms: number;
}
