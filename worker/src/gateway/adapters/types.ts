/**
 * Shared types for the multi-provider LLM gateway adapters.
 *
 * Designed to be OpenAI-compatible since most providers (Groq, Mistral,
 * OpenRouter, Together, etc.) follow the OpenAI Chat Completions shape with
 * only minor provider-specific quirks. Each adapter normalizes to/from
 * these types.
 *
 * Edge-compatible: no Node-only imports.
 */

// ─── Chat Completions Request ─────────────────────────────────────────────────

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessageContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: 'auto' | 'low' | 'high' };
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: string | ChatMessageContentPart[] | null;
  name?: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export type ChatToolChoice =
  | 'none'
  | 'auto'
  | { type: 'function'; function: { name: string } };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number | null;
  max_tokens?: number | null;
  top_p?: number | null;
  stream?: boolean;
  tools?: ChatTool[];
  tool_choice?: ChatToolChoice;
  stop?: string | string[];
  /** Mistral-specific. */
  safe_prompt?: boolean;
  random_seed?: number | null;
  response_format?: { type: 'json_object' | 'text' };
  /** Provider-specific extension fields. Adapters MUST ignore unknown keys. */
  [key: string]: unknown;
}

// ─── Chat Completions Response ────────────────────────────────────────────────

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatResponseChoice {
  index: number;
  message: {
    role: ChatRole;
    content: string | null;
    tool_calls?: ChatToolCall[];
  };
  finish_reason: string | null;
}

/**
 * Mistral returns an optional `warnings` array when request params are
 * ignored (e.g. unsupported tool format, deprecated fields).
 */
export interface ResponseWarning {
  type?: string;
  message?: string;
  [key: string]: unknown;
}

export interface ChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatResponseChoice[];
  usage?: ChatUsage;
  /** Mistral-only. Captured by adapters that expose it. */
  warnings?: ResponseWarning[];
  [key: string]: unknown;
}

// ─── Streaming Delta ──────────────────────────────────────────────────────────

export interface Delta {
  role?: ChatRole;
  content?: string;
  tool_calls?: Partial<ChatToolCall>[];
}

export interface DeltaChoice {
  index: number;
  delta: Delta;
  finish_reason: string | null;
}

export interface DeltaChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices: DeltaChoice[];
  /** Set by the adapter when the stream emits `[DONE]`. */
  done?: boolean;
  [key: string]: unknown;
}

// ─── Rate-Limit Info ──────────────────────────────────────────────────────────

export interface RateLimitInfo {
  requestsRemaining?: number;
  tokensRemaining?: number;
  requestsLimit?: number;
  tokensLimit?: number;
  /** Seconds until a request slot is available (Mistral 429 case). */
  retryAfter?: number;
  /** Provider-specific reset token (e.g. "12s" or "1m"). */
  resetRequestsIn?: string;
  resetTokensIn?: string;
  /** ISO date when the quota resets, if known. */
  resetAt?: string;
  /** Raw headers snapshot for debugging. */
  raw?: Record<string, string>;
}

// ─── Provider Adapter Interface ──────────────────────────────────────────────

/**
 * Every provider adapter implements this. The gateway calls these methods to
 * normalize a `ChatRequest` into the provider's wire format, parse back a
 * `ChatResponse` / `DeltaChunk`, and read provider-specific rate-limit info.
 */
export interface ProviderAdapter {
  /** Provider id, e.g. `"mistral"`, `"groq"`. */
  readonly provider: string;

  /** Build the headers required for an authenticated request. */
  getHeaders(apiKey: string): HeadersInit;

  /** Provider's base URL (no trailing slash). */
  getBaseUrl(): string;

  /** Provider's chat completions path, e.g. `/chat/completions`. */
  getChatCompletionsPath(): string;

  /** List of supported model ids. */
  getSupportedModels(): readonly string[];

  /**
   * Normalize a `ChatRequest` into the provider's wire format. Implementations
   * MUST be pure (no I/O) so they are trivially testable.
   */
  formatRequest(req: ChatRequest): Record<string, unknown>;

  /** Parse a raw provider response object into a normalized `ChatResponse`. */
  parseResponse(raw: unknown): ChatResponse;

  /** Parse one raw SSE chunk into a `DeltaChunk`, or `null` if not a delta. */
  parseStreamChunk(chunk: string): DeltaChunk | null;

  /** Extract rate-limit info from the provider's response headers. */
  extractRateLimitInfo(headers: Headers): RateLimitInfo;
}
