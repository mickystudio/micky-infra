/**
 * Micky Assistant Unlimited — Gateway Monitoring Types
 * ----------------------------------------------------------------------------
 * Agent: A9 (background health checking + monitoring)
 *
 * Shared types + constants for the monitoring subsystem:
 *   health_checker.ts, monitoring.ts, alerts.ts, metrics.ts, cron_handler.ts
 *
 * IMPORTANT — co-existence with parallel gateway modules:
 *   - `gateway/types.ts`             (Agent A6) — provider adapter contract.
 *   - `gateway/cascade_types.ts`     (Agent A8) — cascade router types +
 *     the canonical `ProviderId` union (`'workers-ai' | 'groq' | 'mistral' |
 *     'openrouter' | 'gemini'`). We re-export that type — never redefine it.
 *   - `gateway/ledger/ledger.ts`     (Agent A2) — `QuotaLedger` D1 API +
 *     `provider_quotas` / `provider_calls` / `provider_feedback` tables.
 *
 * This module does NOT touch those files. It owns only the cross-cutting
 * probe config + the health-report shapes that the monitoring layer needs.
 *
 * Created: 2026-11-10
 * Phase: A9
 */

// Re-export the canonical ProviderId so all gateway modules agree on the
// provider set. The cascade router (A8) is the source of truth.
export type { ProviderId } from './cascade_types';
import type { ProviderId } from './cascade_types';

// ============ Constants ============

/**
 * Frozen list of providers the health checker probes. Mirrors cascade_types'
 * ProviderId union — kept here as a runtime array so the cron can iterate
 * without enumerating the union by hand.
 */
export const ALL_PROVIDERS: readonly ProviderId[] = [
  'workers-ai',
  'groq',
  'mistral',
  'openrouter',
  'gemini',
] as const;

// ============ Health states ============

/** Result of a single health probe against one provider. */
export type HealthStatus = 'healthy' | 'degraded' | 'down';

// ============ Probe config ============

/**
 * Per-provider probe config used by the HealthChecker.
 *
 * Two probe kinds:
 *   - 'models'      : GET the provider's /models endpoint. Cheap, no token
 *                     cost, works on most OpenAI-compatible providers.
 *   - 'completion'  : POST a 1-token completion. Used for Cloudflare
 *                     Workers AI (no /models endpoint) and as a deeper
 *                     check when the /models endpoint doesn't require auth
 *                     but we still want to verify the key works.
 *
 * The cascade order is owned by A8's model_router.ts. We only need the
 * probe config here.
 */
export interface ProviderProbe {
  provider: ProviderId;
  displayName: string;
  /** Probe kind — see interface doc. */
  probeType: 'models' | 'completion';
  /** GET endpoint (probeType='models'). Empty for the AI binding. */
  modelsUrl?: string;
  /** POST endpoint (probeType='completion'). Empty for the AI binding. */
  completionUrl?: string;
  /** Name of the env var holding the API key. 'AI_BINDING' = use env.AI. */
  apiKeyEnv: string;
  /** Model id used for the 1-token completion probe. */
  probeModel: string;
}

/**
 * Static probe configuration for all 5 providers in the cascade.
 *
 * Read by HealthChecker. Editing this array is the single source of truth
 * for "which provider do we probe, and how".
 *
 * API key env-var names match the secrets wired into the Env interface by
 * `cascade_types.ts` (declaration-merged: GROQ_API_KEY, MISTRAL_API_KEY,
 * OPENROUTER_API_KEY, GEMINI_API_KEY). If a secret is missing the probe is
 * skipped (provider marked 'degraded' with error 'no API key configured')
 * — the rest of the cron run continues.
 */
export const PROVIDER_PROBES: readonly ProviderProbe[] = [
  {
    provider: 'workers-ai',
    displayName: 'Cloudflare Workers AI',
    probeType: 'completion',
    // Cloudflare Workers AI has no public /models endpoint; we use the AI
    // binding directly. completionUrl is unused — see probeCloudflare().
    completionUrl: '',
    apiKeyEnv: 'AI_BINDING',
    probeModel: '@cf/qwen/qwen2.5-coder-7b-instruct',
  },
  {
    provider: 'groq',
    displayName: 'Groq',
    probeType: 'models',
    modelsUrl: 'https://api.groq.com/openai/v1/models',
    apiKeyEnv: 'GROQ_API_KEY',
    probeModel: 'llama-3.1-8b-instant',
  },
  {
    provider: 'mistral',
    displayName: 'Mistral AI',
    probeType: 'models',
    modelsUrl: 'https://api.mistral.ai/v1/models',
    apiKeyEnv: 'MISTRAL_API_KEY',
    probeModel: 'mistral-small-latest',
  },
  {
    provider: 'openrouter',
    displayName: 'OpenRouter',
    probeType: 'models',
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    probeModel: 'openrouter/auto',
  },
  {
    provider: 'gemini',
    displayName: 'Google Gemini',
    probeType: 'models',
    modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    apiKeyEnv: 'GEMINI_API_KEY',
    probeModel: 'gemini-1.5-flash',
  },
] as const;

// ============ Health report (returned by HealthChecker) ============

export interface HealthReport {
  provider: ProviderId;
  status: HealthStatus;
  latency_ms: number;
  error?: string;
  checked_at: number;
  /** Daily quota remaining at probe time. Infinity = unlimited. */
  quota_remaining?: { rpd: number; tpd: number };
}

// ============ KV namespace for alert rate-limiting ============

/**
 * Optional KV namespace dedicated to alert rate-limiting. When bound
 * (wrangler.toml `PROVIDER_ALERTS`), the AlertManager uses it to throttle
 * per-(provider, alert) messages. Falls back to `env.RATE_LIMITS` when
 * absent so the system works out-of-the-box.
 */
export interface AlertEnv {
  PROVIDER_ALERTS?: KVNamespace;
}
