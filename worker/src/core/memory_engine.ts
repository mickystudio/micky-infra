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

/** Row shape returned by D1 for `project_memory`. */
interface MemoryRow {
  id: string;
  project_id: string;
  memory_type: string;
  content: string;
  confidence: number;
  times_reinforced: number;
  created_at: number;
  last_used: number;
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
    projectId: row.project_id,
    type: coerceMemoryType(row.memory_type),
    content: row.content,
    confidence: Number(row.confidence ?? 0.5),
    timesReinforced: Number(row.times_reinforced ?? 1),
    createdAt: Number(row.created_at ?? 0),
    lastUsed: Number(row.last_used ?? 0),
  };
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
