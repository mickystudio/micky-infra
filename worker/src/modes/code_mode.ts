/**
 * Micky Assistant Unlimited - Code Mode (BYOK + plan.md)
 *
 * Implements:
 *   - P3-T1: API key generation + Cloudflare Access tokens + D1 persistence
 *   - P3-T2: plan.md → surgical task splitter (YAML-shaped)
 *   - P3-T3: BYOK config block (paste-ready for Cline / Qoder / Roo Code)
 *   - Telegram `/code` command handler (Arabic UI)
 *
 * Keys generated here are verified by the existing `/v1/chat/completions`
 * endpoint in `src/index.ts`. The endpoint hashes the incoming key and
 * looks it up in `api_keys` by `key_hash`; therefore `createApiKey` MUST
 * store the SHA-256 hex of the full key (see {@link createApiKey}).
 *
 * Created: 2026-11-10
 * Phase: P3-T1, P3-T2, P3-T3
 */

import type { Env } from '../index.js';
import {
  API_KEY_PREFIX,
  generateApiKey,
  generateAccessTokens,
  generateId,
  hashApiKey,
  maskApiKey,
} from '../utils/crypto.js';
import { estimateTokens } from '../utils/tokens.js';
import { callLLM } from '../runners/hf_space_client.js';

// ============ Types ============

/** Parameters accepted by {@link createApiKey}. */
export interface CreateApiKeyParams {
  /** Optional project to bind the key to. */
  projectId?: string;
  /** Optional mode restriction (text|code|graphics|montage). */
  modeRestriction?: string;
  /** If true, also generate a Cloudflare Access service-token pair. */
  withAccessTokens?: boolean;
}

/** Result of {@link createApiKey}. */
export interface CreateApiKeyResult {
  /** The full API key. Shown ONCE — only stored as a hash. */
  apiKey: string;
  /** D1 primary key for the api_keys row. */
  keyId: string;
  /** Cloudflare Access client id (or null when not requested). */
  accessClientId: string | null;
  /** Cloudflare Access client secret (or null when not requested). */
  accessClientSecret: string | null;
  /** Paste-ready YAML block for Cline / Qoder / Roo Code. */
  config: ByokConfig;
}

/** A single masked API key in {@link listApiKeys}. */
export interface MaskedApiKey {
  id: string;
  /** `micky_xxxx...` (prefix + 6 chars + ellipsis). */
  keyPrefix: string;
  projectId: string | null;
  modeRestriction: string | null;
  createdAt: number;
  lastUsed: number | null;
  revoked: boolean;
}

/** Parameters for {@link generateByokConfig}. */
export interface ByokConfigParams {
  apiKey: string;
  /** e.g. `https://micky-assistant.cources01.workers.dev`. */
  workerUrl: string;
  accessClientId?: string;
  accessClientSecret?: string;
  projectId?: string;
  modeRestriction?: string;
  /** Defaults to `qwen2.5-coder-32b`. */
  modelId?: string;
}

/** A YAML block (string) returned by {@link generateByokConfig}. */
export type ByokConfig = string;

/** A single surgical task parsed from a plan.md file. */
export interface TaskSpec {
  /** Stable id, e.g. `task_P3-T1`. */
  id: string;
  /** Short human-readable title. */
  title: string;
  /** Files referenced inside the section (best-effort extraction). */
  files: string[];
  /** Tests / acceptance-criteria lines found in the section. */
  tests: string[];
  /** Free-form spec text (the section body, cleaned). */
  spec: string;
  /** True if the section mentions secrets/credentials/production data. */
  sensitive: boolean;
  /** Rough size bucket: `small` | `medium` | `large`. */
  size: 'small' | 'medium' | 'large';
  /** Estimated token cost of the spec text. */
  estimatedTokens: number;
}

// ============ Helpers ============

/** Default worker URL used when none is provided in env. */
const DEFAULT_WORKER_URL = 'https://micky-assistant.cources01.workers.dev';

/** Default model id surfaced in the YAML block. */
const DEFAULT_YAML_MODEL = 'qwen2.5-coder-32b';

/** Allowed mode-restriction values. Anything else is rejected. */
const ALLOWED_MODES = new Set(['text', 'code', 'graphics', 'montage']);

/**
 * Resolve the public worker URL from env.
 * Priority: `env.WORKER_URL` (if set) > hard-coded default.
 */
function workerUrl(env: Env): string {
  const fromEnv = (env as unknown as { WORKER_URL?: string }).WORKER_URL;
  return (fromEnv && fromEnv.trim()) || DEFAULT_WORKER_URL;
}

// ============ P3-T1: API Key Generation ============

/**
 * Generate a new BYOK API key, persist its hash in D1, and return the
 * full key plus a paste-ready YAML config block.
 *
 * Security:
 *   - The full key is NEVER persisted. Only its SHA-256 hex digest is stored
 *     in `api_keys.key_hash`.
 *   - `key_prefix` stores the first 12 characters (`micky_xxxxxx`) for
 *     display in `listApiKeys`.
 *   - If `withAccessTokens` is true, a Cloudflare Access service-token pair
 *     is generated and stored (the secret is shown once in the result).
 */
export async function createApiKey(
  env: Env,
  params: CreateApiKeyParams = {}
): Promise<CreateApiKeyResult> {
  // Validate mode restriction if provided.
  if (params.modeRestriction && !ALLOWED_MODES.has(params.modeRestriction)) {
    throw new Error(
      `Invalid modeRestriction: ${params.modeRestriction}. Allowed: ${[...ALLOWED_MODES].join(', ')}`
    );
  }

  const apiKey = generateApiKey();
  const keyId = generateId('key_');
  const keyHash = await hashApiKey(apiKey);
  // First 12 chars: "micky_" (6) + 6 random chars.
  const keyPrefix = apiKey.slice(0, 12);

  // Generate CF Access tokens only if requested.
  const access =
    params.withAccessTokens === true ? generateAccessTokens() : null;

  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(
    `INSERT INTO api_keys
       (id, project_id, key_prefix, key_hash,
        cf_access_client_id, cf_access_client_secret,
        mode_restriction, created_at, last_used, revoked)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`
  )
    .bind(
      keyId,
      params.projectId ?? null,
      keyPrefix,
      keyHash,
      access?.clientId ?? null,
      access?.clientSecret ?? null,
      params.modeRestriction ?? null,
      now
    )
    .run();

  const config = generateByokConfig({
    apiKey,
    workerUrl: workerUrl(env),
    accessClientId: access?.clientId,
    accessClientSecret: access?.clientSecret,
    projectId: params.projectId,
    modeRestriction: params.modeRestriction,
  });

  return {
    apiKey,
    keyId,
    accessClientId: access?.clientId ?? null,
    accessClientSecret: access?.clientSecret ?? null,
    config,
  };
}

/**
 * List all API keys (masked). Never returns the full key.
 */
export async function listApiKeys(env: Env): Promise<MaskedApiKey[]> {
  const result = await env.DB.prepare(
    `SELECT id, key_prefix, project_id, mode_restriction,
            created_at, last_used, revoked
     FROM api_keys
     ORDER BY created_at DESC`
  ).all();

  const rows = (result.results ?? []) as Array<{
    id: string;
    key_prefix: string;
    project_id: string | null;
    mode_restriction: string | null;
    created_at: number;
    last_used: number | null;
    revoked: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    // Stored `key_prefix` already includes "micky_xxxx"; append "..." for masking.
    keyPrefix: `${r.key_prefix}...`,
    projectId: r.project_id,
    modeRestriction: r.mode_restriction,
    createdAt: r.created_at,
    lastUsed: r.last_used,
    revoked: r.revoked === 1,
  }));
}

/**
 * Revoke an API key by id. Idempotent — revoking an already-revoked key
 * returns `true`. Returns `false` if the key was not found.
 */
export async function revokeApiKey(env: Env, keyId: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE api_keys SET revoked = 1 WHERE id = ?`
  )
    .bind(keyId)
    .run();

  const meta = (result.meta as { changes?: number }) ?? {};
  return (meta.changes ?? 0) > 0;
}

// ============ P3-T3: BYOK Config Block ============

/**
 * Generate a paste-ready YAML configuration block for Cline / Qoder / Roo Code.
 *
 * The block is intentionally plain (key: value) so it survives copy-paste
 * into a settings UI without YAML-quoted escaping issues.
 *
 * Example output:
 *
 *   # Micky Assistant Unlimited — BYOK Configuration
 *   Base URL: https://micky-assistant.cources01.workers.dev/v1
 *   API Key: micky_a3B7c9D1kE8fG2hI4jK6lM8nO0pQ2rS4tU6vW8xY0zA1bC
 *   Model ID: qwen2.5-coder-32b
 *   Custom Headers:
 *     CF-Access-Client-Id: cf_access_id_...
 *     CF-Access-Client-Secret: cf_access_secret_...
 *     X-Project-ID: proj_xxx
 *     X-Task-Mode: surgical
 */
export function generateByokConfig(params: ByokConfigParams): ByokConfig {
  const lines: string[] = [];
  lines.push('# Micky Assistant Unlimited — BYOK Configuration');
  lines.push(`Base URL: ${params.workerUrl.replace(/\/$/, '')}/v1`);
  lines.push(`API Key: ${params.apiKey}`);
  lines.push(`Model ID: ${params.modelId ?? DEFAULT_YAML_MODEL}`);

  const hasCustomHeaders =
    params.accessClientId ||
    params.accessClientSecret ||
    params.projectId ||
    params.modeRestriction;

  if (hasCustomHeaders) {
    lines.push('Custom Headers:');
    if (params.accessClientId) {
      lines.push(`  CF-Access-Client-Id: ${params.accessClientId}`);
    }
    if (params.accessClientSecret) {
      lines.push(`  CF-Access-Client-Secret: ${params.accessClientSecret}`);
    }
    if (params.projectId) {
      lines.push(`  X-Project-ID: ${params.projectId}`);
    }
    if (params.modeRestriction) {
      lines.push(`  X-Task-Mode: ${params.modeRestriction}`);
    }
  }

  lines.push('');
  lines.push('# انسخ هذا الكتلة بالكامل والصقها في إعدادات Cline / Qoder / Roo Code.');
  lines.push('# لا تشارك مفتاح API مع أحد — يُستخدم مباشرة ضد /v1/chat/completions.');

  return lines.join('\n');
}

// ============ P3-T2: plan.md → Surgical Task Splitter ============

/** Regex for a markdown header line: `## Title` or `### Title`. */
const HEADER_RE = /^(#{2,4})\s+(.+?)\s*$/;

/** Patterns that hint at "sensitive" task content. */
const SENSITIVE_PATTERNS = [
  /secret/i,
  /token/i,
  /password/i,
  /api[_-]?key/i,
  /credentials?/i,
  /production/i,
  /\bPAT\b/,
  /CF_ACCESS/i,
];

/** Files referenced as `path/to/file.ts` or `\`file.py\``. */
const FILE_REF_RE = /`([\w./-]+\.(?:ts|js|py|sql|json|toml|md|yaml|yml))`/g;

/** Acceptance-criteria line patterns (Arabic + English). */
const ACCEPTANCE_RE =
  /^(?:[-*]\s*)?(?:معايير القبول|acceptance criteria|acceptance|القبول)[:：]?\s*$/i;

/** Bullet/checkbox line used to detect acceptance-criteria items. */
const BULLET_RE = /^\s*[-*]\s+\[?[ xX]?\]?\s*(.+)$/;

/**
 * Parse a plan.md file into a list of surgical tasks.
 *
 * Splitting rules:
 *   1. Iterate over lines.
 *   2. Each `##` (or deeper `###`/`####`) header begins a new section.
 *   3. The header's title becomes the task title; the section body becomes
 *      the task spec.
 *   4. Sections shorter than ~80 tokens are skipped (likely navigation/index).
 *   5. Files are extracted from backticked `path/to/file.ext` references.
 *   6. Acceptance-criteria bullet lines are lifted into `tests`.
 *
 * Task IDs are derived from the heading text (e.g., "P3-T1: ...")
 * if present; otherwise a stable hash is synthesized.
 */
export async function parsePlanMd(
  _env: Env,
  planMdContent: string,
  projectId: string
): Promise<TaskSpec[]> {
  const lines = planMdContent.split(/\r?\n/);
  const tasks: TaskSpec[] = [];

  let currentHeader: string | null = null;
  let currentLevel = 0;
  let currentBody: string[] = [];

  const flush = () => {
    if (currentHeader === null) return;
    const body = currentBody.join('\n').trim();
    if (!body) {
      currentHeader = null;
      currentBody = [];
      return;
    }

    const id = deriveTaskId(currentHeader, tasks.length);
    const title = currentHeader.replace(/\s+/g, ' ').trim();
    const files = extractFiles(body);
    const tests = extractAcceptanceTests(body);
    const sensitive = SENSITIVE_PATTERNS.some((re) => re.test(body));
    const size = sizeFromTokens(body);
    const estimatedTokens = estimateTokens(body);

    // Skip tiny sections (likely TOC entries or section dividers).
    if (estimatedTokens >= 20) {
      tasks.push({
        id,
        title,
        files,
        tests,
        spec: body,
        sensitive,
        size,
        estimatedTokens,
      });
    }

    currentHeader = null;
    currentBody = [];
  };

  for (const line of lines) {
    const m = line.match(HEADER_RE);
    if (m) {
      flush();
      currentLevel = m[1]!.length;
      currentHeader = m[2]!.trim();
      currentBody = [];
      // Stash level marker as a hidden marker line (not in output).
      void currentLevel;
    } else if (currentHeader !== null) {
      currentBody.push(line);
    }
  }
  flush();

  // If nothing matched (no `##`/`###` headers), treat the whole file as one task.
  if (tasks.length === 0 && planMdContent.trim().length > 0) {
    const body = planMdContent.trim();
    tasks.push({
      id: `${projectId}_root`,
      title: 'plan.md (unsplit)',
      files: extractFiles(body),
      tests: extractAcceptanceTests(body),
      spec: body,
      sensitive: SENSITIVE_PATTERNS.some((re) => re.test(body)),
      size: sizeFromTokens(body),
      estimatedTokens: estimateTokens(body),
    });
  }

  return tasks;
}

/** Derive a stable task id from a heading like "P3-T1: مولّد مفاتيح API". */
function deriveTaskId(header: string, index: number): string {
  const m = header.match(/\b([A-Z]\d+-T\d+|[A-Z]\d+-\d+)\b/);
  if (m) return `task_${m[1]}`;
  // Fallback: synthesize a stable-ish id from the heading text.
  const slug = header
    .slice(0, 24)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'section';
  return `task_${index + 1}_${slug}`;
}

/** Extract all backticked file references from a body. */
function extractFiles(body: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  FILE_REF_RE.lastIndex = 0;
  while ((m = FILE_REF_RE.exec(body))) {
    out.add(m[1]!);
  }
  return [...out];
}

/** Lift acceptance-criteria bullets into a clean list. */
function extractAcceptanceTests(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const tests: string[] = [];
  let inAcceptance = false;
  for (const line of lines) {
    if (ACCEPTANCE_RE.test(line.trim())) {
      inAcceptance = true;
      continue;
    }
    if (inAcceptance) {
      const bm = line.match(BULLET_RE);
      if (bm) {
        tests.push(bm[1]!.trim());
      } else if (line.trim() === '') {
        // Blank line ends the acceptance block.
        continue;
      } else {
        // First non-bullet line ends the acceptance block.
        inAcceptance = false;
      }
    }
  }
  return tests;
}

/** Bucket size by token estimate. */
function sizeFromTokens(body: string): 'small' | 'medium' | 'large' {
  const t = estimateTokens(body);
  if (t <= 200) return 'small';
  if (t <= 800) return 'medium';
  return 'large';
}

// ============ Telegram: /code Command ============

/**
 * Handle the `/code` Telegram command.
 *
 * Sub-commands:
 *   - `/code`        → menu (Generate Key | List Keys | Parse plan.md)
 *   - `/code new`    → generate a new BYOK key, send the YAML block
 *   - `/code list`   → list all keys (masked)
 *   - `/code parse`  → prompt the user to upload a plan.md file
 *
 * All responses are in Arabic per project spec.
 */
export async function handleCodeCommand(
  env: Env,
  chatId: number,
  args?: string
): Promise<void> {
  const arg = (args ?? '').trim().toLowerCase();

  if (!arg) {
    await sendTelegramMessage(env, chatId, buildMenuMessage());
    return;
  }

  if (arg === 'new' || arg === 'جديد' || arg === 'create') {
    await handleCodeNew(env, chatId);
    return;
  }

  if (arg === 'list' || arg === 'list_keys' || arg === 'قائمة') {
    await handleCodeList(env, chatId);
    return;
  }

  if (arg === 'parse' || arg === 'تحليل' || arg === 'split') {
    await sendTelegramMessage(
      env,
      chatId,
      [
        '*🧩 تحليل plan.md*',
        '',
        'أرسل الآن ملف `plan.md` كملف (Document) في المحادثة.',
        'سيتم تقسيمه إلى مهام جراحية تلقائيًا وعرضها عليك للمراجعة.',
        '',
        '💡 أرسل الملف بنفس الاسم `plan.md`.',
      ].join('\n')
    );
    return;
  }

  if (arg.startsWith('revoke ')) {
    const keyId = arg.slice('revoke '.length).trim();
    await handleCodeRevoke(env, chatId, keyId);
    return;
  }

  // Unknown sub-command.
  await sendTelegramMessage(
    env,
    chatId,
    [
      '❓ أمر فرعي غير معروف.',
      '',
      'الأوامر المتاحة:',
      '• `/code new` — توليد مفتاح جديد',
      '• `/code list` — عرض المفاتيح (مقنّعة)',
      '• `/code parse` — رفع ملف plan.md للتحليل',
      '• `/code revoke <key_id>` — إلغاء مفتاح',
    ].join('\n')
  );
}

/** Implementation of `/code new`. */
async function handleCodeNew(env: Env, chatId: number): Promise<void> {
  try {
    const result = await createApiKey(env, {
      withAccessTokens: true,
    });

    const lines: string[] = [
      '*🔑 تم توليد مفتاح API جديد بنجاح*',
      '',
      '`' + result.apiKey + '`',
      '',
      '*⚠️ تنبيه أمني:*',
      '• هذا المفتاح يُعرض مرة واحدة فقط.',
      '• لا يمكن استرجاعه لاحقًا — احفظه الآن.',
      '• نسخته مشفّرة SHA-256 فقط في قاعدة البيانات.',
      '',
      '*📋 إعداد BYOK (انسخه والصقه في Cline / Qoder / Roo Code):*',
      '```',
      result.config,
      '```',
      '',
      `🆔 Key ID: \`${result.keyId}\``,
      `🏷️  CF Access Client ID: \`${result.accessClientId ?? '—'}\``,
    ];
    await sendTelegramMessage(env, chatId, lines.join('\n'));
  } catch (err) {
    await sendTelegramMessage(
      env,
      chatId,
      `❌ فشل توليد المفتاح: ${String(err)}`
    );
  }
}

/** Implementation of `/code list`. */
async function handleCodeList(env: Env, chatId: number): Promise<void> {
  try {
    const keys = await listApiKeys(env);
    if (keys.length === 0) {
      await sendTelegramMessage(
        env,
        chatId,
        [
          '*🔑 لا توجد مفاتيح API بعد*',
          '',
          'استخدم `/code new` لتوليد أول مفتاح BYOK.',
        ].join('\n')
      );
      return;
    }

    const lines: string[] = ['*🔑 مفاتيح API المسجّلة*', ''];
    for (const k of keys) {
      const status = k.revoked ? '🔴 ملغى' : '🟢 نشط';
      const lastUsed = k.lastUsed
        ? new Date(k.lastUsed * 1000).toISOString().split('T')[0]!
        : '—';
      lines.push(`${status} \`${k.keyPrefix}\``);
      lines.push(`  • ID: \`${k.id}\``);
      if (k.projectId) lines.push(`  • Project: \`${k.projectId}\``);
      if (k.modeRestriction) lines.push(`  • Mode: ${k.modeRestriction}`);
      lines.push(`  • Created: ${new Date(k.createdAt * 1000).toISOString().split('T')[0]}`);
      lines.push(`  • Last used: ${lastUsed}`);
      lines.push('');
    }
    lines.push('لإلغاء مفتاح: `/code revoke <key_id>`');
    await sendTelegramMessage(env, chatId, lines.join('\n'));
  } catch (err) {
    await sendTelegramMessage(
      env,
      chatId,
      `❌ فشل جلب المفاتيح: ${String(err)}`
    );
  }
}

/** Implementation of `/code revoke <keyId>`. */
async function handleCodeRevoke(
  env: Env,
  chatId: number,
  keyId: string
): Promise<void> {
  if (!keyId) {
    await sendTelegramMessage(
      env,
      chatId,
      '❌ الاستخدام: `/code revoke <key_id>`'
    );
    return;
  }
  try {
    const ok = await revokeApiKey(env, keyId);
    if (ok) {
      await sendTelegramMessage(
        env,
        chatId,
        `✅ تم إلغاء المفتاح \`${keyId}\`. لن يُقبل في طلبات المستقبل.`
      );
    } else {
      await sendTelegramMessage(
        env,
        chatId,
        `⚠️ لم يتم العثور على مفتاح بهذا المعرف: \`${keyId}\`.`
      );
    }
  } catch (err) {
    await sendTelegramMessage(
      env,
      chatId,
      `❌ فشل إلغاء المفتاح: ${String(err)}`
    );
  }
}

/** Build the default `/code` menu. */
function buildMenuMessage(): string {
  return [
    '*💻 Code Mode — BYOK Generator*',
    '',
    'اختر العملية المطلوبة:',
    '',
    '🔑 `/code new` — توليد مفتاح API جديد + إعداد YAML جاهز للنسخ',
    '📋 `/code list` — عرض كل المفاتيح (مقنّعة)',
    '🧩 `/code parse` — رفع ملف `plan.md` وتقسيمه إلى مهام جراحية',
    '🗑️  `/code revoke <key_id>` — إلغاء مفتاح',
    '',
    '_كل مفتاح = مفتاح BYOK يعمل مع Cline / Qoder / Roo Code._',
  ].join('\n');
}

/** Send a Telegram message via the bot token. */
async function sendTelegramMessage(
  env: Env,
  chatId: number,
  text: string
): Promise<void> {
  // Reuse the bot token secret from env.
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN missing — cannot send message');
    return;
  }
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  });
}

// ============ Re-exports ============

// Re-export shared utilities so callers can `import { ... } from './modes/code_mode'`
// without needing to know the internal layout.
export { API_KEY_PREFIX, maskApiKey, hashApiKey, callLLM };
