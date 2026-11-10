/**
 * GitHub Actions Runner
 * Micky Assistant Unlimited
 *
 * Dispatches tasks to GitHub Actions via repository_dispatch webhook.
 * Status is then polled via the GitHub Actions REST API.
 *
 * Used for: code tasks (medium-compute, opens PRs/commits).
 */

import type { Env } from '../index';
import type { Task } from '../core/state_machine';

// ============ Constants ============

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_REPO = 'mickystudio/micky-infra';
const GITHUB_API_VERSION = '2022-11-28';
const USER_AGENT = 'micky-assistant-worker';

// ============ Types ============

export type GitHubRunStatus =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'failed';

interface GitHubRunResponse {
  id?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
}

interface GitHubRunsListResponse {
  workflow_runs?: GitHubRunResponse[];
}

// ============ Public Functions ============

/**
 * Dispatch a task to GitHub Actions via repository_dispatch.
 *
 * POST https://api.github.com/repos/{owner}/{repo}/dispatches
 * Body: { event_type: 'run_task', client_payload: { task_id, type, input_spec } }
 *
 * repository_dispatch returns 204 No Content with no body — the workflow
 * run ID must be looked up via the actions/runs API (filtered by event).
 *
 * Returns: workflow run ID (or empty string if it couldn't be resolved).
 */
export async function dispatchToGitHubActions(env: Env, task: Task): Promise<string> {
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/dispatches`;
  const body = {
    event_type: 'run_task',
    client_payload: {
      task_id: task.id,
      type: task.type,
      input_spec: task.inputSpec,
      chat_id: task.chatId,
    },
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GH_PAT_SCOPED}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`GitHub dispatch network error: ${String(err)}`);
  }

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new Error(
      `GitHub dispatch failed (${response.status} ${response.statusText}): ${text}`
    );
  }

  // GitHub returns 204 No Content; find the resulting workflow run id.
  try {
    const runId = await findLatestRunForTask(env, task.id);
    return runId;
  } catch (err) {
    console.error('dispatchToGitHubActions: could not resolve run id:', err);
    return '';
  }
}

/**
 * Check the status of a GitHub Actions run.
 */
export async function checkGitHubRunStatus(
  env: Env,
  runId: string
): Promise<GitHubRunStatus> {
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/actions/runs/${encodeURIComponent(runId)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${env.GH_PAT_SCOPED}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': USER_AGENT,
      },
    });
  } catch (err) {
    throw new Error(`GitHub status network error: ${String(err)}`);
  }

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new Error(
      `GitHub run status failed (${response.status} ${response.statusText}): ${text}`
    );
  }

  const data = (await response.json()) as GitHubRunResponse;
  const status = (data.status ?? '').toLowerCase();

  if (status === 'queued') return 'queued';
  if (status === 'in_progress') return 'in_progress';
  if (status === 'completed') {
    // conclusion distinguishes success vs. failure
    return data.conclusion === 'success' ? 'completed' : 'failed';
  }

  throw new Error(`Unknown GitHub run status: '${data.status}' (conclusion: ${data.conclusion ?? 'null'})`);
}

/**
 * Cancel a GitHub Actions run. Returns true on success (or if the run was
 * already in a terminal state that returns 409 Conflict).
 */
export async function cancelGitHubRun(env: Env, runId: string): Promise<boolean> {
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/actions/runs/${encodeURIComponent(runId)}/cancel`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GH_PAT_SCOPED}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': USER_AGENT,
      },
    });
  } catch (err) {
    throw new Error(`GitHub cancel network error: ${String(err)}`);
  }

  // 202 Accepted = cancelled
  // 409 Conflict = already completed/cancelled — treat as success
  if (response.ok || response.status === 409) {
    return true;
  }

  const text = await safeReadText(response);
  throw new Error(
    `GitHub cancel failed (${response.status} ${response.statusText}): ${text}`
  );
}

// ============ Internal Helpers ============

/**
 * Find the most recent workflow run that was triggered by this task.
 * The workflow run's `name` field is set to the task id by the GitHub Actions
 * workflow file (the workflow sets `run-name: ${{ github.event.client_payload.task_id }}`).
 */
async function findLatestRunForTask(env: Env, taskId: string): Promise<string> {
  const url =
    `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/actions/runs` +
    `?event=repository_dispatch&per_page=10`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${env.GH_PAT_SCOPED}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': USER_AGENT,
      },
    });
  } catch (err) {
    throw new Error(`GitHub runs query network error: ${String(err)}`);
  }

  if (!response.ok) {
    throw new Error(`GitHub runs query failed (${response.status} ${response.statusText})`);
  }

  const data = (await response.json()) as GitHubRunsListResponse;
  const runs = data.workflow_runs ?? [];

  // Match by name (run-name = task_id) or numeric id
  const match = runs.find(
    (run) => run.name === taskId || String(run.id) === taskId
  );

  return match && match.id != null ? String(match.id) : '';
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<no body>';
  }
}
