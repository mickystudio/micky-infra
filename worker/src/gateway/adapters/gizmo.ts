/**
 * Micky Assistant — Gizmo Platform provider adapter (provider #12).
 *
 * Gizmo (https://api.gizmoplatforms.com) is an OpenAI-compatible aggregator
 * hosting 229+ models from Google, OpenAI, Anthropic, xAI, DeepSeek, Qwen,
 * Z.AI and more. A handful of models carry the `:free` suffix and are
 * served at no cost with a valid `gz_live_...` API key.
 *
 * Verified working (2026-11-11, live curl):
 *   • liquid/lfm-3-1.7b:free          → content "مرحبا" @ 400 max_tokens
 *   • nvidia/nemotron-3.5-lightning:free → reasoning + content
 *
 * Quirks handled here:
 *   • **Reasoning-first responses.** Many Gizmo models emit a `reasoning`
 *     field (and `reasoning_details[]`) BEFORE populating `message.content`.
 *     If `max_tokens` is small the model burns the entire budget on
 *     reasoning and returns `content: null` with `finish_reason: "length"`.
 *     Fix: `mutateRequest` boosts `max_tokens` to at least 2048 (reasoning
 *     headroom), and `mutateRawResponse` falls back to the `reasoning` text
 *     when `content` is null/empty so the user never receives a blank reply.
 *   • Chat path is the standard OpenAI `/chat/completions` (the
 *     `/responses` endpoint also exists but is NOT used by this adapter).
 *   • Auth: plain `Authorization: Bearer gz_live_...` (base class default).
 *   • No `x-ratelimit-*` headers observed → rate limits are tracked by the
 *     D1 ledger's internal counting (same strategy as Gemini).
 *
 * Env: `GIZMO_KEY` (Bearer token).
 *
 * Created: 2026-11-11
 */

import { BaseOpenAICompatibleAdapter } from './_base';
import type { ChatRequest, ModelInfo, ProviderId } from './_types';

export const GIZMO_BASE_URL = 'https://api.gizmoplatforms.com/api/v1';

export const GIZMO_KEY_ENV = 'GIZMO_KEY';

export const GIZMO_DEFAULT_MODEL = 'liquid/lfm-3-1.7b:free';

/**
 * Minimum output budget. Gizmo reasoning models routinely spend 300–600
 * tokens on chain-of-thought before emitting visible content, so requests
 * with small/absent `max_tokens` get boosted to this floor.
 */
export const GIZMO_MIN_OUTPUT_TOKENS = 2048;

/** Static model list — the verified-free subset of Gizmo's 229-model catalog. */
export const GIZMO_MODELS: ModelInfo[] = [
  { id: 'liquid/lfm-3-1.7b:free', object: 'model', created: 0, owned_by: 'liquid', label: 'Liquid LFM 3 1.7B (free, verified)', free_tier: true },
  { id: 'nvidia/nemotron-3.5-lightning:free', object: 'model', created: 0, owned_by: 'nvidia', label: 'Nemotron 3.5 Lightning (free, verified)', free_tier: true },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', object: 'model', created: 0, owned_by: 'nvidia', label: 'Nemotron 3 Ultra 550B (free)', free_tier: true },
  { id: 'recursive/flint-v1.0:free', object: 'model', created: 0, owned_by: 'recursive', label: 'Flint 1.0 (free)', free_tier: true },
  { id: 'thinkingmachines/inkling-2-small:free', object: 'model', created: 0, owned_by: 'thinkingmachines', label: 'Inkling 2 Small (free)', free_tier: true },
];

interface GizmoChoiceMessage {
  role?: string;
  content?: string | null;
  reasoning?: string | null;
  reasoning_details?: unknown[];
  tool_calls?: unknown[];
}

interface GizmoRawResponse {
  id?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index?: number;
    message?: GizmoChoiceMessage;
    finish_reason?: string | null;
  }>;
  usage?: Record<string, number>;
}

export class GizmoAdapter extends BaseOpenAICompatibleAdapter {
  readonly PROVIDER_ID: ProviderId = 'gizmo';

  constructor(apiKey: string) {
    super({
      apiKey,
      baseUrl: GIZMO_BASE_URL,
      defaultModel: GIZMO_DEFAULT_MODEL,
      staticModels: GIZMO_MODELS,
    });
  }

  /**
   * Boost `max_tokens` to the reasoning floor. Gizmo models think before
   * they speak; without headroom the visible content comes back null with
   * `finish_reason: "length"`.
   */
  protected mutateRequest(req: ChatRequest): unknown {
    const boosted: ChatRequest = { ...req };
    if (typeof boosted.max_tokens !== 'number' || boosted.max_tokens < GIZMO_MIN_OUTPUT_TOKENS) {
      boosted.max_tokens = GIZMO_MIN_OUTPUT_TOKENS;
    }
    return boosted;
  }

  /**
   * Reasoning fallback: when `message.content` is null/empty but a
   * `reasoning` string exists, promote the reasoning text to `content` so
   * downstream OpenAI-shape consumers never see an empty assistant reply.
   */
  protected mutateRawResponse(raw: unknown): unknown {
    if (typeof raw !== 'object' || raw === null) return raw;
    const r = raw as GizmoRawResponse;
    if (!Array.isArray(r.choices)) return raw;
    for (const ch of r.choices) {
      const msg = ch?.message;
      if (!msg) continue;
      const contentEmpty = msg.content === null || msg.content === undefined || msg.content === '';
      if (contentEmpty && typeof msg.reasoning === 'string' && msg.reasoning.length > 0) {
        msg.content = msg.reasoning;
      }
    }
    return r;
  }

  // Standard `/chat/completions` path + Bearer auth — base class defaults.
  // No x-ratelimit headers observed; ledger counts internally.
}

/**
 * Factory: build a {@link GizmoAdapter} from a Worker env binding.
 * Throws if `GIZMO_KEY` is missing so misconfiguration fails fast.
 */
export function createGizmoAdapter(env: Record<string, unknown>): GizmoAdapter {
  const key = env[GIZMO_KEY_ENV];
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(
      `GizmoAdapter: ${GIZMO_KEY_ENV} is not configured. ` +
        `Set it with: wrangler secret put ${GIZMO_KEY_ENV}`,
    );
  }
  return new GizmoAdapter(key);
}
