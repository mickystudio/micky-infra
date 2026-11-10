/**
 * Token Counter — edge-safe heuristic estimator for the 11-provider LLM gateway.
 * ----------------------------------------------------------------------------
 *
 * WHY HEURISTIC, NOT tiktoken
 *   Cloudflare Workers cannot cheaply ship the full tiktoken WASM blob
 *   (cl100k_base + o200k_base ≈ 2 MB combined). Lite tokenizers like
 *   `gpt-tokenizer` exist but still add ~300 KB to the bundle and need a
 *   BPE rank table per model family. For a multi-provider gateway whose
 *   job is *budget calculation BEFORE sending the request* — not exact
 *   billing — a script-ratio-weighted heuristic is the right tradeoff:
 *
 *     • 0 KB bundle cost
 *     • ±20% accuracy for typical chat inputs (validated in __tests__)
 *     • Works for every provider's tokenizer (OpenAI BPE, Gemini
 *       SentencePiece, Qwen BBPE) with one switch on the model name
 *
 * STRATEGY
 *   1. Detect the script mix in the text (Arabic / CJK / Latin) by counting
 *      Unicode codepoints. Whitespace is skipped so a 50-line English
 *      message with one Arabic word isn't misclassified.
 *   2. Weight the chars-per-token divisor by script ratio:
 *        Latin  → 4 chars/token (OpenAI BPE averages ~4.0 on English)
 *        Arabic → 2 chars/token (BPE merges are short for Arabic morphemes)
 *        CJK    → 1.5 chars/token (each Han codepoint ≈ 1 token)
 *      Then `tokens = sum_over_scripts(ratio * len / cpt)`.
 *   3. For Gemini (SentencePiece, ~32k vocab), use a flat 3.5 chars/token
 *      across all scripts — SentencePiece is slightly denser than BPE.
 *   4. Workers AI Qwen uses the SAME tokenizer as Qwen on Groq, so it
 *      inherits the OpenAI-family rule.
 *
 * Created: 2026-11-10  (Agent A7)
 */

import type { ChatMessage, ProviderId } from './types';

// ============ Tuning constants ============

/** chars per token, English / Latin text on BPE tokenizers (OpenAI family). */
const CPT_LATIN = 4;
/** chars per token, Arabic text (denser BPE merges). */
const CPT_ARABIC = 2;
/** chars per token, CJK / Chinese text (often 1 token per char). */
const CPT_CHINESE = 1.5;
/** chars per token, Gemini SentencePiece (slightly denser than OpenAI BPE). */
const CPT_GEMINI = 3.5;

/** Per-message wrapper overhead added by `estimateTokens` (role tag + sep). */
const ESTIMATE_OVERHEAD = 3;
/** Per-message overhead added by `countMessageTokens` (role + sep + priming). */
const MESSAGE_OVERHEAD = 4;
/** Fixed overhead added once per message array (chat-template priming). */
const ARRAY_PRIMING_OVERHEAD = 3;

/** Fallback context window if neither model nor provider is recognised. */
const FALLBACK_CONTEXT = 8192;

// ============ Script detection ============

interface ScriptRatios {
  arabic: number;
  chinese: number;
  latin: number;
}

/**
 * Compute the ratio of Arabic / CJK / Latin characters in `text`.
 *
 * Whitespace and punctuation are excluded from the denominator so the
 * ratios reflect actual script density. Characters outside the three
 * tracked blocks (emoji, Cyrillic, etc.) fall into a residual bucket
 * that the caller treats as Latin (4 chars/token is a safe default).
 */
function scriptRatios(text: string): ScriptRatios {
  if (!text || text.length === 0) return { arabic: 0, chinese: 0, latin: 0 };
  let arabic = 0;
  let chinese = 0;
  let latin = 0;
  let total = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    const code = ch.codePointAt(0) ?? 0;
    total++;
    if (
      (code >= 0x0600 && code <= 0x06ff) || // Arabic
      (code >= 0x0750 && code <= 0x077f) || // Arabic Supplement
      (code >= 0xfb50 && code <= 0xfeff)    // Arabic Presentation Forms
    ) {
      arabic++;
    } else if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0xf900 && code <= 0xfaff)    // CJK Compatibility Ideographs
    ) {
      chinese++;
    } else if (
      code < 0x80 || // ASCII
      (code >= 0x00c0 && code <= 0x024f) // Latin-1 Supplement + Latin Extended-A/B
    ) {
      latin++;
    }
  }
  if (total === 0) return { arabic: 0, chinese: 0, latin: 0 };
  return {
    arabic: arabic / total,
    chinese: chinese / total,
    latin: latin / total,
  };
}

/** Is the model a Gemini-family tokenizer (SentencePiece, not BPE)? */
function isGeminiModel(model: string | undefined): boolean {
  if (!model) return false;
  return /gemini/i.test(model);
}

// ============ Raw text estimator (no overhead) ============

/**
 * Estimate the token count of a bare text string, with no message wrapper
 * overhead. Used internally by both `estimateTokens` and `countMessageTokens`
 * so the per-message overhead is applied exactly once per public API.
 */
function rawTextTokens(text: string, model: string | undefined): number {
  if (!text || text.length === 0) return 0;
  const len = text.length;

  if (isGeminiModel(model)) {
    // Gemini: flat heuristic across all scripts (SentencePiece is denser).
    return Math.max(1, Math.ceil(len / CPT_GEMINI));
  }

  // OpenAI family + Qwen (Groq + Workers AI): weighted by script ratio.
  const r = scriptRatios(text);
  const weighted =
    r.arabic * (len / CPT_ARABIC) +
    r.chinese * (len / CPT_CHINESE) +
    r.latin * (len / CPT_LATIN);
  // Treat residual chars (emoji, other scripts) as Latin (4 chars/token).
  const residual = Math.max(0, 1 - r.arabic - r.chinese - r.latin);
  const adjusted = weighted + residual * (len / CPT_LATIN);
  return Math.max(1, Math.ceil(adjusted));
}

// ============ Public API ============

/**
 * Estimate tokens for a single piece of text.
 *
 * Adds `+3` tokens to account for the typical message-role + formatting
 * wrapper (e.g. `<|im_start|>user\n…<|im_end|>\n` ≈ 3 tokens). If you only
 * need raw text tokens, subtract 3 from the result.
 *
 * @param text  message body
 * @param model model id (used to switch tokenizer heuristic; Gemini uses
 *              SentencePiece, everything else uses BPE-style weighting)
 */
export function estimateTokens(text: string, model?: string): number {
  if (!text || text.length === 0) return 0;
  return rawTextTokens(text, model) + ESTIMATE_OVERHEAD;
}

/** Pull the textual portion out of a ChatMessage (string or parts array). */
function messageText(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text ?? '')
      .join('\n');
  }
  return '';
}

/**
 * Estimate the prompt token count for an array of messages.
 *
 * Sums raw text tokens across all messages (including any system prompt as
 * the first message), then adds `+4` overhead per message (role tags +
 * separators) and `+3` for array priming (chat-template prefix).
 *
 * This does NOT internally call `estimateTokens` — that would double-count
 * the per-message overhead. Both functions share the internal
 * `rawTextTokens` helper instead.
 *
 * @param messages  full chat history including system prompt as first message
 * @param model      model id (for tokenizer heuristic)
 */
export function countMessageTokens(
  messages: ChatMessage[],
  model: string,
): number {
  if (!messages || messages.length === 0) return 0;
  let sum = 0;
  for (const m of messages) {
    const txt = messageText(m);
    sum += rawTextTokens(txt, model) + MESSAGE_OVERHEAD;
  }
  return sum + ARRAY_PRIMING_OVERHEAD;
}

/**
 * Realistic output-token estimate.
 *
 * Most chat replies are roughly half the prompt's size, capped at
 * `maxTokens`. Useful for reserving output budget before the request goes
 * out so the cascade router can pick a provider whose context window can
 * actually hold the response.
 *
 * Returns 0 if either input is non-positive.
 */
export function estimateOutputTokens(
  promptTokens: number,
  maxTokens: number,
): number {
  if (promptTokens <= 0 || maxTokens <= 0) return 0;
  return Math.min(maxTokens, Math.floor(promptTokens * 0.5));
}

// ============ Context window table ============

/**
 * Static lookup of model → context window size (input tokens).
 *
 * Keyed by lowercase model id. Values reflect the FREE TIER context window
 * as advertised by each provider (late 2025 / early 2026). Some providers
 * cap the free tier below the model's theoretical max — those caps are
 * reflected here so the cascade router doesn't try a prompt that the free
 * tier will reject.
 *
 * E.g. Groq `llama-3.1-8b-instant` supports 131072 tokens on the free tier;
 * SambaNova's free tier caps all Llama models at 8192 even though the
 * upstream model is 128k.
 *
 * Update this table when providers change their free-tier limits.
 */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // ── Groq (groq1 + groq2) ──────────────────────────────────────────────
  'llama-3.1-8b-instant': 131072,
  'llama-3.1-8b': 131072, // alias
  'llama-3.3-70b-versatile': 131072,
  'qwen-2.5-32b': 131072,
  'qwen3-32b': 32768,
  'deepseek-r1-distill-llama-70b': 131072,
  'allam-2-7b': 4096,
  'gemma2-9b-it': 8192,
  'mixtral-8x7b-32768': 32768,
  // ── Mistral ───────────────────────────────────────────────────────────
  'mistral-large-latest': 128000,
  'mistral-small-latest': 32000,
  'codestral-latest': 256000,
  'open-mixtral-8x7b': 32000,
  'open-mistral-nemo': 128000,
  'magistral-medium-latest': 128000,
  'magistral-small-latest': 128000,
  // ── SambaNova (free tier — all capped at 8k) ───────────────────────────
  'meta-llama-3.1-8b-instruct': 8192,
  'llama-3.3-70b-instruct': 8192,
  'meta-llama-3.1-405b-instruct': 8192,
  'qwen3-32b-sambanova': 8192,
  'deepseek-v3.1-sambanova': 8192,
  'deepseek-r1-sambanova': 8192,
  'qwen2.5-coder-32b-instruct-sambanova': 8192,
  // ── SiliconFlow (free tier) ───────────────────────────────────────────
  'deepseek-ai/deepseek-v3': 64000,
  'deepseek-ai/deepseek-r1': 64000,
  'qwen/qwen2.5-72b-instruct': 32000,
  'qwen/qwen2.5-coder-32b-instruct': 32000,
  // ── Cloudflare Workers AI (binding cap) ───────────────────────────────
  '@cf/qwen/qwen2.5-coder-32b-instruct': 6000,
  '@cf/meta/llama-3.1-8b-instruct': 6000,
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': 24000,
  '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b': 7000,
  '@cf/qwen/qwen1.5-14b-chat-awq': 6000,
  // ── Cerebras (free tier — 8k cap) ─────────────────────────────────────
  'llama3.1-8b': 8192,
  'llama-3.3-70b-cerebras': 8192,
  // ── Cohere ───────────────────────────────────────────────────────────
  'command-r-plus': 128000,
  'command-r': 128000,
  'command-r7b-12-2024': 128000,
  'aya-23-8b': 8192,
  'aya-23-35b': 8192,
  // ── Gemini (Google AI Studio free tier) ──────────────────────────────
  'gemini-1.5-flash': 1048576,
  'gemini-2.0-flash': 1048576,
  'gemini-2.5-flash': 1048576,
  'gemini-flash': 1048576, // alias used by intent_classifier
  'gemini-1.5-pro': 2097152,
  // ── Novita (free tier) ───────────────────────────────────────────────
  'deepseek/deepseek-v3.1': 64000,
  'deepseek/deepseek-r1': 64000,
  'meta-llama/llama-3.1-405b-instruct': 32768,
  // ── OpenRouter (free-tier models) ─────────────────────────────────────
  'openrouter/auto': 128000,
  'openai/gpt-4o-mini': 128000,
  'openai/gpt-4o': 128000,
  'meta-llama/llama-3.3-70b-instruct:free': 131072,
  'qwen/qwen-2.5-72b-instruct:free': 32768,
  'deepseek/deepseek-r1:free': 64000,
  'google/gemini-2.0-flash-exp:free': 1048576,
};

/** Per-provider default context window (used when model is unknown). */
const PROVIDER_DEFAULT_LIMITS: Record<ProviderId, number> = {
  groq1: 32768,
  groq2: 32768,
  mistral: 32000,
  sambanova: 8192,
  siliconflow: 32000,
  workersai: 6000,
  cerebras: 8192,
  cohere: 128000,
  gemini: 1048576,
  novita: 32000,
  openrouter: 32768,
};

/** Normalized (lowercase) version of MODEL_CONTEXT_LIMITS for fast lookup. */
const NORMALIZED_LIMITS: Record<string, number> = Object.fromEntries(
  Object.entries(MODEL_CONTEXT_LIMITS).map(([k, v]) => [k.toLowerCase(), v]),
);

/**
 * Look up the context window size for a model on a given provider.
 *
 * Resolution order:
 *   1. Normalized model name in {@link MODEL_CONTEXT_LIMITS} (case-insensitive)
 *   2. Provider default from `PROVIDER_DEFAULT_LIMITS`
 *   3. `FALLBACK_CONTEXT` (8192) — safest conservative default
 *
 * @param provider  target provider id (used for default fallback)
 * @param model     target model id
 */
export function getProviderContextLimit(
  provider: ProviderId,
  model: string,
): number {
  if (model) {
    const key = model.toLowerCase();
    if (NORMALIZED_LIMITS[key] != null) return NORMALIZED_LIMITS[key];
  }
  const provDefault = PROVIDER_DEFAULT_LIMITS[provider];
  if (provDefault != null) return provDefault;
  return FALLBACK_CONTEXT;
}

/**
 * Will `promptTokens` fit in the model's context window on this provider?
 *
 * Uses strict less-than so at least 1 token is reserved for the response —
 * a "just barely fits" prompt leaves zero room for output and the provider
 * will reject the request. Callers needing a more generous output reserve
 * should compare `promptTokens + outputBudget` against
 * {@link getProviderContextLimit} directly.
 *
 * @param promptTokens  token count of the prompt (use `countMessageTokens`)
 * @param provider       target provider id
 * @param model          target model id
 */
export function willFitInProviderContext(
  promptTokens: number,
  provider: ProviderId,
  model: string,
): boolean {
  const limit = getProviderContextLimit(provider, model);
  return promptTokens < limit;
}
