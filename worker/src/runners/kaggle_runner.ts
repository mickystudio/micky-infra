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

  // Kaggle REST API expects camelCase field names (verified via kagglesdk 2.2.5).
  // `text` is the raw Python source for script-type kernels (NOT base64).
  // `kernelExecutionType: "SAVE_AND_RUN_ALL"` queues an actual GPU session.
  const payload = {
    slug: `dentistmichaelnabil/${kernelSlug}`,
    newTitle: `Micky ${task.type} ${task.id}`,
    text: kernelCode,
    language: 'python',
    kernelType: 'script',
    isPrivate: true,
    enableGpu: true,
    enableTpu: false,
    enableInternet: true,
    datasetDataSources: ['dentistmichaelnabil/micky-assets'],
    kernelDataSources: [],
    competitionDataSources: [],
    modelDataSources: [],
    categoryIds: [],
    kernelExecutionType: 'SAVE_AND_RUN_ALL',
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

  const data = (await response.json()) as KagglePushResponse & { error?: string };

  // Kaggle returns ref like "username/kernel-slug" — use it as the kernel id.
  const kernelId = data.ref ?? data.id ?? kernelSlug;
  if (!kernelId) {
    throw new Error('Kaggle push succeeded but returned no kernel id');
  }
  return kernelId;
}

/**
 * Check the status of a Kaggle kernel.
 * Uses GET /api/v1/kernels/status?userName=...&kernelSlug=... (verified working).
 */
export async function checkKaggleStatus(
  env: Env,
  kernelId: string
): Promise<KaggleStatus> {
  // kernelId looks like "/code/dentistmichaelnabil/micky-montage-abc123"
  // Split into userName + kernelSlug
  const parts = kernelId.split('/').filter(Boolean);
  const userName = parts.length >= 2 ? parts[parts.length - 2] : 'dentistmichaelnabil';
  const kernelSlug = parts[parts.length - 1] || kernelId;

  let response: Response;
  try {
    const url = `${KAGGLE_API_BASE}/kernels/status?userName=${encodeURIComponent(userName)}&kernelSlug=${encodeURIComponent(kernelSlug)}`;
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${env.KAGGLE_API_TOKEN}`,
      },
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

  const data = (await response.json()) as KaggleStatusResponse & { status?: string; failureMessage?: string };
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
 * Uses GET /api/v1/kernels/output?userName=...&kernelSlug=... (verified working).
 */
export async function getKaggleOutput(
  env: Env,
  kernelId: string
): Promise<KaggleOutput> {
  const parts = kernelId.split('/').filter(Boolean);
  const userName = parts.length >= 2 ? parts[parts.length - 2] : 'dentistmichaelnabil';
  const kernelSlug = parts[parts.length - 1] || kernelId;

  let response: Response;
  try {
    const url = `${KAGGLE_API_BASE}/kernels/output?userName=${encodeURIComponent(userName)}&kernelSlug=${encodeURIComponent(kernelSlug)}`;
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${env.KAGGLE_API_TOKEN}`,
      },
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
  // Single-stringify produces a JSON literal that Python parses as a dict
  // (valid as long as inputSpec values are str/num/list/dict — JSON booleans
  // `true`/`false`/`null` would NOT be valid Python; montage specs use only
  // strings, so this is safe for the current pipeline).
  const inputSpecPyLiteral = JSON.stringify(task.inputSpec);
  const taskIdPyLiteral = JSON.stringify(task.id);
  const taskTypePyLiteral = JSON.stringify(task.type);

  // NOTE: This kernel is montage-specific. Kaggle User Secrets (TG_BOT_TOKEN,
  // ADMIN_CHAT_ID, MICKY_WEBHOOK_URL, MICKY_WEBHOOK_SECRET) are injected as
  // env vars before the kernel runs. The kernel fetches the 7 montage modules
  // from the public mickystudio/micky-infra GitHub repo at runtime, imports
  // them, runs the pipeline, sends Telegram progress updates directly via the
  // Bot API, and POSTs the final result back to the worker webhook.
  //
  // Each line below is a single-quoted JS string, so Python f-string `{...}`
  // interpolation is safe (JS only interpolates `${...}`). Python `\n` in
  // f-strings is written as `\\n` here so the literal backslash-n lands in the
  // generated source (otherwise JS would emit a real newline, breaking the
  // string literal in Python).
  return [
    '# Auto-generated Kaggle kernel for Micky task: ' + task.id,
    '# Type: ' + task.type,
    '# Generated: ' + new Date().toISOString(),
    '',
    'import json',
    'import os',
    'import sys',
    'import traceback',
    'import urllib.request',
    'import urllib.error',
    '',
    '# --- Env vars (Kaggle User Secrets auto-injected) ---',
    'MICKY_WEBHOOK_URL = os.environ.get("MICKY_WEBHOOK_URL", "")',
    'MICKY_WEBHOOK_SECRET = os.environ.get("MICKY_WEBHOOK_SECRET", "")',
    'TG_BOT_TOKEN = os.environ.get("TG_BOT_TOKEN", "")',
    'ADMIN_CHAT_ID = os.environ.get("ADMIN_CHAT_ID", "")',
    '',
    'TASK_ID = ' + taskIdPyLiteral,
    'TASK_TYPE = ' + taskTypePyLiteral,
    'INPUT_SPEC = ' + inputSpecPyLiteral,
    '',
    '# --- Modules to fetch from GitHub (mickystudio/micky-infra is public) ---',
    'GITHUB_BASE = "https://raw.githubusercontent.com/mickystudio/micky-infra/main/kaggle-src/montage"',
    'MODULES = [',
    '    "audio_enhancer.py",',
    '    "background_remover.py",',
    '    "caption_generator.py",',
    '    "color_grader.py",',
    '    "multi_export.py",',
    '    "remotion_renderer.py",',
    '    "take_selector.py",',
    '    "pipeline.py",  # last — depends on the others',
    ']',
    '',
    'MODULES_DIR = "/kaggle/working/modules"',
    'os.makedirs(MODULES_DIR, exist_ok=True)',
    '',
    '',
    'def tg_msg(text):',
    '    """Send a Telegram message directly via the Bot API."""',
    '    if not TG_BOT_TOKEN or not ADMIN_CHAT_ID:',
    '        print("[TG]", text)',
    '        return',
    '    try:',
    '        data = json.dumps({',
    '            "chat_id": int(ADMIN_CHAT_ID),',
    '            "text": text,',
    '            "parse_mode": "Markdown",',
    '        }).encode("utf-8")',
    '        req = urllib.request.Request(',
    '            f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendMessage",',
    '            data=data,',
    '            headers={"Content-Type": "application/json"},',
    '            method="POST",',
    '        )',
    '        urllib.request.urlopen(req, timeout=10).read()',
    '    except Exception as exc:',
    '        print(f"[TG failed]: {exc}")',
    '',
    '',
    'def fetch_module(name):',
    '    """Fetch a single Python module from GitHub raw URL into MODULES_DIR."""',
    '    url = f"{GITHUB_BASE}/{name}"',
    '    dest = os.path.join(MODULES_DIR, name)',
    '    print(f"Fetching {url}...")',
    '    req = urllib.request.Request(',
    '        url,',
    '        headers={"User-Agent": "MickyKaggleKernel/1.0"},',
    '    )',
    '    with urllib.request.urlopen(req, timeout=30) as r:',
    '        content = r.read()',
    '    with open(dest, "wb") as f:',
    '        f.write(content)',
    '    print(f"  Saved to {dest} ({len(content)} bytes)")',
    '    return dest',
    '',
    '',
    'def report_back(status, output_url, output_meta):',
    '    """POST the final result back to the worker webhook."""',
    '    if not MICKY_WEBHOOK_URL:',
    '        print("No webhook URL set; skipping report-back")',
    '        return',
    '    payload = json.dumps({',
    '        "task_id": TASK_ID,',
    '        "status": status,',
    '        "output_url": output_url,',
    '        "output_meta": output_meta,',
    '    }).encode("utf-8")',
    '    req = urllib.request.Request(',
    '        MICKY_WEBHOOK_URL,',
    '        data=payload,',
    '        headers={',
    '            "Content-Type": "application/json",',
    '            "X-Webhook-Secret": MICKY_WEBHOOK_SECRET,',
    '        },',
    '        method="POST",',
    '    )',
    '    try:',
    '        with urllib.request.urlopen(req, timeout=30) as resp:',
    '            print(f"Webhook response: {resp.status}")',
    '    except Exception as exc:',
    '        print(f"Webhook failed: {exc}", file=sys.stderr)',
    '',
    '',
    'def download_input_video(url, dest_path):',
    '    """Download the raw input video from a Telegram file URL."""',
    '    print(f"Downloading input from {url[:80]}...")',
    '    req = urllib.request.Request(',
    '        url,',
    '        headers={"User-Agent": "MickyKaggleKernel/1.0"},',
    '    )',
    '    with urllib.request.urlopen(req, timeout=120) as r:',
    '        with open(dest_path, "wb") as f:',
    '            f.write(r.read())',
    '    size = os.path.getsize(dest_path)',
    '    print(f"  Downloaded {size} bytes")',
    '    return dest_path',
    '',
    '',
    'def main():',
    '    print("=== Micky Montage Kernel ===")',
    '    print(f"Task ID: {TASK_ID}")',
    '    print(f"Input spec: {json.dumps(INPUT_SPEC, ensure_ascii=False)}")',
    '    sys.stdout.flush()',
    '',
    '    tg_msg(',
    '        f"🎬 *بدأ معالجة الفيديو*\\n\\n🆔 `{TASK_ID}`\\n⏳ جارٍ تحميل الوحدات..."',
    '    )',
    '',
    '    # Step 1: fetch all modules from GitHub',
    '    failed_module = None',
    '    try:',
    '        for m in MODULES:',
    '            failed_module = m',
    '            fetch_module(m)',
    '    except Exception as exc:',
    '        msg = f"❌ فشل تحميل الوحدة {failed_module}: {exc}"',
    '        tg_msg(msg)',
    '        report_back("failed", "", {"error": msg})',
    '        return',
    '',
    '    sys.path.insert(0, MODULES_DIR)',
    '',
    '    # Step 2: import the pipeline module',
    '    try:',
    '        import pipeline as montage_pipeline  # noqa: E402',
    '    except Exception as exc:',
    '        tb = traceback.format_exc()',
    '        msg = f"❌ فشل استيراد pipeline: {exc}"',
    '        tg_msg(msg)',
    '        report_back("failed", "", {"error": str(exc), "traceback": tb[:1000]})',
    '        return',
    '',
    '    tg_msg("✅ تم تحميل الوحدات. جارٍ تنزيل الفيديو...")',
    '',
    '    # Step 3: download input video from INPUT_SPEC.file_url',
    '    if not isinstance(INPUT_SPEC, dict):',
    '        msg = "❌ INPUT_SPEC ليس قاموساً صالحاً"',
    '        tg_msg(msg)',
    '        report_back("failed", "", {"error": msg})',
    '        return',
    '',
    '    video_url = INPUT_SPEC.get("file_url", "") or ""',
    '    if not video_url:',
    '        msg = "❌ لا يوجد file_url في INPUT_SPEC"',
    '        tg_msg(msg)',
    '        report_back("failed", "", {"error": msg})',
    '        return',
    '',
    '    input_path = "/kaggle/working/input.mp4"',
    '    try:',
    '        download_input_video(video_url, input_path)',
    '    except Exception as exc:',
    '        msg = f"❌ فشل تنزيل الفيديو: {exc}"',
    '        tg_msg(msg)',
    '        report_back("failed", "", {"error": str(exc)})',
    '        return',
    '',
    '    tg_msg("📥 تم تنزيل الفيديو. جارٍ بدء المعالجة...")',
    '',
    '    # Step 4: run the montage pipeline',
    '    INPUT_SPEC["local_video_path"] = input_path',
    '    INPUT_SPEC["output_dir"] = "/kaggle/working/output"',
    '    os.makedirs(INPUT_SPEC["output_dir"], exist_ok=True)',
    '',
    '    try:',
    '        result = montage_pipeline.run_pipeline(INPUT_SPEC)',
    '    except Exception as exc:',
    '        tb = traceback.format_exc()',
    '        msg = f"❌ فشل pipeline: {exc}\\n```\\n{tb[:500]}\\n```"',
    '        tg_msg(msg)',
    '        report_back("failed", "", {"error": str(exc), "traceback": tb[:1000]})',
    '        return',
    '',
    '    if not isinstance(result, dict):',
    '        msg = f"❌ pipeline returned non-dict: {type(result).__name__}"',
    '        tg_msg(msg)',
    '        report_back("failed", "", {"error": msg})',
    '        return',
    '',
    '    output_url = result.get("output_url", "") or ""',
    '    output_meta = result.get("output_meta", {}) or {}',
    '',
    '    tg_msg(',
    '        f"✅ *اكتمل المونتاج بنجاح*\\n\\n📁 الناتج: `{output_url[:60]}...`"',
    '    )',
    '',
    '    # Step 5: report back to worker webhook',
    '    report_back("completed", output_url, output_meta)',
    '    print("=== Kernel Complete ===")',
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
