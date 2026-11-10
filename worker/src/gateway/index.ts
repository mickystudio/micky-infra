/**
 * Micky Assistant — Gateway Public API (Task A1-retry + A8-retry2)
 *
 * Thin re-export wrapper. The actual cascade router (routeChat /
 * routeChatStream / handleFeedback) now lives in `./model_router.ts` (Agent
 * A8-retry2) — the inline cascade that lived here previously has been retired.
 *
 * Public surface (preserved for `src/index.ts` worker entry + other callers):
 *   • `routeChat(req, env, ctx)`                  — from ./model_router
 *   • `routeChatStream(req, env, ctx)`            — from ./model_router
 *   • `handleProviderFeedback(messageId, rating, env)` — alias for
 *     `handleFeedback` (kept so the worker entry's import is unchanged)
 *
 * Re-exports the registry / classifier / ledger / token-counter symbols so
 * callers that imported them from `./gateway` continue to work.
 *
 * Edge-runtime-safe. Created: 2026-11-10 (A1-retry); updated 2026-11-12 (A8-retry2).
 */

import type { Env } from '../index';

// ============================================================================
// Primary cascade router — re-exported from ./model_router (Agent A8-retry2)
// ============================================================================

export {
  routeChat,
  routeChatStream,
  handleFeedback,
} from './model_router';

/** Backward-compat alias for callers that imported `handleProviderFeedback`. */
export { handleFeedback as handleProviderFeedback } from './model_router';

// ============================================================================
// Type re-exports — single canonical import path for the gateway module
// ============================================================================

export type {
  CascadeAttempt,
  CascadeResult,
  ChatRequest,
  ChatResponse,
  GatewayEnv,
  ProviderAdapter,
  ProviderId,
  IntentType,
} from './types';

// ============================================================================
// Registry / classifier / ledger / token-counter re-exports
// ============================================================================

export {
  PROVIDERS,
  getProvider,
  isProviderConfigured,
  listProviders,
  getHealthyProviders,
} from './registry';

export {
  classifyIntent,
  getCascadeForIntent,
  pickBestModel,
} from './utils/intent_classifier';

export { QuotaLedger } from './ledger/ledger';

export {
  countMessageTokens,
  willFitInProviderContext,
  getProviderContextLimit,
} from './utils/token_counter';

// ============================================================================
// Local type alias — Env re-exported for callers that import via ./gateway
// ============================================================================

export type { Env };
