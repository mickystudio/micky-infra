/**
 * Micky Assistant Unlimited - Token Estimation Utilities
 *
 * Approximate token counting for chat messages, useful for:
 *   - Context window management (Text Mode)
 *   - Rate-limit awareness (BYOK)
 *   - plan.md chunking (Code Mode)
 *
 * The Workers AI runtime does not always expose a tokenizer; these
 * heuristics are intentionally conservative and never require a network call.
 *
 * Created: 2026-11-10
 * Phase: P3-T1 / P3-T2
 */

// ============ Constants ============

/** Average characters per token for plain ASCII / Latin text. */
const CHARS_PER_TOKEN_LATIN = 4;

/**
 * Average characters per token for Arabic / CJK text.
 * Arabic morphemes and CJK codepoints are roughly 2 chars / token
 * because each token spans fewer characters.
 */
const CHARS_PER_TOKEN_ARABIC = 2;

/** Average characters per token for source code (denser than English). */
const CHARS_PER_TOKEN_CODE = 3;

/** Per-message overhead (role, separators) in tokens. */
const MESSAGE_OVERHEAD_TOKENS = 4;

/** Total overhead added to a messages array (priming, role formatting). */
const ARRAY_OVERHEAD_TOKENS = 3;

// ============ Detection Heuristics ============

/**
 * Detect whether a string contains a meaningful amount of Arabic characters.
 * Returns the ratio of Arabic chars / total chars (0..1).
 *
 * Arabic Unicode block: U+0600 - U+06FF (with extensions U+0750-U+077F, U+FB50-U+FEFF).
 */
export function arabicRatio(text: string): number {
  if (text.length === 0) return 0;
  let arabic = 0;
  let total = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    // Skip whitespace and punctuation when counting density.
    if (/\s/.test(ch)) continue;
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

/**
 * Heuristic: does the string look like source code?
 *
 * Triggers on common code tokens: braces, semicolons, =>, def/func/function,
 * import, return, common operators, etc.
 */
export function looksLikeCode(text: string): boolean {
  if (text.length === 0) return false;
  let score = 0;
  if (/^\s*\/\*|^\s*#|^\s*\/\//m.test(text)) score += 1; // comments
  if (/[{};]/.test(text)) score += 1;
  if (/=>|->|\bfunc\b|\bdef\b|\bfunction\b|\bclass\b|\bimport\b|\breturn\b/.test(text)) score += 2;
  if (/=\s*[^=]/.test(text)) score += 1;
  return score >= 3;
}

// ============ Public API ============

/**
 * Estimate the number of tokens in a string.
 *
 * - English / Latin text: ~4 chars/token
 * - Arabic: ~2 chars/token (heavier on token budget)
 * - Source code: ~3 chars/token
 *
 * Mixed content is pro-rated by the Arabic ratio; code is detected
 * globally and adjusts the divisor downward.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const len = text.length;
  if (len === 0) return 0;

  if (looksLikeCode(text)) {
    return Math.max(1, Math.ceil(len / CHARS_PER_TOKEN_CODE));
  }

  const ar = arabicRatio(text);
  if (ar > 0.3) {
    // Predominantly Arabic.
    return Math.max(1, Math.ceil(len / CHARS_PER_TOKEN_ARABIC));
  }
  if (ar > 0.05) {
    // Mixed: weight the two divisors.
    const weighted =
      ar * (len / CHARS_PER_TOKEN_ARABIC) +
      (1 - ar) * (len / CHARS_PER_TOKEN_LATIN);
    return Math.max(1, Math.ceil(weighted));
  }
  // Latin/ASCII text.
  return Math.max(1, Math.ceil(len / CHARS_PER_TOKEN_LATIN));
}

/** Shape of a chat message understood by `estimateMessagesTokens`. */
export interface MessageLike {
  role: string;
  content: string;
}

/**
 * Estimate total token usage for an array of messages,
 * including per-message overhead (role tags, separators).
 */
export function estimateMessagesTokens(messages: MessageLike[]): number {
  if (!messages || messages.length === 0) return 0;
  let sum = 0;
  for (const m of messages) {
    sum += estimateTokens(m.content) + MESSAGE_OVERHEAD_TOKENS;
  }
  return sum + ARRAY_OVERHEAD_TOKENS;
}

/**
 * Truncate a string so that its estimated token count does not exceed `maxTokens`.
 *
 * Backs off character-by-character using the appropriate divisor for the
 * text's language/code profile. Never returns more than `maxTokens` tokens.
 *
 * If `maxTokens` is <= 0, returns the empty string.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  const estimated = estimateTokens(text);
  if (estimated <= maxTokens) return text;

  // Pick the divisor matching the content profile.
  let divisor = CHARS_PER_TOKEN_LATIN;
  if (looksLikeCode(text)) {
    divisor = CHARS_PER_TOKEN_CODE;
  } else if (arabicRatio(text) > 0.3) {
    divisor = CHARS_PER_TOKEN_ARABIC;
  }

  const maxChars = Math.max(1, Math.floor(maxTokens * divisor));
  if (text.length <= maxChars) return text;

  // Try to truncate on a whitespace boundary (cleaner for LLM input).
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > maxChars * 0.6) {
    return cut.slice(0, lastSpace).trimEnd() + '…';
  }
  return cut.trimEnd() + '…';
}

/**
 * Split a long string into chunks that each fit within `maxTokensPerChunk`
 * (estimated). The splitter prefers:
 *   1. Paragraph breaks (\n\n)
 *   2. Line breaks (\n)
 *   3. Sentence punctuation (. ! ? Arabic ؟ ،)
 *   4. Whitespace
 *
 * The function never returns an empty array; an empty input returns [].
 */
export function chunkByTokens(text: string, maxTokensPerChunk: number): string[] {
  if (!text) return [];
  const total = estimateTokens(text);
  if (total <= maxTokensPerChunk) {
    return [text];
  }

  const chunks: string[] = [];
  let buffer = '';

  // Split on paragraph boundaries first.
  const paragraphs = text.split(/\n\n+/);

  const flush = () => {
    if (buffer.trim().length > 0) {
      chunks.push(buffer.trim());
    }
    buffer = '';
  };

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);

    if (paraTokens > maxTokensPerChunk) {
      // Paragraph itself is too large → flush current buffer, then split further.
      flush();
      // Try sentence-level splits first.
      const sentences = para.split(/(?<=[.!?؟،])\s+/);
      let current = '';
      for (const s of sentences) {
        const candidate = current ? `${current} ${s}` : s;
        if (estimateTokens(candidate) > maxTokensPerChunk) {
          if (current) chunks.push(current.trim());
          // If the single sentence is still too long, hard-split it.
          if (estimateTokens(s) > maxTokensPerChunk) {
            const split = hardSplit(s, maxTokensPerChunk);
            chunks.push(...split);
            current = '';
          } else {
            current = s;
          }
        } else {
          current = candidate;
        }
      }
      if (current.trim()) chunks.push(current.trim());
      continue;
    }

    // Paragraph fits; try to append to buffer.
    const candidate = buffer ? `${buffer}\n\n${para}` : para;
    if (estimateTokens(candidate) > maxTokensPerChunk) {
      flush();
      buffer = para;
    } else {
      buffer = candidate;
    }
  }
  flush();
  return chunks;
}

/**
 * Hard-split a single (long) string into token-bounded pieces
 * by character count using the appropriate divisor for the content.
 */
function hardSplit(text: string, maxTokens: number): string[] {
  const out: string[] = [];
  let divisor = CHARS_PER_TOKEN_LATIN;
  if (looksLikeCode(text)) divisor = CHARS_PER_TOKEN_CODE;
  else if (arabicRatio(text) > 0.3) divisor = CHARS_PER_TOKEN_ARABIC;

  const maxChars = Math.max(1, Math.floor(maxTokens * divisor));
  for (let i = 0; i < text.length; i += maxChars) {
    out.push(text.slice(i, i + maxChars));
  }
  return out;
}
