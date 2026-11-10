/**
 * Queue Manager - Async Task Dispatch
 * Micky Assistant Unlimited
 *
 * Front-door for asynchronous task execution (LLM inference, montage, graphics, code).
 * Responsibilities:
 *   - enqueueTask:         insert D1 row + send Cloudflare Queue message
 *   - processQueuedTask:   consume a message, route to the right runner, handle retries
 *   - retryTask / cancelTask / getChatTasks / getQueueStats: admin operations
 *
 * Runner routing policy:
 *   inference        -> workers-ai     (synchronous, in-worker)
 *   code             -> github-actions (async, webhook callback completes task)
 *   montage/graphics -> kaggle         (async, webhook callback completes task)
 */

import type { Env } from '../index';
import {
  type Task,
  type TaskStatus,
  type TaskType,
  type TaskRunner,
  transitionTask,
  getTaskStatus,
  isValidTransition,
  parseTaskRow,
} from './state_machine';
import { dispatchToGitHubActions } from '../runners/github_runner';
import { dispatchToKaggle } from '../runners/kaggle_runner';
import { runInference } from '../runners/workers_ai_runner';

// ============ Public Types ============

export interface QueueMessage {
  type: TaskType;
  chatId: number;
  taskId: string;
  payload: Record<string, unknown>;
}

export interface EnqueueParams {
  chatId: string;
  type: TaskType;
  inputSpec: Record<string, unknown>;
  priority?: number; // 1 (highest) .. 10 (lowest). Default 5.
  maxAttempts?: number; // Default 3.
}

export interface QueueStats {
  queued: number;
  running: number;
  completed: number;
  failed: number;
}

// ============ Runner Routing ============

/**
 * Decide which runner executes a given task type.
 */
function selectRunner(taskType: TaskType): TaskRunner {
  switch (taskType) {
    case 'inference':
      return 'workers-ai';
    case 'code':
      return 'github-actions';
    case 'montage':
    case 'graphics':
      return 'kaggle';
    default:
      return 'workers-ai';
  }
}

// ============ Public Functions ============

/**
 * Create a new task and enqueue it.
 *   1. Insert into D1 tasks table (status='queued')
 *   2. Cache in TASK_STATUS KV (TTL 1h)
 *   3. Send a message to TASKS_QUEUE
 * Returns the new task id.
 */
export async function enqueueTask(env: Env, params: EnqueueParams): Promise<string> {
  const taskId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const priority = params.priority ?? 5;
  const maxAttempts = params.maxAttempts ?? 3;

  // 1. Insert into D1
  try {
    await env.DB.prepare(
      `INSERT INTO tasks
         (id, chat_id, type, status, priority, input_spec, max_attempts, queued_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`
    )
      .bind(
        taskId,
        params.chatId,
        params.type,
        priority,
        JSON.stringify(params.inputSpec),
        maxAttempts,
        now
      )
      .run();
  } catch (err) {
    console.error('enqueueTask D1 insert failed:', err);
    throw new Error(`Failed to enqueue task: ${String(err)}`);
  }

  // 2. Warm the KV cache so consumers see the queued state immediately
  const task: Task = {
    id: taskId,
    chatId: params.chatId,
    type: params.type,
    status: 'queued',
    priority,
    runner: null,
    runnerJobId: null,
    inputSpec: params.inputSpec,
    outputUrl: null,
    outputMeta: null,
    attempts: 0,
    maxAttempts,
    errorLog: null,
    queuedAt: now,
    dispatchedAt: null,
    completedAt: null,
  };
  try {
    await env.TASK_STATUS.put(`task:${taskId}`, JSON.stringify(task), {
      expirationTtl: 3600,
    });
  } catch (err) {
    console.error('enqueueTask KV warm failed (non-fatal):', err);
  }

  // 3. Send to the Cloudflare Queue
  const message: QueueMessage = {
    type: params.type,
    chatId: Number(params.chatId),
    taskId,
    payload: params.inputSpec,
  };
  try {
    await env.TASKS_QUEUE.send(message);
  } catch (err) {
    console.error('enqueueTask queue send failed:', err);
    // Leave the D1 row as 'queued' — a sweep job or manual retry can re-enqueue.
    throw new Error(`Failed to dispatch queue message: ${String(err)}`);
  }

  return taskId;
}

/**
 * Process a queued task message (called by the queue consumer in index.ts).
 *
 * Flow:
 *   1. Transition to 'dispatched'
 *   2. Route to the appropriate runner
 *   3. On success: store output and transition to 'completed'
 *      (for async runners like GitHub/Kaggle, leave in 'running' until webhook)
 *   4. On failure: increment attempts and retry up to maxAttempts
 */
export async function processQueuedTask(env: Env, message: QueueMessage): Promise<void> {
  const { taskId, type } = message;

  const task = await getTaskStatus(env, taskId);
  if (!task) {
    console.error(`processQueuedTask: task not found: ${taskId}`);
    return;
  }

  // Skip terminal tasks (e.g. cancelled while sitting in the queue)
  if (
    task.status === 'completed' ||
    task.status === 'cancelled' ||
    task.status === 'failed'
  ) {
    console.log(
      `processQueuedTask: task ${taskId} already in terminal state '${task.status}', skipping`
    );
    return;
  }

  const runner = selectRunner(type);

  try {
    // 1. Transition to dispatched
    const dispatchedTask = await transitionTask(env, taskId, 'dispatched', { runner });

    // 2. Route to runner
    if (runner === 'workers-ai') {
      await runWorkersAiInference(env, dispatchedTask);
    } else if (runner === 'github-actions') {
      await dispatchToGitHubRunner(env, dispatchedTask);
    } else if (runner === 'kaggle') {
      await dispatchToKaggleRunner(env, dispatchedTask);
    } else {
      // Exhaustive: runner is `never` here
      throw new Error(`Unknown runner: ${String(runner)}`);
    }
  } catch (err) {
    console.error(`processQueuedTask: task ${taskId} failed:`, err);
    await handleTaskFailure(env, taskId, err);
  }
}

/**
 * Retry a failed task. Resets attempts and re-enqueues.
 * Returns true if the retry was scheduled, false otherwise.
 */
export async function retryTask(env: Env, taskId: string): Promise<boolean> {
  const task = await getTaskStatus(env, taskId);
  if (!task) {
    return false;
  }
  if (task.status !== 'failed') {
    // Only failed tasks can be retried
    return false;
  }

  try {
    await transitionTask(env, taskId, 'queued', {
      attempts: 0,
      errorLog: null,
      runnerJobId: null,
      dispatchedAt: null,
      completedAt: null,
    });

    const message: QueueMessage = {
      type: task.type,
      chatId: Number(task.chatId),
      taskId,
      payload: task.inputSpec,
    };
    await env.TASKS_QUEUE.send(message);
    return true;
  } catch (err) {
    console.error(`retryTask failed for ${taskId}:`, err);
    return false;
  }
}

/**
 * Cancel a task. Cancels the external runner job (if any) and transitions
 * the task to 'cancelled'. Returns false if the task is already terminal.
 */
export async function cancelTask(env: Env, taskId: string): Promise<boolean> {
  const task = await getTaskStatus(env, taskId);
  if (!task) {
    return false;
  }

  // Already terminal?
  if (task.status === 'completed' || task.status === 'cancelled') {
    return false;
  }

  // Cancel the external runner job (best-effort)
  if (task.runner === 'github-actions' && task.runnerJobId) {
    try {
      const { cancelGitHubRun } = await import('../runners/github_runner');
      await cancelGitHubRun(env, task.runnerJobId);
    } catch (err) {
      console.error('cancelTask: GitHub cancel failed (continuing):', err);
    }
  } else if (task.runner === 'kaggle' && task.runnerJobId) {
    try {
      const { stopKaggleKernel } = await import('../runners/kaggle_runner');
      await stopKaggleKernel(env, task.runnerJobId);
    } catch (err) {
      console.error('cancelTask: Kaggle stop failed (continuing):', err);
    }
  }

  try {
    await transitionTask(env, taskId, 'cancelled', {
      completedAt: Math.floor(Date.now() / 1000),
    });
    return true;
  } catch (err) {
    console.error(`cancelTask failed for ${taskId}:`, err);
    return false;
  }
}

/**
 * Get tasks for a chat, optionally filtered by status.
 * Sorted by queued_at DESC (newest first).
 */
export async function getChatTasks(
  env: Env,
  chatId: string,
  status?: TaskStatus
): Promise<Task[]> {
  try {
    const stmt = status
      ? env.DB.prepare(
          'SELECT * FROM tasks WHERE chat_id = ? AND status = ? ORDER BY queued_at DESC'
        ).bind(chatId, status)
      : env.DB.prepare(
          'SELECT * FROM tasks WHERE chat_id = ? ORDER BY queued_at DESC'
        ).bind(chatId);

    const result = await stmt.all();
    const rows = (result.results ?? []) as Record<string, unknown>[];
    return rows.map(parseTaskRow);
  } catch (err) {
    console.error('getChatTasks failed:', err);
    return [];
  }
}

/**
 * Aggregate counts per status across all tasks.
 */
export async function getQueueStats(env: Env): Promise<QueueStats> {
  try {
    const row = await env.DB.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END), 0) AS queued,
         COALESCE(SUM(CASE WHEN status IN ('dispatched', 'running', 'verifying') THEN 1 ELSE 0 END), 0) AS running,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
       FROM tasks`
    ).first();

    return {
      queued: Number((row as { queued?: number } | null)?.queued) || 0,
      running: Number((row as { running?: number } | null)?.running) || 0,
      completed: Number((row as { completed?: number } | null)?.completed) || 0,
      failed: Number((row as { failed?: number } | null)?.failed) || 0,
    };
  } catch (err) {
    console.error('getQueueStats failed:', err);
    return { queued: 0, running: 0, completed: 0, failed: 0 };
  }
}

// ============ Runner Dispatchers (internal) ============

/**
 * Workers AI path: synchronous inference in-worker.
 * Transitions through verifying -> completed.
 */
async function runWorkersAiInference(env: Env, task: Task): Promise<void> {
  const messages = (task.inputSpec.messages as Array<{ role: string; content: string }>) ?? [];

  const result = await runInference(env, {
    messages,
    model: typeof task.inputSpec.model === 'string' ? task.inputSpec.model : undefined,
    maxTokens: typeof task.inputSpec.maxTokens === 'number'
      ? task.inputSpec.maxTokens
      : undefined,
    temperature: typeof task.inputSpec.temperature === 'number'
      ? task.inputSpec.temperature
      : undefined,
  });

  const outputMeta = {
    response: result.response,
    usage: result.usage,
  };

  // Synchronous success: verifying -> completed
  await transitionTask(env, task.id, 'verifying', { outputMeta });
  await transitionTask(env, task.id, 'completed', { outputMeta });
}

/**
 * GitHub Actions path: dispatch via repository_dispatch and leave the task
 * in 'running' until the GitHub webhook callback (handleGitHubWebhook in
 * index.ts) fires to transition it to 'completed' or 'failed'.
 */
async function dispatchToGitHubRunner(env: Env, task: Task): Promise<void> {
  const runId = await dispatchToGitHubActions(env, task);
  await transitionTask(env, task.id, 'running', {
    runnerJobId: runId || null,
  });
}

/**
 * Kaggle path: push the kernel and leave the task in 'running' until the
 * Kaggle webhook (or polling job) marks it 'completed' or 'failed'.
 */
async function dispatchToKaggleRunner(env: Env, task: Task): Promise<void> {
  const kernelId = await dispatchToKaggle(env, task);
  await transitionTask(env, task.id, 'running', {
    runnerJobId: kernelId,
  });
}

// ============ Failure Handling (internal) ============

/**
 * Handle a task failure: increment attempts and either retry (re-enqueue)
 * or leave permanently failed when maxAttempts is reached.
 */
async function handleTaskFailure(
  env: Env,
  taskId: string,
  err: unknown
): Promise<void> {
  const task = await getTaskStatus(env, taskId);
  if (!task) return;

  // If the task was cancelled or completed externally while we were running,
  // respect that state and do nothing.
  if (task.status === 'cancelled' || task.status === 'completed') {
    console.log(
      `handleTaskFailure: task ${taskId} already '${task.status}', not retrying`
    );
    return;
  }

  const errorMessage = err instanceof Error ? err.message : String(err);
  const newAttempts = task.attempts + 1;

  // Transition to 'failed' (if not already)
  if (task.status !== 'failed') {
    if (!isValidTransition(task.status, 'failed')) {
      console.error(
        `handleTaskFailure: cannot transition ${task.status} -> failed for ${taskId}`
      );
      return;
    }
    try {
      await transitionTask(env, taskId, 'failed', {
        attempts: newAttempts,
        errorLog: errorMessage,
      });
    } catch (transitionErr) {
      console.error('handleTaskFailure: failed-transition failed:', transitionErr);
      return;
    }
  }

  // Retry or give up
  if (newAttempts < task.maxAttempts) {
    try {
      await transitionTask(env, taskId, 'queued', {
        attempts: newAttempts,
        errorLog: errorMessage,
      });
      const message: QueueMessage = {
        type: task.type,
        chatId: Number(task.chatId),
        taskId,
        payload: task.inputSpec,
      };
      await env.TASKS_QUEUE.send(message);
      console.log(
        `handleTaskFailure: task ${taskId} re-enqueued (attempt ${newAttempts + 1}/${task.maxAttempts})`
      );
    } catch (retryErr) {
      console.error(`handleTaskFailure: re-enqueue failed for ${taskId}:`, retryErr);
    }
  } else {
    console.log(
      `handleTaskFailure: task ${taskId} reached max attempts (${task.maxAttempts}), staying failed`
    );
  }
}
