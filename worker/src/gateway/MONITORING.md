# Gateway Monitoring (Agent A9)

Background health checking, metrics recording, and dashboard analytics for the
multi-provider LLM gateway.

**Location:** `worker/src/gateway/`
**Binding:** `DB` (D1) + `RATE_LIMITS` (KV, fallback for alert throttling)
**Task:** A9

---

## Files

| File | Role | Lines |
|------|------|-------|
| `health_checker.ts` | `HealthChecker` class + `runHealthCheckCron()` cron entry point. Probes each provider, updates `provider_quotas` via A2's `QuotaLedger`, writes trend rows to `provider_health_history`, fires alerts on healthy→down transitions. | 397 |
| `monitoring.ts` | `ProviderMonitor` class — read-only dashboard queries: `getDashboardData()`, `getProviderHistory()`, `getCascadeAnalytics()`. | 336 |
| `alerts.ts` | `AlertManager` class — sends Telegram alerts to `ADMIN_CHAT_ID`. Per-(provider, alert) rate-limiting via KV TTL (10 min). | 283 |
| `metrics.ts` | `recordMetric()` + `getMetrics()` — append-only event log to `provider_calls` (extends A2's schema with `event_type` + `meta` columns). | 396 |
| `cron_handler.ts` | `dispatchGatewayCron()` — maps `event.cron` string to the right gateway job. Also exports `resetDailyQuotas()`. | ~75 |
| `monitoring_types.ts` | Shared types + `PROVIDER_PROBES` config (5 providers). Imports `ProviderId` from `cascade_types.ts` (A8) — single source of truth. | 159 |
| `MONITORING.md` | This file. | — |

**Migration:** `migrations/0003_gateway_monitoring.sql` (additive — extends
A2's `provider_calls` with `event_type` + `meta` columns and creates the new
`provider_health_history` table).

---

## Co-existence with parallel gateway modules

The gateway folder is built by multiple agents in parallel. A9 owns the
monitoring layer and is careful not to step on the others' work:

| Module | Owner | What A9 imports from it |
|--------|-------|-------------------------|
| `gateway/types.ts` | A6 (provider adapter contract) | Nothing — A9 uses its own `monitoring_types.ts`. |
| `gateway/cascade_types.ts` | A8 (cascade router) | `ProviderId` type (`'workers-ai' \| 'groq' \| 'mistral' \| 'openrouter' \| 'gemini'`). |
| `gateway/ledger/ledger.ts` | A2 (D1 quota ledger) | `QuotaLedger` class — used for `setProviderHealthy` + `getQuota` + `resetDailyQuotas` + `record429`. |
| `gateway/ledger/schema.sql` | A2 | The `provider_quotas`, `provider_calls`, `provider_feedback` tables. A9 writes to all three. |
| `gateway/adapters/` | A4/A6/A10 | Nothing — A9 probes directly via `fetch()` (the adapters are for the cascade router's inference path, not for health probes). |

**Single source of truth for the provider list:** `cascade_types.ts`'s `ProviderId`
union. `monitoring_types.ts` re-exports it + ships a frozen `ALL_PROVIDERS`
array so the cron can iterate without enumerating the union by hand.

---

## Health check strategy

### Cadence

Cloudflare Cron Triggers fire the `scheduled()` handler (in `src/index.ts`)
which delegates to `handleScheduled(env, ctx, event.cron)` in `src/cron.ts`.
That function calls `dispatchGatewayCron(cron, env, ctx)` first — if the cron
matches a gateway job, the gateway handles it and returns; otherwise the
existing Kaggle stale-task poll runs.

| Cron | Handler | Purpose |
|------|---------|---------|
| `*/5 * * * *` | `handleScheduled` (existing) | Kaggle stale-task safety net. |
| `*/30 * * * *` | `runHealthCheckCron` (A9) | Probe every provider, update ledger, alert on transitions. |
| `0 0 * * *` | `resetDailyQuotas` (A9 → A2's `QuotaLedger.resetDailyQuotas`) | Seed today's quota rows for all 11 providers. |

### Probe kinds

Per provider (`PROVIDER_PROBES` in `monitoring_types.ts`):

| Provider | Probe | Endpoint |
|----------|-------|----------|
| `workers-ai` | 1-token completion | `env.AI.run('@cf/qwen/qwen2.5-coder-7b-instruct', {messages:[{role:'user',content:'ping'}], max_tokens:1})` |
| `groq` | `GET /models` | `https://api.groq.com/openai/v1/models` (Bearer auth) |
| `mistral` | `GET /models` | `https://api.mistral.ai/v1/models` (Bearer auth) |
| `openrouter` | `GET /models` | `https://openrouter.ai/api/v1/models` (Bearer auth) |
| `gemini` | `GET /models` | `https://generativelanguage.googleapis.com/v1beta/models?key=API_KEY` (query-string auth) |

The `/models` endpoint is preferred because it's free (no token cost) and
validates the API key in the process. Workers AI has no public `/models`
endpoint, so it uses a 1-token completion via the AI binding.

### Status thresholds

| Status | Condition |
|--------|-----------|
| `healthy` | Probe succeeded, latency < 3000 ms. |
| `degraded` | Probe succeeded, latency ≥ 3000 ms. |
| `down` | Probe failed (network error, non-2xx, or 8s timeout). |

### Circuit breaker

Implemented via A2's `QuotaLedger.setProviderHealthy(provider, healthy,
circuitOpenUntilMs)`. On `down`, the circuit opens for an escalating backoff:

| Consecutive failures | Circuit open duration |
|----------------------|-----------------------|
| 1 | 1 minute |
| 2 | 5 minutes |
| 3 | 15 minutes |
| 4+ | 30 minutes (capped) |

On `healthy`, the circuit closes immediately and `consecutive_failures` resets.
On `degraded`, the circuit stays as-is (degraded ≠ down — the provider is
still usable, just slow).

The cascade router (A8) reads `provider_quotas.is_healthy` +
`circuit_open_until` on every inference request to skip dead/circuit-open
providers — same source of truth as the health checker.

### Parallelism

`checkAll()` uses `Promise.allSettled` so a slow/hanging probe on one
provider doesn't block the others. Total wall time is bounded by the slowest
probe (~8 s timeout). Well under Cloudflare's 30 s Cron CPU limit.

### Trend analysis

Each probe writes one row to `provider_health_history` with:
- `status` ('healthy' | 'degraded' | 'down')
- `latency_ms`
- `error`
- `quota_rpd_remaining` / `quota_tpd_remaining` (snapshot at probe time)
- `checked_at` (epoch seconds)

The dashboard's `getProviderHistory()` rolls these up into hourly buckets
(averaging latency, taking the worst status in the bucket). A future cleanup
cron will prune rows older than 30 days.

---

## Alert escalation rules

All alerts are sent to `env.ADMIN_CHAT_ID` via Telegram (using
`env.TELEGRAM_BOT_TOKEN`). The `AlertManager` class has 5 escalation tiers:

| Method | Severity | Trigger | Rate-limit |
|--------|----------|---------|------------|
| `notifyAdmin` | info | Ad-hoc / generic messages. | None (caller-controlled). |
| `onProviderDown` | warning | A provider transitioned healthy → down. | 1 per (provider) per 10 min. |
| `onCircuitOpen` | warning | A provider's circuit breaker opened. | 1 per (provider) per 10 min. |
| `onQuotaLow` | info | A provider has <10% daily quota remaining. | 1 per (provider) per 10 min. |
| `onAllProvidersDown` | **critical** | Every provider in the cascade is down. | **Bypassed** (always sends). |

### Rate-limiting

Per-(provider, alertType) rate-limiting uses a KV key with a 600 s TTL:

```
gateway:alert:<provider>:<alertType>  →  "<timestamp>"  (TTL: 600s)
```

The KV namespace is `env.PROVIDER_ALERTS` if bound (see `wrangler.toml`),
falling back to `env.RATE_LIMITS` so the system works out of the box.

The `onAllProvidersDown` critical alert bypasses the rate-limit because it
means user-facing requests are currently failing — better noisy than silent.

### When alerts fire

The health-check cron (`runHealthCheckCron`) is the primary trigger:

1. Snapshot each provider's pre-probe `is_healthy` state.
2. Run `checkAll()` (parallel probes).
3. For each provider that transitioned healthy → down, fire `onProviderDown`.
4. If `downCount === ALL_PROVIDERS.length`, fire `onAllProvidersDown`.

`onCircuitOpen` and `onQuotaLow` are intended for the cascade router (A8) to
call inline (when it opens a circuit on a 429, or when a `decrementQuota`
returns `remaining` < 10% of the daily limit).

---

## Metrics recording

`recordMetric(env, event)` is the unified entry point for all gateway
telemetry. It writes one row to `provider_calls` per event (extending A2's
schema with the `event_type` + `meta` columns added in migration 0003):

| Event type | When to record | Columns populated |
|------------|----------------|-------------------|
| `call_success` | A real inference call completed. | `latency_ms`, `tokens_in`, `tokens_out`, `status='success'`, `model`. |
| `call_failure` | A real inference call failed. | `error`, `latency_ms`, `status='5xx'\|'429'\|'timeout'`. |
| `fallback_triggered` | The cascade router fell through to the next provider. | `conversation_id`, `meta={from, to}`. |
| `circuit_opened` | The health checker opened a provider's circuit. | `error`, `meta={circuit_open_until, duration_ms}`. |
| `quota_depleted` | A provider hit its daily cap. | `error`, `meta={remaining}`. |
| `feedback_received` | A user rated an assistant response. | `rating` ('up'/'down'), `conversation_id`. ALSO writes a row to `provider_feedback` (A2's table) so `QuotaLedger.getProviderStats()` feedback counter keeps working. |

**Backward compatibility:** A2's `QuotaLedger.recordCall()` continues to
write `event_type=NULL` + `status='success'\|'429'\|...` rows. `getMetrics()`
classifies both styles (event_type when present; status → event_type when
NULL) so the dashboard sees a unified view.

**Hot-path safety:** `recordMetric()` is best-effort — any D1 failure is
logged to `console.error` and swallowed. The cascade router should wrap calls
in `ctx.waitUntil()` so the inference response is returned first.

---

## Dashboard access

There's no `/admin/dashboard` route yet — the `ProviderMonitor` class
exposes the data, the HTTP layer just isn't wired. When added, the route
handler would look like:

```typescript
// In src/index.ts:
if (path === '/admin/dashboard' && method === 'GET') {
  // TODO: verify admin auth (existing password / API key check).
  const monitor = new ProviderMonitor(env);
  const data = await monitor.getDashboardData(env);
  return json(data);
}

if (path === '/admin/dashboard/cascade' && method === 'GET') {
  const monitor = new ProviderMonitor(env);
  const hours = parseInt(new URL(request.url).searchParams.get('hours') ?? '24', 10);
  const stats = await monitor.getCascadeAnalytics(env, hours);
  return json(stats);
}

if (path === '/admin/dashboard/history' && method === 'GET') {
  const monitor = new ProviderMonitor(env);
  const provider = new URL(request.url).searchParams.get('provider') as ProviderId;
  const hours = parseInt(new URL(request.url).searchParams.get('hours') ?? '24', 10);
  const history = await monitor.getProviderHistory(provider, hours);
  return json(history);
}
```

The `DashboardData` shape returned by `getDashboardData()` is designed to be
rendered directly by a future Next.js admin page (the
`cloudflare-pages/` folder in this repo).

---

## Deploying the migration

```bash
# Apply the additive migration (extends provider_calls + creates provider_health_history):
npx wrangler d1 execute micky-db --remote --file=migrations/0003_gateway_monitoring.sql

# Set the provider API key secrets (so the health probes can authenticate):
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put MISTRAL_API_KEY
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put GEMINI_API_KEY

# Deploy the worker (picks up the new cron triggers + code):
npx wrangler deploy
```

If a provider key is missing, the probe for that provider is skipped
(marked 'degraded' with error 'no API key configured') — the rest of the
cron run continues. The system degrades gracefully.

---

## Constraints honoured

- ✅ All TypeScript, edge-compatible (no Node-only APIs).
- ✅ Uses `Promise.allSettled` for parallel health checks.
- ✅ Cron handler returns < 30 s (slowest probe ~8 s, all in parallel).
- ✅ No `any` types — full typing throughout.
- ✅ Every file < 400 lines (`health_checker.ts` 397, `monitoring.ts` 336,
  `alerts.ts` 283, `metrics.ts` 396, `cron_handler.ts` ~75,
  `monitoring_types.ts` 159).
- ✅ Idempotent where possible (ON CONFLICT in the ledger, idempotent
  `resetDailyQuotas`).
- ✅ Best-effort writes on the hot path (D1 failures degrade to
  `console.error`, never throw to the caller).

---

## Open follow-ups (not in A9's scope)

- Wire the `/admin/dashboard` HTTP route (when the admin auth story lands).
- Add a cleanup cron for `provider_health_history` rows older than 30 days
  (currently unbounded growth — ~5 providers × 48 probes/day = ~240 rows/day).
- Layer a short-TTL KV cache in front of `getDashboardData()` if the dashboard
  becomes a hot path (currently every call hits D1 ~7 times).
