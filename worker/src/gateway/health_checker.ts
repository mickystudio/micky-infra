/**
 * Micky Assistant Unlimited — Gateway Health Checker (Agent A9)
 *
 * Lightweight probes against each provider in the cascade, run on a Cron
 * Trigger every 30 minutes. Updates the D1 `provider_quotas` ledger
 * (is_healthy + circuit_open_until) via A2's `QuotaLedger` and writes one
 * row to `provider_health_history` per probe for trend analysis.
 *
 * Probe kinds (per PROVIDER_PROBES in monitoring_types.ts):
 *   - 'models'      : GET the provider's /models endpoint. Cheap, no token cost.
 *   - 'completion'  : POST a 1-token completion. Used for Cloudflare Workers AI.
 *
 * Status thresholds:
 *   healthy  : probe ok, latency <  DEGRADED_LATENCY_MS (3000 ms)
 *   degraded : probe ok, latency >= DEGRADED_LATENCY_MS
 *   down     : probe failed (network error, non-2xx, or timeout)
 *
 * Circuit breaker (delegated to QuotaLedger.setProviderHealthy):
 *   down     → circuit_open_until = now + backoff (escalating: 1, 5, 15, 30 min)
 *   healthy  → circuit_open_until = 0, consecutive_failures reset
 *   degraded → circuit stays as-is (degraded ≠ down)
 */

import type { Env } from '../index';
import type { ProviderId } from './cascade_types';
import {
  ALL_PROVIDERS,
  PROVIDER_PROBES,
  type HealthReport,
  type HealthStatus,
  type ProviderProbe,
} from './monitoring_types';
import { AlertManager } from './alerts';
import { recordMetric } from './metrics';
import { QuotaLedger } from './ledger/ledger';


/** Latency threshold above which a successful probe is marked 'degraded'. */
const DEGRADED_LATENCY_MS = 3000;

/** Per-probe timeout (ms). Anything slower is treated as 'down'. */
const PROBE_TIMEOUT_MS = 8000;

/** Backoff schedule (ms) for the circuit breaker — escalating. */
const CIRCUIT_BACKOFF_MS = [
  60_000,      // 1st failure:  1 min
  5 * 60_000,  // 2nd failure:  5 min
  15 * 60_000, // 3rd failure: 15 min
  30 * 60_000, // 4th+:         30 min (capped)
];


/**
 * Probes providers and persists the results to D1.
 *
 * One instance per Worker invocation. Methods are safe to call in parallel
 * (each opens its own D1 prepared statement).
 *
 * Uses A2's QuotaLedger for the is_healthy / circuit_open_until updates so
 * the cascade router (A8) reads the same source of truth.
 */
export class HealthChecker {
  private readonly ledger: QuotaLedger;

  constructor(private readonly env: Env) {
    this.ledger = new QuotaLedger(env.DB);
  }

  /**
   * Probe every provider in parallel (Promise.allSettled).
   *
   * Never throws — a probe that rejects is wrapped into a 'down' report.
   */
  async checkAll(): Promise<HealthReport[]> {
    const probes = PROVIDER_PROBES;
    const settled = await Promise.allSettled(
      probes.map((p) => this.checkOne(p.provider)),
    );
    return settled.map((s, i) => {
      const provider = probes[i].provider;
      if (s.status === 'fulfilled') return s.value;
      return {
        provider,
        status: 'down' as HealthStatus,
        latency_ms: 0,
        error: String(s.reason),
        checked_at: Date.now(),
      } satisfies HealthReport;
    });
  }

  /**
   * Probe a single provider + persist the result to D1.
   *
   * @throws only if the provider id is unknown (programming error).
   */
  async checkOne(provider: ProviderId): Promise<HealthReport> {
    const probe = PROVIDER_PROBES.find((p) => p.provider === provider);
    if (!probe) {
      throw new Error(`[health] unknown provider: ${provider}`);
    }

    const startedAt = Date.now();
    let status: HealthStatus;
    let error: string | undefined;
    let quotaRemaining: { rpd: number; tpd: number } | undefined;

    try {
      quotaRemaining = await this.runProbe(probe);
      const latency = Date.now() - startedAt;
      status = latency >= DEGRADED_LATENCY_MS ? 'degraded' : 'healthy';
    } catch (err) {
      status = 'down';
      error = truncate(String(err), 300);
    }

    const latencyMs = status === 'down' ? 0 : Date.now() - startedAt;
    const report: HealthReport = {
      provider,
      status,
      latency_ms: latencyMs,
      error,
      checked_at: Date.now(),
      quota_remaining: quotaRemaining,
    };

    // Persist ledger + history. Best-effort: a D1 outage must not crash the cron.
    try {
      await this.updateLedger(report);
    } catch (err) {
      console.error(`[health] updateLedger(${provider}) failed: ${String(err)}`);
    }
    try {
      await this.recordHistory(report);
    } catch (err) {
      console.error(`[health] recordHistory(${provider}) failed: ${String(err)}`);
    }

    return report;
  }

  // ============ Internal: probe dispatch ============

  /**
   * Dispatch to the right probe based on `probe.probeType`.
   *
   * Returns the remaining daily quota (rpd, tpd) if computable — read from
   * the QuotaLedger so the dashboard can show "X / Y today".
   *
   * @throws on any probe failure (caller wraps into 'down' status).
   */
  private async runProbe(probe: ProviderProbe): Promise<{ rpd: number; tpd: number }> {
    if (probe.provider === 'workers-ai') {
      await this.probeCloudflare(probe);
    } else if (probe.probeType === 'models') {
      await this.probeModels(probe);
    } else {
      await this.probeCompletion(probe);
    }

    // Quota snapshot from the ledger (best-effort — never fail the probe on this).
    const quota = await this.ledger.getQuota(probe.provider, '*');
    return this.computeQuotaRemaining(quota);
  }

  /** Cloudflare Workers AI — 1-token completion via the AI binding. */
  private async probeCloudflare(probe: ProviderProbe): Promise<void> {
    // env.AI.run doesn't accept an AbortSignal, but the binding enforces a
    // ~30s timeout. We rely on the binding behaviour here.
    const res = (await this.env.AI.run(probe.probeModel, {
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    })) as { response?: string };
    if (!res || typeof res.response !== 'string') {
      throw new Error('Workers AI returned malformed response');
    }
  }

  /** OpenAI-compatible /models GET. */
  private async probeModels(probe: ProviderProbe): Promise<void> {
    if (!probe.modelsUrl) throw new Error('no modelsUrl configured');
    const apiKey = this.requireApiKey(probe);
    const url = probe.provider === 'gemini'
      ? `${probe.modelsUrl}?key=${encodeURIComponent(apiKey)}`
      : probe.modelsUrl;
    const json = await this.fetchJson(probe, url, 'GET', undefined, apiKey);
    if (!json || (!json.data && !json.models)) {
      throw new Error('models response missing data/models array');
    }
  }

  /** 1-token completion POST (OpenAI-compatible). Used for deeper probes. */
  private async probeCompletion(probe: ProviderProbe): Promise<void> {
    if (!probe.completionUrl) throw new Error('no completionUrl configured');
    const apiKey = this.requireApiKey(probe);
    const body = JSON.stringify({
      model: probe.probeModel,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    });
    await this.fetchJson(probe, probe.completionUrl, 'POST', body, apiKey);
  }

  /**
   * Shared HTTP fetch with AbortController timeout + non-2xx error handling.
   * Used by both probeModels (GET) and probeCompletion (POST).
   */
  private async fetchJson(
    probe: ProviderProbe,
    url: string,
    method: 'GET' | 'POST',
    body: string | undefined,
    apiKey: string,
  ): Promise<{ data?: unknown[]; models?: unknown[] } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { ...buildAuthHeaders(probe.provider, apiKey) };
      if (method === 'POST') headers['Content-Type'] = 'application/json';
      const res = await fetch(url, { method, signal: controller.signal, headers, body });
      if (!res.ok) {
        const text = await res.text().catch(() => '(no body)');
        throw new Error(`HTTP ${res.status}: ${truncate(text, 120)}`);
      }
      return (await res.json()) as { data?: unknown[]; models?: unknown[] };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resolve + throw if the API key is missing (non-cloudflare providers). */
  private requireApiKey(probe: ProviderProbe): string {
    const apiKey = this.resolveApiKey(probe);
    if (!apiKey) throw new Error('no API key configured');
    return apiKey;
  }

  /** Update provider_quotas via QuotaLedger + record a 'circuit_opened' metric on healthy→down. */
  private async updateLedger(report: HealthReport): Promise<void> {
    const now = Date.now();
    const beforeQuota = await this.ledger.getQuota(report.provider, '*');
    const wasHealthy = beforeQuota ? beforeQuota.is_healthy === 1 : true;
    const isHealthy = report.status !== 'down';

    let circuitOpenUntilMs = 0;
    let durationMs = 0;
    if (report.status === 'down') {
      const consecutiveFailures = (beforeQuota?.consecutive_failures ?? 0) + 1;
      const backoffIdx = Math.min(
        Math.max(0, consecutiveFailures - 1),
        CIRCUIT_BACKOFF_MS.length - 1,
      );
      const backoffMs = CIRCUIT_BACKOFF_MS[backoffIdx];
      circuitOpenUntilMs = now + backoffMs;
      durationMs = backoffMs;
      await this.ledger.record429(report.provider).catch(() => {/* best-effort */});
    }

    await this.ledger.setProviderHealthy(report.provider, isHealthy, circuitOpenUntilMs);

    if (report.status === 'down' && wasHealthy) {
      await recordMetric(this.env, {
        provider: report.provider,
        type: 'circuit_opened',
        error: report.error,
        meta: { circuit_open_until: circuitOpenUntilMs, duration_ms: durationMs },
      }).catch(() => {/* metrics failure must not break the cron */});
    }
  }

  /** Append a row to provider_health_history for trend charts. */
  private async recordHistory(report: HealthReport): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const quota = report.quota_remaining;
    await this.env.DB.prepare(
      `INSERT INTO provider_health_history
         (provider, status, latency_ms, error,
          quota_rpd_remaining, quota_tpd_remaining, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      report.provider, report.status,
      report.latency_ms || null, report.error ?? null,
      quota?.rpd ?? null, quota?.tpd ?? null, now,
    ).run();
  }

  /** Compute (rpd, tpd) remaining. NULL → unlimited (Number.POSITIVE_INFINITY). */
  private computeQuotaRemaining(
    quota: { remaining_rpd: number | null; remaining_tpd: number | null } | null,
  ): { rpd: number; tpd: number } {
    if (!quota) {
      return { rpd: Number.POSITIVE_INFINITY, tpd: Number.POSITIVE_INFINITY };
    }
    const rpd = quota.remaining_rpd === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, quota.remaining_rpd);
    const tpd = quota.remaining_tpd === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, quota.remaining_tpd);
    return { rpd, tpd };
  }

  /** Resolve the API key for a provider from env. null = missing. */
  private resolveApiKey(probe: ProviderProbe): string | null {
    if (probe.apiKeyEnv === 'AI_BINDING') return null; // cloudflare uses env.AI directly
    const value = (this.env as unknown as Record<string, unknown>)[probe.apiKeyEnv];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }
}


/**
 * Cron entry point — called by `scheduled()` every 30 min.
 *
 * Runs checkAll() in parallel (Promise.allSettled inside checkAll), updates
 * the ledger, sends Telegram alerts on healthy→down transitions, and fires
 * onAllProvidersDown when the whole cascade is dead. The actual work is
 * deferred via ctx.waitUntil() so this returns immediately; total wall time
 * is bounded by the slowest probe (~8s) — well under the 30s Cron CPU limit.
 */
export async function runHealthCheckCron(env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(executeHealthCheckCron(env));
}

async function executeHealthCheckCron(env: Env): Promise<void> {
  const startedAt = Date.now();
  console.log('[health-cron] starting full provider probe');

  const checker = new HealthChecker(env);

  // Snapshot pre-probe is_healthy for transition detection.
  const beforeStates = await snapshotHealthStates(env).catch(
    () => new Map<ProviderId, boolean>(),
  );

  // Run all probes in parallel (Promise.allSettled is inside checkAll).
  const reports = await checker.checkAll();

  const alerts = new AlertManager();
  let downCount = 0;

  for (const report of reports) {
    if (report.status === 'down') downCount++;

    const wasHealthy = beforeStates.get(report.provider) === true;
    if (report.status === 'down' && wasHealthy) {
      // Fire-and-forget — don't block the cron on Telegram.
      alerts.onProviderDown(env, report.provider, report.error ?? 'probe failed')
        .catch((e) => console.error(`[health-cron] alert failed: ${String(e)}`));
    }
  }

  // CRITICAL: all providers down.
  if (downCount === ALL_PROVIDERS.length) {
    alerts.onAllProvidersDown(env)
      .catch((e) => console.error(`[health-cron] critical alert failed: ${String(e)}`));
  }

  const elapsed = Date.now() - startedAt;
  console.log(
    `[health-cron] complete in ${elapsed}ms — ` +
    `${reports.filter((r) => r.status === 'healthy').length} healthy, ` +
    `${reports.filter((r) => r.status === 'degraded').length} degraded, ` +
    `${downCount} down`,
  );
}


async function snapshotHealthStates(env: Env): Promise<Map<ProviderId, boolean>> {
  const out = new Map<ProviderId, boolean>();
  try {
    const result = await env.DB.prepare(
      `SELECT DISTINCT provider, is_healthy
         FROM provider_quotas
        WHERE date_key = ?`,
    ).bind(todayKeyUTC()).all<{ provider: ProviderId; is_healthy: number }>();
    for (const row of result.results ?? []) {
      out.set(row.provider, row.is_healthy === 1);
    }
  } catch (err) {
    console.error(`[health] snapshotHealthStates failed: ${String(err)}`);
  }
  return out;
}

/** Current UTC date as YYYY-MM-DD (matches ledger.ts). Gemini uses query-string auth. */
function todayKeyUTC(): string { return new Date().toISOString().slice(0, 10); }

function buildAuthHeaders(provider: ProviderId, apiKey: string): Record<string, string> {
  if (provider === 'gemini') return {};
  return { Authorization: `Bearer ${apiKey}` };
}

/** Truncate to `max` chars with ellipsis. */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}
