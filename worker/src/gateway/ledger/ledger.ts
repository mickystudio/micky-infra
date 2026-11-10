/**
 * QuotaLedger — strongly-consistent provider quota tracking on Cloudflare D1.
 *
 * Replaces the KV-based rate-limit counters. KV is eventually consistent
 * (<=60s propagation), has no conditional/CAS writes, and caps at 1
 * write/sec/key — under concurrency this loses decrements and oversells
 * quota. D1 (single Durable Object per DB, single writer) makes a conditional
 * `UPDATE ... WHERE remaining > 0 RETURNING` atomic: it either decrements
 * and returns the new value, or matches zero rows.
 *
 * Edge-compatible: only the global `D1Database` type + standard `Date`/`Math`.
 * Task: A2 (micky-assistant upgrade). See README.md for full rationale.
 */

// === Types ===

/** A row in `provider_quotas` for a given (provider, model, date). */
export interface QuotaState {
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
  is_healthy: number; // 0 | 1
  circuit_open_until: number;
}

/** Input to recordCall(). `status` is the canonical call outcome. */
export interface ProviderCall {
  provider: string;
  model?: string | null;
  conversation_id?: string | null;
  intent?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  latency_ms?: number | null;
  status: 'success' | '429' | '5xx' | 'timeout' | string;
  error?: string | null;
}

/** Aggregated stats for a provider over a recent window. */
export interface ProviderStats {
  provider: string;
  window_hours: number;
  total_calls: number;
  successful: number;
  rate_limited: number;
  server_errors: number;
  timeouts: number;
  avg_latency_ms: number;
  total_input_tokens: number;
  total_output_tokens: number;
  positive_feedback: number;
  negative_feedback: number;
  is_healthy: boolean;
  circuit_open_until: number;
  remaining_rpd: number | null;
  remaining_tpd: number | null;
}

/** Result of an atomic decrement. `remaining === -1` means unlimited. */
export interface DecrementResult {
  ok: boolean;
  remaining: number; // -1 = unlimited (NULL column)
  remainingTpd?: number; // -1 = unlimited
}

/** Free-tier daily limits per provider (seeded at init + reset daily). */
export interface ProviderLimit {
  rpd: number | null; // requests/day; null = unlimited
  tpd: number | null; // tokens/day; null = unlimited
  rpm: number | null; // requests/min soft cap (informational)
  tpm: number | null; // tokens/min soft cap (informational)
}

// === Provider free-tier limits (11 providers) ===
// Canonical limits used by initLedger() to seed today's rows and by
// resetDailyQuotas() at UTC midnight. Numbers reflect public free-tier docs
// as of late 2025 / early 2026 — re-verify before production tuning. When a
// dedicated `gateway/providers.ts` config is introduced, import from there.
//   rpd = requests/day (hard gate, atomically decremented)
//   tpd = tokens/day (soft gate, decremented by actual usage)
//   null = provider documents "no fixed daily cap" -> unlimited (NULL col)
export const PROVIDER_LIMITS: Record<string, ProviderLimit> = {
  groq1: { rpd: 14400, tpd: 1_000_000, rpm: 30, tpm: 6000 },
  groq2: { rpd: 14400, tpd: 1_000_000, rpm: 30, tpm: 6000 },
  gemini: { rpd: 1500, tpd: 1_000_000, rpm: 15, tpm: 250_000 },
  cerebras: { rpd: 1500, tpd: 500_000, rpm: 10, tpm: 60_000 },
  sambanova: { rpd: 1200, tpd: 500_000, rpm: 10, tpm: 60_000 },
  mistral: { rpd: 500, tpd: 500_000, rpm: 5, tpm: 120_000 },
  openrouter: { rpd: 1000, tpd: 1_000_000, rpm: 20, tpm: 200_000 },
  'workers-ai': { rpd: 10_000, tpd: 5_000_000, rpm: 50, tpm: 500_000 },
  together: { rpd: 1000, tpd: 500_000, rpm: 10, tpm: 100_000 },
  fireworks: { rpd: 1000, tpd: 500_000, rpm: 10, tpm: 100_000 },
  deepinfra: { rpd: 1000, tpd: 500_000, rpm: 10, tpm: 100_000 },
};

/** All known provider names (keys of PROVIDER_LIMITS). */
export const KNOWN_PROVIDERS: string[] = Object.keys(PROVIDER_LIMITS);

// === Helpers ===

const todayKeyUTC = (): string => new Date().toISOString().slice(0, 10);
const nowMs = (): number => Date.now();

/** Coerce a nullable number column to a JS number, mapping NULL -> -1. */
function numOrUnlimited(v: number | null | undefined): number {
  return v === null || v === undefined ? -1 : v;
}

// === QuotaLedger ===

export class QuotaLedger {
  constructor(private readonly db: D1Database) {}

  /** Ensure today's quota row exists for (provider, model). Idempotent. */
  private async ensureTodayRow(provider: string, model: string): Promise<void> {
    const limits = PROVIDER_LIMITS[provider];
    await this.db
      .prepare(
        `INSERT INTO provider_quotas
           (provider, model, date_key, remaining_rpd, remaining_tpd,
            rpm_used, tpm_used, last_request_at, last_429_at,
            consecutive_failures, is_healthy, circuit_open_until)
         VALUES (?, ?, ?, ?, ?, 0, 0, NULL, NULL, 0, 1, 0)
         ON CONFLICT(provider, model, date_key) DO NOTHING`
      )
      .bind(provider, model, todayKeyUTC(), limits?.rpd ?? null, limits?.tpd ?? null)
      .run();
  }

  /**
   * Atomic decrement. Returns ok=false when:
   *   - provider is unknown to PROVIDER_LIMITS, OR
   *   - today's row has remaining_rpd = 0, OR
   *   - is_healthy = 0 (circuit open), OR
   *   - circuit_open_until >= now.
   * The UPDATE...WHERE remaining_rpd > 0 RETURNING is atomic under D1's
   * single-writer model: two concurrent calls cannot both succeed against a
   * row with remaining_rpd = 1.
   */
  async decrementQuota(provider: string, model: string, tokensUsed: number): Promise<DecrementResult> {
    if (!(provider in PROVIDER_LIMITS)) return { ok: false, remaining: 0 };
    const modelKey = model || '*';
    const dateKey = todayKeyUTC();
    const now = nowMs();

    // ensure the row exists (no-op if already seeded by cron/init), then atomic conditional decrement
    await this.ensureTodayRow(provider, modelKey);
    const row = await this.db
      .prepare(
        `UPDATE provider_quotas
            SET remaining_rpd = CASE WHEN remaining_rpd IS NULL THEN NULL
                                      ELSE remaining_rpd - 1 END,
                remaining_tpd = CASE WHEN remaining_tpd IS NULL THEN NULL
                                     ELSE remaining_tpd - ? END,
                last_request_at = ?,
                rpm_used = rpm_used + 1,
                tpm_used = tpm_used + ?
          WHERE provider = ?
            AND model = ?
            AND date_key = ?
            AND (remaining_rpd IS NULL OR remaining_rpd > 0)
            AND is_healthy = 1
            AND circuit_open_until < ?
          RETURNING remaining_rpd, remaining_tpd`
      )
      .bind(tokensUsed, now, tokensUsed, provider, modelKey, dateKey, now)
      .first<{ remaining_rpd: number | null; remaining_tpd: number | null }>();

    if (!row) return { ok: false, remaining: 0 };
    return {
      ok: true,
      remaining: numOrUnlimited(row.remaining_rpd),
      remainingTpd: numOrUnlimited(row.remaining_tpd),
    };
  }

  /** Read current quota state for (provider, model) for today. */
  async getQuota(provider: string, model: string): Promise<QuotaState | null> {
    return this.db
      .prepare(
        `SELECT provider, model, date_key, remaining_rpd, remaining_tpd,
                rpm_used, tpm_used, last_request_at, last_429_at,
                consecutive_failures, is_healthy, circuit_open_until
           FROM provider_quotas
          WHERE provider = ? AND model = ? AND date_key = ?`
      )
      .bind(provider, model || '*', todayKeyUTC())
      .first<QuotaState>();
  }

  /**
   * Daily reset — called by cron at UTC midnight. Inserts fresh rows for
   * TODAY (the new day) for all 11 providers with full daily limits. Old
   * rows remain for history/analytics. Idempotent: ON CONFLICT DO NOTHING.
   */
  async resetDailyQuotas(): Promise<void> {
    const dateKey = todayKeyUTC();
    const stmts = KNOWN_PROVIDERS.map((p) => {
      const lim = PROVIDER_LIMITS[p];
      return this.db
        .prepare(
          `INSERT INTO provider_quotas
             (provider, model, date_key, remaining_rpd, remaining_tpd,
              rpm_used, tpm_used, last_request_at, last_429_at,
              consecutive_failures, is_healthy, circuit_open_until)
           VALUES (?, '*', ?, ?, ?, 0, 0, NULL, NULL, 0, 1, 0)
           ON CONFLICT(provider, model, date_key) DO NOTHING`
        )
        .bind(p, dateKey, lim.rpd, lim.tpd);
    });
    await this.db.batch(stmts);
  }

  /**
   * Toggle provider health / open the circuit breaker.
   * `circuitOpenUntil` (epoch ms) sets when the circuit re-closes; pass 0 (or
   * omit) when re-enabling to close immediately. Resets consecutive_failures
   * on re-enable.
   */
  async setProviderHealthy(provider: string, healthy: boolean, circuitOpenUntil: number = 0): Promise<void> {
    await this.ensureTodayRow(provider, '*');
    await this.db
      .prepare(
        `UPDATE provider_quotas
            SET is_healthy = ?,
                circuit_open_until = ?,
                consecutive_failures = CASE WHEN ? = 1 THEN 0
                                            ELSE consecutive_failures END
          WHERE provider = ? AND model = '*' AND date_key = ?`
      )
      .bind(healthy ? 1 : 0, circuitOpenUntil, healthy ? 1 : 0, provider, todayKeyUTC())
      .run();
  }

  /**
   * Record a 429 / failure. Bumps consecutive_failures and stamps
   * last_429_at. The gateway may then call setProviderHealthy(false, ...) to
   * open the circuit when consecutive_failures exceeds a threshold.
   */
  async record429(provider: string): Promise<void> {
    await this.ensureTodayRow(provider, '*');
    await this.db
      .prepare(
        `UPDATE provider_quotas
            SET last_429_at = ?,
                consecutive_failures = consecutive_failures + 1
          WHERE provider = ? AND model = '*' AND date_key = ?`
      )
      .bind(nowMs(), provider, todayKeyUTC())
      .run();
  }

  /** Append a call to the audit log. */
  async recordCall(call: ProviderCall): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO provider_calls
           (provider, model, conversation_id, intent,
            input_tokens, output_tokens, latency_ms, status, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        call.provider, call.model ?? null, call.conversation_id ?? null,
        call.intent ?? null, call.input_tokens ?? null, call.output_tokens ?? null,
        call.latency_ms ?? null, call.status, call.error ?? null, nowMs()
      )
      .run();
  }

  /** Record user thumbs-up/down feedback for a provider. */
  async recordFeedback(provider: string, rating: 1 | -1, messageId: string, intent?: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO provider_feedback (provider, message_id, rating, intent, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(provider, messageId, rating, intent ?? null, nowMs())
      .run();
  }

  /**
   * Get the sticky provider for a conversation, if any. Returns null when no
   * mapping exists (caller should pick + setStickyProvider).
   */
  async getStickyProvider(conversationId: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT provider FROM conversation_provider_sticky WHERE conversation_id = ?`)
      .bind(conversationId)
      .first<{ provider: string }>();
    return row?.provider ?? null;
  }

  /**
   * Set / refresh the sticky mapping for a conversation. Upsert: first_used_at
   * is preserved on conflict; provider/model/last_used/request_count updated.
   * Switching a conversation to a new provider (after the old one's circuit
   * opened) is allowed.
   */
  async setStickyProvider(conversationId: string, provider: string, model: string): Promise<void> {
    const now = nowMs();
    await this.db
      .prepare(
        `INSERT INTO conversation_provider_sticky
           (conversation_id, provider, model, first_used_at, last_used_at, request_count)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(conversation_id) DO UPDATE SET
           provider = excluded.provider,
           model = excluded.model,
           last_used_at = excluded.last_used_at,
           request_count = request_count + 1`
      )
      .bind(conversationId, provider, model, now, now)
      .run();
  }

  /**
   * Aggregate stats for a provider over the last `lastNHours` (default 24h).
   * Joins provider_calls + provider_feedback + today's quota row.
   */
  async getProviderStats(provider: string, lastNHours: number = 24): Promise<ProviderStats> {
    const since = nowMs() - lastNHours * 3_600_000;

    const c = await this.db
      .prepare(
        `SELECT
           COUNT(*) AS total_calls,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successful,
           SUM(CASE WHEN status = '429'     THEN 1 ELSE 0 END) AS rate_limited,
           SUM(CASE WHEN status = '5xx'     THEN 1 ELSE 0 END) AS server_errors,
           SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END) AS timeouts,
           AVG(latency_ms) AS avg_latency_ms,
           SUM(input_tokens)  AS total_input_tokens,
           SUM(output_tokens) AS total_output_tokens
         FROM provider_calls
         WHERE provider = ? AND created_at >= ?`
      )
      .bind(provider, since)
      .first<Record<string, number | null>>();

    const f = await this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN rating > 0 THEN 1 ELSE 0 END) AS positive,
           SUM(CASE WHEN rating < 0 THEN 1 ELSE 0 END) AS negative
         FROM provider_feedback
         WHERE provider = ? AND created_at >= ?`
      )
      .bind(provider, since)
      .first<{ positive: number | null; negative: number | null }>();

    const quota = await this.getQuota(provider, '*');

    return {
      provider,
      window_hours: lastNHours,
      total_calls: c?.total_calls ?? 0,
      successful: c?.successful ?? 0,
      rate_limited: c?.rate_limited ?? 0,
      server_errors: c?.server_errors ?? 0,
      timeouts: c?.timeouts ?? 0,
      avg_latency_ms: c?.avg_latency_ms ?? 0,
      total_input_tokens: c?.total_input_tokens ?? 0,
      total_output_tokens: c?.total_output_tokens ?? 0,
      positive_feedback: f?.positive ?? 0,
      negative_feedback: f?.negative ?? 0,
      is_healthy: quota ? quota.is_healthy === 1 : true,
      circuit_open_until: quota?.circuit_open_until ?? 0,
      remaining_rpd: quota?.remaining_rpd ?? null,
      remaining_tpd: quota?.remaining_tpd ?? null,
    };
  }

  /**
   * List providers currently usable: is_healthy = 1 AND circuit_open_until <
   * now. Returns distinct provider names from today's provider_quotas rows.
   */
  async getHealthyProviders(): Promise<string[]> {
    const rows = await this.db
      .prepare(
        `SELECT DISTINCT provider
           FROM provider_quotas
          WHERE date_key = ?
            AND is_healthy = 1
            AND circuit_open_until < ?`
      )
      .bind(todayKeyUTC(), nowMs())
      .all<{ provider: string }>();
    return rows.results.map((r) => r.provider);
  }
}
