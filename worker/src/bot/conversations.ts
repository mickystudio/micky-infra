/**
 * Micky Assistant Unlimited - Conversation (Chat) Management
 *
 * CRUD operations for the `chats` and `messages` D1 tables.
 * All chat IDs are prefixed with `chat_`.
 *
 * Public API summary:
 *
 *   createChat(env, projectId, mode)                       — create in a known project
 *   createChat(env, userId,    mode, title)                — create in user's default project
 *   listChats(env, projectId)                              — list all chats in a project
 *   listChats(env, userId, limit, offset)                  — paginated chats across all projects
 *   getChat(env, chatId)                                   — fetch a single chat row
 *   getChatWithMeta(env, chatId)                           — fetch chat + message metadata
 *   archiveChat(env, chatId)                               — soft-delete (status='archived')
 *   switchMode(env, chatId, newMode)                       — change mode mid-conversation
 *   getChatHistory(env, chatId, limit)                     — recent messages
 *   updateChatActivity(env, chatId)                       — bump last_activity (internal)
 *   setChatMode(env, chatId, mode)                        — low-level mode setter (internal)
 *
 * Created: 2026-11-10 (P1-T4)
 * Updated: 2026-11-12 (P1-T5: pagination + history + metadata + switchMode)
 */

import type { Env } from '../index';
import type { ChatMode } from './keyboards';

// ============ Types ============
export interface Chat {
  id: string;
  project_id: string;
  mode: string;
  title: string | null;
  status: string;
  queue_position: number | null;
  context_window: number | null;
  model_preference: string | null;
  created_at: number;
  last_activity: number | null;
}

/**
 * A chat row joined with derived message metadata. The metadata fields
 * are optional so that callers that only need the chat row itself can
 * still receive a `Chat`-shaped object via {@link getChat}.
 */
export interface ChatWithMeta extends Chat {
  /** Total number of messages stored for the chat. */
  message_count: number;
  /** Timestamp (seconds) of the most recent message, or null if empty. */
  last_message_at: number | null;
  /** Truncated preview of the most recent message content. */
  last_message_preview: string | null;
}

/** A single message row from the `messages` table. */
export interface ChatMessage {
  id: string;
  chat_id: string;
  role: string;
  content: string;
  tokens_in: number | null;
  tokens_out: number | null;
  model_used: string | null;
  prompt_compiled: string | null;
  sources: string | null;
  attachments: string | null;
  created_at: number;
}

export interface OperationResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ============ Helpers ============

function genChatId(): string {
  return `chat_${crypto.randomUUID()}`;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Returns a default Arabic title based on the chat mode. */
function defaultChatTitle(mode: string): string {
  switch (mode) {
    case 'text':     return 'محادثة نصية';
    case 'code':     return 'محادثة كود';
    case 'graphics': return 'محادثة صور';
    case 'montage':  return 'محادثة مونتاج';
    default:          return 'محادثة جديدة';
  }
}

/** Validates that `mode` is one of the supported chat modes. */
function isValidMode(mode: string): mode is ChatMode {
  return mode === 'text' || mode === 'code' || mode === 'graphics' || mode === 'montage';
}

// ============ Chats ============

/**
 * Creates a new chat.
 *
 * Two call shapes are supported:
 *
 *   1. `createChat(env, projectId, mode)` — inserts a chat directly into
 *      the given project. Used by the Telegram handlers when the user
 *      has already selected a project.
 *
 *   2. `createChat(env, userId, mode, title)` — looks up the user's most
 *      recently-updated project and creates the chat inside it. If the
 *      user has no projects yet the call returns `{ ok: false }` and the
 *      caller is expected to prompt the user to create one first.
 *
 * The `mode` must be one of: text | code | graphics | montage.
 */
export function createChat(
  env: Env,
  projectId: string,
  mode: ChatMode | string,
): Promise<OperationResult<Chat>>;
export function createChat(
  env: Env,
  userId: number,
  mode: ChatMode | string,
  title: string,
): Promise<OperationResult<Chat>>;
export function createChat(
  env: Env,
  id: string | number,
  mode: ChatMode | string,
  title?: string,
): Promise<OperationResult<Chat>> {
  if (typeof id === 'string') {
    // Path 1: projectId provided.
    return createChatInProject(env, id, mode, title ?? null);
  }
  // Path 2: userId provided — resolve to a project first.
  return createChatForUser(env, id, mode, title ?? null);
}

/** Implementation: create a chat directly in a known project. */
async function createChatInProject(
  env: Env,
  projectId: string,
  mode: ChatMode | string,
  title: string | null,
): Promise<OperationResult<Chat>> {
  if (!isValidMode(mode as string)) {
    return { ok: false, error: `invalid mode: ${mode}` };
  }
  const chatId = genChatId();
  const ts = nowSec();
  const finalTitle = title?.trim() || defaultChatTitle(mode);

  try {
    await env.DB.prepare(
      `INSERT INTO chats
         (id, project_id, mode, title, status, queue_position, context_window, model_preference, created_at, last_activity)
       VALUES (?, ?, ?, ?, 'active', 0, 8192, 'auto', ?, ?)`,
    ).bind(chatId, projectId, mode, finalTitle, ts, ts).run();

    const created = await env.DB.prepare(
      `SELECT * FROM chats WHERE id = ?`,
    ).bind(chatId).first<Chat>();

    if (!created) {
      return { ok: false, error: 'chat created but not retrievable' };
    }
    return { ok: true, data: created };
  } catch (err) {
    return { ok: false, error: `createChat failed: ${String(err)}` };
  }
}

/** Implementation: resolve user's most-recently-updated project, then create. */
async function createChatForUser(
  env: Env,
  userId: number,
  mode: ChatMode | string,
  title: string | null,
): Promise<OperationResult<Chat>> {
  if (!isValidMode(mode as string)) {
    return { ok: false, error: `invalid mode: ${mode}` };
  }
  try {
    const projectRow = await env.DB.prepare(
      `SELECT id FROM projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1`,
    ).bind(userId).first<{ id: string }>();

    if (!projectRow) {
      return { ok: false, error: 'user has no projects; create a project first' };
    }
    return await createChatInProject(env, projectRow.id, mode, title);
  } catch (err) {
    return { ok: false, error: `createChat failed: ${String(err)}` };
  }
}

/**
 * Lists chats.
 *
 * Two call shapes are supported:
 *
 *   1. `listChats(env, projectId)` — returns all chats in a project,
 *      most-recently-active first. Backward compatible with the original
 *      Telegram handler call.
 *
 *   2. `listChats(env, userId, limit, offset)` — returns a paginated
 *      slice of all chats across all of the user's projects, joined via
 *      the `projects` table. The returned chats include `status` so the
 *      caller can render status indicators.
 */
export function listChats(
  env: Env,
  projectId: string,
): Promise<OperationResult<Chat[]>>;
export function listChats(
  env: Env,
  userId: number,
  limit: number,
  offset: number,
): Promise<OperationResult<Chat[]>>;
export function listChats(
  env: Env,
  id: string | number,
  limit?: number,
  offset?: number,
): Promise<OperationResult<Chat[]>> {
  if (typeof id === 'string') {
    return listChatsByProject(env, id);
  }
  return listChatsByUser(env, id, limit ?? 20, offset ?? 0);
}

/** Returns all chats in a project, most-recently-active first. */
async function listChatsByProject(env: Env, projectId: string): Promise<OperationResult<Chat[]>> {
  try {
    const res = await env.DB.prepare(
      `SELECT * FROM chats WHERE project_id = ? ORDER BY last_activity DESC`,
    ).bind(projectId).all<Chat>();
    return { ok: true, data: res.results ?? [] };
  } catch (err) {
    return { ok: false, error: `listChats failed: ${String(err)}` };
  }
}

/** Returns a paginated slice of all chats across a user's projects. */
async function listChatsByUser(
  env: Env,
  userId: number,
  limit: number,
  offset: number,
): Promise<OperationResult<Chat[]>> {
  // Clamp inputs to sensible bounds.
  const safeLimit = Math.min(Math.max(1, limit), 100);
  const safeOffset = Math.max(0, offset);
  try {
    const res = await env.DB.prepare(
      `SELECT c.*
         FROM chats c
         JOIN projects p ON p.id = c.project_id
        WHERE p.user_id = ?
        ORDER BY c.last_activity DESC
        LIMIT ? OFFSET ?`,
    ).bind(userId, safeLimit, safeOffset).all<Chat>();
    return { ok: true, data: res.results ?? [] };
  } catch (err) {
    return { ok: false, error: `listChats failed: ${String(err)}` };
  }
}

/** Returns a single chat by id (or null if not found). */
export async function getChat(env: Env, chatId: string): Promise<OperationResult<Chat | null>> {
  try {
    const row = await env.DB.prepare(
      `SELECT * FROM chats WHERE id = ?`,
    ).bind(chatId).first<Chat>();
    return { ok: true, data: row ?? null };
  } catch (err) {
    return { ok: false, error: `getChat failed: ${String(err)}` };
  }
}

/**
 * Returns a single chat joined with derived message metadata:
 *   - `message_count`        — total messages stored for the chat
 *   - `last_message_at`      — most recent message timestamp (sec)
 *   - `last_message_preview` — first ~120 chars of the most recent message
 *
 * Returns `{ ok: true, data: null }` when the chat does not exist.
 */
export async function getChatWithMeta(
  env: Env,
  chatId: string,
): Promise<OperationResult<ChatWithMeta | null>> {
  try {
    const chat = await env.DB.prepare(
      `SELECT * FROM chats WHERE id = ?`,
    ).bind(chatId).first<Chat>();
    if (!chat) return { ok: true, data: null };

    const meta = await env.DB.prepare(
      `SELECT
         COUNT(*)                                                  AS message_count,
         MAX(created_at)                                           AS last_message_at,
         SUBSTR((SELECT content FROM messages
                  WHERE chat_id = ?
                  ORDER BY created_at DESC LIMIT 1), 1, 120)       AS last_message_preview
       FROM messages
       WHERE chat_id = ?`,
    ).bind(chatId, chatId).first<{ message_count: number; last_message_at: number | null; last_message_preview: string | null }>();

    const merged: ChatWithMeta = {
      ...chat,
      message_count: meta?.message_count ?? 0,
      last_message_at: meta?.last_message_at ?? null,
      last_message_preview: meta?.last_message_preview ?? null,
    };
    return { ok: true, data: merged };
  } catch (err) {
    return { ok: false, error: `getChatWithMeta failed: ${String(err)}` };
  }
}

/** Bumps the last_activity timestamp on a chat (call after each message). */
export async function updateChatActivity(env: Env, chatId: string): Promise<OperationResult<void>> {
  try {
    await env.DB.prepare(
      `UPDATE chats SET last_activity = ? WHERE id = ?`,
    ).bind(nowSec(), chatId).run();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `updateChatActivity failed: ${String(err)}` };
  }
}

/**
 * Changes the mode of an existing chat. This is the public alias of
 * {@link setChatMode} and is the name requested by the conversation
 * handler contract. The original `setChatMode` is retained for backward
 * compatibility with any code that already imports it.
 *
 * `newMode` must be one of: text | code | graphics | montage.
 */
export async function switchMode(
  env: Env,
  chatId: string,
  newMode: ChatMode | string,
): Promise<OperationResult<void>> {
  if (!isValidMode(newMode as string)) {
    return { ok: false, error: `invalid mode: ${newMode}` };
  }
  return await setChatMode(env, chatId, newMode);
}

/** Low-level mode setter (no validation). Used by {@link switchMode}. */
export async function setChatMode(
  env: Env,
  chatId: string,
  mode: ChatMode | string,
): Promise<OperationResult<void>> {
  try {
    await env.DB.prepare(
      `UPDATE chats SET mode = ?, last_activity = ? WHERE id = ?`,
    ).bind(mode, nowSec(), chatId).run();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `setChatMode failed: ${String(err)}` };
  }
}

/** Marks a chat as archived (hidden from the active chats list). */
export async function archiveChat(env: Env, chatId: string): Promise<OperationResult<void>> {
  try {
    await env.DB.prepare(
      `UPDATE chats SET status = 'archived', last_activity = ? WHERE id = ?`,
    ).bind(nowSec(), chatId).run();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `archiveChat failed: ${String(err)}` };
  }
}

/**
 * Returns the most recent `limit` messages for a chat, oldest-first
 * (i.e. in the order they would naturally render in a chat UI).
 *
 * The query reads from the `messages` table. The caller is expected to
 * pass a small `limit` (e.g. 20) since the entire payload is shipped to
 * Telegram as a single message.
 *
 * @param limit clamped to the range [1, 100]; defaults to 20.
 */
export async function getChatHistory(
  env: Env,
  chatId: string,
  limit: number = 20,
): Promise<OperationResult<ChatMessage[]>> {
  const safeLimit = Math.min(Math.max(1, limit), 100);
  try {
    // Sub-select the most recent N rows, then re-sort oldest-first so
    // the caller can render them top-to-bottom without extra work.
    const res = await env.DB.prepare(
      `SELECT * FROM messages
        WHERE chat_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
    ).bind(chatId, safeLimit).all<ChatMessage>();

    const rows = res.results ?? [];
    rows.reverse(); // oldest → newest
    return { ok: true, data: rows };
  } catch (err) {
    return { ok: false, error: `getChatHistory failed: ${String(err)}` };
  }
}
