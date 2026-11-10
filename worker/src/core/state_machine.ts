/**
 * State Machine - Task Lifecycle Management
 * Micky Assistant Unlimited
 *
 * Manages task state transitions with strict validation.
 * Lifecycle:
 *   queued → dispatched → running → verifying → completed
 *                                          ↘ failed → queued (retry up to maxAttempts)
 *   Any non-terminal state → cancelled (where allowed)
 *
 * State is the source-of-truth in D1 (tasks table) with a 1-hour TTL cache
 * in the TASK_STATUS KV namespace for fast lookups.
 */

import type { Env } from '../index';

// ============ Public Types ============

export type TaskStatus =
  | 'queued'
  | 'dispatched'
  | 'running'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskType = 'inference' | 'montage' | 'graphics' | 'code';

export type TaskRunner = 'workers-ai' | 'github-actions' | 'kaggle';

export interface Task {
  id: string;
  chatId: string;
  type: TaskType;
  status: TaskStatus;
  priority: number;
  runner: TaskRunner | null;
  runnerJobId: string | null;
  inputSpec: Record<string, unknown>;
  outputUrl: string | null;
  outputMeta: Record<string, unknown> | null;
  attempts: number;
  maxAttempts: number;
  errorLog: string | null;
  queuedAt: number;
  dispatchedAt: number | null;
  completedAt: number | null;
}

// ============ Transition Table ============

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  queued: ['dispatched', 'cancelled'],
  dispatched: ['running', 'failed', 'cancelled'],
  running: ['verifying', 'failed', 'cancelled'],
  verifying: ['completed', 'failed'],
  completed: [],
  failed: ['queued'], // retry
  cancelled: [],
};

// ============ Constants ============

const TASK_STATUS_TTL_SECONDS = 3600; // 1 hour
const KV_KEY_PREFIX = 'task:';

// ============ Public Functions ============

/**
 * Check whether a state transition is allowed by the state machine.
 */
export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * Get the current task. KV cache is checked first (fast path),
 * then falls back to D1 (source of truth).
 */
export async function getTaskStatus(env: Env, taskId: string): Promise<Task | null> {
  // 1. Try KV cache first
  try {
    const cached = await env.TASK_STATUS.get(KV_KEY_PREFIX + taskId);
    if (cached) {
      return JSON.parse(cached) as Task;
    }
  } catch (err) {
    console.error('KV read failed for task status:', err);
    // fall through to D1
  }

  // 2. Fall back to D1
  try {
    const row = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?')
      .bind(taskId)
      .first();
    if (!row) return null;
    return parseTaskRow(row as Record<string, unknown>);
  } catch (err) {
    console.error('D1 read failed for task:', err);
    return null;
  }
}

/**
 * Transition a task to a new status. Validates the transition is allowed.
 * Writes to BOTH D1 (source of truth) and KV (fast cache).
 *
 * Metadata may include any mutable Task field. The fields id, chatId, type
 * and queuedAt are immutable and will be ignored if present in metadata.
 */
export async function transitionTask(
  env: Env,
  taskId: string,
  newStatus: TaskStatus,
  metadata?: Partial<Task>
): Promise<Task> {
  // 1. Load current state
  const current = await getTaskStatus(env, taskId);
  if (!current) {
    throw new Error(`Task not found: ${taskId}`);
  }

  // 2. Validate transition
  if (current.status === newStatus) {
    // No-op — return current state without writing
    return current;
  }
  if (!isValidTransition(current.status, newStatus)) {
    throw new Error(
      `Invalid transition: ${current.status} -> ${newStatus} for task ${taskId}`
    );
  }

  // 3. Build the updated Task object
  const now = Math.floor(Date.now() / 1000);
  const updated: Task = {
    ...current,
    ...(metadata ?? {}),
    status: newStatus,
    // Immutable fields (always preserved from current)
    id: current.id,
    chatId: current.chatId,
    type: current.type,
    queuedAt: current.queuedAt,
  };

  // 4. Apply transition-specific timestamp / state resets
  if (newStatus === 'dispatched' && updated.dispatchedAt == null) {
    updated.dispatchedAt = now;
  }
  if (
    (newStatus === 'completed' || newStatus === 'failed' || newStatus === 'cancelled') &&
    updated.completedAt == null
  ) {
    updated.completedAt = now;
  }
  if (newStatus === 'queued') {
    // Retry: reset transient fields for a fresh run
    updated.dispatchedAt = null;
    updated.completedAt = null;
    updated.runnerJobId = null;
  }

  // 5. Persist to D1
  try {
    await env.DB.prepare(
      `UPDATE tasks
         SET status = ?,
             runner = ?,
             runner_job_id = ?,
             output_url = ?,
             output_meta = ?,
             attempts = ?,
             error_log = ?,
             dispatched_at = ?,
             completed_at = ?
       WHERE id = ?`
    )
      .bind(
        updated.status,
        updated.runner,
        updated.runnerJobId,
        updated.outputUrl,
        updated.outputMeta ? JSON.stringify(updated.outputMeta) : null,
        updated.attempts,
        updated.errorLog,
        updated.dispatchedAt,
        updated.completedAt,
        updated.id
      )
      .run();
  } catch (err) {
    console.error('D1 update failed for task transition:', err);
    throw new Error(`Failed to persist task transition: ${String(err)}`);
  }

  // 6. Update KV cache (non-fatal on failure — D1 is source of truth)
  try {
    await env.TASK_STATUS.put(KV_KEY_PREFIX + taskId, JSON.stringify(updated), {
      expirationTtl: TASK_STATUS_TTL_SECONDS,
    });
  } catch (err) {
    console.error('KV write failed for task status:', err);
  }

  return updated;
}

/**
 * Invalidate the KV cache entry for a task (forces next read to hit D1).
 * Useful when an external system (GitHub/Kaggle webhook) updates the row
 * out-of-band and we want to refresh.
 */
export async function invalidateTaskCache(env: Env, taskId: string): Promise<void> {
  try {
    await env.TASK_STATUS.delete(KV_KEY_PREFIX + taskId);
  } catch (err) {
    console.error('KV delete failed for task cache invalidation:', err);
  }
}

// ============ Helpers ============

/**
 * Convert a D1 row (snake_case columns) into a Task (camelCase fields).
 * Exported so other modules (queue_manager, runners) can reuse the parser.
 */
export function parseTaskRow(row: Record<string, unknown>): Task {
  return {
    id: String(row.id),
    chatId: row.chat_id != null ? String(row.chat_id) : '',
    type: (row.type as TaskType) ?? 'inference',
    status: (row.status as TaskStatus) ?? 'queued',
    priority: row.priority != null ? Number(row.priority) : 5,
    runner: (row.runner as TaskRunner | null) ?? null,
    runnerJobId: (row.runner_job_id as string | null) ?? null,
    inputSpec: parseJsonObject(row.input_spec),
    outputUrl: (row.output_url as string | null) ?? null,
    outputMeta: row.output_meta != null ? parseJsonObject(row.output_meta) : null,
    attempts: row.attempts != null ? Number(row.attempts) : 0,
    maxAttempts: row.max_attempts != null ? Number(row.max_attempts) : 3,
    errorLog: (row.error_log as string | null) ?? null,
    queuedAt: row.queued_at != null ? Number(row.queued_at) : 0,
    dispatchedAt: (row.dispatched_at as number | null) ?? null,
    completedAt: (row.completed_at as number | null) ?? null,
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
