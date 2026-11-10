/**
 * Micky Assistant Unlimited - Prompt Compiler (Main Orchestrator)
 * ----------------------------------------------------------------------------
 * مُوجّه البرومبت - المنسق الرئيسي (P2-T1)
 *
 * Transforms a raw user message into an optimized LLM prompt through 4 layers:
 *
 *   1. compress        — strip filler, focus intent (rule-based + LLM fallback)
 *   2. contextualize    — inject project system_prompt + history + memory
 *   3. route            — pick a golden template based on request type
 *   4. constrain        — enforce output format, language, safety constraints
 *
 * Caching: the compiled prompt is stored in PROMPT_CACHE KV under a SHA-256
 * key derived from (chatId + userMessage + options). TTL = 7 days (604800s).
 * Same input always yields the same output, retrieved from KV on cache hit.
 *
 * Error handling: each layer is wrapped in try/catch. If a layer fails the
 * orchestrator falls back gracefully (raw input, default system prompt, the
 * 'question' template, default constraints) so compilation never throws.
 *
 * Created: 2026-11-10
 * Phase: P2-T1
 */

import type { Env } from '../index';
import { compress } from '../prompts/compiler/1_compress';
import { contextualize, type ContextualizedPrompt } from '../prompts/compiler/2_contextualize';
import { route, type RoutedPrompt, type RequestType, type GoldenTemplate } from '../prompts/compiler/3_route';
import {
  constrain,
  type CompiledPrompt,
  type CompiledPromptMetadata,
  type ConstrainOptions,
} from '../prompts/compiler/4_constrain';

// Re-export the public surface so callers can import everything from here.
export { compress } from '../prompts/compiler/1_compress';
export { contextualize } from '../prompts/compiler/2_contextualize';
export { route, detectType, loadTemplate, clearTemplateCache } from '../prompts/compiler/3_route';
export { constrain } from '../prompts/compiler/4_constrain';
export type { ConstrainOptions } from '../prompts/compiler/4_constrain';
export type { ContextualizedPrompt } from '../prompts/compiler/2_contextualize';
export type { RoutedPrompt, RequestType, GoldenTemplate } from '../prompts/compiler/3_route';
export type { CompiledPrompt, CompiledPromptMetadata } from '../prompts/compiler/4_constrain';

// ============ Constants ============

/** Cache TTL: 7 days in seconds. */
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 7; // 604800

/** Cache schema version — bump when the compiled shape changes. */
const CACHE_VERSION = 'v1';

/** Prefix on every cache key, for namespacing inside the KV namespace. */
const CACHE_KEY_PREFIX = 'pc';

// ============ Public API ============

/**
 * Compile a user message into an optimized prompt.
 *
 * @param env           Worker bindings (DB + AI + PROMPT_CACHE).
 * @param chatId        The chat_id (TEXT in D1) the message belongs to.
 * @param userMessage   Raw user message text.
 * @param options       Optional overrides: output format, language, skipCache.
 * @returns             A CompiledPrompt ready to send to the LLM.
 */
export async function compilePrompt(
  env: Env,
  chatId: string,
  userMessage: string,
  options: CompilePromptOptions = {},
): Promise<CompiledPrompt> {
  const startTime = Date.now();

  // === Cache lookup ===
  const cacheKey = await buildCacheKey(chatId, userMessage, options);
  if (!options.skipCache && env?.PROMPT_CACHE) {
    try {
      const cached = await env.PROMPT_CACHE.get(cacheKey, 'json');
      if (cached && typeof cached === 'object') {
        const cachedPrompt = cached as CompiledPrompt;
        // Mark metadata as cached + record diagnostics.
        cachedPrompt.metadata = {
          ...cachedPrompt.metadata,
          cached: true,
          cache_key: cacheKey,
          compile_time_ms: Date.now() - startTime,
        };
        return cachedPrompt;
      }
    } catch (err) {
      console.error('[prompt_compiler] cache read failed:', err);
    }
  }

  // === Layer 1: Compress ===
  let compressed = userMessage;
  try {
    compressed = await compress(env, userMessage);
  } catch (err) {
    console.error('[prompt_compiler] L1 compress failed:', err);
    compressed = userMessage;
  }

  // === Layer 2: Contextualize ===
  let contextualized: ContextualizedPrompt;
  try {
    contextualized = await contextualize(env, chatId, compressed);
  } catch (err) {
    console.error('[prompt_compiler] L2 contextualize failed:', err);
    contextualized = {
      systemPrompt:
        'You are Micky Assistant. Reply in Arabic unless asked otherwise.',
      compressedUserMessage: compressed,
      conversationHistory: [],
      memorySnippets: [],
      chatSummaries: [],
    };
  }

  // === Layer 3: Route ===
  let routed: RoutedPrompt;
  try {
    routed = await route(env, contextualized);
  } catch (err) {
    console.error('[prompt_compiler] L3 route failed:', err);
    routed = {
      type: 'question',
      templateName: 'question.yaml',
      template: {
        name: 'question',
        system_prompt: '',
        output_format: options.format ?? 'markdown',
        constraints: [],
        examples: [],
      },
      contextualized,
    };
  }

  // === Layer 4: Constrain ===
  let compiled: CompiledPrompt;
  try {
    compiled = constrain(routed, {
      format: options.format,
      language: options.language,
    });
  } catch (err) {
    console.error('[prompt_compiler] L4 constrain failed:', err);
    // Last-resort minimal compiled prompt.
    compiled = {
      systemPrompt: contextualized.systemPrompt,
      messages: [
        { role: 'system', content: contextualized.systemPrompt },
        { role: 'user', content: compressed },
      ],
      metadata: {
        layers_applied: ['compress', 'contextualize'],
        template_used: 'fallback',
        request_type: 'question',
        tokens_estimated: {
          system_prompt: 0,
          messages: 0,
          total: 0,
        },
        cached: false,
        compile_time_ms: 0,
      },
    };
  }

  // Record full-pipeline compile time (constrain's own timer only covers its work).
  compiled.metadata.compile_time_ms = Date.now() - startTime;

  // === Cache write ===
  if (!options.skipCache && env?.PROMPT_CACHE) {
    try {
      await env.PROMPT_CACHE.put(cacheKey, JSON.stringify(compiled), {
        expirationTtl: CACHE_TTL_SECONDS,
      });
    } catch (err) {
      console.error('[prompt_compiler] cache write failed:', err);
    }
  }

  return compiled;
}

// ============ Options type ============

export interface CompilePromptOptions {
  /** Override the template's default output_format. */
  format?: ConstrainOptions['format'];
  /** Override the language directive. Defaults to 'ar'. */
  language?: ConstrainOptions['language'];
  /** Skip KV cache read/write for this call (e.g. for tests). */
  skipCache?: boolean;
}

// ============ Helpers ============

/**
 * Build a deterministic KV cache key from the inputs.
 * Key shape: `pc:v1:<sha256-hex>`.
 *
 * The hashed payload includes the cache version, chatId, userMessage, and
 * the format/language options (so different option combos get distinct keys).
 */
async function buildCacheKey(
  chatId: string,
  userMessage: string,
  options: CompilePromptOptions,
): Promise<string> {
  const payload = JSON.stringify({
    v: CACHE_VERSION,
    chatId,
    userMessage,
    format: options.format ?? 'auto',
    language: options.language ?? 'auto',
    skipCache: options.skipCache ?? false,
  });

  const encoder = new TextEncoder();
  const data = encoder.encode(payload);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return `${CACHE_KEY_PREFIX}:${CACHE_VERSION}:${hashHex}`;
}
