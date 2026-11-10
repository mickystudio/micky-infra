# A8-retry2 — Model Router (focused scope)

**Agent:** A8-retry2
**Task ID:** A8-retry2
**Date:** 2026-11-12
**Scope (REDUCED from A8):** Build ONLY `worker/src/gateway/model_router.ts` —
no SSE normalizer, no error_handler.ts. Those are deferred to a future agent.
Plus: update `worker/src/gateway/index.ts` to call the new `routeChat`, and
ship a 10+ test vitest suite at `worker/src/gateway/__tests__/model_router.test.ts`.

---

## What I built

### Files created (2)

| Path | Lines | Purpose |
|------|-------|---------|
| `worker/src/gateway/model_router.ts` | 495 | **Focused** replacement of the legacy cascade router. Exports three public functions: `routeChat(req, env, ctx): Promise<Response>`, `routeChatStream(req, env, ctx): Promise<Response>`, `handleFeedback(messageId, rating, env): Promise<void>`. Algorithm: resolve conversation_id → check sticky session → if sticky valid, try it first (skipping classifyIntent / cascade build); else classify intent + build cascade → filter by `getHealthyProviders(env)` → for each provider: pick best model, estimate tokens via `countMessageTokens`, check `willFitInProviderContext`, atomic `decrementQuota` (D1 UPDATE...WHERE remaining>0 RETURNING), call `adapter.chat()` / `chatStream()` with 25s `AbortController`-backed timeout → on 429 `record429` + `setProviderHealthy(false, now+5min)`; on 5xx/network/timeout, read `consecutive_failures` from `getQuota`, if ≥3 → `setProviderHealthy(false, now+1h)`; on success `recordCall` + `setStickyProvider` via `ctx.waitUntil()` → return Response with `X-Provider` / `X-Model` / `X-Fallback-Used` headers → 503 `all_providers_exhausted` if every provider fails. Streaming: pre-stream errors fall back to next provider; mid-stream errors emit `data: {"error":"Provider failed: ..."}\n\n` + terminal `data: [DONE]\n\n` then close (no mid-stream fallback). `handleFeedback`: queries `provider_calls` by `conversation_id` (= messageId in single-turn flows), falls back to `getStickyProvider` lookup, then `recordFeedback`. NO `any` types (uses proper `Env` / `GatewayEnv` / `ProviderId` / `IntentType` from `./types`); casts through `unknown` where the adapters/types.ts ↔ utils/types.ts `ChatMessage` shapes diverge (null-vs-non-null `content`). |
| `worker/src/gateway/__tests__/model_router.test.ts` | 515 | 19 vitest tests covering the 10 required scenarios + 9 bonus edge cases. Uses `vi.mock()` to replace `QuotaLedger` (singleton in-memory stub with all 9 methods the router actually calls), `registry` (`getProvider` / `getHealthyProviders`), `utils/intent_classifier` (`classifyIntent` / `getCascadeForIntent` / `pickBestModel`), and `utils/token_counter` (`countMessageTokens` / `willFitInProviderContext`). Each test asserts on the returned `Response` (status, headers, body) AND on the mock-call assertions (verifies `recordCall`, `setStickyProvider`, `record429`, `setProviderHealthy` were called with the expected args). `ctx.waitUntil` is captured into a `pending[]` array and flushed via `await flush()` before assertions. |

### Files modified (1)

| Path | Change |
|------|--------|
| `worker/src/gateway/index.ts` | Was 500 lines of inline cascade + helpers. Now an 80-line **thin re-export wrapper** — the inline cascade with the `// TODO: replace with full model_router when A8 lands` comment has been retired. Re-exports `routeChat` / `routeChatStream` / `handleFeedback` from `./model_router`; preserves backward compat by aliasing `handleFeedback` as `handleProviderFeedback` (so the worker entry `src/index.ts` line 23 `import { routeChat, handleProviderFeedback } from './gateway'` continues to work unchanged). Also re-exports the registry / classifier / ledger / token-counter symbols so other callers that imported them via `./gateway` keep working. |

---

## Architecture decisions

### Why a SINGLE shared `routeInternal(req, env, ctx, isStream)` for both routes

`routeChat` and `routeChatStream` differ only in (a) the `isStream` flag, (b) which adapter method they call (`adapter.chat` vs `adapter.chatStream`), and (c) the response builder (`buildJsonResponse` vs `buildStreamResponse`). All the cascade / sticky / quota / circuit-breaker logic is identical. A single `routeInternal` with an `isStream: boolean` param keeps the algorithm in ONE place — when the cascade logic changes (e.g. a new circuit-breaker rule), there's only one place to update. The two thin public wrappers just call `routeInternal(req, env, ctx, false)` and `routeInternal({ ...req, stream: true }, env, ctx, true)`.

### Why `intent` is passed INTO `tryProvider` (not classified inside it)

The sticky-session path doesn't need to call `classifyIntent(req)` — the sticky mapping was set on a previous turn, and the conversation's original intent is irrelevant (the model is already chosen by `pickBestModel('simple_chat', provider)` in `resolveSticky`). So `routeInternal` classifies intent ONCE before the cascade loop, and passes the resulting `IntentType` as a parameter to `tryProvider`. This:

1. Avoids the redundant `classifyIntent` call on the sticky path (verified by Test 1 — `expect(classifyIntent).not.toHaveBeenCalled()`).
2. Avoids double-classification on the cascade path (the legacy code called `classifyIntent` inside `tryProvider` AND in the cascade builder — Test 2 caught this regression immediately).

### Why I rewrote errorResponse to use `code` as `type` for 5xx

The task spec's 503 example is `{"error":{"message":"...","type":"all_providers_exhausted","attempted_providers":[...]}}`. My original errorResponse used `type: 'server_error'` for all 5xx (OpenAI convention). Test 4 (`expect(body.error.type).toBe('all_providers_exhausted')`) caught the mismatch. Fix: for 5xx, surface the specific `code` as `type` (so `code='all_providers_exhausted'` ↔ `type='all_providers_exhausted'`); for 4xx, keep OpenAI's canonical `invalid_request_error`. This matches the spec example exactly while staying OpenAI-compatible for the 4xx case.

### Why `record429` is used for ALL failures (not just 429s)

The A2 ledger's `record429(provider)` method is misnamed — it actually does `SET last_429_at = ?, consecutive_failures = consecutive_failures + 1` for ANY failure (not just 429s). The legacy `model_router.ts` (Agent A8-retry's earlier attempt, which I replaced) used the same pattern with a clarifying comment. I followed that convention: every failure (429, 5xx, network, timeout) calls `ledger.record429(provider)` to bump `consecutive_failures`, then the circuit-breaker policy decides whether to open the circuit based on the failure type:

- 429 → 5-minute cool-down (`RATE_LIMIT_CIRCUIT_MS`)
- 5xx / network / timeout → read `consecutive_failures` from `getQuota`, if ≥3 → 1-hour circuit (`SERVER_ERROR_CIRCUIT_MS`)

This matches the task spec exactly: "On 429: record429 + open circuit 5 min; On 5xx: increment consecutive_failures; if 3+, open circuit 1h".

### Why `handleFeedback` queries D1 directly (not via QuotaLedger)

The task spec offered two options: "query D1: `SELECT provider FROM provider_calls WHERE id = ?` OR use a message_id→provider KV". The `provider_calls` table has an autoincrement `id INTEGER PRIMARY KEY` (NOT a `message_id` column), so querying by `id = messageId` doesn't work directly. I queried by `conversation_id = messageId` instead — in single-turn flows the `conversation_id` IS the messageId (we set `conversation_id = messageId` when the user first sends a message). For multi-turn flows where this assumption breaks, the test verifies a fallback to `getStickyProvider(messageId)` lookup. The D1 query returns `{ provider, intent }` so we can pass the original intent to `recordFeedback` (useful for the dashboard's per-intent feedback aggregation).

### What I did NOT do (deferred to future agents)

- **No `error_handler.ts`** — the task explicitly deferred this. The cascade error classification is inline (3-line `extractStatus` + `isNetworkError` helpers in `model_router.ts`). If a future agent builds `error_handler.ts`, the inline logic can be refactored to delegate.
- **No `sse_normalizer.ts`** — also deferred. The streaming path wraps the upstream stream through a simple `wrapStreamWithErrorHandler` that catches mid-stream errors and emits the spec's `data: {"error":"Provider failed: ..."}\n\n` + `data: [DONE]\n\n` terminal events. Provider-specific SSE shape normalization (the old `SSENormalizer` class) is not implemented — we trust that the registry's `BaseCompatHandle.chunksToSSEStream` and `MistralHandle.rawSSEToOpenAIStream` already produce OpenAI-shaped bytes (they do, per `registry.ts`).
- **Did NOT touch the legacy `cascade_router.ts`** — the OLD router (which depends on the deferred `error_handler.ts` / `sse_normalizer.ts` / `router_helpers.ts` / `adapters.ts` / `cascade_types.ts`) still exists at `src/gateway/cascade_router.ts`. Its test file at `tests/model_router.test.ts` has 8 failing tests, all pre-existing (they import from `cascade_router`, not `model_router`). Those failures are out of scope for A8-retry2.
- **Did NOT remove the legacy `gateway/model_router.ts` dependencies** — the file I replaced referenced `cascade_types`, `error_handler`, `sse_normalizer`, `router_helpers`, `adapters`. My new file imports ONLY from `./types`, `./utils/intent_classifier`, `./utils/token_counter`, `./ledger/ledger`, `./registry`, and `../index` (for the `Env` type). The legacy modules are now orphaned (only the legacy `cascade_router.ts` + its broken test still reference them) — they can be deleted in a future cleanup task.

---

## Test results

```
src/gateway/__tests__/model_router.test.ts (19 tests) 22ms
✓ model_router — routeChat > uses sticky provider when set, healthy, and quota available
✓ model_router — routeChat > builds the cascade when no sticky mapping exists
✓ model_router — routeChat > falls back to the next provider when the first returns 429
✓ model_router — routeChat > returns 503 all_providers_exhausted when every provider fails
✓ model_router — routeChat > records a success call audit + sets the sticky provider
✓ model_router — routeChat > opens the 1-hour circuit when consecutive_failures reaches the threshold
✓ model_router — routeChat > skips providers whose context window is too small
✓ model_router — routeChatStream > returns a 200 SSE response with the provider headers
✓ model_router — routeChatStream > falls back to the next provider when chatStream() rejects
✓ model_router — handleFeedback > looks up the provider via D1 + records feedback with the provider + intent
✓ model_router — handleFeedback > falls back to sticky-session lookup when D1 returns no row
✓ model_router — handleFeedback > records no feedback when the provider cannot be attributed
✓ model_router — handleFeedback > returns silently when env.DB is not configured
✓ model_router — edge cases > returns 400 when messages is empty
✓ model_router — edge cases > returns 503 when no providers are healthy
✓ model_router — edge cases > skips a provider whose decrementQuota returns ok=false
✓ model_router — edge cases > derives conversation_id from the first user message when metadata is absent
✓ model_router — edge cases > uses the explicit conversation_id from metadata when provided
✓ model_router — edge cases > records a 429 call audit with status="429" on rate-limit failures

Test Files  1 passed (1)
Tests  19 passed (19)
Duration  322ms
```

## Type-checking

| File | tsc errors | Notes |
|------|-----------|-------|
| `src/gateway/model_router.ts` | 0 | Clean. Casts through `unknown` for the two `ChatMessage` shape mismatches (adapters/types.ts ↔ utils/types.ts `content` nullability) — same pattern as the legacy `gateway/index.ts`. |
| `src/gateway/index.ts` | 0 | Clean. Pure re-export wrapper. |
| `src/gateway/__tests__/model_router.test.ts` | 0 | Clean. Imports `Env` type-only from `../../index`. |

Pre-existing tsc errors (NOT in scope, NOT introduced by me):
- `src/gateway/adapters/__tests__/new_providers.test.ts` (1 error)
- `src/gateway/adapters/_base.ts` (1 error)
- `src/gateway/provider_adapters.ts` (2 errors)
- `src/gateway/workersai_adapter.ts` (6 errors)

Pre-existing failing tests (NOT in scope, NOT introduced by me):
- `tests/model_router.test.ts` (8 failures) — tests the legacy `cascade_router.ts` which depends on the deferred `error_handler.ts` / `sse_normalizer.ts`. These were broken before A8-retry2 started.

---

## Constraints satisfied

| Constraint | How |
|------------|-----|
| TypeScript only — no Node APIs | Uses Web Standards only: `fetch`, `AbortController`, `setTimeout`/`clearTimeout`, `ReadableStream`, `TextEncoder`, `crypto.randomUUID`. No `fs`, `path`, `Buffer`, etc. |
| 25s timeout hard limit (AbortController + setTimeout) | `withTimeout(promise, ms)` creates an `AbortController`, registers an `abort` event listener that rejects with a `TimeoutError`-named Error, schedules `setTimeout(() => ctrl.abort(), ms)`, races the promise against the abort promise. `CHAT_TIMEOUT_MS = 25_000`. |
| No `any` (use `unknown` + casts, or proper types) | All function signatures use `Env`, `GatewayEnv`, `ProviderId`, `IntentType`, `ChatRequest`, `ChatResponse`, `ExecutionContext`, `D1Database`, `ReadableStream<Uint8Array>`, `Record<string, unknown>`, etc. Error handling uses `unknown` + `instanceof Error` checks. The two type-shape mismatches (`ChatMessage` nullability) are bridged via `as unknown as Parameters<typeof …>[0]`. |
| File <500 lines | `model_router.ts` is 495 lines. `__tests__/model_router.test.ts` is 515 lines (no constraint). |
| Use the actual exported functions from sibling modules (don't reinvent) | Imports `classifyIntent`, `getCascadeForIntent`, `pickBestModel` from `./utils/intent_classifier`; `countMessageTokens`, `willFitInProviderContext` from `./utils/token_counter`; `QuotaLedger` from `./ledger/ledger`; `getProvider`, `getHealthyProviders` from `./registry`. No re-implementations. |
| Use `ctx.waitUntil()` for non-critical background tasks | `recordSuccess` (recordCall + setStickyProvider) and `handleFailure` (record429 + setProviderHealthy + getQuota + recordCall) are both wrapped in `ctx.waitUntil(...)` so the user-facing response isn't blocked on D1 writes. Only the quota `decrementQuota` is awaited inline (it's a HARD gate — we can't call the adapter without first reserving quota). |
| Vitest with `vi.mock()` for ledger, registry, intent_classifier | Test file mocks all four sibling modules (`../ledger/ledger`, `../registry`, `../utils/intent_classifier`, `../utils/token_counter`) with `vi.mock()` and uses `vi.mocked(...)` to configure return values per-test. |
| 10+ tests covering the required scenarios | 19 tests total: 7 in `routeChat` describe block (incl. 7 required scenarios), 2 in `routeChatStream` block, 4 in `handleFeedback` block, 6 in `edge cases` block. |

---

## Files

```
worker/src/gateway/
├── model_router.ts                     # NEW (495 lines) — Agent A8-retry2
├── index.ts                            # MODIFIED (80 lines, was 500) — thin re-export wrapper
└── __tests__/
    └── model_router.test.ts            # NEW (515 lines) — 19 vitest tests
```

---

## Integration with sibling agents' work

The new `model_router.ts` consumes the work of sibling agents A1-retry (registry / types / `getHealthyProviders`), A2 (QuotaLedger with atomic decrement / recordCall / record429 / setProviderHealthy / getStickyProvider / setStickyProvider / recordFeedback), and A7 (intent_classifier with `classifyIntent` / `getCascadeForIntent` / `pickBestModel` + token_counter with `countMessageTokens` / `willFitInProviderContext`). All 11 adapters from A3/A4/A6/A10 are accessed via `getProvider(id)` which returns the uniform runtime `ProviderAdapter` handle defined in A1-retry's `types.ts`.

The worker entry point (`src/index.ts`, sibling A1-retry's domain) continues to import `{ routeChat, handleProviderFeedback }` from `./gateway` — both re-exports still resolve correctly.

---

## What a future agent should do

1. **Delete the legacy cascade router stack.** The orphaned files (`cascade_router.ts`, `cascade_types.ts`, `error_handler.ts`, `sse_normalizer.ts`, `router_helpers.ts`, `adapters.ts`, `provider_adapters.ts`, `workersai_adapter.ts`) are now only referenced by `tests/model_router.test.ts` (which has 8 failing tests against the legacy `cascade_router.ts`). Once those legacy tests are migrated to test the new `model_router.ts` (or deleted as superseded), the legacy files can be removed.

2. **Build `error_handler.ts` (deferred).** A dedicated error-classification module would let the cascade's failure policy be configured per-provider (e.g. Cohere might warrant a longer 429 cool-down than Groq). The inline `extractStatus` + `isNetworkError` + circuit-breaker threshold logic in `model_router.ts` should be extracted into `error_handler.ts` and the router updated to delegate.

3. **Build `sse_normalizer.ts` (deferred).** The current streaming path trusts that the registry's handles already emit OpenAI-shaped SSE bytes. A dedicated `SSENormalizer` would let us add provider-specific transformations (e.g. rewriting Gemini's `functionCall` parts into OpenAI's `tool_calls` shape) without touching the registry's `chunksToSSEStream` helper.

4. **Add a `message_id` column to `provider_calls`.** Currently `handleFeedback` queries by `conversation_id` (works for single-turn flows but not for multi-turn where `conversation_id ≠ messageId`). A proper `message_id` column + index would let `handleFeedback` look up the exact call that emitted the message being rated, and the dashboard's per-message feedback attribution would be exact.

---

## Summary

Shipped a focused, self-contained `model_router.ts` (495 lines) that fully implements the cascade algorithm per the A8-retry2 task spec, with no `any` types, no Node-only APIs, a 25s hard timeout per provider attempt, `ctx.waitUntil()` for non-critical background tasks, and a 19-test vitest suite (10 required + 9 bonus) covering sticky sessions, cascade ordering, 429 fallback, all-providers-exhausted 503, success metrics + sticky recording, circuit-breaker threshold, token-budget skipping, streaming success, streaming pre-stream fallback, and handleFeedback. The legacy `gateway/index.ts` inline cascade has been retired in favor of a thin re-export wrapper. The deferred `error_handler.ts` / `sse_normalizer.ts` modules are documented as future work; the new router is fully usable end-to-end without them.
