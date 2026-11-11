/**
 * Micky Assistant — OpenRouter Provider Adapter (Agent A6-retry).
 *
 * OpenRouter is an OpenAI-compatible aggregator: a single Bearer token
 * routes to ~200 models from Anthropic, Google, Meta, Mistral, Qwen, etc.
 * Free-tier models are suffixed `:free` and share a 50 req/day budget
 * across the entire account (no credit card required).
 *
 * This adapter extends the shared {@link BaseOpenAICompatibleAdapter}
 * (Agent A10) so it inherits the standard fetch-retry-stream-parse
 * lifecycle. Only the OpenRouter-specific quirks are overridden:
 *
 *   • `mutateRequest` — auto-append `:free` to known free models.
 *   • `getHeaders`    — emit `HTTP-Referer` + `X-Title` for dashboard
 *                        attribution (in addition to Bearer auth).
 *   • `mutateRawResponse` + `parseResponse` — capture `usage.cost` (USD)
 *     into `provider_meta.cost` so the gateway can record spend telemetry
 *     without losing the OpenAI response shape.
 *
 * Env: `OPENROUTER_KEY` (Bearer token). Resolved by the factory below.
 *
 * Edge-only: fetch, Headers, ReadableStream, TextDecoder, AbortController,
 * setTimeout, Date. Created: 2026-11-10 (Agent A6-retry)
 */

import { BaseOpenAICompatibleAdapter } from './_base';
import type {
  ChatRequest, ChatResponse, ChatUsage, ModelInfo, ProviderId, RateLimitInfo,
} from './_types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Env var name that holds the OpenRouter Bearer token. */
export const OPENROUTER_KEY_ENV = 'OPENROUTER_KEY';

export const OPENROUTER_DEFAULT_MODEL = 'meta-llama/llama-3.1-8b-instruct:free';

/** Default `HTTP-Referer` header value (dashboard attribution). */
export const OPENROUTER_DEFAULT_REFERER = 'https://micky-assistant.workers.dev';

/** Default `X-Title` header value (dashboard attribution + leaderboard). */
export const OPENROUTER_DEFAULT_TITLE = 'Micky Assistant';

/** Free-tier daily request cap (shared across the entire OpenRouter account). */
export const OPENROUTER_FREE_TIER_RPD = 50;

/**
 * Curated set of bare model ids that ship a `:free` variant on OpenRouter.
 * When the caller asks for one of these (without an explicit `:free` suffix),
 * `mutateRequest` appends `:free` so the request routes to the free endpoint.
 *
 * Verified free at time of writing — re-check quarterly.
 */
export const OPENROUTER_FREE_MODELS: readonly string[] = [
  'meta-llama/llama-3.1-8b-instruct',
  'meta-llama/llama-3.1-70b-instruct',
  'meta-llama/llama-3.3-70b-instruct',
  'google/gemini-flash-1.5',
  'google/gemini-flash-1.5-8b',
  'qwen/qwen-2-7b-instruct',
  'qwen/qwen-2.5-7b-instruct',
  'qwen/qwen-2.5-coder-7b-instruct',
  'mistralai/mistral-7b-instruct',
  'mistralai/mistral-nemo',
  'mistralai/mistral-7b-instruct-v0.3',
  'microsoft/phi-3-medium-128k-instruct',
  'microsoft/phi-3-mini-128k-instruct',
  'microsoft/phi-3.5-mini-128k-instruct',
  'huggingfaceh4/zephyr-7b-beta',
  'openchat/openchat-7b',
  'gryphe/tomy-8b',
  'nousresearch/hermes-2-theta-llama-3-8b',
  'teknium/openhermes-2.5-mistral-7b',
  'cognitivecomputations/dolphin-mistral-7b',
  'undichat/undichat-7b',
  'sao10k/l3-euryale-70b',
  'sophosympatheia/rogue-rose-103b-v0.2',
  'alpindale/goliath-120b',
];

const FREE_MODELS_SET: ReadonlySet<string> = new Set(OPENROUTER_FREE_MODELS);

/** Static fallback model list (used when `/models` 5xx's). */
export const OPENROUTER_STATIC_MODELS: ModelInfo[] = OPENROUTER_FREE_MODELS.slice(0, 6).map((id) => ({
  id: `${id}:free`,
  object: 'model',
  created: 0,
  owned_by: 'openrouter',
  label: `${id} (free)`,
  free_tier: true,
}));

// ---------------------------------------------------------------------------
// Raw response shape (OpenAI-compatible + OpenRouter cost extras)
// ---------------------------------------------------------------------------

interface OpenRouterRawResponse {
  id?: string;
  model?: string;
  created?: number;
  system_fingerprint?: string;
  choices?: unknown[];
  usage?: Partial<ChatUsage> & { cost?: number };
  /** Some OpenRouter payloads surface the USD cost at the top level. */
  cost?: number;
  /** Internal marker — populated by `mutateRawResponse` and consumed by
   *  `parseResponse` to lift the cost onto `provider_meta`. */
  __or_cost?: number;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface OpenRouterAdapterOptions {
  /** Override `HTTP-Referer` (default: {@link OPENROUTER_DEFAULT_REFERER}). */
  referer?: string;
  /** Override `X-Title` (default: {@link OPENROUTER_DEFAULT_TITLE}). */
  title?: string;
  /** Override the set of model ids auto-suffixed with `:free`. */
  freeModels?: ReadonlySet<string>;
}

export class OpenRouterAdapter extends BaseOpenAICompatibleAdapter {
  readonly PROVIDER_ID: ProviderId = 'openrouter';

  private readonly referer: string;
  private readonly title: string;
  private readonly freeModels: ReadonlySet<string>;

  /**
   * @param apiKey  Bearer token. Required for real I/O; an empty string is
   *                accepted so a singleton (used for shape-only access)
   *                can be constructed at module load. Use the
   *                {@link createOpenRouterAdapter} factory for production.
   * @param opts    Per-deployment overrides (referer, title, freeModels).
   */
  constructor(apiKey: string = '', opts: OpenRouterAdapterOptions = {}) {
    super({
      apiKey,
      baseUrl: OPENROUTER_BASE_URL,
      defaultModel: OPENROUTER_DEFAULT_MODEL,
      staticModels: OPENROUTER_STATIC_MODELS,
    });
    this.referer = opts.referer ?? OPENROUTER_DEFAULT_REFERER;
    this.title = opts.title ?? OPENROUTER_DEFAULT_TITLE;
    this.freeModels = opts.freeModels ?? FREE_MODELS_SET;
  }

  // ---- Hook overrides -------------------------------------------------------

  /** Explicit override (matches the base return value) so the docstring
   *  makes the OpenRouter endpoint discoverable. */
  getBaseUrl(): string {
    return OPENROUTER_BASE_URL;
  }

  /**
   * Auto-append `:free` when the bare model id is in the curated free list
   * AND the caller hasn't already specified a `:` qualifier (e.g. `:free`
   * or a paid variant). Paid models (e.g. `anthropic/claude-3.5-sonnet`)
   * are passed through untouched.
   */
  protected mutateRequest(req: ChatRequest): unknown {
    const model = req.model;
    if (typeof model !== 'string' || model.length === 0) return req;
    // Already qualified (e.g. `:free`, `:nitro`, `:floor`) — leave alone.
    if (model.includes(':')) return req;
    if (this.freeModels.has(model)) {
      return { ...req, model: `${model}:free` };
    }
    return req;
  }

  /**
   * Emit Bearer auth + the two OpenRouter-attribution headers.
   *
   * Per the task brief, this accepts an explicit `apiKey` argument so it can
   * be called without a captured instance key (the singleton pattern). When
   * called without an argument (the base-class I/O flow), it falls back to
   * `this.apiKey`.
   */
  getHeaders(apiKey?: string): Record<string, string> {
    const key = apiKey ?? this.apiKey;
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error(
        `OpenRouterAdapter: ${OPENROUTER_KEY_ENV} is not configured. ` +
          `Set it with: wrangler secret put ${OPENROUTER_KEY_ENV}`,
      );
    }
    return {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': this.referer,
      'X-Title': this.title,
    };
  }

  /**
   * Capture the OpenRouter-specific `usage.cost` (USD) field and stash it on
   * a private marker (`__or_cost`) so {@link parseResponse} can lift it
   * onto `provider_meta.cost` without polluting the OpenAI `usage` shape.
   *
   * Idempotent: if no cost is present (or it has already been detached),
   * returns the input verbatim.
   */
  protected mutateRawResponse(raw: unknown): unknown {
    if (typeof raw !== 'object' || raw === null) return raw;
    const r = raw as OpenRouterRawResponse;
    if (r.__or_cost !== undefined) return raw; // already detached
    const cost = typeof r.usage?.cost === 'number'
      ? r.usage.cost
      : typeof r.cost === 'number'
        ? r.cost
        : undefined;
    if (cost === undefined) return raw;
    // Detach `cost` from `usage` so the base parser sees a pure OpenAI shape.
    const { usage, ...rest } = r;
    const cleanedUsage = usage === undefined
      ? undefined
      : (() => {
        const { cost: _drop, ...restUsage } = usage;
        return restUsage;
      })();
    return {
      ...rest,
      ...(cleanedUsage ? { usage: cleanedUsage } : {}),
      __or_cost: cost,
    };
  }

  /**
   * Lift the captured `__or_cost` marker onto the normalized response's
   * `provider_meta.cost`. Falls back to the base implementation when no
   * cost was present.
   */
  parseResponse(raw: unknown, requestedModel: string): ChatResponse {
    const mutated = this.mutateRawResponse(raw) as OpenRouterRawResponse;
    const cost = typeof mutated.__or_cost === 'number' ? mutated.__or_cost : undefined;
    if (mutated.__or_cost === undefined) {
      return super.parseResponse(raw, requestedModel);
    }
    // Strip the marker before delegating so the base parser sees a clean shape.
    const { __or_cost: _drop, ...rest } = mutated;
    const base = super.parseResponse(rest, requestedModel);
    if (cost !== undefined) {
      base.provider_meta = { ...(base.provider_meta ?? {}), cost };
    }
    return base;
  }

  /**
   * OpenRouter emits the standard `x-ratelimit-*` family that the base class
   * already parses, BUT it also uses the older single-token form
   * (`x-ratelimit-limit` / `-remaining` / `-reset`) on the free tier. Map
   * those into the canonical {@link RateLimitInfo} fields.
   */
  protected rateLimitHeaderMap(): Record<string, 'requestsRemaining' | 'requestsLimit' | 'resetAfterSeconds' | 'retryAfterSeconds' | 'tokensRemaining' | 'tokensLimit'> {
    return {
      'x-ratelimit-limit': 'requestsLimit',
      'x-ratelimit-remaining': 'requestsRemaining',
      // OpenRouter's `x-ratelimit-reset` is epoch seconds, not a duration —
      // but the base class's `resetAfterSeconds` is the closest canonical
      // slot. The gateway can read `rawHeaders` for the exact value.
      'x-ratelimit-reset': 'resetAfterSeconds',
      'x-ratelimit-reset-timestamp': 'resetAfterSeconds',
      // OpenRouter-specific USD cost header (mirrors `usage.cost`).
      // Not a rate-limit field, but we let it flow into `rawHeaders` for
      // the dashboard; the body-level `provider_meta.cost` is authoritative.
    };
  }
}

// ---------------------------------------------------------------------------
// Factory + singleton
// ---------------------------------------------------------------------------

/**
 * Factory: build a {@link OpenRouterAdapter} from a Worker env binding.
 *
 * Throws a clear error if `OPENROUTER_KEY` is missing — placeholders are
 * fine for development (any non-empty string passes the gate); the user
 * will swap in a real key via `wrangler secret put OPENROUTER_KEY`.
 */
export function createOpenRouterAdapter(env: Record<string, unknown>): OpenRouterAdapter {
  const key = env[OPENROUTER_KEY_ENV];
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(
      `OpenRouterAdapter: ${OPENROUTER_KEY_ENV} is not configured. ` +
        `Set it with: wrangler secret put ${OPENROUTER_KEY_ENV}`,
    );
  }
  return new OpenRouterAdapter(key);
}

/**
 * Pre-wired singleton with no API key. Useful for accessing shape helpers
 * (`formatRequest`, `parseResponse`, `mutateRequest`, etc.) without a key
 * bound at module-load time. For real I/O, use {@link createOpenRouterAdapter}.
 */
export const openrouterAdapter = new OpenRouterAdapter();
