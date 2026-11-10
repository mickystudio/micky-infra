/**
 * Micky Assistant Unlimited - Prompt Compiler / Layer 4: Constraining
 * ----------------------------------------------------------------------------
 * مُوجّه البرومبت - الطبقة 4: التقييد
 *
 * Final layer: assembles the final system prompt and messages array that gets
 * sent to the LLM. Merges:
 *   - Project system prompt (from layer 2).
 *   - Template system prompt (from layer 3).
 *   - Conversation history + chat summaries + memory snippets (from layer 2).
 *   - Output-format directive (markdown / json / steps / code).
 *   - Language directive (Arabic by default).
 *   - Safety constraints (no hallucination, cite sources, etc.).
 *
 * Also produces token-estimation metadata using the shared `utils/tokens`
 * helpers (which handle Arabic / English / code ratio detection).
 *
 * Created: 2026-11-10
 * Phase: P2-T1
 */

import type { RoutedPrompt, RequestType, GoldenTemplate, OutputFormat } from './3_route';
import { estimateTokens, estimateMessagesTokens, type MessageLike } from '../../utils/tokens';

// Re-exports for callers who only want to import from one module.
export type { RoutedPrompt, RequestType, GoldenTemplate, OutputFormat };

// ============ Public types ============

export interface ConstrainOptions {
  /** Override the template's default output_format. */
  format?: OutputFormat;
  /** Override the language directive. Defaults to 'ar'. */
  language?: 'ar' | 'en';
}

export interface CompiledPromptMetadata {
  /** Layers applied (in order). Always the 4 layers for a normal compilation. */
  layers_applied: string[];
  /** File name of the golden template used (e.g. "question.yaml"). */
  template_used: string;
  /** Detected request type (e.g. "dental_medical"). */
  request_type: RequestType;
  /** Rough token estimation. */
  tokens_estimated: {
    system_prompt: number;
    messages: number;
    total: number;
  };
  /** True when this CompiledPrompt was served from PROMPT_CACHE. */
  cached: boolean;
  /** The KV cache key, when cached. */
  cache_key?: string;
  /** Total compile time in ms (orchestrator-level, set by prompt_compiler). */
  compile_time_ms: number;
}

export interface CompiledPrompt {
  /** Final system prompt to send to the LLM. */
  systemPrompt: string;
  /** Final messages array (system + history + user). */
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /** Diagnostic metadata. */
  metadata: CompiledPromptMetadata;
}

// ============ Public API ============

/**
 * Apply constraints and assemble the final CompiledPrompt.
 *
 * Pure function — no I/O. Deterministic given the same `routed` and `options`.
 * Token estimation is heuristic (uses utils/tokens, no network call).
 */
export function constrain(
  routed: RoutedPrompt,
  options: ConstrainOptions = {},
): CompiledPrompt {
  const startTime = Date.now();
  const { template, contextualized, type, templateName } = routed;

  const format: OutputFormat = options.format ?? template.output_format ?? 'markdown';
  const language: 'ar' | 'en' = options.language ?? 'ar';

  // === Build final system prompt as discrete sections ===
  const sections: string[] = [];

  // 1) Project system prompt (or default from layer 2).
  if (contextualized.systemPrompt?.trim()) {
    sections.push(contextualized.systemPrompt.trim());
  }

  // 2) Template-specific system prompt.
  if (template.system_prompt?.trim()) {
    sections.push(template.system_prompt.trim());
  }

  // 3) Older chat summaries (compressed history beyond the window).
  if (contextualized.chatSummaries.length > 0) {
    const block = contextualized.chatSummaries
      .map((s, i) => `(${i + 1}) ${s.summary}`)
      .join('\n');
    sections.push(
      `## ملخص المحادثات السابقة (Older Conversation Summaries)\n${block}`,
    );
  }

  // 4) Project memory snippets (long-term learning).
  if (contextualized.memorySnippets.length > 0) {
    const block = contextualized.memorySnippets
      .map((m) => `- [${m.memory_type ?? 'general'}] ${m.content}`)
      .join('\n');
    sections.push(`## ذاكرة المشروع (Project Memory)\n${block}`);
  }

  // 5) Output-format directive.
  sections.push(buildFormatDirective(format));

  // 6) Language directive.
  sections.push(buildLanguageDirective(language));

  // 7) Safety constraints (base + template-specific).
  sections.push(buildSafetyConstraints(template.constraints));

  const systemPrompt = sections.filter((s) => s && s.trim().length > 0).join('\n\n---\n\n');

  // === Build messages array ===
  const messages: CompiledPrompt['messages'] = [{ role: 'system', content: systemPrompt }];

  // Conversation history (chronological — layer 2 already reverses to oldest-first).
  // Stray 'system' messages in history are collapsed to 'user' to keep the API
  // happy with strict role ordering.
  for (const m of contextualized.conversationHistory) {
    messages.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    });
  }

  // Current user message (the compressed intent from layer 1).
  messages.push({
    role: 'user',
    content: contextualized.compressedUserMessage,
  });

  // === Token estimation ===
  const systemTokens = estimateTokens(systemPrompt);
  const messagesTokens = estimateMessagesTokens(
    messages.filter((m) => m.role !== 'system') as MessageLike[],
  );

  const metadata: CompiledPromptMetadata = {
    layers_applied: ['compress', 'contextualize', 'route', 'constrain'],
    template_used: templateName,
    request_type: type,
    tokens_estimated: {
      system_prompt: systemTokens,
      messages: messagesTokens,
      total: systemTokens + messagesTokens,
    },
    cached: false,
    compile_time_ms: Date.now() - startTime,
  };

  return { systemPrompt, messages, metadata };
}

// ============ Directive builders ============

function buildFormatDirective(format: OutputFormat): string {
  switch (format) {
    case 'json':
      return [
        '## صيغة الإخراج المطلوبة (Required Output Format)',
        'Output MUST be valid JSON. No prose before or after the JSON object.',
        'Do NOT wrap the JSON in markdown fences.',
        'If the answer cannot be JSON, return `{ "error": "reason" }`.',
      ].join('\n');
    case 'steps':
      return [
        '## صيغة الإخراج المطلوبة',
        'Structure your answer as numbered steps (1. 2. 3.).',
        'Each step on its own line. Use sub-bullets (a, b, c) only when needed.',
        'Keep each step focused on a single action.',
      ].join('\n');
    case 'code':
      return [
        '## صيغة الإخراج المطلوبة',
        'Provide code in fenced blocks with the correct language tag',
        '(```ts, ```py, ```sql, ```bash, ...).',
        'Keep prose minimal. State assumptions in 1-2 lines BEFORE the code.',
        'Add a brief usage example after the main code block.',
      ].join('\n');
    case 'markdown':
    default:
      return [
        '## صيغة الإخراج المطلوبة',
        'Use clean Markdown:',
        '- ## for sections, ### for subsections.',
        '- Bullet lists (-) for enumerations, numbered lists for sequences.',
        '- **bold** for emphasis; `code` for inline technical terms.',
        '- Keep paragraphs short (2-4 lines).',
      ].join('\n');
  }
}

function buildLanguageDirective(language: 'ar' | 'en'): string {
  if (language === 'ar') {
    return [
      '## اللغة (Language)',
      'أجب بالعربية الفصحى المعاصرة (Modern Standard Arabic) افتراضياً.',
      'استخدم الإنجليزية فقط في الحالات التالية:',
      '- مصطلحات تقنية بين قوسين بعد ترجمتها (مثال: تقويم (Orthodontics)).',
      '- إذا طلب المستخدم صراحة لغة أخرى.',
      '- أسماء الأدوية أو العلامات التجارية عند عدم وجود ترجمة معتمدة.',
    ].join('\n');
  }
  return [
    '## Language',
    'Reply in English unless the user explicitly requests another language.',
    'Preserve any Arabic technical terms in parentheses when helpful.',
  ].join('\n');
}

/**
 * Always-on safety constraints (no hallucination, cite sources, no diagnosis)
 * plus the template-specific constraints from the chosen golden template.
 */
function buildSafetyConstraints(
  templateConstraints: string[] | undefined,
): string {
  const base: string[] = [
    'لا تختلق معلومات (no hallucination). إذا كنت غير متأكد، اذكر ذلك صراحة.',
    'لا تخترع مصادر أو إحصائيات. إذا لم تعرف، قل "لا أعرف".',
    'إذا استخدمت نتائج بحث ويب، اذكر المصدر بصيغة [source: domain.com].',
    'لا تقدم نصائح طبية تشخيصية محددة لحالة معينة — وجّه المريض لاستشارة طبيبه.',
    'حافظ على نبرة مهنية محترمة في كل الإجابات.',
  ];
  const extra = (templateConstraints ?? []).filter((c) => typeof c === 'string' && c.trim().length > 0);
  return '## قيود السلامة (Safety Constraints)\n' + [...base, ...extra].map((c) => `- ${c}`).join('\n');
}
