/**
 * Kaggle Runner
 * Micky Assistant Unlimited
 *
 * Pushes kernels to Kaggle for GPU execution (montage, graphics).
 * Status and output are fetched via the Kaggle public API.
 *
 * Used for: montage (RVM + Remotion/FFmpeg) and graphics (SDXL).
 * Constraint: 30h GPU/week budget — auto-stop on completion/cancel.
 */

import type { Env } from '../index';
import type { Task } from '../core/state_machine';

// ============ Constants ============

const KAGGLE_API_BASE = 'https://www.kaggle.com/api/v1';
const KERNEL_SLUG_PREFIX = 'micky';

// ============ Types ============

export type KaggleStatus = 'running' | 'complete' | 'cancelled' | 'error';

export interface KaggleFile {
  filename: string;
  url: string;
}

export interface KaggleOutput {
  files: KaggleFile[];
  logs: string;
}

interface KagglePushResponse {
  ref?: string;
  id?: string;
  url?: string;
}

interface KaggleStatusResponse {
  status?: string;
}

interface KaggleOutputResponse {
  files?: KaggleFile[];
  log?: string;
}

// ============ Public Functions ============

/**
 * Push a kernel to Kaggle and start execution.
 *
 * POST https://www.kaggle.com/api/v1/kernels/push
 * Auth: Bearer KAGGLE_API_TOKEN
 *
 * Returns: kernel id (Kaggle ref like "username/kernel-slug", or slug).
 */
export async function dispatchToKaggle(env: Env, task: Task): Promise<string> {
  const kernelSlug = buildKernelSlug(task);
  const kernelCode = buildKernelCode(task);

  const payload = {
    text: kernelCode,
    kernel_type: 'script',
    title: kernelSlug,
    language: 'python',
    is_private: 'true',
    enable_gpu: 'true',
    enable_internet: 'true',
    dataset_sources: [] as string[],
    competition_sources: [] as string[],
    kernel_sources: [] as string[],
  };

  let response: Response;
  try {
    response = await fetch(`${KAGGLE_API_BASE}/kernels/push`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.KAGGLE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new Error(`Kaggle push network error: ${String(err)}`);
  }

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new Error(
      `Kaggle push failed (${response.status} ${response.statusText}): ${text}`
    );
  }

  const data = (await response.json()) as KagglePushResponse;

  // Kaggle returns ref like "username/kernel-slug" — use it as the kernel id.
  const kernelId = data.ref ?? data.id ?? kernelSlug;
  if (!kernelId) {
    throw new Error('Kaggle push succeeded but returned no kernel id');
  }
  return kernelId;
}

/**
 * Check the status of a Kaggle kernel.
 */
export async function checkKaggleStatus(
  env: Env,
  kernelId: string
): Promise<KaggleStatus> {
  let response: Response;
  try {
    response = await fetch(`${KAGGLE_API_BASE}/kernels/status`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.KAGGLE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ kernelId }),
    });
  } catch (err) {
    throw new Error(`Kaggle status network error: ${String(err)}`);
  }

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new Error(
      `Kaggle status check failed (${response.status} ${response.statusText}): ${text}`
    );
  }

  const data = (await response.json()) as KaggleStatusResponse;
  const status = (data.status ?? '').toLowerCase();

  if (status === 'running' || status === 'queue' || status === 'queued') {
    return 'running';
  }
  if (status === 'complete') return 'complete';
  if (status === 'cancelled' || status === 'cancel_acknowledged') return 'cancelled';
  if (status === 'error') return 'error';

  throw new Error(`Unknown Kaggle status: '${data.status}'`);
}

/**
 * Get the output files and logs of a completed Kaggle kernel.
 */
export async function getKaggleOutput(
  env: Env,
  kernelId: string
): Promise<KaggleOutput> {
  let response: Response;
  try {
    response = await fetch(`${KAGGLE_API_BASE}/kernels/output`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.KAGGLE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ kernelId }),
    });
  } catch (err) {
    throw new Error(`Kaggle output network error: ${String(err)}`);
  }

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new Error(
      `Kaggle output fetch failed (${response.status} ${response.statusText}): ${text}`
    );
  }

  const data = (await response.json()) as KaggleOutputResponse;

  return {
    files: Array.isArray(data.files) ? data.files : [],
    logs: typeof data.log === 'string' ? data.log : '',
  };
}

/**
 * Stop a running Kaggle kernel.
 * Returns true on success (or if the kernel was already stopped, 404).
 */
export async function stopKaggleKernel(env: Env, kernelId: string): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(`${KAGGLE_API_BASE}/kernels/stop`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.KAGGLE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ kernelId }),
    });
  } catch (err) {
    throw new Error(`Kaggle stop network error: ${String(err)}`);
  }

  // 200 OK = stopped
  // 404 Not Found = already terminated/never existed — treat as success
  if (response.ok || response.status === 404) {
    return true;
  }

  const text = await safeReadText(response);
  throw new Error(
    `Kaggle stop failed (${response.status} ${response.statusText}): ${text}`
  );
}

// ============ Internal Helpers ============

/**
 * Build a Kaggle kernel slug from the task id.
 * Kaggle requires lowercase, ASCII, hyphenated, ≤50 chars.
 */
function buildKernelSlug(task: Task): string {
  const suffix = task.id.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 32);
  return `${KERNEL_SLUG_PREFIX}-${task.type}-${suffix}`;
}

/**
 * Generate the Python kernel source for this task.
 *
 * The kernel:
 *   1. Loads its INPUT_SPEC constant (embedded JSON)
 *   2. Prints diagnostic logs
 *   3. Dispatches to the appropriate processor (montage/graphics)
 *   4. POSTs results back to the Worker webhook
 *
 * NOTE: We use string concatenation (not f-strings) in the Python source to
 * keep the JS template literal simple — only ${...} is interpolated by JS.
 */
function buildKernelCode(task: Task): string {
  // Double-stringify: produces a JSON-encoded string literal that Python
  // can parse as a str containing JSON.
  const inputSpecPyLiteral = JSON.stringify(JSON.stringify(task.inputSpec));
  const taskIdPyLiteral = JSON.stringify(task.id);
  const taskTypePyLiteral = JSON.stringify(task.type);

  return [
    '# Auto-generated Kaggle kernel for Micky task: ' + task.id,
    '# Type: ' + task.type,
    '# Generated: ' + new Date().toISOString(),
    '',
    'import json',
    'import os',
    'import sys',
    'import urllib.request',
    '',
    'TASK_ID = ' + taskIdPyLiteral,
    'TASK_TYPE = ' + taskTypePyLiteral,
    'INPUT_SPEC = ' + inputSpecPyLiteral,
    'WEBHOOK_URL = os.environ.get("MICKY_WEBHOOK_URL", "")',
    'WEBHOOK_SECRET = os.environ.get("MICKY_WEBHOOK_SECRET", "")',
    '',
    '',
    'def main():',
    '    spec = json.loads(INPUT_SPEC) if INPUT_SPEC else {}',
    '    print("Starting task " + TASK_ID + " (" + TASK_TYPE + ")")',
    '    print("Input spec: " + json.dumps(spec))',
    '    sys.stdout.flush()',
    '',
    '    output_url = ""',
    '    output_meta = {}',
    '    status = "completed"',
    '',
    '    try:',
    '        if TASK_TYPE == "montage":',
    '            output_url, output_meta = run_montage(spec)',
    '        elif TASK_TYPE == "graphics":',
    '            output_url, output_meta = run_graphics(spec)',
    '        else:',
    '            raise RuntimeError("Unknown task type: " + TASK_TYPE)',
    '    except Exception as exc:',
    '        status = "failed"',
    '        output_meta = {"error": str(exc)}',
    '        print("Task failed: " + str(exc), file=sys.stderr)',
    '',
    '    report_back(status, output_url, output_meta)',
    '',
    '',
    'def run_montage(spec):',
    '    # TODO: implement montage pipeline (RVM + Remotion/FFmpeg)',
    '    print("Montage pipeline not yet implemented")',
    '    return "", {}',
    '',
    '',
    'def run_graphics(spec):',
    '    # TODO: implement graphics pipeline (SDXL)',
    '    print("Graphics pipeline not yet implemented")',
    '    return "", {}',
    '',
    '',
    'def report_back(status, output_url, output_meta):',
    '    if not WEBHOOK_URL:',
    '        print("No webhook URL set; skipping report-back")',
    '        return',
    '    payload = json.dumps({',
    '        "task_id": TASK_ID,',
    '        "status": status,',
    '        "output_url": output_url,',
    '        "output_meta": output_meta,',
    '    }).encode("utf-8")',
    '    req = urllib.request.Request(',
    '        WEBHOOK_URL,',
    '        data=payload,',
    '        headers={',
    '            "Content-Type": "application/json",',
    '            "X-Webhook-Secret": WEBHOOK_SECRET,',
    '        },',
    '        method="POST",',
    '    )',
    '    try:',
    '        with urllib.request.urlopen(req, timeout=30) as resp:',
    '            print("Webhook response: " + str(resp.status))',
    '    except Exception as exc:',
    '        print("Webhook failed: " + str(exc), file=sys.stderr)',
    '',
    '',
    'if __name__ == "__main__":',
    '    main()',
    '',
  ].join('\n');
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<no body>';
  }
}
