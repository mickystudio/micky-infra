/**
 * Micky Assistant Unlimited - Conversation (Chat) Management
 *
 * CRUD operations for the `chats` D1 table.
 * All chat IDs are prefixed with `chat_`.
 *
 * Created: 2026-11-10 (P1-T4)
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

// ============ Chats ============

/**
 * Creates a new chat inside a project.
 * `mode` must be one of: text | code | graphics | montage.
 */
export async function createChat(
  env: Env,
  projectId: string,
  mode: ChatMode | string,
): Promise<OperationResult<Chat>> {
  const chatId = genChatId();
  const ts = nowSec();
  const title = defaultChatTitle(mode);

  try {
    await env.DB.prepare(
      `INSERT INTO chats
         (id, project_id, mode, title, status, queue_position, context_window, model_preference, created_at, last_activity)
       VALUES (?, ?, ?, ?, 'active', 0, 8192, 'auto', ?, ?)`,
    ).bind(chatId, projectId, mode, title, ts, ts).run();

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

/** Returns all chats in a project, most-recently-active first. */
export async function listChats(env: Env, projectId: string): Promise<OperationResult<Chat[]>> {
  try {
    const res = await env.DB.prepare(
      `SELECT * FROM chats WHERE project_id = ? ORDER BY last_activity DESC`,
    ).bind(projectId).all<Chat>();
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

/** Changes the mode of an existing chat. */
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
