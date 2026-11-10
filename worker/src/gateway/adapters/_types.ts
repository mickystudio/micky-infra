/**
 * Micky Assistant — Types for the new (Agent A10) provider adapter layer.
 * ----------------------------------------------------------------------------
 * This file defines the {@link ProviderAdapter} contract that the five new
 * OpenAI-compatible adapters (SambaNova, Cohere, SiliconFlow, Cerebras,
 * Novita) implement.
 *
 * Why a separate types file?
 * --------------------------
 * The repo already has two parallel `ProviderAdapter` interfaces —
 * `gateway/types.ts` (Task A6: HTTP-shape-only, optional `chat?` /
 * `chatStream?` for binding adapters) and `gateway/adapters/types.ts`
 * (Task A8: richer `getChatCompletionsPath` / `getSupportedModels`). The
 * Agent A10 brief describes a THIRD, self-contained contract where every
 * adapter owns its own `chat` / `chatStream` / `listModels` / `healthCheck`
 * I/O (no separate fetcher needed). Rather than overwrite either existing
 * file (which would break their downstream adapters), we keep this contract
 * local to the five new adapters.
 *
 * Edge-only: pure structural types + error classes. No Node APIs.
 * Created: 2026-11-10 (Agent A10)
 */

// ============================================================================
// Provider registry
// ============================================================================

export type ProviderId =
  | 'sambanova' | 'cohere' | 'siliconflow' | 'cerebras' | 'novita'
  | 'openrouter' | 'workersai';

export function isProviderId(value: string): value is ProviderId {
  return value === 'sambanova' || value === 'cohere' || value === 'siliconflow'
    || value === 'cerebras' || value === 'novita'
    || value === 'openrouter' || value === 'workersai';
}

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

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  stop?: string | string[];
  provider_options?: Record<string, unknown>;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
  tool_calls?: ToolCall[];
}

export interface ChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatChoice[];
  usage: ChatUsage;
  system_fingerprint?: string;
  /** Provider-specific extras (e.g. SiliconFlow `cost`). */
  provider_meta?: Record<string, unknown>;
}

/** Normalized streaming chunk — one OpenAI-shaped `chat.completion.chunk` delta. */
export interface ChatStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Partial<ChatMessage> & { tool_calls?: ToolCall[] };
    finish_reason: string | null;
  }>;
  usage?: ChatUsage;
}

// ============================================================================
// Rate-limit + model + health
// ============================================================================

export interface RateLimitInfo {
  provider: ProviderId;
  requestsRemaining?: number;
  requestsLimit?: number;
  tokensRemaining?: number;
  tokensLimit?: number;
  resetAfterSeconds?: number;
  resetAt?: number;
  retryAfterSeconds?: number;
  rawHeaders?: Record<string, string>;
}

export interface ModelInfo {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  label?: string;
  context_window?: number;
  free_tier?: boolean;
}

export interface HealthStatus {
  provider: ProviderId;
  healthy: boolean;
  status: number;
  latencyMs: number;
  message: string;
  rateLimit?: RateLimitInfo;
  checkedAt: string;
}

// ============================================================================
// Errors
// ============================================================================

/** Base adapter error. Carries provider id + HTTP status for routing decisions. */
export class ProviderError extends Error {
  readonly provider: ProviderId;
  readonly status: number;
  readonly retryable: boolean;
  readonly upstreamBody?: string;

  constructor(
    provider: ProviderId,
    status: number,
    message: string,
    opts: { retryable?: boolean; upstreamBody?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
    this.retryable = opts.retryable ?? (status >= 500 || status === 429);
    this.upstreamBody = opts.upstreamBody;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

/** Throttled by upstream (429) — carries retry-after info. */
export class RateLimitError extends ProviderError {
  readonly rateLimit: RateLimitInfo;
  constructor(provider: ProviderId, rateLimit: RateLimitInfo, message?: string) {
    super(provider, 429, message ?? `Provider ${provider} rate-limited (429)`, { retryable: true });
    this.name = 'RateLimitError';
    this.rateLimit = rateLimit;
  }
}

/** Network-level failure (DNS/TCP/TLS/abort) — always retryable. */
export class NetworkError extends ProviderError {
  constructor(provider: ProviderId, message: string, cause?: unknown) {
    super(provider, 0, message, { retryable: true, cause });
    this.name = 'NetworkError';
  }
}

// ============================================================================
// Provider adapter interface
// ============================================================================

/** State passed through a streaming parse so adapters can stitch deltas. */
export interface StreamParseContext {
  model: string;
  id: string;
  created: number;
}

/**
 * Contract every Agent A10 LLM provider adapter implements. Split into:
 *   - Identity: PROVIDER_ID, getBaseUrl()
 *   - Auth:     getHeaders()
 *   - Shaping:  formatRequest, parseResponse, parseStreamChunk
 *   - Telemetry: extractRateLimitInfo
 *   - I/O:      chat, chatStream, listModels, healthCheck
 *
 * Implementations should be **stateless** (other than a captured API key) so
 * the gateway can pool and reuse a single instance per provider.
 */
export interface ProviderAdapter {
  readonly PROVIDER_ID: ProviderId;
  getBaseUrl(): string;
  getHeaders(): Record<string, string>;
  formatRequest(req: ChatRequest): unknown;
  parseResponse(raw: unknown, requestedModel: string): ChatResponse;
  parseStreamChunk(line: string, ctx: StreamParseContext): ChatStreamChunk | null;
  extractRateLimitInfo(headers: Headers): RateLimitInfo;
  chat(req: ChatRequest): Promise<ChatResponse>;
  chatStream(req: ChatRequest): AsyncIterable<ChatStreamChunk>;
  listModels(): Promise<ModelInfo[]>;
  healthCheck(): Promise<HealthStatus>;
}
