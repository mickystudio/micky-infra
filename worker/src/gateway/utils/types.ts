/**
 * Micky Assistant — Multi-provider LLM Gateway (utilities layer)
 * ----------------------------------------------------------------------------
 * Shared types for the 11-provider token counter + intent classifier.
 *
 * This module is intentionally self-contained: it does NOT depend on the
 * parallel `gateway/types.ts` (Agent A4/A6 — narrower 5-provider set with
 * `content: string`-only messages) or `gateway/cascade_types.ts` (Agent A8 —
 * different cascade intents). The utilities layer owns its own minimal,
 * OpenAI-compatible shape so the token counter and the intent classifier
 * can import from one place without coupling to upstream gateway changes.
 *
 * Edge-only: every type here is a pure structural type. No runtime APIs are
 * referenced — the file is safe to import from any Workers entry point.
 *
 * Created: 2026-11-10  (Agent A7)
 */

// ============================================================================
// Provider registry — 11 providers
// ============================================================================

/**
 * Canonical provider ids the gateway knows how to dispatch to.
 *
 * The two Groq slots (`groq1`, `groq2`) model TWO separate API keys / rate
 * pools on the same upstream — Groq's free tier is per-key, so carrying two
 * keys doubles the effective daily quota. They share the same model list
 * and the same tokenizer heuristics.
 *
 * The remaining nine providers each have their own key, rate pool, and
 * (sometimes) tokenizer:
 *   - mistral     — OpenAI-compatible, 32k-256k context
 *   - sambanova   — OpenAI-compatible, free tier capped at 8k context
 *   - siliconflow — OpenAI-compatible, free tier ~32k context
 *   - workersai   — Cloudflare binding (`env.AI.run`), 6k context
 *   - cerebras    — OpenAI-compatible, very fast inference, 8k context
 *   - cohere      — OpenAI-compatible via v2/chat, has Arabic-specialized Aya
 *   - gemini      — Native Google format, 1M context, only free-tier vision
 *   - novita      — OpenAI-compatible aggregator, DeepSeek-V3.1 / R1
 *   - openrouter  — OpenAI-compatible aggregator, many models with `:free`
 */
export type ProviderId =
  | 'groq1'
  | 'groq2'
  | 'mistral'
  | 'sambanova'
  | 'siliconflow'
  | 'workersai'
  | 'cerebras'
  | 'cohere'
  | 'gemini'
  | 'novita'
  | 'openrouter';

/** Runtime guard for {@link ProviderId}. */
export function isProviderId(value: string): value is ProviderId {
  return (
    value === 'groq1' ||
    value === 'groq2' ||
    value === 'mistral' ||
    value === 'sambanova' ||
    value === 'siliconflow' ||
    value === 'workersai' ||
    value === 'cerebras' ||
    value === 'cohere' ||
    value === 'gemini' ||
    value === 'novita' ||
    value === 'openrouter'
  );
}

/** Human-readable provider labels (for logs / dashboards). */
export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = Object.freeze({
  groq1: 'Groq (pool 1)',
  groq2: 'Groq (pool 2)',
  mistral: 'Mistral AI',
  sambanova: 'SambaNova Cloud',
  siliconflow: 'SiliconFlow',
  workersai: 'Cloudflare Workers AI',
  cerebras: 'Cerebras Inference',
  cohere: 'Cohere',
  gemini: 'Google Gemini',
  novita: 'Novita AI',
  openrouter: 'OpenRouter',
});

// ============================================================================
// Chat types (OpenAI-compatible subset, with multimodal content parts)
// ============================================================================

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** One content part within a multimodal message (text or image_url). */
export interface ContentPart {
  type: 'text' | 'image_url';
  /** Present when `type === 'text'`. */
  text?: string;
  /** Present when `type === 'image_url'`. */
  image_url?: { url: string; detail?: 'auto' | 'low' | 'high' };
}

/**
 * OpenAI-compatible chat message.
 *
 * `content` may be either a plain string (the common case) or an array of
 * typed parts (multimodal: text + image_url). The token counter and intent
 * classifier extract the textual portion via `messageText()`.
 */
export interface ChatMessage {
  role: ChatRole | string;
  content: string | ContentPart[];
  /** Optional name for tool messages. */
  name?: string;
  /** Required for tool-result messages. */
  tool_call_id?: string;
}

/** OpenAI-compatible tool / function definition. */
export interface ToolDefinition {
  type?: 'function';
  function?: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/**
 * Inbound chat-completion request shape understood by the gateway utilities.
 *
 * A strict subset of OpenAI's `/v1/chat/completions` body — only the fields
 * the token counter and intent classifier care about. Adapters downstream
 * tolerate (and forward) any extra fields.
 */
export interface ChatRequest {
  messages: ChatMessage[];
  /** Optional model hint (used to pick a tokenizer heuristic). */
  model?: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  /** OpenAI tool-calling spec; presence forces `tool_calling` intent. */
  tools?: ToolDefinition[];
  tool_choice?: unknown;
}
