/**
 * Micky Assistant — Cerebras provider adapter (Agent A10).
 *
 * Cerebras exposes an OpenAI-compatible `/v1/chat/completions` endpoint
 * backed by its Wafer-Scale Engine (WSE) LPU. Inference is exceptionally
 * fast (2,000+ tok/s on smaller models) so this adapter is the gateway's
 * preferred path when latency matters more than model size.
 *
 * Free tier: 1,000,000 tokens/day + 50 RPM. No credit card.
 *
 * No major wire-level quirks — Cerebras returns the standard
 * `x-ratelimit-*` header family that the base class already parses. The
 * only "quirk" worth noting is throughput: the gateway should NOT rate-
 * limit client-side based on tokens/sec because Cerebras will out-pace
 * naïve throttles and just waste capacity.
 *
 * Env: `CEREBRAS_KEY` (Bearer token). Resolved by the factory below.
 *
 * Created: 2026-11-10 (Agent A10)
 */

import { BaseOpenAICompatibleAdapter } from './_base';
import type { ModelInfo, ProviderId } from './_types';

export const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';

export const CEREBRAS_KEY_ENV = 'CEREBRAS_KEY';

export const CEREBRAS_DEFAULT_MODEL = 'qwen-3.8-27b';

/** Static fallback model list. */
export const CEREBRAS_MODELS: ModelInfo[] = [
  { id: 'qwen-3.8-27b', object: 'model', created: 0, owned_by: 'qwen', label: 'Qwen 3.8 27B (default)', free_tier: true },
  { id: 'gpt-oss-120b', object: 'model', created: 0, owned_by: 'openai', label: 'gpt-oss 120B', free_tier: true },
  { id: 'llama-4-scout-17b-16e-instruct', object: 'model', created: 0, owned_by: 'meta-llama', label: 'Llama 4 Scout 17B (16e)', free_tier: true },
];

export class CerebrasAdapter extends BaseOpenAICompatibleAdapter {
  readonly PROVIDER_ID: ProviderId = 'cerebras';

  constructor(apiKey: string) {
    super({
      apiKey,
      baseUrl: CEREBRAS_BASE_URL,
      defaultModel: CEREBRAS_DEFAULT_MODEL,
      staticModels: CEREBRAS_MODELS,
    });
  }

  // No mutations needed — Cerebras is fully OpenAI-compatible:
  //   • Standard `x-ratelimit-remaining-requests` / `-tokens` / `-reset-*`
  //     headers (base class handles them).
  //   • Standard `data: <json>\n\n` SSE shape (base class handles it).
  //   • Standard OpenAI tool-calling schema (pass-through).
  //
  // The throughput "quirk" (2k+ tok/s on LPU) is interesting but doesn't
  // affect the wire format — it's a router-side optimization concern:
  //   • Don't apply client-side token/sec throttles; they'll just waste WSE
  //     capacity.
  //   • Consider Cerebras as the preferred provider for streaming UX where
  //     first-byte latency dominates (typing indicators, etc.).
  //
  // Standard x-ratelimit-* headers, so no rateLimitHeaderMap() override.
}

/**
 * Factory: build a {@link CerebrasAdapter} from a Worker env binding.
 * Throws if `CEREBRAS_KEY` is missing so misconfiguration fails fast.
 */
export function createCerebrasAdapter(env: Record<string, unknown>): CerebrasAdapter {
  const key = env[CEREBRAS_KEY_ENV];
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(
      `CerebrasAdapter: ${CEREBRAS_KEY_ENV} is not configured. ` +
        `Set it with: wrangler secret put ${CEREBRAS_KEY_ENV}`,
    );
  }
  return new CerebrasAdapter(key);
}
