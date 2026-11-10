/**
 * Micky Assistant Unlimited — Gateway Monitoring (Agent A9)
 *
 * Read-only queries that power the ops dashboard:
 *   - getDashboardData(env)             : one-shot snapshot of every provider
 *   - getProviderHistory(provider, hours): hourly latency/status trend
 *   - getCascadeAnalytics()             : provider-usage mix + fallback rate
 *
 * Pulls from A2's `provider_quotas` / `provider_calls` / `provider_feedback`
 * tables + the new `provider_health_history` (A9's migration 0003). Does NOT
 * mutate any state.
 *
 * All queries are best-effort: a D1 failure logs to console + returns an
 * empty result so the dashboard degrades gracefully.
 *
 * Created: 2026-11-10
 * Phase: A9
 */

import type { Env } from '../index';
import type { ProviderId } from './cascade_types';
import { ALL_PROVIDERS } from './monitoring_types';
import { QuotaLedger } from './ledger/ledger';

// ============ Public types ============

export interface DashboardData {
  generated_at: number;
  cascade: CascadeHealthSummary;
  providers: ProviderDashboardRow[];
  top_providers: ProviderDashboardRow[];   // top 5 by calls_today
  recent_feedback: { up: number; down: number; window_hours: number };
}

export interface CascadeHealthSummary {
  total: number;
  healthy: number;
  degraded: number;
  down: number;
  circuits_open: number;
}

export interface ProviderDashboardRow {
  provider: ProviderId;
  status: 'healthy' | 'degraded' | 'down' | 'unknown';
  is_healthy: boolean;
  circuit_open_until: number;     // epoch ms; 0 = closed
  quota_remaining: { rpd: number; tpd: number };
  calls_today: number;
  tokens_today: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  success_rate: number;            // 0..1
  last_error: string | null;
  last_check_at: number | null;    // epoch ms
}

export interface HistoryPoint {
  bucket_start: number;            // epoch ms (bucket start, hourly)
  status: 'healthy' | 'degraded' | 'down';
  avg_latency_ms: number;
  sample_count: number;
}

export interface CascadeStats {
  provider_usage: Array<{ provider: ProviderId; calls: number; share: number }>;
  total_calls: number;
  total_fallbacks: number;
  fallback_rate: number;            // 0..1
  avg_attempts_before_success: number;
  window_hours: number;
}

// ============ Public: ProviderMonitor ============

/**
 * Stateless read-only dashboard queries. One instance per Worker invocation.
 */
export class ProviderMonitor {
  private readonly ledger: QuotaLedger;

  constructor(private readonly env: Env) {
    this.ledger = new QuotaLedger(env.DB);
  }

  /**
   * One-shot snapshot of every provider + cascade summary + top 5 + recent
   * feedback. Designed to back a future `/admin/dashboard` route.
   */
  async getDashboardData(env: Env): Promise<DashboardData> {
    const now = Date.now();
    const dayStartSec = Math.floor(now / 1000) - 86_400; // last 24h

    // Parallel: pull all per-provider quota rows + last-24h metrics.
    const [providerRows, metricsSummary, feedbackCounts] = await Promise.all([
      this.fetchAllProviderQuotas(),
      this.fetchMetrics(env, dayStartSec, Math.floor(now / 1000)),
      this.fetchFeedbackTotals(env, 24),
    ]);

    const providers: ProviderDashboardRow[] = [];
    let healthy = 0, degraded = 0, down = 0, circuitsOpen = 0;

    for (const provider of ALL_PROVIDERS) {
      const quota = providerRows.get(provider);
      const metrics = metricsSummary.by_provider[provider];

      const status = deriveStatus(quota);
      if (status === 'healthy') healthy++;
      else if (status === 'degraded') degraded++;
      else if (status === 'down') down++;

      const circuitOpenUntil = quota?.circuit_open_until ?? 0;
      if (circuitOpenUntil > now) circuitsOpen++;

      providers.push({
        provider,
        status,
        is_healthy: quota ? quota.is_healthy === 1 : true,
        circuit_open_until: circuitOpenUntil,
        quota_remaining: this.computeRemaining(quota),
        calls_today: quota?.rpm_used ?? 0,
        tokens_today: quota?.tpm_used ?? 0,
        avg_latency_ms: metrics?.avg_latency_ms ?? 0,
        p95_latency_ms: metrics?.p95_latency_ms ?? 0,
        success_rate: metrics?.success_rate ?? 0,
        last_error: quota?.last_429_at ? `429 at ${new Date(quota.last_429_at).toISOString()}` : null,
        last_check_at: quota?.last_request_at ?? null,
      });
    }

    // Top 5 by calls_today (descending).
    const topProviders = providers.slice().sort((a, b) => b.calls_today - a.calls_today).slice(0, 5);

    return {
      generated_at: now,
      cascade: { total: ALL_PROVIDERS.length, healthy, degraded, down, circuits_open: circuitsOpen },
      providers,
      top_providers: topProviders,
      recent_feedback: { ...feedbackCounts, window_hours: 24 },
    };
  }

  /**
   * Hourly trend buckets for one provider — powers the dashboard's latency
   * chart. Reads `provider_health_history` (one row per probe).
   */
  async getProviderHistory(provider: ProviderId, hours: number): Promise<HistoryPoint[]> {
    const nowSec = Math.floor(Date.now() / 1000);
    const fromSec = nowSec - hours * 3600;

    let rows: HistoryRow[] = [];
    try {
      const result = await this.env.DB.prepare(
        `SELECT status, latency_ms, checked_at
           FROM provider_health_history
          WHERE provider = ? AND checked_at >= ?
          ORDER BY checked_at ASC
          LIMIT 5000`,
      ).bind(provider, fromSec).all<HistoryRow>();
      rows = result.results ?? [];
    } catch (err) {
      console.error(`[monitor] getProviderHistory failed: ${String(err)}`);
    }

    // Bucket by hour. Each bucket: avg latency + sample count + worst status.
    const buckets = new Map<number, { latencies: number[]; statuses: Set<string> }>();
    for (const row of rows) {
      const bucketStart = Math.floor(row.checked_at / 3600) * 3600; // epoch sec
      let b = buckets.get(bucketStart);
      if (!b) {
        b = { latencies: [], statuses: new Set<string>() };
        buckets.set(bucketStart, b);
      }
      if (row.latency_ms != null) b.latencies.push(row.latency_ms);
      b.statuses.add(row.status);
    }

    const out: HistoryPoint[] = [];
    for (const [bucketStartSec, b] of buckets) {
      const avg = b.latencies.length > 0
        ? Math.round(b.latencies.reduce((s, n) => s + n, 0) / b.latencies.length)
        : 0;
      // Worst status wins for the bucket: down > degraded > healthy.
      let status: 'healthy' | 'degraded' | 'down' = 'healthy';
      if (b.statuses.has('down')) status = 'down';
      else if (b.statuses.has('degraded')) status = 'degraded';
      out.push({
        bucket_start: bucketStartSec * 1000, // epoch ms
        status,
        avg_latency_ms: avg,
        sample_count: b.latencies.length,
      });
    }
    out.sort((a, b) => a.bucket_start - b.bucket_start);
    return out;
  }

  /**
   * Cascade analytics over the last `hours` (default 24h):
   *   - per-provider call counts + share of total
   *   - fallback rate = fallback_triggered / total_calls
   *   - avg attempts before success = (total_calls + total_fallbacks) / successful_calls
   */
  async getCascadeAnalytics(env: Env, hours: number = 24): Promise<CascadeStats> {
    const nowSec = Math.floor(Date.now() / 1000);
    const fromSec = nowSec - hours * 3600;

    const metrics = await this.fetchMetrics(env, fromSec, nowSec);

    const providerUsage: Array<{ provider: ProviderId; calls: number; share: number }> = [];
    let totalCalls = 0;
    let totalFallbacks = 0;
    let totalSuccessful = 0;

    for (const provider of ALL_PROVIDERS) {
      const m = metrics.by_provider[provider];
      const calls = m?.total_calls ?? 0;
      totalCalls += calls;
      totalFallbacks += m?.fallbacks_triggered ?? 0;
      totalSuccessful += m?.successful_calls ?? 0;
      providerUsage.push({ provider, calls, share: 0 }); // share computed below
    }
    for (const p of providerUsage) {
      p.share = totalCalls > 0 ? p.calls / totalCalls : 0;
    }
    providerUsage.sort((a, b) => b.calls - a.calls);

    const fallbackRate = totalCalls > 0 ? totalFallbacks / totalCalls : 0;
    // avg attempts = (calls + fallbacks) / successful — each fallback is an
    // extra attempt that didn't directly succeed but contributed to a
    // successful final call.
    const avgAttempts = totalSuccessful > 0
      ? (totalCalls + totalFallbacks) / totalSuccessful
      : 0;

    return {
      provider_usage: providerUsage,
      total_calls: totalCalls,
      total_fallbacks: totalFallbacks,
      fallback_rate: fallbackRate,
      avg_attempts_before_success: avgAttempts,
      window_hours: hours,
    };
  }

  // ============ Internal: data fetchers ============

  /** Pull today's quota row for every provider in ALL_PROVIDERS. */
  private async fetchAllProviderQuotas(): Promise<Map<ProviderId, QuotaRow>> {
    const out = new Map<ProviderId, QuotaRow>();
    const dateKey = new Date().toISOString().slice(0, 10);
    try {
      const result = await this.env.DB.prepare(
        `SELECT provider, model, date_key, remaining_rpd, remaining_tpd,
                rpm_used, tpm_used, last_request_at, last_429_at,
                consecutive_failures, is_healthy, circuit_open_until
           FROM provider_quotas
          WHERE date_key = ? AND model = '*'`,
      ).bind(dateKey).all<QuotaRow>();
      for (const row of result.results ?? []) {
        out.set(row.provider as ProviderId, row);
      }
    } catch (err) {
      console.error(`[monitor] fetchAllProviderQuotas failed: ${String(err)}`);
    }
    return out;
  }

  /** Wrap the metrics module's getMetrics so the dashboard doesn't import it directly. */
  private async fetchMetrics(env: Env, fromSec: number, toSec: number) {
    const { getMetrics } = await import('./metrics');
    return getMetrics(env, { from: fromSec, to: toSec });
  }

  /** Total 👍/👎 counts over the last `hours` (across all providers). */
  private async fetchFeedbackTotals(env: Env, hours: number): Promise<{ up: number; down: number }> {
    const fromSec = Math.floor(Date.now() / 1000) - hours * 3600;
    try {
      const row = await env.DB.prepare(
        `SELECT
           SUM(CASE WHEN rating > 0 THEN 1 ELSE 0 END) AS up,
           SUM(CASE WHEN rating < 0 THEN 1 ELSE 0 END) AS down
         FROM provider_feedback
        WHERE created_at >= ?`,
      ).bind(fromSec).first<{ up: number | null; down: number | null }>();
      return { up: row?.up ?? 0, down: row?.down ?? 0 };
    } catch (err) {
      console.error(`[monitor] fetchFeedbackTotals failed: ${String(err)}`);
      return { up: 0, down: 0 };
    }
  }

  /** Compute (rpd, tpd) remaining. NULL → unlimited (Infinity). */
  private computeRemaining(quota: QuotaRow | undefined): { rpd: number; tpd: number } {
    if (!quota) return { rpd: Number.POSITIVE_INFINITY, tpd: Number.POSITIVE_INFINITY };
    return {
      rpd: quota.remaining_rpd === null ? Number.POSITIVE_INFINITY : Math.max(0, quota.remaining_rpd),
      tpd: quota.remaining_tpd === null ? Number.POSITIVE_INFINITY : Math.max(0, quota.remaining_tpd),
    };
  }
}

// ============ Helpers ============

/** Derive a display status from today's quota row. */
function deriveStatus(quota: QuotaRow | undefined): 'healthy' | 'degraded' | 'down' | 'unknown' {
  if (!quota) return 'unknown';
  if (quota.is_healthy === 0) return 'down';
  if (quota.circuit_open_until > Date.now()) return 'down';
  if (quota.consecutive_failures > 0) return 'degraded';
  return 'healthy';
}

// ============ Internal D1 row shapes ============

interface QuotaRow {
  provider: string;
  model: string;
  date_key: string;
  remaining_rpd: number | null;
  remaining_tpd: number | null;
  rpm_used: number;
  tpm_used: number;
  last_request_at: number | null;
  last_429_at: number | null;
  consecutive_failures: number;
  is_healthy: number;
  circuit_open_until: number;
}

interface HistoryRow {
  status: 'healthy' | 'degraded' | 'down';
  latency_ms: number | null;
  checked_at: number;
}
