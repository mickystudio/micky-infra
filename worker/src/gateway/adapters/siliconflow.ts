/**
 * Micky Assistant — SiliconFlow provider adapter (Agent A10).
 *
 * SiliconFlow is an OpenAI-compatible aggregator (think Chinese OpenRouter)
 * hosting DeepSeek, Qwen, Llama, GLM, etc. on its own GPU fleet. Signup
 * comes with ~$2 credit and many models have a $0 price tag (free forever,
 * not just during the trial).
 *
 * Quirks handled here:
 *   • Model IDs include a vendor prefix (`deepseek-ai/DeepSeek-V3`,
 *     `Qwen/Qwen3-Coder-30B-A3B-Instruct`, `meta-llama/Meta-Llama-3.1-…`).
 *     We pass them through verbatim — no client-side rewriting.
 *   • Responses include a per-request USD cost (the `usage.cost` or
 *     top-level `cost` field). We capture it into `provider_meta.cost` so
 *     the router can record spend telemetry without losing the OpenAI
 *     response shape.
 *
 * Env: `SILICONFLOW_KEY` (Bearer token). Resolved by the factory below.
 *
 * Created: 2026-11-10 (Agent A10)
 */

import { BaseOpenAICompatibleAdapter } from './_base';
import type { ChatRequest, ChatResponse, ModelInfo, ProviderId } from './_types';

export const SILICONFLOW_BASE_URL = 'https://api.siliconflow.com/v1';

export const SILICONFLOW_KEY_ENV = 'SILICONFLOW_KEY';

export const SILICONFLOW_DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V3';

/** Static fallback model list — note vendor-prefixed ids. */
export const SILICONFLOW_MODELS: ModelInfo[] = [
  { id: 'deepseek-ai/DeepSeek-V3', object: 'model', created: 0, owned_by: 'deepseek-ai', label: 'DeepSeek V3 (default)', free_tier: true },
  { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', object: 'model', created: 0, owned_by: 'Qwen', label: 'Qwen3 Coder 30B A3B Instruct', free_tier: true },
  { id: 'meta-llama/Meta-Llama-3.1-405B-Instruct', object: 'model', created: 0, owned_by: 'meta-llama', label: 'Llama 3.1 405B Instruct', free_tier: false },
];

/** Raw SiliconFlow response shape — OpenAI-compatible + a `cost` field. */
interface SiliconFlowRawResponse {
  id?: string;
  created?: number;
  model?: string;
  choices?: unknown[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
  /** Some models surface cost at the top level instead of nested in `usage`. */
  cost?: number;
  system_fingerprint?: string;
}

export class SiliconFlowAdapter extends BaseOpenAICompatibleAdapter {
  readonly PROVIDER_ID: ProviderId = 'siliconflow';

  constructor(apiKey: string) {
    super({
      apiKey,
      baseUrl: SILICONFLOW_BASE_URL,
      defaultModel: SILICONFLOW_DEFAULT_MODEL,
      staticModels: SILICONFLOW_MODELS,
    });
  }

  /**
   * No body mutation: SiliconFlow accepts OpenAI-shaped requests verbatim
   * (including vendor-prefixed model ids). Kept as an explicit no-op so the
   * intent is documented, and so future quirks have a place to land.
   */
  protected mutateRequest(req: ChatRequest): unknown {
    return req;
  }

  /**
   * Capture the SiliconFlow-specific `cost` field from the raw response and
   * stash it in `provider_meta.cost` on the normalized {@link ChatResponse}.
   * The base class's `parseResponse` will run after this and pick up the
   * (now cost-stripped) OpenAI fields normally.
   *
   * We mutate via a shallow copy so we never modify the caller's object.
   */
  protected mutateRawResponse(raw: unknown): unknown {
    const r = raw as SiliconFlowRawResponse;
    const cost = typeof r.usage?.cost === 'number'
      ? r.usage.cost
      : typeof r.cost === 'number'
        ? r.cost
        : undefined;
    if (cost === undefined) return raw;
    // Detach the cost from `usage` so the base parser sees a pure OpenAI shape.
    const { usage, ...rest } = r;
    const cleanedUsage = usage === undefined ? undefined : (() => {
      const { cost: _drop, ...restUsage } = usage;
      return restUsage;
    })();
    return {
      ...rest,
      ...(cleanedUsage ? { usage: cleanedUsage } : {}),
      // The base parser ignores unknown top-level fields; we attach cost via
      // provider_meta in parseResponse below by reading it back off `raw`.
      __sf_cost: cost,
    };
  }

  /**
   * Override `parseResponse` to lift the captured `cost` onto the normalized
   * response's `provider_meta`. Falls back to the base implementation when no
   * cost was present.
   */
  parseResponse(raw: unknown, requestedModel: string): ChatResponse {
    const mutated = this.mutateRawResponse(raw) as SiliconFlowRawResponse & { __sf_cost?: number };
    const cost = typeof mutated.__sf_cost === 'number' ? mutated.__sf_cost : undefined;
    // Strip the marker before delegating so the base parser sees a clean shape.
    if (mutated.__sf_cost !== undefined) {
      const { __sf_cost: _drop, ...rest } = mutated;
      const base = super.parseResponse(rest, requestedModel);
      if (cost !== undefined) base.provider_meta = { ...(base.provider_meta ?? {}), cost };
      return base;
    }
    return super.parseResponse(raw, requestedModel);
  }
}

/**
 * Factory: build a {@link SiliconFlowAdapter} from a Worker env binding.
 * Throws if `SILICONFLOW_KEY` is missing so misconfiguration fails fast.
 */
export function createSiliconFlowAdapter(env: Record<string, unknown>): SiliconFlowAdapter {
  const key = env[SILICONFLOW_KEY_ENV];
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(
      `SiliconFlowAdapter: ${SILICONFLOW_KEY_ENV} is not configured. ` +
        `Set it with: wrangler secret put ${SILICONFLOW_KEY_ENV}`,
    );
  }
  return new SiliconFlowAdapter(key);
}
