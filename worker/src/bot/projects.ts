/**
 * Micky Assistant Unlimited - Project Management (D1 layer)
 *
 * CRUD operations for the `projects` and `project_files` tables.
 * All IDs are prefixed with `proj_` / `file_` to make them recognizable
 * in logs and to provide a cheap namespace separation in D1.
 *
 * Created: 2026-11-10 (P1-T4)
 */

import type { Env } from '../index';

// ============ Types ============
export interface Project {
  id: string;
  user_id: number;
  name: string;
  description: string | null;
  system_prompt: string | null;
  audience: string | null;
  tone: string | null;
  default_mode: string | null;
  created_at: number;
  updated_at: number;
}

export interface ProjectFile {
  id: string;
  project_id: string;
  type: string;
  filename: string;
  storage_url: string | null;
  storage_type: string | null;
  extracted_text: string | null;
  size_bytes: number | null;
  tokens_estimate: number | null;
  uploaded_at: number;
}

export interface OperationResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ============ Helpers ============

/** Generates an ID with the given prefix, e.g. `proj_<uuid>`. */
function genId(prefix: string): string {
  return `${prefix}${crypto.randomUUID()}`;
}

/** Returns the current Unix timestamp in seconds. */
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Rough token estimate for stored extracted text.
 * Uses ~3 chars per token as a conservative average across English/Arabic.
 */
function estimateTokens(text: string | null): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3);
}

// ============ Projects ============

/**
 * Create a new project row in D1.
 * Returns the freshly created project (looked-up after insert).
 */
export async function createProject(
  env: Env,
  userId: number,
  name: string,
  description: string,
  audience = 'patients',
  tone = 'educational',
): Promise<OperationResult<Project>> {
  const projectId = genId('proj_');
  const ts = nowSec();

  try {
    await env.DB.prepare(
      `INSERT INTO projects (id, user_id, name, description, audience, tone, default_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(projectId, userId, name, description || null, audience, tone, 'text', ts, ts).run();

    const created = await getProject(env, projectId);
    if (!created.ok || !created.data) {
      return { ok: false, error: created.error || 'project created but not retrievable' };
    }
    return { ok: true, data: created.data };
  } catch (err) {
    return { ok: false, error: `createProject failed: ${String(err)}` };
  }
}

/** Returns all projects for a given user, newest first. */
export async function listProjects(env: Env, userId: number): Promise<OperationResult<Project[]>> {
  try {
    const res = await env.DB.prepare(
      `SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC`,
    ).bind(userId).all<Project>();
    return { ok: true, data: res.results ?? [] };
  } catch (err) {
    return { ok: false, error: `listProjects failed: ${String(err)}` };
  }
}

/** Returns a single project by id (or null if not found). */
export async function getProject(env: Env, projectId: string): Promise<OperationResult<Project | null>> {
  try {
    const row = await env.DB.prepare(
      `SELECT * FROM projects WHERE id = ?`,
    ).bind(projectId).first<Project>();
    return { ok: true, data: row ?? null };
  } catch (err) {
    return { ok: false, error: `getProject failed: ${String(err)}` };
  }
}

/**
 * Deletes a project. The D1 schema declares ON DELETE CASCADE on the
 * foreign keys, so project_files, chats, messages, chat_summaries,
 * project_memory, etc. will be removed automatically.
 */
export async function deleteProject(env: Env, projectId: string): Promise<OperationResult<void>> {
  try {
    await env.DB.prepare(`DELETE FROM projects WHERE id = ?`).bind(projectId).run();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `deleteProject failed: ${String(err)}` };
  }
}

/** Updates the project's permanent system_prompt context. */
export async function updateProjectContext(
  env: Env,
  projectId: string,
  systemPrompt: string,
): Promise<OperationResult<void>> {
  try {
    await env.DB.prepare(
      `UPDATE projects SET system_prompt = ?, updated_at = ? WHERE id = ?`,
    ).bind(systemPrompt, nowSec(), projectId).run();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `updateProjectContext failed: ${String(err)}` };
  }
}

// ============ Project Files ============

/**
 * Inserts a file reference into project_files.
 * `storageType` defaults to 'r2' but can be 'telegram' when the file is
 * still hosted on Telegram's side (R2 transfer happens later via the queue).
 */
export async function addProjectFile(
  env: Env,
  projectId: string,
  type: string,
  filename: string,
  storageUrl: string,
  extractedText: string | null,
  sizeBytes: number,
  storageType: string = 'r2',
): Promise<OperationResult<ProjectFile>> {
  const fileId = genId('file_');
  const ts = nowSec();
  const tokens = estimateTokens(extractedText);

  try {
    await env.DB.prepare(
      `INSERT INTO project_files
         (id, project_id, type, filename, storage_url, storage_type, extracted_text, size_bytes, tokens_estimate, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      fileId,
      projectId,
      type,
      filename,
      storageUrl,
      storageType,
      extractedText,
      sizeBytes,
      tokens,
      ts,
    ).run();

    const created = await env.DB.prepare(
      `SELECT * FROM project_files WHERE id = ?`,
    ).bind(fileId).first<ProjectFile>();

    if (!created) {
      return { ok: false, error: 'project_file created but not retrievable' };
    }
    return { ok: true, data: created };
  } catch (err) {
    return { ok: false, error: `addProjectFile failed: ${String(err)}` };
  }
}

/** Returns all files attached to a project, newest first. */
export async function listProjectFiles(env: Env, projectId: string): Promise<OperationResult<ProjectFile[]>> {
  try {
    const res = await env.DB.prepare(
      `SELECT * FROM project_files WHERE project_id = ? ORDER BY uploaded_at DESC`,
    ).bind(projectId).all<ProjectFile>();
    return { ok: true, data: res.results ?? [] };
  } catch (err) {
    return { ok: false, error: `listProjectFiles failed: ${String(err)}` };
  }
}

/** Deletes a single project_file by id. */
export async function deleteProjectFile(env: Env, fileId: string): Promise<OperationResult<void>> {
  try {
    await env.DB.prepare(`DELETE FROM project_files WHERE id = ?`).bind(fileId).run();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `deleteProjectFile failed: ${String(err)}` };
  }
}
