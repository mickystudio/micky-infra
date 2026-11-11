/**
 * HF Spaces Client (B9)
 * Micky Assistant Unlimited
 *
 * Cloudflare Worker-side client for Hugging Face Spaces running on
 * ZeroGPU hardware (RTX Pro 6000, up to 96 GB VRAM, queue-based, free).
 *
 * Used by `kaggle_runner.ts` as an alternative compute target for:
 *   - VLM inference (Qwen2.5-VL-72B, too big for Kaggle T4)
 *   - Video generation (Qwen-Video, Wan2.1)
 *
 * All HTTP calls use the global `fetch` (edge-compatible). Polling
 * cadence: 5 s — HF rate-limit friendly. The HF Space is expected
 * to expose the same JSON API documented in
 * `kaggle-src/montage/hf_spaces_runner.py`.
 *
 * Graceful degradation: every public method throws
 * `HFSpacesUnavailable` on network/HTTP errors. Callers must catch
 * and fall back to Kaggle.
 *
 * Created: 2026-12-01  |  Task B9  |  Phase P5-T1
 */

// ============ Constants ============

const POLL_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min — ZeroGPU queue can be slow
const HTTP_TIMEOUT_MS = 30_000;
const HF_SPACE_DEFAULT = 'micky151246/micky-llm';

// ============ Types ============

export interface HFSpacesConfig {
  /** HF Space id, e.g. "micky151246/micky-llm". Defaults to env or const. */
  spaceId?: string;
  /** HF access token. Falls back to env.HF_TOKEN. */
  hfToken?: string;
}

export type HFJobStatus =
  | 'queued'
  | 'running'
  | 'complete'
  | 'failed'
  | 'unknown';

export interface HFJobState {
  status: HFJobStatus;
  /** 0.0–1.0 — progress fraction reported by the Space. */
  progress: number;
  /** Final result URL (set when status === 'complete'). */
  resultUrl: string | null;
  /** Error message (set when status === 'failed'). */
  error: string | null;
}

export interface HFVLMResult {
  scores: number[];
  reasoning: string;
}

/** Env subset required by HF Spaces client. */
export interface HFSpacesEnv {
  HF_TOKEN?: string;
  HF_SPACE_ID?: string;
}

// ============ Error ============

export class HFSpacesUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HFSpacesUnavailable';
  }
}

// ============ HFSpacesClient ============

export class HFSpacesClient {
  private readonly spaceId: string;
  private readonly hfToken: string;
  private readonly baseUrl: string;

  constructor(env: HFSpacesEnv, config: HFSpacesConfig = {}) {
    this.spaceId = (
      config.spaceId ||
      env.HF_SPACE_ID ||
      HF_SPACE_DEFAULT
    )
      .trim()
      .replace(/^\/+|\/+$/g, '');
    this.hfToken = (config.hfToken || env.HF_TOKEN || '').trim();
    if (!this.hfToken) {
      throw new HFSpacesUnavailable(
        'HF_TOKEN not set. Create a token at ' +
          'https://huggingface.co/settings/tokens and run ' +
          '`wrangler secret put HF_TOKEN`.'
      );
    }
    const slug = this.spaceId.replace('/', '-');
    this.baseUrl = `https://${slug}.hf.space`;
  }

  // --- Public API ------------------------------------------------------

  /**
   * POST a job to ``/{endpoint}`` and return the new job_id.
   * Used internally by `runVLM` / `runVideoGeneration`.
   */
  async submitJob(
    env: HFSpacesEnv,
    endpoint: string,
    payload: Record<string, unknown>
  ): Promise<string> {
    // Re-validate token in case the env mutated (Workers are stateless).
    if (!this.hfToken) {
      throw new HFSpacesUnavailable('HF_TOKEN missing on submitJob');
    }
    const url = `${this.baseUrl}/${endpoint.replace(/^\/+/, '')}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.hfToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'MickyHFSpacesClient/1.0',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      throw new HFSpacesUnavailable(
        `HF Space POST ${endpoint} network error: ${String(err)}`
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const text = await safeReadText(response);
      if (response.status >= 500) {
        throw new HFSpacesUnavailable(
          `HF Space ${this.spaceId} temporarily unavailable ` +
            `(${response.status}): ${text.slice(0, 200)}`
        );
      }
      throw new HFSpacesUnavailable(
        `HF Space POST ${endpoint} failed (${response.status}): ` +
          `${text.slice(0, 200)}`
      );
    }
    const data = (await response.json()) as { job_id?: string; id?: string };
    const jobId = data.job_id || data.id;
    if (!jobId) {
      throw new HFSpacesUnavailable(
        `HF Space ${endpoint} returned no job_id: ${JSON.stringify(data)}`
      );
    }
    return jobId;
  }

  /**
   * GET /status/<job_id> → terminal-or-intermediate status.
   */
  async getJobStatus(env: HFSpacesEnv, jobId: string): Promise<HFJobState> {
    const url = `${this.baseUrl}/status/${encodeURIComponent(jobId)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.hfToken}`,
          'User-Agent': 'MickyHFSpacesClient/1.0',
        },
        signal: controller.signal,
      });
    } catch (err) {
      throw new HFSpacesUnavailable(
        `HF Space GET status/${jobId} network error: ${String(err)}`
      );
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 404) {
      return {
        status: 'failed',
        progress: 0,
        resultUrl: null,
        error: 'job not found',
      };
    }
    if (!response.ok) {
      const text = await safeReadText(response);
      throw new HFSpacesUnavailable(
        `HF Space GET status/${jobId} failed (${response.status}): ` +
          `${text.slice(0, 200)}`
      );
    }
    const data = (await response.json()) as {
      status?: string;
      progress?: number | string;
      result_url?: string | null;
      error?: string | null;
    };
    const progress =
      typeof data.progress === 'string'
        ? Number.parseFloat(data.progress) || 0
        : Number(data.progress ?? 0);
    return {
      status: String(data.status ?? 'unknown').toLowerCase() as HFJobStatus,
      progress: Math.max(0, Math.min(1, progress)),
      resultUrl: data.result_url ?? null,
      error: data.error ?? null,
    };
  }

  /**
   * Poll status every 5 s until ``complete`` or ``failed``.
   * Throws HFSpacesUnavailable on timeout / failure — caller falls back.
   */
  async waitForResult<T = unknown>(
    env: HFSpacesEnv,
    jobId: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS
  ): Promise<T> {
    const deadline = Date.now() + Math.max(timeoutMs, 30_000);
    let lastLog = 0;
    while (Date.now() < deadline) {
      let state: HFJobState;
      try {
        state = await this.getJobStatus(env, jobId);
      } catch (err) {
        // Transient network glitch — keep polling.
        if (err instanceof HFSpacesUnavailable) {
          state = { status: 'queued', progress: 0, resultUrl: null, error: null };
        } else {
          throw err;
        }
      }
      if (state.status === 'complete') {
        if (!state.resultUrl) {
          // Some Spaces embed the answer inline in the status payload.
          // Caller is responsible for decoding; return the raw state.
          return { ...state, jobId } as unknown as T;
        }
        // Fetch the JSON result file.
        const resultResp = await fetch(state.resultUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        if (!resultResp.ok) {
          throw new HFSpacesUnavailable(
            `HF Spaces result fetch failed (${resultResp.status})`
          );
        }
        return (await resultResp.json()) as T;
      }
      if (state.status === 'failed') {
        throw new HFSpacesUnavailable(
          `HF Spaces job ${jobId} failed: ${state.error ?? 'unknown'}`
        );
      }
      if (Date.now() - lastLog > 30_000) {
        console.log(
          `[hf_spaces] job ${jobId}: ${state.status} ` +
            `(${Math.round(state.progress * 100)}%)`
        );
        lastLog = Date.now();
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new HFSpacesUnavailable(
      `HF Spaces job ${jobId} timed out after ${timeoutMs}ms`
    );
  }

  // --- High-level helpers ----------------------------------------------

  /**
   * Run VLM inference on a list of base64 images.
   * Returns ``{scores: number[], reasoning: string}``.
   */
  async runVLM(
    env: HFSpacesEnv,
    imagesBase64: string[],
    prompt: string
  ): Promise<HFVLMResult> {
    if (!imagesBase64.length) {
      throw new HFSpacesUnavailable('No images supplied to runVLM');
    }
    const jobId = await this.submitJob(env, 'vlm', {
      images: imagesBase64,
      prompt,
    });
    return this.waitForResult<HFVLMResult>(env, jobId);
  }

  /**
   * Submit a video-generation job. Returns the remote result URL
   * (Worker does NOT download the binary — caller can stream it back
   * to the user via the Telegram bot separately).
   */
  async runVideoGeneration(
    env: HFSpacesEnv,
    prompt: string,
    durationSec = 5.0
  ): Promise<string> {
    const jobId = await this.submitJob(env, 'generate_video', {
      prompt,
      duration: durationSec,
    });
    const state = await this.waitForResult<HFJobState>(env, jobId);
    if (!state.resultUrl) {
      throw new HFSpacesUnavailable(
        `HF Spaces video job ${jobId} returned no result_url`
      );
    }
    return state.resultUrl;
  }
}

// ============ Internal helpers ============

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<no body>';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
