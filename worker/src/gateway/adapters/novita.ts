/**
 * Micky Assistant — Novita AI provider adapter (Agent A10).
 *
 * Novita exposes an OpenAI-compatible surface under the `/openai` prefix
 * (base URL: `https://api.novita.ai/openai`). It hosts DeepSeek, GLM, Qwen
 * and a long tail of other OSS models on a tiered pricing system.
 *
 * Free tier: signup voucher + tier-based RPM/TPM (starts low, scales with
 * spend). No credit card required for the trial voucher.
 *
 * Quirks handled here:
 *   • The base URL is `https://api.novita.ai/openai` (note: `/openai`
 *     prefix, NOT `/v1`). The OpenAI chat path is `/chat/completions`
 *     appended to that, so the full URL is
 *     `https://api.novita.ai/openai/chat/completions`.
 *   • SOME models live on alternate base URLs (e.g. dedicated fine-tune
 *     endpoints). We expose a `model → baseUrl` override map via the
 *     `resolveBaseUrl(model)` hook; unknown models fall through to the
 *     default base URL.
 *   • Standard `x-ratelimit-*` headers on every response (the base class
 *     already parses these).
 *
 * Env: `NOVITA_KEY` (Bearer token). Resolved by the factory below.
 *
 * Created: 2026-11-10 (Agent A10)
 */

import { BaseOpenAICompatibleAdapter } from './_base';
import type { ModelInfo, ProviderId } from './_types';

export const NOVITA_BASE_URL = 'https://api.novita.ai/openai';

export const NOVITA_KEY_ENV = 'NOVITA_KEY';

export const NOVITA_DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash';

/** Static fallback model list. */
export const NOVITA_MODELS: ModelInfo[] = [
  { id: 'deepseek/deepseek-v4.1-flash', object: 'model', created: 0, owned_by: 'deepseek', label: 'DeepSeek V4.1 Flash (default)', free_tier: true },
  { id: 'glm-5.3-flash', object: 'model', created: 0, owned_by: 'zhipu', label: 'GLM 5.3 Flash', free_tier: true },
  { id: 'qwen3-coder', object: 'model', created: 0, owned_by: 'qwen', label: 'Qwen3 Coder', free_tier: false },
];

/**
 * Per-model base-URL overrides for Novita models that aren't served from the
 * primary `/openai` endpoint. Empty by default — populate as you discover
 * them (each entry should map a model id → its dedicated base URL).
 *
 * Example:
 *   { 'some-finetune': 'https://api.novita.ai/openai-finetune' }
 */
export const NOVITA_MODEL_BASE_OVERRIDES: Readonly<Record<string, string>> = {};

export class NovitaAdapter extends BaseOpenAICompatibleAdapter {
  readonly PROVIDER_ID: ProviderId = 'novita';

  private readonly modelBaseOverrides: Readonly<Record<string, string>>;

  constructor(
    apiKey: string,
    opts: { modelBaseOverrides?: Readonly<Record<string, string>> } = {},
  ) {
    super({
      apiKey,
      baseUrl: NOVITA_BASE_URL,
      defaultModel: NOVITA_DEFAULT_MODEL,
      staticModels: NOVITA_MODELS,
    });
    this.modelBaseOverrides = opts.modelBaseOverrides ?? NOVITA_MODEL_BASE_OVERRIDES;
  }

  /**
   * Per-model base-URL resolution. Falls back to the default `this.baseUrl`
   * for unknown models — most Novita models live under `/openai` so the
   * common case is a no-op.
   */
  protected resolveBaseUrl(model: string): string {
    return this.modelBaseOverrides[model] ?? this.baseUrl;
  }

  // No body mutation needed — Novita accepts OpenAI-shaped requests verbatim.
  // Standard `x-ratelimit-*` headers, so no rateLimitHeaderMap() override.
}

/**
 * Factory: build a {@link NovitaAdapter} from a Worker env binding.
 * Throws if `NOVITA_KEY` is missing so misconfiguration fails fast.
 */
export function createNovitaAdapter(env: Record<string, unknown>): NovitaAdapter {
  const key = env[NOVITA_KEY_ENV];
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(
      `NovitaAdapter: ${NOVITA_KEY_ENV} is not configured. ` +
        `Set it with: wrangler secret put ${NOVITA_KEY_ENV}`,
    );
  }
  return new NovitaAdapter(key);
}
