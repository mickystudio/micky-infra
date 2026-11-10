# A9 — Gateway Health Checking + Monitoring

**Agent:** A9
**Task ID:** A9
**Date:** 2026-11-10
**Scope:** Background health checking, metrics recording, alerting, and
dashboard analytics for the multi-provider LLM gateway.

---

## What I built

### Files created (8 new)

| Path | Lines | Purpose |
|------|-------|---------|
| `worker/src/gateway/health_checker.ts` | 397 | `HealthChecker` class (`checkAll`, `checkOne`) + `runHealthCheckCron(env, ctx)` cron entry point. Probes each provider (model-list GET or 1-token completion), updates `provider_quotas` via A2's `QuotaLedger`, writes trend rows to `provider_health_history`, fires alerts on healthy→down transitions. |
| `worker/src/gateway/monitoring.ts` | 336 | `ProviderMonitor` class — `getDashboardData()`, `getProviderHistory(provider, hours)`, `getCascadeAnalytics(env, hours)`. Read-only D1 queries that power the future `/admin/dashboard` route. |
| `worker/src/gateway/alerts.ts` | 283 | `AlertManager` class — `notifyAdmin`, `onProviderDown`, `onCircuitOpen`, `onAllProvidersDown`, `onQuotaLow`. Telegram alerts to `ADMIN_CHAT_ID` with per-(provider, alert) rate-limiting via KV TTL (10 min). |
| `worker/src/gateway/metrics.ts` | 396 | `recordMetric(env, event)` + `getMetrics(env, timeRange)`. Append-only event log to `provider_calls` (extends A2's schema with `event_type` + `meta` columns). 6 event types: call_success, call_failure, fallback_triggered, circuit_opened, quota_depleted, feedback_received. |
| `worker/src/gateway/cron_handler.ts` | 80 | `dispatchGatewayCron(cron, env, ctx)` — maps `event.cron` to `runHealthCheckCron` or `resetDailyQuotas`. Also exports `resetDailyQuotas` (delegates to A2's `QuotaLedger.resetDailyQuotas`). |
| `worker/src/gateway/monitoring_types.ts` | 159 | Shared types + `PROVIDER_PROBES` config (5 providers). Re-exports `ProviderId` from `cascade_types.ts` (A8) — single source of truth. |
| `worker/src/gateway/MONITORING.md` | 279 | Docs: health-check strategy, alert escalation, dashboard access, migration deploy. |
| `worker/migrations/0003_gateway_monitoring.sql` | 54 | Additive migration: `ALTER TABLE provider_calls ADD COLUMN event_type/meta` + creates `provider_health_history` table. |

### Files modified (3)

| Path | Change |
|------|--------|
| `worker/src/cron.ts` | `handleScheduled(env)` → `handleScheduled(env, ctx, cron)`. Calls `dispatchGatewayCron` first; falls through to existing Kaggle poll if not handled. |
| `worker/src/index.ts` | `scheduled()` handler now passes `event.cron` + `ctx` to `handleScheduled`. |
| `worker/wrangler.toml` | Added 2 cron triggers: `*/30 * * * *` (health check) + `0 0 * * *` (daily reset). Documented new provider API key secrets + optional `PROVIDER_ALERTS` KV binding. |

---

## Co-existence with parallel agents

The `gateway/` folder is built by 5+ agents in parallel. A9 is careful not to
step on the others' work:

| Module | Owner | A9's relationship |
|--------|-------|--------------------|
| `gateway/types.ts` | A6 (provider adapter contract) | **Did NOT touch.** A6 overwrote my initial `types.ts` — I moved my shared types to `monitoring_types.ts` to avoid the conflict. |
| `gateway/cascade_types.ts` | A8 (cascade router) | Imports `ProviderId` from here — single source of truth for the 5-provider union (`'workers-ai' \| 'groq' \| 'mistral' \| 'openrouter' \| 'gemini'`). |
| `gateway/ledger/ledger.ts` | A2 (D1 quota ledger) | Imports `QuotaLedger` class — uses `setProviderHealthy`, `getQuota`, `record429`, `resetDailyQuotas`. Same source of truth as the cascade router. |
| `gateway/ledger/schema.sql` | A2 | Writes to A2's `provider_quotas`, `provider_calls`, `provider_feedback` tables. |
| `gateway/adapters/` | A4/A6/A10 | Does NOT use — A9 probes providers directly via `fetch()` (the adapters are for the cascade router's inference path). |

### Race condition encountered

While I was writing `gateway/types.ts`, agent A6 concurrently overwrote it
with their `ProviderAdapter` contract. I detected this during a follow-up
`ls`, pivoted to a separate `monitoring_types.ts` file, and re-exported
`ProviderId` from `cascade_types.ts` (A8's module) instead of redefining it.
No data was lost; A6's work is intact.

### Provider id reconciliation

- **A2's ledger** uses 11 provider ids at finer granularity (`groq1`, `groq2`,
  `cerebras`, `sambanova`, `together`, `fireworks`, `deepinfra`, etc.) — for
  per-API-key quota tracking.
- **A8's cascade router** uses 5 provider ids at service granularity
  (`workers-ai`, `groq`, `mistral`, `openrouter`, `gemini`) — for routing.
- **A9's health checker** uses A8's 5-provider granularity. The health
  checker probes "the groq service" via the first available Groq API key
  (`env.GROQ_API_KEY`) and writes the result to `provider_quotas` with
  `provider='groq'`. The cascade router can still maintain finer-grained
  per-key circuit-breaker state separately.

This means the health checker operates at the routing layer's granularity
(matching A8), while A2's ledger can also have finer-grained entries managed
by the router. The two layers don't conflict.

---

## Design decisions

### 1. Probe strategy

- **Models GET** for groq/mistral/openrouter/gemini (free, validates the API key).
- **1-token completion** for workers-ai (no public /models endpoint).
- 8-second timeout per probe.
- All 5 probes run in parallel via `Promise.allSettled` — total wall time ~8s,
  well under CF's 30s Cron CPU limit.

### 2. Circuit breaker

Delegated to A2's `QuotaLedger.setProviderHealthy(provider, healthy,
circuitOpenUntilMs)`. Escalating backoff: 1 min → 5 min → 15 min → 30 min
(capped) based on `consecutive_failures`. On `healthy`, the circuit closes
immediately and `consecutive_failures` resets.

### 3. Alert rate-limiting

Per-(provider, alertType) KV key with 600s TTL:
`gateway:alert:<provider>:<alertType>`. Read-first-then-write pattern; tiny
race window is acceptable for an alert system (worst case: 1 duplicate
message per 10 min).

`onAllProvidersDown` (CRITICAL) bypasses the rate-limit — when the whole
cascade is dead, we want every invocation to fire.

### 4. Metrics backward compatibility

A2's `QuotaLedger.recordCall()` writes `event_type=NULL` + `status='success'|'429'|...`.
A9's `recordMetric()` writes `event_type=<MetricEventType>` (+ `status` for
call events). `getMetrics()` classifies both styles so the dashboard sees a
unified view. This means A2's existing call audit log continues to work
unchanged.

For `feedback_received` events, `recordMetric()` writes to BOTH
`provider_calls` (with `event_type='feedback_received'`) AND `provider_feedback`
(A2's table with `rating INTEGER +1/-1`). This keeps A2's
`QuotaLedger.getProviderStats()` feedback counter working.

### 5. ctx.waitUntil pattern

`runHealthCheckCron(env, ctx)` defers the actual work via `ctx.waitUntil()`
and returns immediately. The cron handler returns synchronously (well under
30s); the actual probing happens in the background, bounded by the slowest
probe (~8s).

---

## Migration notes

`migrations/0003_gateway_monitoring.sql` is **additive** on top of A2's
`gateway/ledger/schema.sql`:

```sql
ALTER TABLE provider_calls ADD COLUMN event_type TEXT;
ALTER TABLE provider_calls ADD COLUMN meta TEXT;
CREATE INDEX IF NOT EXISTS idx_pcalls_event_type ON provider_calls(event_type);

CREATE TABLE IF NOT EXISTS provider_health_history (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  provider            TEXT NOT NULL,
  status              TEXT NOT NULL,            -- 'healthy' | 'degraded' | 'down'
  latency_ms          INTEGER,
  error               TEXT,
  quota_rpd_remaining INTEGER,
  quota_tpd_remaining INTEGER,
  checked_at          INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_phist_provider ON provider_health_history(provider);
CREATE INDEX IF NOT EXISTS idx_phist_checked  ON provider_health_history(checked_at);
```

Deploy with:
```bash
npx wrangler d1 execute micky-db --remote --file=migrations/0003_gateway_monitoring.sql
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put MISTRAL_API_KEY
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler deploy
```

---

## Type-check results

`tsc --noEmit -p tsconfig.json` shows **34 total errors in the worker**, but
**0 are in A9's files** beyond the pre-existing environmental errors
(`Cannot find name 'KVNamespace' / 'ExecutionContext' / 'D1Database' / 'Ai'`)
that affect EVERY file in the worker (including `src/index.ts`,
`src/gateway/ledger/ledger.ts`, `src/gateway/cascade_types.ts`). This is a
`@cloudflare/workers-types` global-types loading issue, not a code defect.

The only non-environmental tsc errors in the worker are in other agents'
files: `adapters/_base.ts` and `adapters/__tests__/new_providers.test.ts`
(both A10).

---

## Constraints honoured

- ✅ All TypeScript, edge-compatible (no Node-only APIs).
- ✅ `Promise.allSettled` for parallel health checks.
- ✅ Cron handler returns < 30 s (slowest probe ~8 s, all in parallel).
- ✅ No `any` types — full typing throughout (one `as unknown as` cast to
  work around Env's missing index signature when reading provider API keys).
- ✅ Every file < 400 lines (max: `health_checker.ts` at 397).
- ✅ Idempotent where possible (ON CONFLICT in the ledger, idempotent
  `resetDailyQuotas`).
- ✅ Best-effort writes on the hot path (D1 failures degrade to
  `console.error`, never throw to the caller).

---

## Open follow-ups (out of A9 scope)

1. Wire the `/admin/dashboard` HTTP route (when the admin auth story lands).
   The `ProviderMonitor` class is ready; the route handler would be ~20 lines.
2. Add a cleanup cron for `provider_health_history` rows older than 30 days
   (currently unbounded growth — ~5 providers × 48 probes/day = ~240 rows/day).
3. Layer a short-TTL KV cache in front of `getDashboardData()` if the
   dashboard becomes a hot path (currently every call hits D1 ~7 times).
4. Reconcile the provider id granularity between A2's 11-provider ledger and
   A8's 5-provider router (currently the health checker writes to
   `provider_quotas` with the 5-provider names, which works but creates
   parallel rows to A2's `groq1`/`groq2` entries — the cascade router reads
   both).
