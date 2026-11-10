/**
 * Micky Assistant Unlimited - Memory Engine
 * ----------------------------------------------------------------------------
 * محرك الذاكرة الدائمة (P2-T2)
 *
 * Long-term learning system: extracts reusable "success patterns" from
 * completed conversations, stores them in D1 (project_memory table),
 * retrieves the most relevant ones for prompt injection, reinforces useful
 * memories, and decays stale ones.
 *
 * Storage: D1 (table `project_memory`)
 * AI binding: env.AI (FAST_MODEL) — used for conversation analysis
 *
 * Created: 2026-11-10
 * Phase: P2-T2
 */

import type { Env } from '../index';
import { generateId } from '../utils/crypto';

// ============ Types ============

export interface Memory {
  id: string;
  projectId: string;
  type: 'preference' | 'pattern' | 'fact' | 'error';
  content: string;
  confidence: number;
  timesReinforced: number;
  createdAt: number;
  lastUsed: number;
}

/**
 * Category used by the newer `rememberFact` / `recallFacts` API (tasks A13).
 * Stored in the same `memory_type` column the legacy API uses, so the two
 * APIs are fully interoperable.
 */
export type MemoryCategory = 'preference' | 'fact' | 'instruction' | 'context';

/**
 * Lightweight memory record returned by the newer recall API (task A13).
 * Distinct from the richer `Memory` interface used by the legacy
 * pattern-extraction API on purpose: prompt-injection callers usually only
 * need the category + content.
 */
export interface MemoryFact {
  id: string;
  category: string;
  content: string;
  confidence: number;
  created_at: number;
}

/** Row shape returned by D1 for `project_memory`. */
interface MemoryRow {
  id: string;
  project_id: string | null;
  memory_type: string | null;
  user_id: number | null;
  content: string;
  confidence: number;
  times_reinforced: number;
  created_at: number;
  last_used: number;
  expires_at: number | null;
}

/** Shape of a `users` row (for chat_id → user_id lookup). */
interface UserRow {
  id: number;
}

/** Shape of a `messages` row (for conversation extraction). */
interface MessageRow {
  role: string;
  content: string;
  created_at: number;
}

/** Shape of a `chats` row (for project_id lookup). */
interface ChatRow {
  project_id: string | null;
}

// ============ Constants ============

/** Maximum number of recent messages to feed to the AI for extraction. */
const EXTRACT_WINDOW = 10;

/** Memories not used in this many seconds have their confidence decayed. */
const DECAY_THRESHOLD_SECONDS = 30 * 24 * 60 * 60; // 30 days

/** Confidence decay multiplier applied on each decay pass. */
const DECAY_FACTOR = 0.95;

/** Maximum achievable confidence for any memory. */
const MAX_CONFIDENCE = 0.95;

/** Base confidence floor (a brand-new memory starts here). */
const BASE_CONFIDENCE = 0.3;

/** Confidence increment per reinforcement. */
const CONFIDENCE_INCREMENT = 0.1;

/** Maximum memories returned by getRelevantMemories. */
const MAX_RELEVANT_MEMORIES = 5;

/** Pool size before keyword filtering (fetch more, filter to top N). */
const RELEVANCE_POOL_SIZE = 20;

// ============ KV cache constants (newer rememberFact / recallFacts API) ============

/** Default TTL for memory cache entries when no ttlSeconds is supplied. */
const DEFAULT_MEMORY_CACHE_TTL_SECONDS = 60 * 60; // 1 hour

/** Maximum number of facts returned by `recallFacts` when caller passes no limit. */
const DEFAULT_RECALL_LIMIT = 10;

/** Hard ceiling on `limit` to avoid pathological queries. */
const MAX_RECALL_LIMIT = 100;

/** Prefix used for individual-fact KV cache entries. */
const KV_FACT_PREFIX = 'memfact:';

/** Prefix used for recall-list KV cache entries. */
const KV_LIST_PREFIX = 'memlist:';

// ============ Helpers ============

/** Current Unix time in seconds (matches D1 `unixepoch()`). */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Compute confidence from reinforcement count.
 * Formula: min(MAX, BASE + count * INCREMENT)
 *
 * حساب الثقة بناءً على عدد مرات التثبيت:
 * كلما تكررت الذاكرة زادت ثقتها حتى حد أقصى 0.95
 */
function confidenceFromReinforcement(timesReinforced: number): number {
  return Math.min(MAX_CONFIDENCE, BASE_CONFIDENCE + timesReinforced * CONFIDENCE_INCREMENT);
}

/** Coerce an arbitrary DB value into `Memory['type']`. */
function coerceMemoryType(raw: unknown): Memory['type'] {
  switch (String(raw)) {
    case 'preference':
    case 'pattern':
    case 'fact':
    case 'error':
      return raw as Memory['type'];
    default:
      return 'fact';
  }
}

/** Map a D1 row to the public Memory interface. */
function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    projectId: row.project_id ?? '',
    type: coerceMemoryType(row.memory_type),
    content: row.content,
    confidence: Number(row.confidence ?? 0.5),
    timesReinforced: Number(row.times_reinforced ?? 1),
    createdAt: Number(row.created_at ?? 0),
    lastUsed: Number(row.last_used ?? 0),
  };
}

/** Map a D1 row to the lightweight MemoryFact interface (newer API). */
function rowToMemoryFact(row: MemoryRow): MemoryFact {
  return {
    id: row.id,
    category: row.memory_type ?? 'fact',
    content: row.content,
    confidence: Number(row.confidence ?? 0.5),
    created_at: Number(row.created_at ?? 0),
  };
}

/** Coerce an arbitrary DB value into `MemoryCategory`. */
function coerceMemoryCategory(raw: unknown): MemoryCategory {
  switch (String(raw)) {
    case 'preference':
    case 'fact':
    case 'instruction':
    case 'context':
      return raw as MemoryCategory;
    default:
      return 'fact';
  }
}

/**
 * Simple keyword overlap score between a memory's content and a context
 * string. Used as a relevance filter on top of the confidence-sorted pool.
 *
 * تقييم بسيط: عدد الكلمات المشتركة بين الذاكرة والسياق
 */
function relevanceScore(memoryContent: string, context: string): number {
  if (!context || !memoryContent) return 0;
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'of', 'to', 'in', 'on', 'and', 'or', 'for',
    'و', 'في', 'من', 'على', 'إلى', 'أن', 'مع', 'هذا', 'هذه', 'التي', 'الذي',
  ]);

  // Split on non-letter/digit (handles Latin + Arabic punctuation)
  const tokens = (s: string) =>
    s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean) as string[];

  const ctxTokens = new Set(tokens(context));
  const memTokens = tokens(memoryContent);

  let score = 0;
  for (const tok of memTokens) {
    if (stopWords.has(tok)) continue;
    if (ctxTokens.has(tok)) score += 1;
  }
  return score;
}

// ============ Public API ============

/**
 * Extract a reusable "success pattern" from the last N messages of a chat.
 *
 * الخطوات:
 * 1. اقرأ آخر 10 رسائل من جدول `messages`
 * 2. حدّد project_id من جدول `chats`
 * 3. استدعِ AI (FAST_MODEL) لاستخلاص نمط/تفضيل
 * 4. خزّن الذاكرة وأعدها
 *
 * Returns `null` if the conversation is empty, no project is linked,
 * or the AI found nothing notable.
 */
export async function extractMemoryFromConversation(
  env: Env,
  chatId: string,
): Promise<Memory | null> {
  // 1) Lookup project_id from chats table
  let projectId: string | null = null;
  try {
    const chat = await env.DB.prepare(
      'SELECT project_id FROM chats WHERE id = ? LIMIT 1',
    )
      .bind(chatId)
      .first<ChatRow>();
    projectId = chat?.project_id ?? null;
  } catch (err) {
    console.error('[memory_engine] failed to lookup chat project:', err);
    return null;
  }

  if (!projectId) {
    // No project bound → nothing meaningful to remember
    return null;
  }

  // 2) Read the last EXTRACT_WINDOW messages in chronological order
  let messages: MessageRow[] = [];
  try {
    const result = await env.DB.prepare(
      'SELECT role, content, created_at FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?',
    )
      .bind(chatId, EXTRACT_WINDOW)
      .all<MessageRow>();
    messages = (result.results ?? []).slice().reverse();
  } catch (err) {
    console.error('[memory_engine] failed to fetch messages:', err);
    return null;
  }

  if (messages.length === 0) return null;

  // 3) Build a compact transcript
  const transcript = messages
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');

  if (!transcript.trim()) return null;

  // 4) Ask the FAST_MODEL to extract a reusable pattern
  let aiReply = '';
  try {
    const aiResponse = await env.AI.run(env.FAST_MODEL, {
      messages: [
        {
          role: 'system',
          content:
            'Extract a reusable pattern or preference from this conversation. ' +
            'Reply in format: TYPE|CONTENT where TYPE is preference/pattern/fact. ' +
            'If nothing notable, reply NONE.',
        },
        { role: 'user', content: transcript },
      ],
      max_tokens: 256,
      temperature: 0.3,
    });
    aiReply = ((aiResponse as { response?: string }).response ?? '').trim();
  } catch (err) {
    console.error('[memory_engine] AI extraction failed:', err);
    return null;
  }

  // 5) Parse "TYPE|CONTENT" or NONE
  const parsed = parseAiMemoryReply(aiReply);
  if (!parsed) return null;

  // 6) Store and return
  const memoryId = await storeMemory(env, {
    projectId,
    type: parsed.type,
    content: parsed.content,
    confidence: confidenceFromReinforcement(1),
    timesReinforced: 1,
  });

  if (!memoryId) return null;

  return {
    id: memoryId,
    projectId,
    type: parsed.type,
    content: parsed.content,
    confidence: confidenceFromReinforcement(1),
    timesReinforced: 1,
    createdAt: nowSeconds(),
    lastUsed: nowSeconds(),
  };
}

/** Parse "TYPE|CONTENT" / "NONE" responses from the AI. */
function parseAiMemoryReply(
  reply: string,
): { type: Memory['type']; content: string } | null {
  const text = reply.trim();
  if (!text || text.toUpperCase() === 'NONE') return null;

  const pipeIdx = text.indexOf('|');
  if (pipeIdx === -1) {
    // No pipe → treat the whole reply as a 'fact'
    return { type: 'fact', content: text };
  }

  const rawType = text.slice(0, pipeIdx).trim().toLowerCase();
  const content = text.slice(pipeIdx + 1).trim();
  if (!content) return null;

  return { type: coerceMemoryType(rawType), content };
}

/**
 * Store a memory in D1. Returns the new memory ID, or empty string on failure.
 *
 * يخزّن الذاكرة في جدول project_memory
 */
export async function storeMemory(
  env: Env,
  memory: Omit<Memory, 'id' | 'createdAt' | 'lastUsed'>,
): Promise<string> {
  const id = generateId('mem_');
  const ts = nowSeconds();
  const confidence =
    memory.confidence ?? confidenceFromReinforcement(memory.timesReinforced ?? 1);

  try {
    await env.DB.prepare(
      `INSERT INTO project_memory
         (id, project_id, memory_type, content, confidence, times_reinforced, created_at, last_used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        memory.projectId,
        memory.type,
        memory.content,
        confidence,
        memory.timesReinforced ?? 1,
        ts,
        ts,
      )
      .run();
    return id;
  } catch (err) {
    console.error('[memory_engine] storeMemory failed:', err);
    return '';
  }
}

/**
 * Retrieve relevant memories for a given project + context.
 *
 * 1. Fetch top-N pool by confidence
 * 2. Filter & re-rank by simple keyword overlap with `context`
 * 3. Return top 5
 * 4. Bump `last_used` for the returned memories (keeps them from decaying)
 *
 * يجلب الذاكرة الأكثر صلة بالسياق المُعطى
 */
export async function getRelevantMemories(
  env: Env,
  projectId: string,
  context: string,
): Promise<Memory[]> {
  let pool: Memory[] = [];
  try {
    const result = await env.DB.prepare(
      `SELECT id, project_id, memory_type, content, confidence, times_reinforced, created_at, last_used
       FROM project_memory
       WHERE project_id = ?
       ORDER BY confidence DESC
       LIMIT ?`,
    )
      .bind(projectId, RELEVANCE_POOL_SIZE)
      .all<MemoryRow>();
    pool = (result.results ?? []).map(rowToMemory);
  } catch (err) {
    console.error('[memory_engine] getRelevantMemories query failed:', err);
    return [];
  }

  // Score & re-rank by relevance to context
  const scored = pool
    .map((m) => ({
      memory: m,
      score: relevanceScore(m.content, context),
    }))
    .sort((a, b) => {
      // Primary: relevance score (desc)
      if (b.score !== a.score) return b.score - a.score;
      // Secondary: confidence (desc) as tie-breaker
      return b.memory.confidence - a.memory.confidence;
    });

  // If everything has zero relevance, fall back to confidence-only ranking
  const top = scored.some((s) => s.score > 0)
    ? scored.filter((s) => s.score > 0)
    : scored;

  const selected = top.slice(0, MAX_RELEVANT_MEMORIES).map((s) => s.memory);

  // Bump last_used in the background (best-effort, non-blocking)
  if (selected.length > 0) {
    const ids = selected.map((m) => m.id);
    try {
      // D1 doesn't support IN with bound arrays directly — use placeholders
      const placeholders = ids.map(() => '?').join(',');
      await env.DB.prepare(
        `UPDATE project_memory SET last_used = ? WHERE id IN (${placeholders})`,
      )
        .bind(nowSeconds(), ...ids)
        .run();
    } catch (err) {
      // Non-fatal: best-effort bump
      console.warn('[memory_engine] last_used bump failed:', err);
    }
  }

  return selected;
}

/**
 * Reinforce an existing memory: increment `times_reinforced` and recompute
 * confidence using the formula `min(MAX, BASE + n*INC)`.
 *
 * يثبّت ذاكرة موجودة: يزيد عدّاد التكرار ويرفع الثقة
 */
export async function reinforceMemory(env: Env, memoryId: string): Promise<void> {
  try {
    await env.DB.prepare(
      `UPDATE project_memory
       SET times_reinforced = times_reinforced + 1,
           confidence = MIN(?, 0.3 + (times_reinforced * 0.1)),
           last_used = ?
       WHERE id = ?`,
    )
      .bind(MAX_CONFIDENCE, nowSeconds(), memoryId)
      .run();
  } catch (err) {
    console.error('[memory_engine] reinforceMemory failed:', err);
  }
}

/**
 * Decay old memories: any memory whose `last_used` is older than 30 days
 * has its confidence multiplied by 0.95.
 *
 * الذاكرة غير المستخدمة لمدة 30 يومًا تُخفّض ثقتها
 *
 * @returns Number of rows affected.
 */
export async function decayOldMemories(env: Env): Promise<number> {
  const cutoff = nowSeconds() - DECAY_THRESHOLD_SECONDS;
  try {
    const result = await env.DB.prepare(
      `UPDATE project_memory
       SET confidence = confidence * ?
       WHERE last_used < ?`,
    )
      .bind(DECAY_FACTOR, cutoff)
      .run();
    return result.meta?.changes ?? 0;
  } catch (err) {
    console.error('[memory_engine] decayOldMemories failed:', err);
    return 0;
  }
}

/**
 * Format memories for injection into a system prompt.
 * Returns an empty string when the list is empty so callers can safely concat.
 *
 * مثال:
 *   ## Relevant memory:
 *   - [preference] Micky prefers concise replies in Arabic
 *   - [fact] Clinic hours: 10am-8pm daily
 */
export function formatMemoriesForPrompt(memories: Memory[]): string {
  if (!memories || memories.length === 0) return '';

  const header =
    memories.length === 1
      ? '## Relevant memory:'
      : `## Relevant memories (${memories.length}):`;

  const lines = memories.map((m) => {
    const conf = m.confidence.toFixed(2);
    return `- [${m.type}] ${m.content}  (confidence: ${conf})`;
  });

  return [header, ...lines].join('\n');
}

// ============================================================================
// ===========  NEWER API (task A13): remember / recall / forget  =============
// ============================================================================
//
// Designed for ad-hoc, application-driven memory storage:
//   - "user prefers Arabic responses"                → preference
//   - "project X uses dental terminology"            → context
//   - "do not run code without confirmation"         → instruction
//
// Persists to the same `project_memory` table the legacy pattern-extraction
// API uses (so the two are interoperable), and additionally caches reads in
// the PROMPT_CACHE KV namespace.

/**
 * Look up the numeric `users.id` for a Telegram `chat_id`.
 * Returns `null` if the user has not authenticated with the bot yet.
 *
 * يحوّل chat_id إلى user_id داخل جدول users
 */
async function resolveUserId(env: Env, chatId: number): Promise<number | null> {
  try {
    const row = await env.DB.prepare(
      'SELECT id FROM users WHERE chat_id = ? LIMIT 1',
    )
      .bind(chatId)
      .first<UserRow>();
    return row?.id ?? null;
  } catch (err) {
    console.error('[memory_engine] resolveUserId failed:', err);
    return null;
  }
}

/**
 * Resolve `project_id` for a memory write.
 * Priority: explicit `projectId` argument → most recent project owned by the
 * Telegram user. Returns `null` when neither is available (the memory will
 * still be stored as user-scoped only).
 *
 * يحدّد project_id للذاكرة: إمّا مُمرّر صراحةً أو آخر مشروع للمستخدم
 */
async function resolveProjectIdForMemory(
  env: Env,
  chatId: number,
  projectId?: string,
): Promise<string | null> {
  if (projectId) return projectId;

  const userId = await resolveUserId(env, chatId);
  if (!userId) return null;

  try {
    const row = await env.DB.prepare(
      'SELECT id FROM projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1',
    )
      .bind(userId)
      .first<{ id: string }>();
    return row?.id ?? null;
  } catch (err) {
    console.error('[memory_engine] resolveProjectIdForMemory failed:', err);
    return null;
  }
}

/**
 * Build the KV list-cache key used by `recallFacts`.
 *
 * ```
 *   memlist:chat:1235548782:cat:preference:proj:prj_abc:lim:10
 * ```
 *
 * Any filter that is `undefined` is encoded as `all` so the same query hits
 * the same cache slot.
 */
function makeListCacheKey(
  chatId: number,
  category: MemoryCategory | undefined,
  projectId: string | null | undefined,
  limit: number,
): string {
  return (
    `${KV_LIST_PREFIX}chat:${chatId}` +
    `:cat:${category ?? 'all'}` +
    `:proj:${projectId ?? 'all'}` +
    `:lim:${limit}`
  );
}

/**
 * Store a memory fact for a user/project.
 *
 * Examples:
 *   - rememberFact(env, 123, 'user prefers Arabic responses', 'preference')
 *   - rememberFact(env, 123, 'project X uses dental terminology', 'context', 'prj_x')
 *
 * Behaviour:
 *   - Resolves `project_id` (explicit arg → user's latest project → null).
 *   - Resolves `user_id` from `chat_id` via the `users` table.
 *   - Persists to D1 `project_memory` using `memory_type = category`.
 *   - Writes a per-fact KV cache entry (PROMPT_CACHE, TTL = ttlSeconds or 1h).
 *   - Best-effort invalidates the recallFacts list cache for the same scope.
 *
 * @returns The new memory ID (prefix `mem_`), or empty string on failure.
 */
export async function rememberFact(
  env: Env,
  chatId: number,
  fact: string,
  category: MemoryCategory = 'fact',
  projectId?: string,
  confidence: number = 1.0,
  ttlSeconds?: number,
): Promise<string> {
  const cleanFact = (fact ?? '').trim();
  if (!cleanFact) return '';

  const safeCategory = coerceMemoryCategory(category);
  const safeConfidence = Math.min(
    MAX_CONFIDENCE,
    Math.max(0, Number(confidence) || 0),
  );

  // 1) Resolve scoping columns
  const userId = await resolveUserId(env, chatId);
  const resolvedProjectId = await resolveProjectIdForMemory(env, chatId, projectId);

  // 2) Compute expires_at if a TTL was supplied
  const ts = nowSeconds();
  const expiresAt =
    typeof ttlSeconds === 'number' && ttlSeconds > 0 ? ts + Math.floor(ttlSeconds) : null;

  // 3) Insert into D1
  const id = generateId('mem_');
  try {
    await env.DB.prepare(
      `INSERT INTO project_memory
         (id, project_id, user_id, memory_type, content, confidence,
          times_reinforced, created_at, last_used, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        resolvedProjectId,
        userId,
        safeCategory,
        cleanFact,
        safeConfidence,
        1,
        ts,
        ts,
        expiresAt,
      )
      .run();
  } catch (err) {
    console.error('[memory_engine] rememberFact insert failed:', err);
    return '';
  }

  // 4) Write per-fact KV cache (best-effort, non-blocking failure)
  const factRecord: MemoryFact = {
    id,
    category: safeCategory,
    content: cleanFact,
    confidence: safeConfidence,
    created_at: ts,
  };
  const cacheTtl =
    typeof ttlSeconds === 'number' && ttlSeconds > 0
      ? Math.min(ttlSeconds, DEFAULT_MEMORY_CACHE_TTL_SECONDS * 24) // cap at 24h
      : DEFAULT_MEMORY_CACHE_TTL_SECONDS;

  try {
    await env.PROMPT_CACHE.put(
      `${KV_FACT_PREFIX}${id}`,
      JSON.stringify(factRecord),
      { expirationTtl: cacheTtl },
    );
  } catch (err) {
    console.warn('[memory_engine] rememberFact KV put failed:', err);
  }

  // 5) Best-effort invalidate the recall list cache for the same scope.
  // We can't enumerate KV keys, so we delete the most common slot patterns.
  const invalidateSlots: MemoryCategory[] = [
    'preference',
    'fact',
    'instruction',
    'context',
  ];
  await Promise.all(
    invalidateSlots.map((cat) =>
      env.PROMPT_CACHE
        .delete(makeListCacheKey(chatId, cat, resolvedProjectId, DEFAULT_RECALL_LIMIT))
        .catch(() => {
          /* best-effort */
        }),
    ),
  );

  return id;
}

/**
 * Retrieve relevant memories for a user/project.
 *
 * Ordering: most recent first, then highest confidence. Expired facts
 * (rows whose `expires_at` has passed) are filtered out at the SQL layer.
 *
 * Caching: the result is cached in PROMPT_CACHE for 1h keyed by
 * (chatId, category, projectId, limit). A cache miss falls through to D1.
 *
 * @returns Array of MemoryFact (may be empty).
 */
export async function recallFacts(
  env: Env,
  chatId: number,
  category?: MemoryCategory,
  projectId?: string,
  limit: number = DEFAULT_RECALL_LIMIT,
): Promise<MemoryFact[]> {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), MAX_RECALL_LIMIT);
  const safeCategory = category ? coerceMemoryCategory(category) : undefined;
  const now = nowSeconds();

  // 1) KV cache lookup
  const cacheKey = makeListCacheKey(chatId, safeCategory, projectId, safeLimit);
  try {
    const cached = await env.PROMPT_CACHE.get(cacheKey, 'json');
    if (cached && Array.isArray(cached)) {
      return cached as MemoryFact[];
    }
  } catch (err) {
    // Treat any cache read error as a miss.
    console.warn('[memory_engine] recallFacts KV read failed:', err);
  }

  // 2) Build the D1 query dynamically
  const conditions: string[] = ['(expires_at IS NULL OR expires_at > ?)'];
  const bindings: (string | number | null)[] = [now];

  // Scoping: projectId first, else fall back to user_id resolved from chatId
  if (projectId) {
    const userId = await resolveUserId(env, chatId);
    conditions.push('(project_id = ? OR user_id = ?)');
    bindings.push(projectId, userId ?? 0);
  } else {
    const userId = await resolveUserId(env, chatId);
    if (userId === null) {
      // Unknown user → nothing to recall.
      return [];
    }
    conditions.push('user_id = ?');
    bindings.push(userId);
  }

  if (safeCategory) {
    conditions.push('memory_type = ?');
    bindings.push(safeCategory);
  }

  const sql =
    'SELECT id, project_id, user_id, memory_type, content, confidence, ' +
    'times_reinforced, created_at, last_used, expires_at ' +
    'FROM project_memory ' +
    `WHERE ${conditions.join(' AND ')} ` +
    'ORDER BY created_at DESC, confidence DESC ' +
    'LIMIT ?';
  bindings.push(safeLimit);

  let facts: MemoryFact[] = [];
  try {
    const result = await env.DB.prepare(sql).bind(...bindings).all<MemoryRow>();
    facts = (result.results ?? []).map(rowToMemoryFact);
  } catch (err) {
    console.error('[memory_engine] recallFacts query failed:', err);
    return [];
  }

  // 3) Backfill the KV cache (best-effort)
  try {
    await env.PROMPT_CACHE.put(cacheKey, JSON.stringify(facts), {
      expirationTtl: DEFAULT_MEMORY_CACHE_TTL_SECONDS,
    });
  } catch (err) {
    console.warn('[memory_engine] recallFacts KV put failed:', err);
  }

  return facts;
}

/**
 * Forget (delete) a memory by ID.
 *
 * Removes the row from D1 and deletes its individual KV cache entry.
 * List-cache entries (`memlist:`) are not invalidated here — they will be
 * refreshed naturally as their 1h TTL expires.
 *
 * @returns `true` if a row was deleted, `false` otherwise.
 */
export async function forgetFact(env: Env, factId: string): Promise<boolean> {
  if (!factId) return false;

  let changes = 0;
  try {
    const result = await env.DB.prepare(
      'DELETE FROM project_memory WHERE id = ?',
    )
      .bind(factId)
      .run();
    changes = result.meta?.changes ?? 0;
  } catch (err) {
    console.error('[memory_engine] forgetFact delete failed:', err);
    return false;
  }

  if (changes > 0) {
    // Best-effort KV invalidation for the individual-fact cache entry.
    try {
      await env.PROMPT_CACHE.delete(`${KV_FACT_PREFIX}${factId}`);
    } catch (err) {
      console.warn('[memory_engine] forgetFact KV delete failed:', err);
    }
    return true;
  }

  return false;
}

/**
 * Map a `MemoryCategory` to a human-readable section title for the prompt
 * context block.
 */
function categoryTitle(category: string): string {
  switch (category) {
    case 'preference':
      return 'User preferences';
    case 'fact':
      return 'Facts';
    case 'instruction':
      return 'Instructions';
    case 'context':
      return 'Context';
    default:
      return category.charAt(0).toUpperCase() + category.slice(1);
  }
}

/**
 * Build a "memory context" string to inject into LLM prompts.
 *
 * Output format (empty string when no memories):
 *
 * ```
 * User preferences:
 * - prefers Arabic responses
 * - concise replies, code blocks only
 * Facts:
 * - dentist by profession, runs a clinic in Riyadh
 * Instructions:
 * - never run code without confirmation
 * ```
 *
 * Pulls the most recent 30 facts across all categories for the given
 * chatId (and optional projectId), grouped by category.
 */
export async function buildMemoryContext(
  env: Env,
  chatId: number,
  projectId?: string,
): Promise<string> {
  const facts = await recallFacts(env, chatId, undefined, projectId, 30);
  if (facts.length === 0) return '';

  // Group by category, preserving recall order within each group.
  const grouped = new Map<string, string[]>();
  for (const f of facts) {
    const cat = f.category || 'fact';
    const bucket = grouped.get(cat) ?? [];
    bucket.push(f.content);
    grouped.set(cat, bucket);
  }

  // Render in a fixed, predictable section order.
  const sectionOrder: MemoryCategory[] = [
    'preference',
    'instruction',
    'fact',
    'context',
  ];
  const seen = new Set<string>();
  const blocks: string[] = [];

  for (const cat of sectionOrder) {
    const items = grouped.get(cat);
    if (!items || items.length === 0) continue;
    blocks.push(`${categoryTitle(cat)}:\n${items.map((i) => `- ${i}`).join('\n')}`);
    seen.add(cat);
  }

  // Append any unexpected categories in insertion order.
  for (const [cat, items] of grouped) {
    if (seen.has(cat)) continue;
    blocks.push(`${categoryTitle(cat)}:\n${items.map((i) => `- ${i}`).join('\n')}`);
  }

  return blocks.join('\n\n');
}
