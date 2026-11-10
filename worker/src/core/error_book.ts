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

/** Row shape returned by D1 for `error_book`. */
interface ErrorRow {
  id: string;
  category: string;
  pattern: string;
  lesson: string;
  occurrence_count: number;
  last_seen: number;
}

/** Shape of a category-count row returned by GROUP BY. */
interface CategoryCountRow {
  category: string;
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
 * Get aggregate error statistics.
 *
 * يعيد إحصائيات شاملة: العدد الإجمالي وتوزيع الفئات
 */
export async function getErrorStats(
  env: Env,
): Promise<{ total: number; byCategory: Record<string, number> }> {
  // 1) Total count
  let total = 0;
  try {
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS total FROM error_book',
    ).first<{ total: number }>();
    total = Number(row?.total ?? 0);
  } catch (err) {
    console.error('[error_book] getErrorStats (total) failed:', err);
    return { total: 0, byCategory: {} };
  }

  // 2) Group by category
  const byCategory: Record<string, number> = {};
  try {
    const result = await env.DB.prepare(
      'SELECT category, COUNT(*) AS count FROM error_book GROUP BY category',
    ).all<CategoryCountRow>();
    for (const row of result.results ?? []) {
      byCategory[String(row.category)] = Number(row.count ?? 0);
    }
  } catch (err) {
    console.error('[error_book] getErrorStats (byCategory) failed:', err);
  }

  return { total, byCategory };
}
