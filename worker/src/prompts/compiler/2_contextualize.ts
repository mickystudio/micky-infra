/**
 * Micky Assistant Unlimited - Prompt Compiler / Layer 2: Contextualization
 * ----------------------------------------------------------------------------
 * مُوجّه البرومبت - الطبقة 2: السياق
 *
 * Enriches the compressed user message with:
 *   - Project `system_prompt` (or a sensible default).
 *   - Sliding window of the last 10 messages from `messages` (chronological).
 *   - Up to 3 `chat_summaries` rows (older conversation context).
 *   - Top 5 `project_memory` rows by `confidence` (long-term learning).
 *
 * Each D1 query is wrapped in try/catch so a missing table or DB hiccup
 * degrades gracefully to "no context" instead of failing compilation.
 *
 * Created: 2026-11-10
 * Phase: P2-T1
 */

import type { Env } from '../../index';

// ============ Public types ============

/** A chat message used inside the conversation history window. */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at?: number;
}

/** A long-term memory row from `project_memory`. */
export interface MemorySnippet {
  id: string;
  memory_type: string;
  content: string;
  confidence: number;
}

/** A summary row from `chat_summaries` (older context). */
export interface ChatSummary {
  id: string;
  summary: string;
  until_message_id?: string;
  created_at: number;
}

/** Output of layer 2 — everything layer 3 (routing) needs to know. */
export interface ContextualizedPrompt {
  /** Project system prompt (or default) to be merged with the template. */
  systemPrompt: string;
  /** The compressed user message coming from layer 1. */
  compressedUserMessage: string;
  /** Last 10 messages, oldest-first (sliding window). */
  conversationHistory: ChatMessage[];
  /** Long-term memory snippets to inject. */
  memorySnippets: MemorySnippet[];
  /** Older chat summaries (compressed history beyond the window). */
  chatSummaries: ChatSummary[];
  /** Project ID if the chat is bound to a project. */
  projectId?: string;
  /** Project name for display / logging. */
  projectName?: string;
}

// ============ Row types (D1 schema snake_case) ============

interface ChatRow {
  project_id: string | null;
}

interface ProjectRow {
  name: string;
  system_prompt: string | null;
}

interface MessageRow {
  role: string;
  content: string;
  created_at: number;
}

interface SummaryRow {
  id: string;
  summary: string;
  until_message_id: string | null;
  created_at: number;
}

interface MemoryRow {
  id: string;
  memory_type: string | null;
  content: string;
  confidence: number | null;
}

// ============ Constants ============

/** Sliding-window size for raw message history. */
const MESSAGE_WINDOW = 10;

/** Maximum number of chat summaries to inject. */
const MAX_SUMMARIES = 3;

/** Maximum number of memory snippets to inject (top by confidence). */
const MAX_MEMORIES = 5;

/** Default system prompt when no project system_prompt is defined. */
const DEFAULT_SYSTEM_PROMPT = [
  'You are Micky Assistant, a professional AI assistant for Dr. Micky (dentist).',
  'Help with dental topics, professional content creation, code, and analysis.',
  'Reply in Modern Standard Arabic unless the user explicitly requests another language.',
  'Be accurate, concise, and avoid hallucination. If unsure, say so explicitly.',
].join(' ');

// ============ Public API ============

/**
 * Build a fully contextualized prompt object for the given chat.
 *
 * Reads:
 *   - chats (for project_id)
 *   - messages (last 10, DESC → reversed to chronological)
 *   - chat_summaries (last 3)
 *   - projects (system_prompt + name)
 *   - project_memory (top 5 by confidence)
 *
 * Never throws — every D1 query has its own try/catch and missing context
 * yields empty arrays / default system prompt.
 */
export async function contextualize(
  env: Env,
  chatId: string,
  compressed: string,
): Promise<ContextualizedPrompt> {
  // === 1) Resolve project_id from chats ===
  let projectId: string | null = null;
  try {
    if (env?.DB) {
      const chat = await env.DB.prepare(
        'SELECT project_id FROM chats WHERE id = ? LIMIT 1',
      )
        .bind(chatId)
        .first<ChatRow>();
      projectId = chat?.project_id ?? null;
    }
  } catch (err) {
    console.error('[contextualize] chat lookup failed:', err);
  }

  // === 2) Sliding window of recent messages ===
  const conversationHistory = await fetchMessages(env, chatId);

  // === 3) Older chat summaries ===
  const chatSummaries = await fetchSummaries(env, chatId);

  // === 4) Project context (system_prompt + name) and memory ===
  let systemPrompt = DEFAULT_SYSTEM_PROMPT;
  let projectName: string | undefined;
  let memorySnippets: MemorySnippet[] = [];

  if (projectId) {
    const project = await fetchProject(env, projectId);
    if (project) {
      projectName = project.name;
      if (project.system_prompt && project.system_prompt.trim().length > 0) {
        systemPrompt = project.system_prompt.trim();
      }
    }
    memorySnippets = await fetchMemory(env, projectId);
  }

  return {
    systemPrompt,
    compressedUserMessage: compressed,
    conversationHistory,
    memorySnippets,
    chatSummaries,
    projectId: projectId ?? undefined,
    projectName,
  };
}

// ============ D1 fetchers ============

async function fetchMessages(env: Env, chatId: string): Promise<ChatMessage[]> {
  if (!env?.DB) return [];
  try {
    const rs = await env.DB.prepare(
      'SELECT role, content, created_at FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?',
    )
      .bind(chatId, MESSAGE_WINDOW)
      .all<MessageRow>();

    const rows = rs.results ?? [];
    // Reverse to chronological (oldest → newest).
    return rows
      .slice()
      .reverse()
      .map((r) => ({
        role: coerceRole(r.role),
        content: r.content,
        created_at: r.created_at,
      }));
  } catch (err) {
    console.error('[contextualize] messages fetch failed:', err);
    return [];
  }
}

async function fetchSummaries(env: Env, chatId: string): Promise<ChatSummary[]> {
  if (!env?.DB) return [];
  try {
    const rs = await env.DB.prepare(
      'SELECT id, summary, until_message_id, created_at FROM chat_summaries WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?',
    )
      .bind(chatId, MAX_SUMMARIES)
      .all<SummaryRow>();
    return (rs.results ?? []).map((r) => ({
      id: r.id,
      summary: r.summary,
      until_message_id: r.until_message_id ?? undefined,
      created_at: r.created_at,
    }));
  } catch (err) {
    console.error('[contextualize] summaries fetch failed:', err);
    return [];
  }
}

async function fetchProject(
  env: Env,
  projectId: string,
): Promise<ProjectRow | null> {
  if (!env?.DB) return null;
  try {
    return await env.DB.prepare(
      'SELECT name, system_prompt FROM projects WHERE id = ? LIMIT 1',
    )
      .bind(projectId)
      .first<ProjectRow>();
  } catch (err) {
    console.error('[contextualize] project fetch failed:', err);
    return null;
  }
}

async function fetchMemory(
  env: Env,
  projectId: string,
): Promise<MemorySnippet[]> {
  if (!env?.DB) return [];
  try {
    const rs = await env.DB.prepare(
      'SELECT id, memory_type, content, confidence FROM project_memory WHERE project_id = ? ORDER BY confidence DESC LIMIT ?',
    )
      .bind(projectId, MAX_MEMORIES)
      .all<MemoryRow>();
    return (rs.results ?? []).map((r) => ({
      id: r.id,
      memory_type: r.memory_type ?? 'general',
      content: r.content,
      confidence: Number(r.confidence ?? 0.5),
    }));
  } catch (err) {
    console.error('[contextualize] memory fetch failed:', err);
    return [];
  }
}

// ============ Helpers ============

/** Coerce an arbitrary DB role string into the strict union type. */
function coerceRole(raw: string): ChatMessage['role'] {
  switch (String(raw ?? '').toLowerCase()) {
    case 'assistant':
      return 'assistant';
    case 'system':
      return 'system';
    case 'user':
    default:
      return 'user';
  }
}
