/**
 * Micky Assistant Unlimited - Error Book
 * ----------------------------------------------------------------------------
 * كتاب الأخطاء (P2-T2)
 *
 * Mistake learning system: every failed task can record an error pattern
 * so the assistant avoids repeating it. Errors are grouped by category
 * (typescript | python | ffmpeg | prompt | dental | general) and tagged
 * with a "lesson" — what to do instead.
 *
 * Storage: D1 (table `error_book`)
 *
 * Created: 2026-11-10
 * Phase: P2-T2
 */

import type { Env } from '../index';
import { generateId } from '../utils/crypto';

// ============ Types ============

export type ErrorCategory =
  | 'typescript'
  | 'python'
  | 'ffmpeg'
  | 'prompt'
  | 'dental'
  | 'general';

export interface ErrorEntry {
  id: string;
  category: ErrorCategory;
  /** A short description of what went wrong. */
  pattern: string;
  /** What to do instead. */
  lesson: string;
  occurrenceCount: number;
  lastSeen: number;
}

// ============================================================================
// ===========  NEWER API (task A14): operational error logging  ==============
// ============================================================================
//
// Distinct from the existing `recordError` API which records *recurring
// lesson patterns* for prompt injection (typed by `category` like
// 'typescript' / 'python' / 'ffmpeg'). The newer `logError` API records
// individual operational failures with full stack traces + structured
// context for post-mortem diagnosis — typed by `component` (e.g.
// 'byok', 'kaggle-runner', 'telegram-webhook') and `severity`.
//
// Both shapes co-exist in the same `error_book` table; old columns are kept
// nullable and ignored by the new code path (and vice versa).

/** Operational severity levels used by the newer `logError` API. */
export type ErrorSeverity = 'info' | 'warning' | 'error' | 'critical';

/** Valid severity strings (used for sanitisation). */
const VALID_SEVERITIES: readonly ErrorSeverity[] = [
  'info',
  'warning',
  'error',
  'critical',
];

/**
 * An individual operational error entry (task A14).
 *
 * Distinct from the existing `ErrorEntry` (the lesson-pattern shape used by
 * `recordError` / `getRelevantErrors`). Kept as a separate exported interface
 * so legacy callers continue to compile unchanged.
 */
export interface ErrorLogEntry {
  id: string;
  component: string;
  error_message: string;
  stack_trace: string | null;
  context: Record<string, unknown> | null;
  severity: string;
  chat_id: number | null;
  task_id: string | null;
  created_at: number;
  resolved: number;
  resolution_note: string | null;
}

/** Row shape returned by D1 for `error_book`. */
interface ErrorRow {
  id: string;
  category: string;
  pattern: string;
  lesson: string;
  occurrence_count: number;
  last_seen: number;
}

/** Row shape returned by D1 for the new operational-logging columns. */
interface ErrorLogRow {
  id: string;
  component: string | null;
  error_message: string | null;
  stack_trace: string | null;
  context: string | null;
  severity: string | null;
  chat_id: number | null;
  task_id: string | null;
  created_at: number | null;
  resolved: number | null;
  resolution_note: string | null;
}

/** Shape of a category-count row returned by GROUP BY. */
interface CategoryCountRow {
  category: string;
  count: number;
}

/** Shape of a generic GROUP BY count row used by getErrorStats. */
interface GroupCountRow {
  key: string;
  count: number;
}

// ============ Constants ============

/** Maximum errors returned by getRelevantErrors per query. */
const MAX_RELEVANT_ERRORS = 10;

/** Pool size before keyword filtering. */
const RELEVANCE_POOL_SIZE = 25;

/** Valid categories (used for sanitisation). */
const VALID_CATEGORIES: readonly ErrorCategory[] = [
  'typescript',
  'python',
  'ffmpeg',
  'prompt',
  'dental',
  'general',
];

/** Default lookback window for the newer getErrorStats API (in days). */
const DEFAULT_STATS_WINDOW_DAYS = 7;

/** Hard ceiling on the `limit` option of getRecentErrors. */
const MAX_RECENT_ERRORS_LIMIT = 500;

/** Default `limit` for getRecentErrors when the caller passes none. */
const DEFAULT_RECENT_ERRORS_LIMIT = 50;

// ============ Helpers ============

/** Current Unix time in seconds. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Coerce an arbitrary DB value into `ErrorCategory`. */
function coerceCategory(raw: unknown): ErrorCategory {
  const s = String(raw);
  return (VALID_CATEGORIES as readonly string[]).includes(s)
    ? (s as ErrorCategory)
    : 'general';
}

/** Coerce an arbitrary DB value into `ErrorSeverity`. */
function coerceSeverity(raw: unknown): ErrorSeverity {
  const s = String(raw);
  return (VALID_SEVERITIES as readonly string[]).includes(s)
    ? (s as ErrorSeverity)
    : 'error';
}

/** Map a D1 row to the public ErrorEntry interface. */
function rowToError(row: ErrorRow): ErrorEntry {
  return {
    id: row.id,
    category: coerceCategory(row.category),
    pattern: row.pattern,
    lesson: row.lesson,
    occurrenceCount: Number(row.occurrence_count ?? 1),
    lastSeen: Number(row.last_seen ?? 0),
  };
}

/**
 * Map a D1 row to the public ErrorLogEntry interface (newer API).
 *
 * Parses the `context` JSON column lazily — if it fails to parse, falls back
 * to `null` rather than throwing.
 */
function rowToErrorLogEntry(row: ErrorLogRow): ErrorLogEntry {
  let context: Record<string, unknown> | null = null;
  if (row.context) {
    try {
      const parsed = JSON.parse(row.context);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        context = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed JSON in DB → treat as no context.
      context = null;
    }
  }

  return {
    id: row.id,
    component: row.component ?? 'unknown',
    error_message: row.error_message ?? '',
    stack_trace: row.stack_trace,
    context,
    severity: row.severity ?? 'error',
    chat_id: row.chat_id !== null ? Number(row.chat_id) : null,
    task_id: row.task_id,
    created_at: Number(row.created_at ?? 0),
    resolved: Number(row.resolved ?? 0),
    resolution_note: row.resolution_note,
  };
}

/**
 * Keyword overlap score between an error and a task context.
 * Higher = more relevant.
 *
 * تقييم بسيط: عدد الكلمات المشتركة بين الخطأ والسياق
 */
function relevanceScore(pattern: string, context: string): number {
  if (!context || !pattern) return 0;
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'of', 'to', 'in', 'on', 'and', 'or', 'for',
    'و', 'في', 'من', 'على', 'إلى', 'أن', 'مع', 'هذا', 'هذه',
  ]);
  const tokens = (s: string) =>
    s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean) as string[];

  const ctxTokens = new Set(tokens(context));
  const errTokens = tokens(pattern);

  let score = 0;
  for (const tok of errTokens) {
    if (stopWords.has(tok)) continue;
    if (ctxTokens.has(tok)) score += 1;
  }
  return score;
}

/**
 * Find an existing similar error for the same category.
 * Similarity: case-insensitive exact match on the (trimmed) pattern.
 *
 * يبحث عن خطأ مشابه بنفس الفئة ونفس النمط (تجاهل حالة الأحرف)
 */
async function findSimilarError(
  env: Env,
  category: ErrorCategory,
  pattern: string,
): Promise<ErrorRow | null> {
  try {
    return await env.DB.prepare(
      `SELECT id, category, pattern, lesson, occurrence_count, last_seen
       FROM error_book
       WHERE category = ? AND LOWER(TRIM(pattern)) = LOWER(TRIM(?))
       LIMIT 1`,
    )
      .bind(category, pattern)
      .first<ErrorRow>();
  } catch (err) {
    console.error('[error_book] findSimilarError failed:', err);
    return null;
  }
}

// ============ Public API ============

/**
 * Record an error from a failed task.
 *
 * - If a similar error (same category + same pattern) already exists,
 *   increment its `occurrence_count` and update `last_seen`.
 * - Otherwise insert a new row.
 *
 * يسجّل خطأً جديدًا أو يزيد عدّاد تكرار خطأ موجود
 *
 * @returns The error ID (existing or newly created). Empty string on failure.
 */
export async function recordError(
  env: Env,
  category: ErrorCategory,
  pattern: string,
  lesson: string,
): Promise<string> {
  const safeCategory = coerceCategory(category);
  const cleanPattern = (pattern ?? '').trim();
  const cleanLesson = (lesson ?? '').trim();

  if (!cleanPattern || !cleanLesson) {
    // Nothing meaningful to record
    return '';
  }

  // 1) Look for an existing similar error
  const existing = await findSimilarError(env, safeCategory, cleanPattern);
  if (existing) {
    try {
      await env.DB.prepare(
        `UPDATE error_book
         SET occurrence_count = occurrence_count + 1,
             last_seen = ?
         WHERE id = ?`,
      )
        .bind(nowSeconds(), existing.id)
        .run();
      return existing.id;
    } catch (err) {
      console.error('[error_book] increment failed, falling back to insert:', err);
      // fall through to insert
    }
  }

  // 2) Insert a brand-new error entry
  const id = generateId('err_');
  try {
    await env.DB.prepare(
      `INSERT INTO error_book (id, category, pattern, lesson, occurrence_count, last_seen)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, safeCategory, cleanPattern, cleanLesson, 1, nowSeconds())
      .run();
    return id;
  } catch (err) {
    console.error('[error_book] recordError insert failed:', err);
    return '';
  }
}

/**
 * Get relevant errors for a given task context.
 *
 * 1. Fetch top-N pool by occurrence_count (most common first)
 * 2. Re-rank by keyword overlap with `context`
 * 3. Return top MAX_RELEVANT_ERRORS
 *
 * يجلب الأخطاء الأكثر صلة بسياق المهمة
 */
export async function getRelevantErrors(
  env: Env,
  category: string,
  context: string,
): Promise<ErrorEntry[]> {
  let pool: ErrorEntry[] = [];
  try {
    const result = await env.DB.prepare(
      `SELECT id, category, pattern, lesson, occurrence_count, last_seen
       FROM error_book
       WHERE category = ?
       ORDER BY occurrence_count DESC, last_seen DESC
       LIMIT ?`,
    )
      .bind(coerceCategory(category), RELEVANCE_POOL_SIZE)
      .all<ErrorRow>();
    pool = (result.results ?? []).map(rowToError);
  } catch (err) {
    console.error('[error_book] getRelevantErrors query failed:', err);
    return [];
  }

  if (pool.length === 0) return [];

  const scored = pool
    .map((e) => ({ error: e, score: relevanceScore(e.pattern, context) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.error.occurrenceCount - a.error.occurrenceCount;
    });

  const top = scored.some((s) => s.score > 0)
    ? scored.filter((s) => s.score > 0)
    : scored;

  return top.slice(0, MAX_RELEVANT_ERRORS).map((s) => s.error);
}

/**
 * Format errors for injection into a system prompt.
 *
 * Example output:
 *   ## Avoid these mistakes:
 *   - [3×] Using `any` type: always prefer explicit types
 *   - Forgetting `await` on Promise.all: use `await Promise.all(...)`
 *
 * إذا لم توجد أخطاء، تُرجع سلسلة فارغة
 */
export function formatErrorsForPrompt(errors: ErrorEntry[]): string {
  if (!errors || errors.length === 0) return '';

  const lines = errors.map((e) => {
    const count = e.occurrenceCount > 1 ? `[${e.occurrenceCount}×] ` : '';
    return `- ${count}${e.pattern}: ${e.lesson}`;
  });

  return ['## Avoid these mistakes:', ...lines].join('\n');
}

/**
 * Get aggregate error statistics (task A14 — enhanced).
 *
 * Returns:
 *   - `total`: total number of operational errors logged in the last `days` days
 *     (counting only rows that have a `created_at` value, i.e. the new API).
 *   - `by_component`: counts grouped by the `component` column.
 *   - `by_severity`: counts grouped by the `severity` column.
 *   - `by_day`: counts grouped by `YYYY-MM-DD` derived from `created_at`.
 *   - `byCategory`: legacy counts grouped by the pre-existing `category`
 *     column (kept for backward compatibility — the older `recordError`
 *     API still uses it).
 *
 * يعيد إحصائيات شاملة: العدد الإجمالي + التوزيع حسب المكون والخطورة واليوم
 *
 * @param env Worker environment.
 * @param days Lookback window in days (default 7). Clamped to >=1.
 */
export async function getErrorStats(
  env: Env,
  days: number = DEFAULT_STATS_WINDOW_DAYS,
): Promise<{
  total: number;
  by_component: Record<string, number>;
  by_severity: Record<string, number>;
  by_day: Record<string, number>;
  byCategory: Record<string, number>;
}> {
  const safeDays = Math.max(1, Math.floor(days));
  const cutoff = nowSeconds() - safeDays * 24 * 60 * 60;

  const by_component: Record<string, number> = {};
  const by_severity: Record<string, number> = {};
  const by_day: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  let total = 0;

  // 1) Total operational errors in the window (rows with a `created_at`)
  try {
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS total FROM error_book WHERE created_at IS NOT NULL AND created_at >= ?',
    )
      .bind(cutoff)
      .first<{ total: number }>();
    total = Number(row?.total ?? 0);
  } catch (err) {
    console.error('[error_book] getErrorStats (total) failed:', err);
  }

  // 2) Group by component
  try {
    const result = await env.DB.prepare(
      'SELECT component AS key, COUNT(*) AS count FROM error_book ' +
        'WHERE created_at IS NOT NULL AND created_at >= ? GROUP BY component',
    )
      .bind(cutoff)
      .all<GroupCountRow>();
    for (const row of result.results ?? []) {
      const k = row.key ?? 'unknown';
      by_component[String(k)] = Number(row.count ?? 0);
    }
  } catch (err) {
    console.error('[error_book] getErrorStats (by_component) failed:', err);
  }

  // 3) Group by severity
  try {
    const result = await env.DB.prepare(
      'SELECT severity AS key, COUNT(*) AS count FROM error_book ' +
        'WHERE created_at IS NOT NULL AND created_at >= ? GROUP BY severity',
    )
      .bind(cutoff)
      .all<GroupCountRow>();
    for (const row of result.results ?? []) {
      const k = row.key ?? 'error';
      by_severity[String(k)] = Number(row.count ?? 0);
    }
  } catch (err) {
    console.error('[error_book] getErrorStats (by_severity) failed:', err);
  }

  // 4) Group by day (YYYY-MM-DD in UTC, derived from unixepoch seconds)
  try {
    const result = await env.DB.prepare(
      "SELECT strftime('%Y-%m-%d', created_at, 'unixepoch') AS key, " +
        'COUNT(*) AS count FROM error_book ' +
        'WHERE created_at IS NOT NULL AND created_at >= ? GROUP BY key',
    )
      .bind(cutoff)
      .all<GroupCountRow>();
    for (const row of result.results ?? []) {
      const k = row.key ?? 'unknown';
      by_day[String(k)] = Number(row.count ?? 0);
    }
  } catch (err) {
    console.error('[error_book] getErrorStats (by_day) failed:', err);
  }

  // 5) Legacy: group by the pre-existing `category` column (no time filter —
  //    the legacy API does not record `created_at` for these rows).
  try {
    const result = await env.DB.prepare(
      'SELECT category AS key, COUNT(*) AS count FROM error_book GROUP BY category',
    ).all<GroupCountRow>();
    for (const row of result.results ?? []) {
      const k = row.key ?? 'general';
      byCategory[String(k)] = Number(row.count ?? 0);
    }
  } catch (err) {
    console.error('[error_book] getErrorStats (byCategory) failed:', err);
  }

  return { total, by_component, by_severity, by_day, byCategory };
}

// ============================================================================
// ===========  NEWER API (task A14): logError / getRecentErrors  ==============
// ============================================================================

/**
 * Extract a stack trace string from an `Error` object, falling back to the
 * error's `message` or the input itself when no stack is available.
 */
function extractStackTrace(err: Error | string): {
  message: string;
  stack: string | null;
} {
  if (typeof err === 'string') {
    return { message: err, stack: null };
  }
  if (err instanceof Error) {
    return {
      message: err.message || err.name || 'Unknown error',
      stack: typeof err.stack === 'string' && err.stack.length > 0 ? err.stack : null,
    };
  }
  // Fallback for unknown throw values (objects, numbers, …)
  try {
    return { message: JSON.stringify(err), stack: null };
  } catch {
    return { message: String(err), stack: null };
  }
}

/**
 * Log an error to the `error_book` table with full context (task A14).
 *
 * Used by the queue consumer, webhook handlers, and AI call sites whenever
 * something fails and we want to capture it for post-mortem diagnosis.
 *
 * Columns written:
 *   - `id`            (uuid prefixed with `errlog_`)
 *   - `component`     e.g. 'byok', 'kaggle-runner', 'telegram-webhook'
 *   - `error_message` the human-readable error message
 *   - `stack_trace`   the full JS stack trace (if available)
 *   - `context`       arbitrary JSON-serialisable metadata
 *   - `severity`      'info' | 'warning' | 'error' | 'critical' (default 'error')
 *   - `chat_id`       Telegram chat ID (if known)
 *   - `task_id`       Async task ID (if known)
 *   - `created_at`    unixepoch seconds
 *   - `resolved`      0 by default
 *
 * For `severity === 'critical'` this function also emits a high-visibility
 * `console.error` line — a future Slack/email alert hook can be wired here.
 *
 * @returns The error ID (prefix `errlog_`), or empty string on failure.
 */
export async function logError(
  env: Env,
  params: {
    component: string;
    error: Error | string;
    context?: Record<string, unknown>;
    chatId?: number;
    taskId?: string;
    severity?: ErrorSeverity;
  },
): Promise<string> {
  const component = (params.component ?? 'unknown').trim() || 'unknown';
  const severity = coerceSeverity(params.severity ?? 'error');
  const { message, stack } = extractStackTrace(params.error);

  // Serialise context to JSON (best-effort; drop if not JSON-safe)
  let contextJson: string | null = null;
  if (params.context !== undefined && params.context !== null) {
    try {
      contextJson = JSON.stringify(params.context);
    } catch {
      contextJson = JSON.stringify({ _unserialisable: true });
    }
  }

  const id = generateId('errlog_');
  const ts = nowSeconds();

  try {
    await env.DB.prepare(
      `INSERT INTO error_book
         (id, component, error_message, stack_trace, context,
          severity, chat_id, task_id, created_at, resolved)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
      .bind(
        id,
        component,
        message,
        stack,
        contextJson,
        severity,
        params.chatId ?? null,
        params.taskId ?? null,
        ts,
      )
      .run();
  } catch (err) {
    console.error('[error_book] logError insert failed:', err);
    return '';
  }

  // Severity escalation hook: critical errors get a high-visibility log line.
  // A future Slack/email alerting pipeline can be wired in here.
  if (severity === 'critical') {
    console.error(
      `[error_book] CRITICAL error in component=${component} id=${id}: ${message}`,
    );
  }

  return id;
}

/**
 * Get recent operational errors for diagnosis (task A14).
 *
 * Filtering options:
 *   - `component`  filter by the `component` column (exact match)
 *   - `severity`   filter by the `severity` column (exact match)
 *   - `resolved`   when `false`, only unresolved errors; when `true`, only
 *                  resolved ones; when `undefined`, both
 *   - `limit`      max number of rows (default 50, capped at 500)
 *
 * Results are ordered by `created_at DESC` (newest first) and only include
 * rows that have a non-null `created_at` (i.e. rows written by `logError`).
 */
export async function getRecentErrors(
  env: Env,
  options: {
    component?: string;
    severity?: string;
    resolved?: boolean;
    limit?: number;
  } = {},
): Promise<ErrorLogEntry[]> {
  const limit = Math.min(
    MAX_RECENT_ERRORS_LIMIT,
    Math.max(1, Math.floor(options.limit ?? DEFAULT_RECENT_ERRORS_LIMIT)),
  );

  const conditions: string[] = ['created_at IS NOT NULL'];
  const bindings: (string | number)[] = [];

  if (options.component) {
    conditions.push('component = ?');
    bindings.push(options.component);
  }
  if (options.severity) {
    // Validate against the known severity set; if invalid, ignore the filter.
    const sev = coerceSeverity(options.severity);
    if (sev === options.severity) {
      conditions.push('severity = ?');
      bindings.push(sev);
    }
  }
  if (options.resolved !== undefined) {
    conditions.push('resolved = ?');
    bindings.push(options.resolved ? 1 : 0);
  }

  const sql =
    'SELECT id, component, error_message, stack_trace, context, severity, ' +
    'chat_id, task_id, created_at, resolved, resolution_note ' +
    'FROM error_book ' +
    `WHERE ${conditions.join(' AND ')} ` +
    'ORDER BY created_at DESC ' +
    'LIMIT ?';
  bindings.push(limit);

  try {
    const result = await env.DB.prepare(sql)
      .bind(...bindings)
      .all<ErrorLogRow>();
    return (result.results ?? []).map(rowToErrorLogEntry);
  } catch (err) {
    console.error('[error_book] getRecentErrors query failed:', err);
    return [];
  }
}

/**
 * Mark an error as resolved (task A14).
 *
 * Optionally records a free-form `note` explaining what was done to fix the
 * underlying issue (root-cause, deploy SHA, ticket ID, …).
 *
 * @returns `true` if a row was updated, `false` otherwise.
 */
export async function resolveError(
  env: Env,
  errorId: string,
  note?: string,
): Promise<boolean> {
  if (!errorId) return false;

  const safeNote = note ? note.trim() : null;

  try {
    const result = await env.DB.prepare(
      `UPDATE error_book
       SET resolved = 1,
           resolution_note = ?
       WHERE id = ?`,
    )
      .bind(safeNote, errorId)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  } catch (err) {
    console.error('[error_book] resolveError failed:', err);
    return false;
  }
}
