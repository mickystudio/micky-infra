/**
 * Micky Assistant — Cohere provider adapter (Agent A10).
 *
 * Cohere exposes an OpenAI-compatible surface at `/compatibility/v1`
 * (note: NOT `/v1` — the native Cohere v2 API is at `/v1` and uses a
 * different request/response schema). The compatibility endpoint
 * normalizes the OpenAI tool-calling schema into Cohere's native v2 form
 * server-side, so we don't need a client-side tool shim.
 *
 * Free tier: 1,000 calls/month + 20 RPM. **Monthly quota, not daily** — the
 * router's quota tracking should reset counters on the 1st of each month
 * (UTC) rather than at midnight.
 *
 * Env: `COHERE_KEY` (Bearer token). Resolved by the factory below.
 *
 * Created: 2026-11-10 (Agent A10)
 */

import { BaseOpenAICompatibleAdapter } from './_base';
import type { ModelInfo, ProviderId } from './_types';

/**
 * Cohere's OpenAI-compatibility base URL. Note the `/compatibility/v1`
 * suffix (NOT `/v1`) — `/v1` is the native Cohere v2 API and would reject
 * OpenAI-shaped requests.
 */
export const COHERE_BASE_URL = 'https://api.cohere.ai/compatibility/v1';

export const COHERE_KEY_ENV = 'COHERE_KEY';

export const COHERE_DEFAULT_MODEL = 'command-a-plus-05-2026';

/** Static fallback model list. */
export const COHERE_MODELS: ModelInfo[] = [
  { id: 'command-a-plus-05-2026', object: 'model', created: 0, owned_by: 'cohere', label: 'Command A+ 05-2026 (default)', free_tier: true },
  { id: 'command-r-plus', object: 'model', created: 0, owned_by: 'cohere', label: 'Command R+', free_tier: true },
  { id: 'aya', object: 'model', created: 0, owned_by: 'cohere', label: 'Aya (Arabic-tuned)', free_tier: true },
];

export class CohereAdapter extends BaseOpenAICompatibleAdapter {
  readonly PROVIDER_ID: ProviderId = 'cohere';

  constructor(apiKey: string) {
    super({
      apiKey,
      baseUrl: COHERE_BASE_URL,
      defaultModel: COHERE_DEFAULT_MODEL,
      staticModels: COHERE_MODELS,
    });
  }

  // No request mutation needed — Cohere's /compatibility endpoint normalizes
  // OpenAI tool-calling schema into native v2 server-side. The only quirk
  // (monthly vs daily quota) is a router-side concern, not an adapter one.
  //
  // Cohere returns the standard `x-ratelimit-*` header family that the base
  // class already parses, so no rateLimitHeaderMap() override is required.
}

/**
 * Factory: build a {@link CohereAdapter} from a Worker env binding.
 *
 * Throws if `COHERE_KEY` is missing so misconfiguration fails fast.
 */
export function createCohereAdapter(env: Record<string, unknown>): CohereAdapter {
  const key = env[COHERE_KEY_ENV];
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(
      `CohereAdapter: ${COHERE_KEY_ENV} is not configured. ` +
        `Set it with: wrangler secret put ${COHERE_KEY_ENV}`,
    );
  }
  return new CohereAdapter(key);
}
