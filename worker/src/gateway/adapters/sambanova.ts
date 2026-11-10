/**
 * Micky Assistant — SambaNova provider adapter (Agent A10).
 *
 * SambaNova exposes an OpenAI-compatible `/v1/chat/completions` endpoint with
 * DeepSeek-V3.1, Llama-3.3-70B and gpt-oss-120b on its RDU hardware. Free
 * tier: 20 RPM, 20 RPD, 200K TPD — no credit card.
 *
 * Quirks handled here:
 *   • Rate limits are PER-MODEL, not per-account — a 429 on DeepSeek-V3.1
 *     does NOT mean Llama-3.3-70B is also throttled. The router should keep
 *     this in mind when keying circuit-breaker state.
 *   • 429s arrive WITHOUT a `Retry-After` header. We synthesize a 3 s
 *     default backoff (= 60 s / 20 RPM free-tier minimum spacing) so the
 *     router has a number to work with.
 *
 * Env: `SAMBANOVA_KEY` (Bearer token). Resolved by the factory below.
 *
 * Created: 2026-11-10 (Agent A10)
 */

import { BaseOpenAICompatibleAdapter } from './_base';
import type { ModelInfo, ProviderId, RateLimitInfo } from './_types';

export const SAMBANOVA_BASE_URL = 'https://api.sambanova.ai/v1';

/** Env var name that holds the SambaNova Bearer token. */
export const SAMBANOVA_KEY_ENV = 'SAMBANOVA_KEY';

export const SAMBANOVA_DEFAULT_MODEL = 'DeepSeek-V3.1';

/** Static fallback model list (used when `/models` 5xx's). */
export const SAMBANOVA_MODELS: ModelInfo[] = [
  { id: 'DeepSeek-V3.1', object: 'model', created: 0, owned_by: 'sambanova', label: 'DeepSeek V3.1 (default)', free_tier: true },
  { id: 'Meta-Llama-3.3-70B-Instruct', object: 'model', created: 0, owned_by: 'meta-llama', label: 'Llama 3.3 70B Instruct', free_tier: true },
  { id: 'gpt-oss-120b', object: 'model', created: 0, owned_by: 'openai', label: 'gpt-oss 120B', free_tier: true },
];

/** Free-tier minimum spacing (60 s / 20 RPM = 3 s between requests). */
const FREE_TIER_MIN_SPACING_SECONDS = 3;

export class SambaNovaAdapter extends BaseOpenAICompatibleAdapter {
  readonly PROVIDER_ID: ProviderId = 'sambanova';

  constructor(apiKey: string) {
    super({
      apiKey,
      baseUrl: SAMBANOVA_BASE_URL,
      defaultModel: SAMBANOVA_DEFAULT_MODEL,
      staticModels: SAMBANOVA_MODELS,
    });
  }

  /**
   * SambaNova quirk: 429s arrive with NO `Retry-After` header and rate limits
   * are PER-MODEL. When the upstream gives us nothing, synthesize a 3 s default
   * (= 20 RPM free-tier minimum spacing) so the router can still schedule a
   * retry. We do NOT clear an existing `retryAfterSeconds` if one is present.
   *
   * NOTE: the returned RateLimitInfo describes the per-model bucket that
   * triggered this response — the router must key circuit-breaker state on
   * `(provider, model)`, NOT `(provider,)` alone.
   */
  extractRateLimitInfo(headers: Headers): RateLimitInfo {
    const info = super.extractRateLimitInfo(headers);
    if (
      info.retryAfterSeconds === undefined
      && info.resetAfterSeconds === undefined
      && info.resetAt === undefined
    ) {
      info.retryAfterSeconds = FREE_TIER_MIN_SPACING_SECONDS;
    }
    return info;
  }
}

/**
 * Factory: build a {@link SambaNovaAdapter} from a Worker env binding.
 *
 * Throws a clear error if `SAMBANOVA_KEY` is missing — placeholders are fine
 * for development (any non-empty string passes the gate); the user will swap
 * in a real key via `wrangler secret put SAMBANOVA_KEY`.
 */
export function createSambaNovaAdapter(env: Record<string, unknown>): SambaNovaAdapter {
  const key = env[SAMBANOVA_KEY_ENV];
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(
      `SambaNovaAdapter: ${SAMBANOVA_KEY_ENV} is not configured. ` +
        `Set it with: wrangler secret put ${SAMBANOVA_KEY_ENV}`,
    );
  }
  return new SambaNovaAdapter(key);
}
