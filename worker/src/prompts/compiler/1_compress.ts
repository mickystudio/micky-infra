/**
 * Micky Assistant Unlimited - Prompt Compiler / Layer 1: Compression
 * ----------------------------------------------------------------------------
 * مُوجّه البرومبت - الطبقة 1: الضغط
 *
 * Reduces raw user input to its core intent by:
 *   1. Stripping greetings (Arabic + English).
 *   2. Removing filler phrases ("please", "لو سمحت", "يعني", …).
 *   3. Collapsing whitespace.
 *   4. Deduplicating near-identical sentences.
 *
 * For complex or long messages that resist rule-based compression, falls back
 * to the FAST_MODEL (14B) for an LLM pass. The rule-based path is the default
 * because it is ~1000x faster and has no rate-limit cost.
 *
 * Created: 2026-11-10
 * Phase: P2-T1
 */

import type { Env } from '../../index';

// ============ Public API ============

/**
 * Compress a raw user message into its core intent.
 *
 * - Rule-based first (instant, free).
 * - Falls back to FAST_MODEL only when rules barely reduced a long/complex
 *   message, or when the rule output is suspiciously empty.
 *
 * Never throws — on any failure returns the trimmed original input.
 */
export async function compress(env: Env, text: string): Promise<string> {
  const original = (text ?? '').trim();
  if (original.length === 0) return '';
  if (original.length < 8) return original;

  // === Rule-based pass ===
  const ruleBased = applyRules(original);

  // === Decide whether to escalate to the LLM ===
  const ratio = ruleBased.length / original.length;
  const needsLLM =
    ruleBased.length === 0 || // rules ate everything
    original.length > 600 || // long & complex
    (ratio > 0.92 && original.length > 120); // barely compressed

  if (!needsLLM) {
    return ruleBased || original;
  }

  if (!env?.AI || !env?.FAST_MODEL) {
    return ruleBased || original;
  }

  try {
    const llmCompressed = await compressWithLLM(env, original);
    if (llmCompressed && llmCompressed.length >= 4 && llmCompressed.length <= original.length * 2) {
      return llmCompressed;
    }
  } catch (err) {
    console.error('[compress] LLM fallback failed:', err);
  }

  return ruleBased || original;
}

// ============ Rule-based compression ============

/**
 * Apply a sequence of regex-based reductions. Each pass is independent and
 * idempotent, so order does not matter for correctness but is tuned for
 * readability of intermediate output.
 */
function applyRules(text: string): string {
  let out = text;

  // 1) Strip leading greetings.
  out = out.replace(GREETING_RE, '');
  // 2) Strip trailing pleasantries ("thanks!", "شكرا لك", ...).
  out = out.replace(OUTRO_RE, '');
  // 3) Remove filler phrases (case-insensitive, Unicode-aware).
  for (const phrase of FILLER_PHRASES) {
    const re = new RegExp(escapeRegex(phrase), 'giu');
    out = out.replace(re, '');
  }
  // 4) Collapse repeated punctuation ("???" → "?", "!!!" → "!").
  out = out.replace(/([!?؟.،,;:])\1{1,}/gu, '$1');
  // 5) Collapse whitespace runs to a single space.
  out = out.replace(/\s+/g, ' ').trim();
  // 6) Deduplicate near-identical sentences (case-insensitive, trimmed).
  out = dedupeSentences(out);
  // 7) Final trim.
  return out.trim();
}

/**
 * Split into sentences on Arabic + Latin terminal punctuation, drop
 * duplicates (case-insensitive), and re-join. Short fragments (<3 chars)
 * are dropped as noise.
 */
function dedupeSentences(text: string): string {
  if (!text) return '';
  const parts = text.split(/(?<=[.!?؟])\s+/u).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return text;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of parts) {
    const key = s.toLowerCase().replace(/\s+/g, ' ').trim();
    if (key.length < 3) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.join(' ').trim();
}

/** Escape regex metacharacters in a literal string. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============ LLM fallback ============

async function compressWithLLM(env: Env, text: string): Promise<string> {
  const aiResponse = await env.AI.run(env.FAST_MODEL, {
    messages: [
      {
        role: 'system',
        content: [
          'You are a prompt compression engine.',
          'Rewrite the user message to be concise and intent-focused.',
          'Remove greetings, filler, and repetition.',
          'Preserve all technical terms (Arabic, English, dental, medical, code).',
          'Output ONLY the compressed message — no explanation, no quotes.',
          'Use the SAME language as the input (Arabic in → Arabic out).',
        ].join(' '),
      },
      { role: 'user', content: text },
    ],
    max_tokens: 256,
    temperature: 0.0,
  });
  const reply = (aiResponse as { response?: string }).response ?? '';
  return reply.trim();
}

// ============ Patterns ============

/** Leading greetings (Arabic + English) followed by separator. */
const GREETING_RE =
  /^\s*(?:hello|hi|hey|yo|hola|salam|سلام|مرحبا|مرحبًا|أهلاً|اهلا|السلام\s+عليكم|good\s+(?:morning|evening|afternoon)|صباح\s+(?:الخير|النور)|مساء\s+(?:الخير|النور))[!.,،\s]*/iu;

/** Trailing pleasantries (thanks, bye, etc.). */
const OUTRO_RE =
  /(?:\s*,?\s*(?:thanks|thank\s+you|thx|شكراً?|شكرا\s+لك|يعطيك\s+العافية|تسلم|bye|مع\s+السلامة)[!.,،\s]*)+$/iu;

/** Filler phrases removed by rule 3. Order: longer first to avoid partials. */
const FILLER_PHRASES: readonly string[] = [
  // Arabic
  'لو سمحت',
  'من فضلك',
  'لو ممكن',
  'إذا أمكن',
  'يا صديقي',
  'يا دكتور',
  'بصراحة',
  'بصراحةً',
  'يعني',
  'كنت أتساءل',
  'أحب أن',
  'أريد أن',
  'أود أن',
  'محتاج مساعدة',
  'هل يمكنك',
  'هل يمكنك أن',
  'ممكن',
  // English
  'i was wondering',
  'could you possibly',
  'could you please',
  'would you please',
  'just wanted to',
  'kindly',
  'please',
  'basically',
  'actually',
  'really',
  'honestly',
  'so to speak',
  'in other words',
];
