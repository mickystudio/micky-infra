/**
 * Micky Assistant Unlimited - Prompt Compiler / Layer 3: Routing
 * ----------------------------------------------------------------------------
 * مُوجّه البرومبت - الطبقة 3: التوجيه
 *
 * Detects the request type (question / code_request / analysis / creative /
 * dental_medical) and selects the matching golden template.
 *
 * Detection is rule-based (keyword regex) — fast and free. The dental bucket
 * further splits into `dental_educational` (patient-facing) vs
 * `dental_clinical` (colleague-facing) via a sub-pattern.
 *
 * Templates live in `../golden_templates/*.yaml` (source of truth). The same
 * YAML content is embedded as TS template literals below (because Cloudflare
 * Workers cannot read files from disk at runtime and Wrangler does not expose
 * a `.yaml` text loader by default). Parsed once at module load and cached.
 *
 * Sync rule: when you edit a .yaml file in `../golden_templates/`, update the
 * matching string in TEMPLATE_YAML_CONTENT too.
 *
 * Created: 2026-11-10
 * Phase: P2-T1
 */

import { parse as parseYaml } from 'yaml';
import type { Env } from '../../index';
import type { ContextualizedPrompt } from './2_contextualize';

// ============ Public types ============

export type RequestType =
  | 'question'
  | 'code_request'
  | 'analysis'
  | 'creative'
  | 'dental_medical';

export type OutputFormat = 'markdown' | 'json' | 'steps' | 'code';

export interface GoldenTemplate {
  name: string;
  description?: string;
  language?: string;
  audience?: string;
  system_prompt: string;
  output_format: OutputFormat;
  constraints: string[];
  examples: Array<{ input: string; output: string }>;
}

export interface RoutedPrompt {
  /** Detected request type. */
  type: RequestType;
  /** File name of the chosen template, e.g. "question.yaml". */
  templateName: string;
  /** Parsed template object. */
  template: GoldenTemplate;
  /** Pass-through of layer 2 output for layer 4 to consume. */
  contextualized: ContextualizedPrompt;
}

// ============ Routing rules ============

interface RoutingRule {
  type: RequestType;
  patterns: RegExp[];
}

/**
 * Unicode-aware word boundaries.
 *
 * JavaScript's `\b` only considers ASCII `[A-Za-z0-9_]`, so it does NOT match
 * at Arabic word edges. We use explicit lookarounds on `\p{L}` (any letter),
 * `\p{N}` (any number), and `_` instead. Requires the `u` flag.
 */
const WB_START = '(?<![\\p{L}\\p{N}_])';
const WB_END = '(?![\\p{L}\\p{N}_])';

/** Build a Unicode-aware regex from a body, wrapped in word boundaries. */
function wb(body: string): RegExp {
  return new RegExp(`${WB_START}(?:${body})${WB_END}`, 'iu');
}

/**
 * Routing order (most specific first):
 *   1. analysis       — explicit compare/analyze verbs (overrides code mentions)
 *   2. code_request   — explicit code-writing verbs / programming terms
 *   3. creative       — explicit create/generate verbs
 *   4. dental_medical — domain terms (checked last so a comparison request
 *                       mentioning dental terms still routes to `analysis`)
 *   5. question       — implicit default
 */
const ROUTING_RULES: RoutingRule[] = [
  {
    type: 'analysis',
    patterns: [
      // Arabic analysis verbs / keywords
      wb('حلل|قارن\s+بين|قارن|مقارنة|قيّم|تقييم|الفروق|مميزات\s+وعيوب|عيوب|مميزات'),
      // English analysis verbs / keywords
      wb('analyze|compare|comparison|evaluate|evaluation|trade-?offs|pros\s+and\s+cons|investigate|review'),
    ],
  },
  {
    type: 'code_request',
    patterns: [
      // Arabic code-writing phrases
      wb('اكتب\s+كود|اكتب\s+دالة|اكتب\s+سكريبت|اكتب\s+برنامج|صحح\s+الكود|برمج|برمجة|دالة|كلاس|سكريبت|خوارزمية'),
      // English code-writing phrases / programming terms
      wb('write\s+(?:a\s+)?(?:function|class|method|script|code|program|algorithm|component)|refactor|api|endpoint|script|function|class|method|algorithm|debug|compile|parse|regex|sql|query|typescript|javascript|python|rust|golang|java|c\+\+|html|css'),
    ],
  },
  {
    type: 'creative',
    patterns: [
      // Arabic creative verbs
      wb('صمم|اكتب\s+مقال|اكتب\s+قصة|اكتب\s+قصيدة|اكتب\s+شعر|اكتب\s+سيناريو|اقترح\s+أفكار|ألّف|ألف'),
      // English creative verbs
      wb('create|generate|compose|design|story|poem|caption|scenario|article|blog|newsletter|tagline|slogan'),
    ],
  },
  {
    type: 'dental_medical',
    patterns: [
      // Arabic dental terms (with common definite-article prefix `ال`)
      wb('الأسنان|أسنان|التبييض|تبييض|الزراعة|زراعة|زرع|التقويم|تقويم|العصب|عصب|الحشوة|حشوة|اللثة|لثة|الضرس|ضرس|أضراس|قاطع|طربون|التركيب|تركيب|التاج|تاج|فينير|معجون|فرشاة|الخيط|خيط|التسوّس|التسوس|تسوّس|تسوس|النخر|نخر|العاج|الجذر|الفك|التخدير|تخدير|الخلع|خلع|القلع|قلع|الخراج|خراج|حساسية'),
      // English dental terms
      wb('teeth|tooth|dental|dentist|whitening|bleaching|implant|implants|orthodontic|orthodontics|braces|aligner|aligners|veneer|veneers|crown|bridge|root\s+canal|cavity|caries|gingivitis|periodontal|enamel|dentin|pulp|extraction|filling|scaling|polishing|prophylaxis|impression|abutment|denture|occlusion|malocclusion'),
    ],
  },
  // 'question' is the default fall-through.
];

/** Sub-pattern to escalate a dental request to the clinical (colleague) template. */
const CLINICAL_HINT_RE = wb(
  'clinical|colleague|protocol|بروتوكول|تقرير\s+حالة|تشخيص|تشخيص\s+تفريقي|differential|contraindications|موانع|استطباب|case\s+report|evidence-based|استناداً|مرجع|ADA|AAP|EFP|ISO',
);

/** Maps a RequestType to its default template file name. */
const DEFAULT_TEMPLATE: Record<RequestType, string> = {
  question: 'question.yaml',
  code_request: 'code_request.yaml',
  analysis: 'analysis.yaml',
  creative: 'question.yaml', // creative falls back to question's general template
  dental_medical: 'dental_educational.yaml',
};

// ============ Embedded YAML (mirrors ../golden_templates/*.yaml) ============
//
// NOTE: The actual YAML strings are declared at the BOTTOM of this file. We
// resolve them through a function (not a top-level map literal) to avoid
// "used before declaration" errors for block-scoped const references.

function getTemplateYaml(name: string): string | undefined {
  switch (name) {
    case 'question.yaml':
      return QUESTION_YAML;
    case 'code_request.yaml':
      return CODE_REQUEST_YAML;
    case 'analysis.yaml':
      return ANALYSIS_YAML;
    case 'dental_educational.yaml':
      return DENTAL_EDUCATIONAL_YAML;
    case 'dental_clinical.yaml':
      return DENTAL_CLINICAL_YAML;
    default:
      return undefined;
  }
}

const FALLBACK_TEMPLATE: GoldenTemplate = {
  name: 'fallback',
  description: 'Fallback when no template is available or parsing fails.',
  language: 'ar',
  system_prompt:
    'You are Micky Assistant. Reply in Arabic unless asked otherwise. Be accurate and concise.',
  output_format: 'markdown',
  constraints: [
    'Reply in Arabic unless the user explicitly requests another language.',
    'Do not hallucinate; say so if unsure.',
  ],
  examples: [],
};

// ============ Template cache ============

const templateCache = new Map<string, GoldenTemplate>();

/**
 * Parse (and cache) a template by file name.
 *
 * Parsing happens at most once per template per worker instance. Subsequent
 * calls hit the in-memory `templateCache` Map.
 */
export function loadTemplate(name: string): GoldenTemplate {
  const cached = templateCache.get(name);
  if (cached) return cached;

  const yamlContent = getTemplateYaml(name);
  if (!yamlContent) {
    console.error('[route] template not found:', name);
    return { ...FALLBACK_TEMPLATE, name };
  }

  try {
    const parsed = parseYaml(yamlContent) as GoldenTemplate;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('parsed template is not an object');
    }
    // Defensive: ensure required fields exist.
    const normalized: GoldenTemplate = {
      name: String(parsed.name ?? name),
      description: parsed.description,
      language: parsed.language ?? 'ar',
      audience: parsed.audience,
      system_prompt: String(parsed.system_prompt ?? ''),
      output_format: (parsed.output_format as OutputFormat) ?? 'markdown',
      constraints: Array.isArray(parsed.constraints) ? parsed.constraints.filter(Boolean) : [],
      examples: Array.isArray(parsed.examples) ? parsed.examples : [],
    };
    templateCache.set(name, normalized);
    return normalized;
  } catch (err) {
    console.error('[route] failed to parse template', name, err);
    templateCache.set(name, FALLBACK_TEMPLATE);
    return FALLBACK_TEMPLATE;
  }
}

/** Clear the in-memory template cache (useful for tests). */
export function clearTemplateCache(): void {
  templateCache.clear();
}

// ============ Public API ============

/**
 * Detect the request type and pick the matching golden template.
 *
 * Currently `env` is not used (templates are static + cached in-process) but
 * the parameter is kept for API symmetry with the other layers and to allow
 * future KV-based template overrides without changing the signature.
 */
export async function route(
  env: Env,
  contextualized: ContextualizedPrompt,
): Promise<RoutedPrompt> {
  // `env` is intentionally unused for now — kept for future KV overrides.
  void env;

  const text = contextualized.compressedUserMessage ?? '';
  const detected = detectType(text);

  // For dental requests, decide between educational (patient) and clinical.
  let templateName = DEFAULT_TEMPLATE[detected];
  if (detected === 'dental_medical' && CLINICAL_HINT_RE.test(text)) {
    templateName = 'dental_clinical.yaml';
  }

  const template = loadTemplate(templateName);

  return {
    type: detected,
    templateName,
    template,
    contextualized,
  };
}

/** Exposed for tests / layer-4 introspection. */
export function detectType(text: string): RequestType {
  if (!text) return 'question';
  for (const rule of ROUTING_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) return rule.type;
    }
  }
  return 'question';
}

// ============ Embedded YAML content (mirrors .yaml files exactly) ============
// Keep in sync with ../golden_templates/*.yaml.
// Backticks inside code blocks are escaped as \` to survive the TS template literal.

const QUESTION_YAML = `# Micky Assistant - Golden Template: Question
name: question
description: Explanatory or definitional questions
language: ar
audience: general
system_prompt: |
  You are Micky Assistant, a knowledgeable professional assistant for Dr. Micky (dentist).
  Answer the user's question clearly and accurately using Modern Standard Arabic.
  Prefer clarity over brevity when the topic is complex; otherwise be concise.
  Structure the answer with Markdown headings and bullet lists when helpful.
output_format: markdown
constraints:
  - "Reply in Arabic unless the user explicitly requests another language."
  - "Use ## headings for sections when the answer is multi-part."
  - "Use bullet lists for enumerations."
  - "Do not hallucinate facts, sources, or statistics."
  - "If unsure, say so explicitly rather than guessing."
  - "Avoid filler phrases like 'As an AI...' or 'I am just an assistant...'."
examples:
  - input: "ما هو تبييض الأسنان؟"
    output: |
      ## تبييض الأسنان

      تبييض الأسنان هو إجراء تجميلي يهدف إلى إزالة التصبغات وتفتيح لون الأسنان
      باستخدام مواد مؤكسدة (مثل بيروكسيد الهيدروجين).

      ### الأنواع
      - المنزلي: قوالب مخصصة مع جل تركيز منخفض (10-20%).
      - العيادي: جلسة واحدة بتركيز عالٍ (25-40%) تحت إشراف الطبيب.

      *هذه معلومات تعليمية وليست بديلاً لاستشارة طبيبك.*
`;

const CODE_REQUEST_YAML = `# Micky Assistant - Golden Template: Code Request
name: code_request
description: Code generation, functions, scripts, refactoring
language: en
audience: developer
system_prompt: |
  You are a senior software engineer. Write clean, idiomatic, well-commented code.
  Prefer correctness, readability, and minimal dependencies.
  Explain non-obvious decisions briefly. Include error handling when relevant.
  Keep prose concise and Arabic for explanations; keep code identifiers in English.
output_format: code
constraints:
  - "Wrap every code block in a fenced block with the correct language tag (\`\`\`ts, \`\`\`py, \`\`\`sql, ...)."
  - "Add minimal but useful comments inside the code."
  - "If the request is ambiguous, state assumptions in 1-2 lines BEFORE the code."
  - "Include error handling when the operation can fail (IO, parsing, network)."
  - "Prefer the standard library; only suggest external deps when clearly justified."
  - "Explanations in Arabic, code identifiers in English."
examples:
  - input: "اكتب دالة لحساب مضروب رقم"
    output: |
      إليك دالة لحساب المضروب (factorial) في TypeScript:

      \`\`\`ts
      function factorial(n: number): number {
        if (!Number.isInteger(n)) throw new Error('n must be an integer');
        if (n < 0) throw new Error('n must be non-negative');
        return n <= 1 ? 1 : n * factorial(n - 1);
      }
      \`\`\`

      الاستخدام:
      \`\`\`ts
      factorial(5); // 120
      \`\`\`
`;

const ANALYSIS_YAML = `# Micky Assistant - Golden Template: Analysis
name: analysis
description: Comparisons, evaluations, trade-offs, pros/cons
language: ar
audience: general
system_prompt: |
  You are an analytical assistant. Break down complex topics, compare options
  objectively, and present trade-offs clearly. Use comparison tables for
  vs-questions. Provide a brief, justified recommendation at the end.
output_format: markdown
constraints:
  - "Reply in Arabic unless the user explicitly requests another language."
  - "Use a Markdown comparison table for any 'X vs Y' question."
  - "List pros and cons explicitly when relevant."
  - "End with a short recommendation grounded in the analysis."
  - "Mark any numerical estimates as estimates; do not invent statistics."
  - "Cite the source when quoting a specific figure (e.g., [source: ada.org])."
examples:
  - input: "قارن بين تقويم الأسنان الشفاف والمعدني"
    output: |
      ## مقارنة بين التقويم الشفاف والمعدني

      | المعيار | الشفاف (Aligner) | المعدني التقليدي |
      |---|---|---|
      | المظهر | شبه غير مرئي | ملحوظ |
      | إزالة للتنظيف | نعم | لا |
      | مدة العلاج | 6-18 شهراً | 12-24 شهراً |
      | التكلفة | أعلى عادةً | أقل عادةً |

      ### التوصية
      للحالات البسيطة: التقويم الشفاف. للحالات المعقدة: المعدني التقليدي.
`;

const DENTAL_EDUCATIONAL_YAML = `# Micky Assistant - Golden Template: Dental Educational
name: dental_educational
description: Patient-facing dental education content
language: ar
audience: patients
system_prompt: |
  You are a dental patient-education assistant for Dr. Micky.
  Explain dental topics in clear, simple Arabic suitable for patients.
  Avoid jargon, or define it immediately when used. Use analogies and
  step-by-step explanations. Always include an aftercare / what-to-expect
  section when relevant, and a non-frightening, reassuring tone.
output_format: markdown
constraints:
  - "Reply in Arabic (MSA) unless the user explicitly requests another language."
  - "Use simple, non-frightening language suitable for patients."
  - "Include a 'الرعاية بعد الإجراء' section when relevant."
  - "Include a 'ما يجب توقعه' section when relevant."
  - "Add the disclaimer at the end: 'هذه معلومات تعليمية وليست بديلاً لاستشارة طبيبك'."
  - "Do NOT diagnose a specific patient's condition — direct them to consult their dentist."
  - "Define any clinical term in parentheses the first time it appears."
examples:
  - input: "اشرح لي زراعة الأسنان"
    output: |
      ## زراعة الأسنان

      زراعة الأسنان هي إجراء يستعاض به عن السن المفقود بجذر صناعي يُثبَّت في عظم الفك،
      ثم يُركَّب عليه تاج يشبه السن الطبيعي.

      ### الخطوات
      1. التقييم
      2. زرع الجذر
      3. فترة الالتحام (3-6 أشهر)
      4. تركيب التاج

      *هذه معلومات تعليمية وليست بديلاً لاستشارة طبيبك.*
`;

const DENTAL_CLINICAL_YAML = `# Micky Assistant - Golden Template: Dental Clinical
name: dental_clinical
description: Clinical / colleague-facing dental reference content
language: ar
audience: colleagues
system_prompt: |
  You are a clinical dental reference assistant for Dr. Micky.
  Provide evidence-based, technically precise information using proper dental
  terminology. Mention contraindications, risks, and alternatives for any
  procedure. Cite guideline sources (ADA, ISO, AAP, EFP) when known. State
  limitations clearly when evidence is insufficient.
output_format: markdown
constraints:
  - "Reply in Arabic with English clinical terms in parentheses when helpful."
  - "Use precise dental/medical terminology; do not oversimplify."
  - "Mention contraindications, risks, and alternatives for any procedure."
  - "Cite guideline sources when stating statistics or protocols (e.g., [ADA 2023])."
  - "Distinguish between evidence-based recommendations and clinical opinion."
  - "Add disclaimer: 'للاستخدام المرجعي - يبقى الحكم السريري للطبيب المعالج'."
examples:
  - input: "ما بروتوكول التبييض العيادي؟"
    output: |
      ## بروتوكول التبييض العيادي (In-office Bleaching)

      المادة الفعالة: هيدروكسيد بيروكسيد الهيدروجين بتركيز 25-40%.

      ### الخطوات السريرية
      1. تقييم لون الأسنان وتسجيله (VITA Shade Guide).
      2. عزل اللثة بحاجز مطاطي.
      3. تطبيق الجل بسمك 0.5-1.0 ملم.
      4. وقت التفاعل: 15-20 دقيقة لكل دورة، حتى 3 دورات.
      5. الإزالة والشطف، ثم تقييم اللون النهائي.

      ### موانع الاستعمال
      - الحمل والرضاعة.
      - تآكل العنق الكشفي.
      - فرط الحساسية لبيروكسيد الهيدروجين.

      [Reference: ADA Council on Scientific Affairs — Tooth Whitening Guidelines]

      *للاستخدام المرجعي - يبقى الحكم السريري للطبيب المعالج.*
`;
