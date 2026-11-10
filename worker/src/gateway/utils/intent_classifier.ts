/**
 * Intent Classifier — decides which provider cascade to use for a request.
 * ----------------------------------------------------------------------------
 *
 * Classifies an incoming {@link ChatRequest} into one of 7 intents, then
 * maps that intent to:
 *   1. An ordered provider cascade ({@link getCascadeForIntent}) — the
 *      primary provider first, then failover fallbacks in priority order.
 *   2. The best model id for each (intent, provider) pair
 *      ({@link pickBestModel}) — chosen from the provider's free-tier model
 *      list with the intent's primary requirement in mind (code capability,
 *      Arabic fluency, long context, reasoning, vision, etc.).
 *
 * The classifier is pure + edge-safe: no I/O, no regex backtracking
 * (all patterns are linear), no globals.
 *
 * PRIORITY ORDER (first match wins)
 *   1. multimodal    — messages contain `image_url` parts.
 *                      HARD constraint: only Gemini does vision on the free
 *                      tier, so it must win even if tools are also requested.
 *   2. tool_calling  — `req.tools` is a non-empty array.
 *                      SEMI-HARD: most providers support function calling
 *                      but not every model — must use a tool-capable model.
 *   3. long_context  — estimated prompt tokens > 16000.
 *                      HARD on context size: a 20k prompt will not fit in an
 *                      8k model no matter how good the model is otherwise.
 *   4. code          — code fence / file extension / ≥2 code keywords in
 *                      the last user message.
 *   5. arabic        — >50% of the last user message is Arabic script.
 *   6. reasoning     — reasoning trigger keywords ("step by step", etc.).
 *   7. simple_chat   — fallback for ordinary chitchat.
 *
 * Content-based detectors (4-6) inspect ONLY the last user message because
 * that is what the model will actually respond to; older turns are context,
 * not intent.
 *
 * Created: 2026-11-10  (Agent A7)
 */

import type { ChatMessage, ChatRequest, ProviderId } from './types';
import { countMessageTokens } from './token_counter';

export type IntentType =
  | 'code'
  | 'arabic'
  | 'long_context'
  | 'reasoning'
  | 'simple_chat'
  | 'tool_calling'
  | 'multimodal';

// ============ Detectors ============

/** Markdown fenced code block: ``` ... ```. */
const CODE_FENCE_RE = /```[\s\S]*?```/;

/**
 * File-extension pattern. Matches `foo.ts`, `index.jsx`, `app.py`, etc.
 * Word-boundary on the left so `cats` isn't matched as `cat.s`.
 */
const FILE_EXT_RE =
  /\b[a-zA-Z_][\w-]*\.(ts|tsx|js|jsx|py|rb|go|rs|java|c|cpp|cc|h|hpp|cs|php|swift|kt|scala|sh|bash|zsh|sql|json|ya?ml|toml|ini|xml|html|css|scss|less|vue|svelte|md|tex|cla|pl)\b/;

/**
 * Code keyword list. Each is matched as a whole word (case-sensitive — these
 * keywords are case-sensitive in their host languages, so a lowercase
 * `class` is meaningful but `Class` in prose isn't).
 *
 * The classifier requires AT LEAST TWO distinct keywords to fire, which
 * suppresses false positives like "what is the function of the liver?"
 * (1 keyword) while still catching `def foo():\n  return bar` (2 keywords).
 */
const CODE_KEYWORDS: readonly string[] = [
  'def', 'function', 'func', 'fn', 'class', 'import', 'return',
  'public', 'private', 'static', 'void', 'interface', 'extends',
  'implements', 'async', 'await', 'yield', 'export', 'const',
  'let', 'var', 'namespace', 'package', 'struct', 'enum', 'trait',
  'impl', 'pub', 'module', 'require', 'lambda',
];

/** Reasoning trigger keywords (case-insensitive, whole-word). */
const REASONING_RE =
  /\b(explain why|step[- ]by[- ]step|reason|think|analyze|analyse|reasoning|chain of thought|walk through|derive|prove|why does|why is|why are|justify)\b/i;

/**
 * Pull the textual portion out of a ChatMessage (string or parts array).
 * Image parts are dropped — only `text` parts contribute to intent detection.
 */
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
 * Compute the ratio of Arabic characters in `text` (0..1).
 *
 * Whitespace is excluded from the denominator. The Arabic block plus its
 * Supplement and Presentation Forms are all counted.
 */
function arabicRatio(text: string): number {
  if (!text) return 0;
  let arabic = 0;
  let total = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    const code = ch.codePointAt(0) ?? 0;
    total++;
    if (
      (code >= 0x0600 && code <= 0x06ff) ||
      (code >= 0x0750 && code <= 0x077f) ||
      (code >= 0xfb50 && code <= 0xfeff)
    ) {
      arabic++;
    }
  }
  if (total === 0) return 0;
  return arabic / total;
}

/** Does any message in the array carry an `image_url` content part? */
function hasImagePart(messages: ChatMessage[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((p) => p.type === 'image_url' && p.image_url != null),
  );
}

/** Count distinct code-keyword hits in `text` (capped at 2 for speed). */
function countCodeKeywordHits(text: string): number {
  let hits = 0;
  for (const kw of CODE_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`);
    if (re.test(text)) {
      hits++;
      if (hits >= 2) return hits;
    }
  }
  return hits;
}

/**
 * Heuristic: does `text` look like source code (or a code-related request)?
 *
 * Triggers on any of:
 *   - A markdown fenced code block (``` ... ```).
 *   - A file extension reference (e.g. `index.ts`, `app.py`).
 *   - ≥2 distinct code keywords on word boundaries.
 */
function looksLikeCode(text: string): boolean {
  if (!text) return false;
  if (CODE_FENCE_RE.test(text)) return true;
  if (FILE_EXT_RE.test(text)) return true;
  return countCodeKeywordHits(text) >= 2;
}

// ============ Public API ============

/**
 * Classify a chat request into one of 7 intents.
 *
 * Priority order is documented at the top of this file. The content-based
 * detectors (code / arabic / reasoning) operate on the LAST user message
 * because that is the turn the model will respond to.
 *
 * @param req  inbound chat request (messages + optional model + tools)
 */
export function classifyIntent(req: ChatRequest): IntentType {
  const messages = req?.messages ?? [];

  // 1. Multimodal — hard constraint (only Gemini does vision on free tier).
  if (hasImagePart(messages)) return 'multimodal';

  // 2. Tool calling — semi-hard (most providers support function calling).
  if (Array.isArray(req?.tools) && req.tools.length > 0) return 'tool_calling';

  // 3. Long context — hard on context size.
  const model = req?.model ?? '';
  const promptTokens = countMessageTokens(messages, model);
  if (promptTokens > 16000) return 'long_context';

  // 4-6: content-based detectors — inspect only the last user turn.
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const text = lastUser ? messageText(lastUser) : '';

  if (looksLikeCode(text)) return 'code';
  if (arabicRatio(text) > 0.5) return 'arabic';
  if (REASONING_RE.test(text)) return 'reasoning';

  return 'simple_chat';
}

// ============ Cascades ============

/**
 * Ordered provider cascades per intent. The first entry is the primary
 * provider; the rest are failover fallbacks in priority order.
 *
 * Rationale (per intent):
 *   • code          — Groq's qwen3-32b is the fastest coder; cascade through
 *                     other fast inference providers before falling back to
 *                     the slower aggregator (OpenRouter) and Workers AI.
 *   • arabic        — Groq hosts allam-2-7b (IBM's Arabic-specialized model);
 *                     Cohere's aya is the next best multilingual model.
 *   • long_context  — Gemini has 1M context, so it leads. Groq's
 *                     llama-3.1-8b-instant (131k) and Mistral Large (128k)
 *                     cover the 16k-128k range.
 *   • reasoning     — DeepSeek-R1 / V3.1 are the strongest open reasoning
 *                     models; Groq has the distilled 70B (fastest), SambaNova
 *                     and Novita host the full-size models.
 *   • simple_chat   — Spread across cheap-fast providers; Gemini and
 *                     OpenRouter as catch-alls.
 *   • tool_calling  — OpenAI-compatible function-calling models on Groq,
 *                     Mistral, OpenRouter, and Gemini (native function
 *                     calling support).
 *   • multimodal    — Only Gemini supports vision in the free tier.
 */
const CASCADES: Readonly<Record<IntentType, readonly ProviderId[]>> = Object.freeze({
  code: ['groq1', 'groq2', 'mistral', 'sambanova', 'siliconflow', 'workersai', 'cerebras'],
  arabic: ['groq1', 'groq2', 'cohere', 'sambanova', 'gemini'],
  long_context: ['gemini', 'groq1', 'groq2', 'mistral'],
  reasoning: ['groq1', 'groq2', 'sambanova', 'novita'],
  simple_chat: ['groq1', 'groq2', 'mistral', 'gemini', 'openrouter', 'workersai'],
  tool_calling: ['groq1', 'groq2', 'mistral', 'openrouter', 'gemini'],
  multimodal: ['gemini'],
});

/**
 * Return the ordered list of providers to try for a given intent.
 *
 * The first provider in the list is the primary; the rest are failover
 * fallbacks in priority order. Never returns an empty array — falls back
 * to the `simple_chat` cascade for unknown intents.
 */
export function getCascadeForIntent(intent: IntentType): ProviderId[] {
  return [...(CASCADES[intent] ?? CASCADES.simple_chat)];
}

// ============ Best model per (intent, provider) ============

/**
 * Per-(intent, provider) best model id. Keyed as `${intent}:${provider}`.
 *
 * Selection criteria:
 *   - Code intent → coder-tuned models (Codestral, Qwen2.5-Coder, qwen3-32b).
 *   - Arabic intent → Arabic-specialized models where available (allam-2-7b
 *     on Groq, aya-23-35b on Cohere), else the strongest general model.
 *   - Long context → the largest-context model on each provider.
 *   - Reasoning → DeepSeek-R1 / V3.1 where available.
 *   - Simple chat → the cheapest / fastest model on each provider.
 *   - Tool calling → a model with strong function-calling support.
 *   - Multimodal → only Gemini (others fall back to provider default; the
 *     cascade for multimodal only contains Gemini anyway).
 */
const BEST_MODEL: Readonly<Record<string, string>> = Object.freeze({
  // ── code ───────────────────────────────────────────────────────────────
  'code:groq1': 'qwen3-32b',
  'code:groq2': 'qwen3-32b',
  'code:mistral': 'codestral-latest',
  'code:sambanova': 'Qwen2.5-Coder-32B-Instruct',
  'code:siliconflow': 'Qwen/Qwen2.5-Coder-32B-Instruct',
  'code:workersai': '@cf/qwen/qwen2.5-coder-32b-instruct',
  'code:cerebras': 'llama3.1-8b',
  'code:openrouter': 'openrouter/auto',
  'code:gemini': 'gemini-2.0-flash',
  'code:cohere': 'command-r-plus',
  'code:novita': 'qwen/qwen2.5-72b-instruct',
  // ── arabic ─────────────────────────────────────────────────────────────
  'arabic:groq1': 'allam-2-7b',
  'arabic:groq2': 'allam-2-7b',
  'arabic:cohere': 'aya-23-35b',
  'arabic:sambanova': 'Llama-3.3-70B-Instruct',
  'arabic:gemini': 'gemini-2.0-flash',
  'arabic:mistral': 'mistral-large-latest',
  'arabic:siliconflow': 'Qwen/Qwen2.5-72B-Instruct',
  'arabic:workersai': '@cf/qwen/qwen2.5-coder-32b-instruct',
  'arabic:cerebras': 'llama3.1-8b',
  'arabic:openrouter': 'openrouter/auto',
  'arabic:novita': 'qwen/qwen2.5-72b-instruct',
  // ── long_context ───────────────────────────────────────────────────────
  'long_context:gemini': 'gemini-1.5-flash',
  'long_context:groq1': 'llama-3.1-8b-instant',
  'long_context:groq2': 'llama-3.1-8b-instant',
  'long_context:mistral': 'mistral-large-latest',
  'long_context:sambanova': 'Llama-3.3-70B-Instruct',
  'long_context:siliconflow': 'deepseek-ai/DeepSeek-V3',
  'long_context:workersai': '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  'long_context:cerebras': 'llama3.1-8b',
  'long_context:cohere': 'command-r-plus',
  'long_context:novita': 'deepseek/deepseek-v3.1',
  'long_context:openrouter': 'openrouter/auto',
  // ── reasoning ──────────────────────────────────────────────────────────
  'reasoning:groq1': 'deepseek-r1-distill-llama-70b',
  'reasoning:groq2': 'deepseek-r1-distill-llama-70b',
  'reasoning:sambanova': 'DeepSeek-R1',
  'reasoning:novita': 'deepseek/deepseek-r1',
  'reasoning:mistral': 'magistral-medium-latest',
  'reasoning:siliconflow': 'deepseek-ai/DeepSeek-R1',
  'reasoning:workersai': '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
  'reasoning:cerebras': 'llama3.1-8b',
  'reasoning:cohere': 'command-r-plus',
  'reasoning:gemini': 'gemini-2.0-flash',
  'reasoning:openrouter': 'openrouter/auto',
  // ── simple_chat ────────────────────────────────────────────────────────
  'simple_chat:groq1': 'llama-3.1-8b-instant',
  'simple_chat:groq2': 'llama-3.1-8b-instant',
  'simple_chat:mistral': 'mistral-small-latest',
  'simple_chat:gemini': 'gemini-2.0-flash',
  'simple_chat:openrouter': 'openrouter/auto',
  'simple_chat:workersai': '@cf/meta/llama-3.1-8b-instruct',
  'simple_chat:sambanova': 'Llama-3.3-70B-Instruct',
  'simple_chat:siliconflow': 'Qwen/Qwen2.5-72B-Instruct',
  'simple_chat:cerebras': 'llama3.1-8b',
  'simple_chat:cohere': 'command-r-plus',
  'simple_chat:novita': 'qwen/qwen2.5-72b-instruct',
  // ── tool_calling ───────────────────────────────────────────────────────
  'tool_calling:groq1': 'llama-3.3-70b-versatile',
  'tool_calling:groq2': 'llama-3.3-70b-versatile',
  'tool_calling:mistral': 'mistral-large-latest',
  'tool_calling:openrouter': 'openrouter/auto',
  'tool_calling:gemini': 'gemini-2.0-flash',
  'tool_calling:sambanova': 'Llama-3.3-70B-Instruct',
  'tool_calling:siliconflow': 'Qwen/Qwen2.5-72B-Instruct',
  'tool_calling:workersai': '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  'tool_calling:cerebras': 'llama3.1-8b',
  'tool_calling:cohere': 'command-r-plus',
  'tool_calling:novita': 'qwen/qwen2.5-72b-instruct',
  // ── multimodal ─────────────────────────────────────────────────────────
  'multimodal:gemini': 'gemini-2.0-flash',
});

/** Per-provider default model (used when no intent-specific entry exists). */
const PROVIDER_DEFAULT_MODEL: Readonly<Record<ProviderId, string>> = Object.freeze({
  groq1: 'llama-3.1-8b-instant',
  groq2: 'llama-3.1-8b-instant',
  mistral: 'mistral-small-latest',
  sambanova: 'Llama-3.3-70B-Instruct',
  siliconflow: 'Qwen/Qwen2.5-72B-Instruct',
  workersai: '@cf/meta/llama-3.1-8b-instruct',
  cerebras: 'llama3.1-8b',
  cohere: 'command-r-plus',
  gemini: 'gemini-2.0-flash',
  novita: 'qwen/qwen2.5-72b-instruct',
  openrouter: 'openrouter/auto',
});

/**
 * Pick the best model id for a (intent, provider) pair.
 *
 * Falls back to the provider's default model if no intent-specific entry
 * exists. This happens for combinations where the provider isn't in the
 * intent's cascade (e.g. `multimodal:groq1` → Groq can't do vision, so the
 * router would never ask for it — but the function is still total).
 *
 * Returns the empty string only if the provider is unknown (shouldn't
 * happen in practice because `provider: ProviderId` is enforced by TS).
 */
export function pickBestModel(
  intent: IntentType,
  provider: ProviderId,
): string {
  const key = `${intent}:${provider}`;
  return BEST_MODEL[key] ?? PROVIDER_DEFAULT_MODEL[provider] ?? '';
}
