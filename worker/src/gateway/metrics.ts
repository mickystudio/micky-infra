/**
 * Micky Assistant Unlimited — Gateway Metrics
 * ----------------------------------------------------------------------------
 * Agent: A9 (background health checking + monitoring)
 *
 * Append-only metric events written to the D1 `provider_calls` table (same
 * table A2's QuotaLedger writes call audit rows to). Backward-compatible:
 *   - A2's recordCall() writes event_type=NULL + status='success'|'429'|...
 *   - recordMetric() writes event_type=<MetricEventType> (+ status for calls).
 *
 * Event types:
 *   call_success | call_failure | fallback_triggered | circuit_opened |
 *   quota_depleted | feedback_received
 *     (feedback_received ALSO writes a row to provider_feedback for the
 *      A2-style rating INTEGER column — keeps QuotaLedger.getProviderStats()
 *      working.)
 *
 * Two entry points:
 *   recordMetric(env, event)   — fire-and-forget insert (one row per event)
 *   getMetrics(env, timeRange) — aggregate summary over [from, to]
 *
 * All writes are best-effort: a D1 outage degrades to console.error and the
 * caller is never blocked (recordMetric is on the hot inference path).
 *
 * Created: 2026-11-10
 * Phase: A9
 */

import type { Env } from '../index';
import type { ProviderId } from './cascade_types';


export type MetricEventType =
  | 'call_success'
  | 'call_failure'
  | 'fallback_triggered'
  | 'circuit_opened'
  | 'quota_depleted'
  | 'feedback_received';

/** Discriminated union — one row per metric event. */
export interface MetricEvent {
  provider: ProviderId;
  type: MetricEventType;
  model?: string;
  latency_ms?: number;
  success?: boolean;
  error?: string;
  tokens_in?: number;
  tokens_out?: number;
  /** 'up' | 'down' — feedback_received only. */
  rating?: 'up' | 'down';
  conversation_id?: string;
  intent?: string;
  chat_id?: number;
  /** Ad-hoc structured fields (JSON-serialized into the `meta` column). */
  meta?: Record<string, unknown>;
}

/** Aggregate metrics over a time window — returned by getMetrics(). */
export interface MetricsSummary {
  from: number;
  to: number;
  total_events: number;
  by_provider: Record<string, ProviderMetrics>;
  by_event_type: Record<MetricEventType, number>;
}

export interface ProviderMetrics {
  provider: ProviderId;
  total_calls: number;
  successful_calls: number;
  failed_calls: number;
  fallbacks_triggered: number;
  circuits_opened: number;
  quotas_depleted: number;
  feedback_up: number;
  feedback_down: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  success_rate: number; // 0..1
}


/** Cap on the meta JSON blob length — guards against accidental large payloads. */
const MAX_META_JSON_LENGTH = 2048;


/**
 * Append a metric event to the D1 `provider_calls` table.
 *
 * For `feedback_received` events, ALSO writes a row to `provider_feedback`
 * (A2's table) so QuotaLedger.getProviderStats() feedback counter keeps working.
 * Best-effort: any D1 failure is logged + swallowed. Callers on the hot path
 * should wrap in ctx.waitUntil() rather than await.
 */
export async function recordMetric(env: Env, event: MetricEvent): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const metaJson = event.meta ? safeStringify(event.meta) : null;
  const truncatedMeta = metaJson && metaJson.length > MAX_META_JSON_LENGTH
    ? metaJson.slice(0, MAX_META_JSON_LENGTH) + '…(truncated)'
    : metaJson;

  // Map MetricEvent → provider_calls row (A2's schema + the new event_type/meta cols).
  const status = mapEventTypeToStatus(event);

  try {
    await env.DB.prepare(
      `INSERT INTO provider_calls
         (provider, model, conversation_id, intent,
          input_tokens, output_tokens, latency_ms,
          status, error, created_at,
          event_type, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      event.provider,
      event.model ?? null,
      event.conversation_id ?? null,
      event.intent ?? null,
      event.tokens_in ?? null,
      event.tokens_out ?? null,
      event.latency_ms ?? null,
      status,
      event.error ?? null,
      now,
      event.type,
      truncatedMeta,
    ).run();
  } catch (err) {
    // Never throw on the hot path.
    console.error(
      `[metrics] D1 insert failed for ${event.provider}/${event.type}: ${String(err)}`,
    );
    return false;
  }

  // For feedback events, ALSO write to provider_feedback (A2's table) so
  // QuotaLedger.getProviderStats() can join feedback counts.
  if (event.type === 'feedback_received' && event.rating) {
    try {
      await env.DB.prepare(
        `INSERT INTO provider_feedback
           (provider, message_id, rating, intent, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        event.provider,
        event.conversation_id ?? null, // re-use conversation_id slot for message_id when absent
        event.rating === 'up' ? 1 : -1,
        event.intent ?? null,
        now,
      ).run();
    } catch (err) {
      console.error(`[metrics] provider_feedback insert failed: ${String(err)}`);
    }
  }

  return true;
}


/**
 * Aggregate provider_calls over a time window — per-provider counts +
 * avg/p95 latency + overall event-type counts. Reads BOTH A2's call audit
 * rows (event_type IS NULL) AND recordMetric's event rows.
 */
export async function getMetrics(
  env: Env,
  timeRange: { from: number; to: number },
): Promise<MetricsSummary> {
  const { from, to } = timeRange;

  let rows: ProviderCallRow[] = [];
  try {
    const result = await env.DB.prepare(
      `SELECT provider, event_type, model, status, latency_ms, error,
              input_tokens, output_tokens, intent, conversation_id, created_at
         FROM provider_calls
        WHERE created_at >= ? AND created_at <= ?
        ORDER BY created_at ASC
        LIMIT 5000`,
    ).bind(from, to).all<ProviderCallRow>();
    rows = result.results ?? [];
  } catch (err) {
    console.error(`[metrics] getMetrics query failed: ${String(err)}`);
  }

  // ============ Aggregate in-JS (cheaper than 5 D1 GROUP BYs) ============
  const byProvider = new Map<ProviderId, ProviderMetrics>();
  const byEventType: Record<MetricEventType, number> = {
    call_success: 0,
    call_failure: 0,
    fallback_triggered: 0,
    circuit_opened: 0,
    quota_depleted: 0,
    feedback_received: 0,
  };

  for (const row of rows) {
    const evt = classifyRow(row);
    if (evt) byEventType[evt] = (byEventType[evt] ?? 0) + 1;

    const provider = row.provider as ProviderId;
    let agg = byProvider.get(provider);
    if (!agg) {
      agg = newEmptyProviderMetrics(provider);
      byProvider.set(provider, agg);
    }

    switch (evt) {
      case 'call_success':
        agg.total_calls++;
        agg.successful_calls++;
        break;
      case 'call_failure':
        agg.total_calls++;
        agg.failed_calls++;
        break;
      case 'fallback_triggered':
        agg.fallbacks_triggered++;
        break;
      case 'circuit_opened':
        agg.circuits_opened++;
        break;
      case 'quota_depleted':
        agg.quotas_depleted++;
        break;
      case 'feedback_received':
        // feedback rows live in provider_feedback, not provider_calls —
        // counted separately below via the feedback table.
        break;
    }
  }

  // Feedback counts come from provider_feedback (A2's table), not provider_calls.
  const feedbackCounts = await fetchFeedbackCounts(env, timeRange);
  for (const [provider, counts] of feedbackCounts) {
    let agg = byProvider.get(provider);
    if (!agg) {
      agg = newEmptyProviderMetrics(provider);
      byProvider.set(provider, agg);
    }
    agg.feedback_up = counts.up;
    agg.feedback_down = counts.down;
    byEventType.feedback_received += counts.up + counts.down;
  }

  // Compute avg + p95 latency in a second pass (only over call events).
  const byProviderCalls = new Map<ProviderId, number[]>();
  for (const row of rows) {
    const evt = classifyRow(row);
    if (evt !== 'call_success' && evt !== 'call_failure') continue;
    if (row.latency_ms == null) continue;
    const provider = row.provider as ProviderId;
    let arr = byProviderCalls.get(provider);
    if (!arr) {
      arr = [];
      byProviderCalls.set(provider, arr);
    }
    arr.push(row.latency_ms);
  }

  const byProviderOut: Record<string, ProviderMetrics> = {};
  for (const [provider, agg] of byProvider) {
    const latencies = byProviderCalls.get(provider) ?? [];
    latencies.sort((a, b) => a - b);
    if (latencies.length > 0) {
      agg.avg_latency_ms = Math.round(
        latencies.reduce((s, n) => s + n, 0) / latencies.length,
      );
      const p95Idx = Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95));
      agg.p95_latency_ms = latencies[p95Idx] ?? 0;
    }
    agg.success_rate = agg.total_calls > 0
      ? agg.successful_calls / agg.total_calls
      : 0;
    byProviderOut[provider] = agg;
  }

  return {
    from,
    to,
    total_events: rows.length,
    by_provider: byProviderOut,
    by_event_type: byEventType,
  };
}


/**
 * Classify a provider_calls row into a MetricEventType.
 *
 * - Rows written by recordMetric(): event_type is set → use it directly.
 * - Rows written by A2's QuotaLedger.recordCall(): event_type is NULL → map
 *   status 'success' → call_success, '429'/'5xx'/'timeout' → call_failure,
 *   anything else → null (skip).
 */
function classifyRow(row: ProviderCallRow): MetricEventType | null {
  if (row.event_type) return row.event_type as MetricEventType;
  // A2-style call audit row.
  switch (row.status) {
    case 'success': return 'call_success';
    case '429':
    case '5xx':
    case 'timeout': return 'call_failure';
    default: return null;
  }
}

/**
 * Map a MetricEvent to the `status` column value (A2's convention).
 *
 * Non-call events get status=NULL (they have event_type set instead).
 */
function mapEventTypeToStatus(event: MetricEvent): string | null {
  switch (event.type) {
    case 'call_success': return 'success';
    case 'call_failure':
      // Infer a coarse status bucket from the error string if available.
      if (!event.error) return '5xx';
      const e = event.error.toLowerCase();
      if (e.includes('timeout')) return 'timeout';
      if (e.includes('429') || e.includes('rate limit')) return '429';
      return '5xx';
    default: return null; // non-call events: status is meaningless
  }
}

/** Pull feedback counts from provider_feedback (A2's table). Returns a per-provider map. */
async function fetchFeedbackCounts(
  env: Env,
  timeRange: { from: number; to: number },
): Promise<Map<ProviderId, { up: number; down: number }>> {
  const out = new Map<ProviderId, { up: number; down: number }>();
  try {
    const rows = await env.DB.prepare(
      `SELECT provider,
              SUM(CASE WHEN rating > 0 THEN 1 ELSE 0 END) AS up,
              SUM(CASE WHEN rating < 0 THEN 1 ELSE 0 END) AS down
         FROM provider_feedback
        WHERE created_at >= ? AND created_at <= ?
        GROUP BY provider`,
    ).bind(timeRange.from, timeRange.to).all<{ provider: string; up: number; down: number }>();

    for (const row of rows.results ?? []) {
      const provider = row.provider as ProviderId;
      out.set(provider, { up: row.up ?? 0, down: row.down ?? 0 });
    }
  } catch (err) {
    console.error(`[metrics] fetchFeedbackCounts failed: ${String(err)}`);
  }
  return out;
}

function newEmptyProviderMetrics(provider: ProviderId): ProviderMetrics {
  return {
    provider,
    total_calls: 0,
    successful_calls: 0,
    failed_calls: 0,
    fallbacks_triggered: 0,
    circuits_opened: 0,
    quotas_depleted: 0,
    feedback_up: 0,
    feedback_down: 0,
    avg_latency_ms: 0,
    p95_latency_ms: 0,
    success_rate: 0,
  };
}

/** Safe JSON.stringify — tolerates circular references and BigInt. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'bigint') return val.toString();
      return val;
    });
  } catch {
    return String(value);
  }
}


interface ProviderCallRow {
  provider: string;
  event_type: string | null;
  model: string | null;
  status: string | null;
  latency_ms: number | null;
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  intent: string | null;
  conversation_id: string | null;
  created_at: number;
}
