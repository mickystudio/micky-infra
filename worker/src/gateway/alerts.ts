/**
 * Micky Assistant Unlimited — Gateway Alert Manager
 * ----------------------------------------------------------------------------
 * Agent: A9 (background health checking + monitoring)
 *
 * Sends Telegram alerts to the bot admin (env.ADMIN_CHAT_ID) when bad things
 * happen in the multi-provider LLM gateway:
 *
 *   notifyAdmin(env, message)                  — generic message
 *   onProviderDown(env, provider, error)      — provider just went down
 *   onCircuitOpen(env, provider, durationMs)   — circuit breaker opened
 *   onAllProvidersDown(env)                    — CRITICAL: cascade exhausted
 *   onQuotaLow(env, provider, remaining)       — <10% daily quota left
 *
 * Alert rate-limiting:
 *   To avoid flooding the admin's chat when a provider flaps, each (provider,
 *   alertType) pair is rate-limited to at most 1 message per 10 minutes via a
 *   KV key with a 600s TTL.
 *
 *   The single exception is onAllProvidersDown() — that is treated as
 *   CRITICAL and bypasses the rate-limit (because it means every user-facing
 *   request is currently failing).
 *
 * KV namespace:
 *   Prefers env.PROVIDER_ALERTS if bound (see wrangler.toml). Falls back to
 *   env.RATE_LIMITS so the system works with the existing bindings.
 *
 * Created: 2026-11-10
 * Phase: A9
 */

import type { Env } from '../index';
import type { ProviderId } from './cascade_types';
import type { AlertEnv } from './monitoring_types';

// ============ Constants ============

/** KV TTL (seconds) for the per-(provider,alert) rate-limit key. */
const ALERT_RATE_LIMIT_TTL_SECONDS = 600; // 10 minutes

/** Emoji prefix per alert severity (used in the Telegram message). */
const SEVERITY_EMOJI: Record<AlertSeverityKind, string> = {
  info: 'ℹ️',
  warning: '⚠️',
  critical: '🚨',
};

type AlertSeverityKind = 'info' | 'warning' | 'critical';

/** Per-alert-type severity — drives the emoji + the rate-limit decision. */
const ALERT_SEVERITY: Record<AlertKind, AlertSeverityKind> = {
  provider_down: 'warning',
  circuit_open: 'warning',
  all_down: 'critical',
  quota_low: 'info',
  generic: 'info',
};

type AlertKind = 'provider_down' | 'circuit_open' | 'all_down' | 'quota_low' | 'generic';

/** Daily-quota threshold below which onQuotaLow fires (10%). */
const QUOTA_LOW_PERCENT = 0.10;

// ============ Public: AlertManager ============

/**
 * Stateless facade over the Telegram + KV rate-limit primitives.
 *
 * All methods are async + best-effort: a Telegram API failure is logged and
 * swallowed (the bot is the only channel — there's no second-tier pager).
 *
 * Constructed once per Worker invocation; safe to reuse across calls in the
 * same request/cron run.
 */
export class AlertManager {
  /**
   * Send a free-form message to the admin chat.
   *
   * Bypasses the per-(provider,alert) rate-limit — callers are responsible
   * for not spamming. Used for ad-hoc notifications (e.g. cron start/stop).
   */
  async notifyAdmin(env: Env, message: string): Promise<void> {
    await this.sendTelegram(env, message);
  }

  /**
   * Fire when a provider transitions healthy → down.
   *
   * Rate-limited to 1 per 10 min per provider.
   */
  async onProviderDown(env: Env, provider: ProviderId, error: string): Promise<void> {
    const ok = await this.acquireRateLimit(env, provider, 'provider_down');
    if (!ok) {
      console.log(`[alerts] onProviderDown(${provider}) suppressed by rate-limit`);
      return;
    }
    const lines = [
      `${SEVERITY_EMOJI.warning} *Provider Down*`,
      '',
      `*Provider:* \`${provider}\``,
      `*Error:* ${truncate(error, 400)}`,
      '',
      `_The cascade router will skip this provider until its circuit reopens._`,
    ];
    await this.sendTelegram(env, lines.join('\n'));
  }

  /**
   * Fire when a provider's circuit breaker opens.
   *
   * Rate-limited to 1 per 10 min per provider.
   *
   * @param durationMs How long the circuit will stay open (ms).
   */
  async onCircuitOpen(env: Env, provider: ProviderId, durationMs: number): Promise<void> {
    const ok = await this.acquireRateLimit(env, provider, 'circuit_open');
    if (!ok) {
      console.log(`[alerts] onCircuitOpen(${provider}) suppressed by rate-limit`);
      return;
    }
    const minutes = Math.round(durationMs / 60_000);
    const lines = [
      `${SEVERITY_EMOJI.warning} *Circuit Breaker Opened*`,
      '',
      `*Provider:* \`${provider}\``,
      `*Closed for:* ~${minutes} min`,
      '',
      `_Requests to this provider will fast-fail until the circuit reopens._`,
    ];
    await this.sendTelegram(env, lines.join('\n'));
  }

  /**
   * CRITICAL — fire when every provider in the cascade is down.
   *
   * Bypasses the per-provider rate-limit because this means user-facing
   * requests are currently failing. Still bounded by the fact that the cron
   * only fires this when ALL providers are down (rare).
   */
  async onAllProvidersDown(env: Env): Promise<void> {
    const lines = [
      `${SEVERITY_EMOJI.critical} *CRITICAL — All Providers Down*`,
      '',
      'Every provider in the cascade is currently unreachable.',
      'User requests will fail until at least one provider recovers.',
      '',
      '_Check Cloudflare status, provider dashboards, and API key validity._',
    ];
    await this.sendTelegram(env, lines.join('\n'));
  }

  /**
   * Warning — fire when a provider has <10% of its daily quota remaining.
   *
   * Rate-limited to 1 per 10 min per provider. Fires once when crossing the
   * 10% threshold — won't spam again until the rate-limit TTL expires.
   *
   * @param remaining Number of requests (or tokens) remaining in the day.
   */
  async onQuotaLow(env: Env, provider: ProviderId, remaining: number): Promise<void> {
    const ok = await this.acquireRateLimit(env, provider, 'quota_low');
    if (!ok) {
      console.log(`[alerts] onQuotaLow(${provider}) suppressed by rate-limit`);
      return;
    }
    const lines = [
      `${SEVERITY_EMOJI.info} *Low Quota*`,
      '',
      `*Provider:* \`${provider}\``,
      `*Remaining:* ${remaining}`,
      '',
      `_Below the ${Math.round(QUOTA_LOW_PERCENT * 100)}% daily-quota threshold — `,
      `the cascade will start preferring other providers._`,
    ];
    await this.sendTelegram(env, lines.join('\n'));
  }

  // ============ Internal: Telegram send ============

  /**
   * Post a Markdown message to the admin Telegram chat.
   *
   * Failures are logged + swallowed — alert delivery is best-effort. The
   * bot token + chat id come from env (set via `wrangler secret put`).
   */
  private async sendTelegram(env: Env, message: string): Promise<void> {
    const chatId = parseInt(env.ADMIN_CHAT_ID || '0', 10);
    if (!chatId || !env.TELEGRAM_BOT_TOKEN) {
      console.warn('[alerts] ADMIN_CHAT_ID or TELEGRAM_BOT_TOKEN missing — skipping alert');
      return;
    }

    try {
      const res = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
          }),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '(no body)');
        console.error(
          `[alerts] Telegram sendMessage failed: HTTP ${res.status} — ${body.slice(0, 200)}`,
        );
      }
    } catch (err) {
      console.error(`[alerts] Telegram send threw: ${String(err)}`);
    }
  }

  // ============ Internal: rate-limit (KV TTL) ============

  /**
   * Acquire the per-(provider,alertType) rate-limit slot.
   *
   * Returns true if this caller should send the alert (and we just wrote the
   * KV key with a 600s TTL). Returns false if another caller fired the same
   * alert within the last 10 minutes.
   *
   * Implementation: KV `put` with `expirationTtl` is idempotent — we rely on
   * the read-first-then-write pattern. There is a tiny race window between
   * GET and PUT (two concurrent crons could both fire) — that's acceptable
   * for an alert system (worst case: 1 duplicate message per 10 min).
   */
  private async acquireRateLimit(
    env: Env,
    provider: ProviderId,
    alertType: AlertKind,
  ): Promise<boolean> {
    // 'all_down' bypasses rate-limit (CRITICAL — see class doc).
    if (alertType === 'all_down') return true;

    const ns = pickAlertKv(env);
    if (!ns) {
      // No KV bound — fail-open (always send). Better noisy than silent.
      return true;
    }
    const key = `gateway:alert:${provider}:${alertType}`;
    try {
      const existing = await ns.get(key);
      if (existing) return false;
      await ns.put(key, String(Date.now()), {
        expirationTtl: ALERT_RATE_LIMIT_TTL_SECONDS,
      });
      return true;
    } catch (err) {
      console.error(`[alerts] KV rate-limit check failed (${key}): ${String(err)} — failing open`);
      return true;
    }
  }
}

// ============ Helpers ============

/**
 * Pick the KV namespace used for alert rate-limiting.
 *
 * Prefers `PROVIDER_ALERTS` (dedicated, recommended) and falls back to
 * `RATE_LIMITS` (always present) so the system works out of the box.
 */
function pickAlertKv(env: Env): KVNamespace | null {
  const alertEnv = env as Env & AlertEnv;
  if (alertEnv.PROVIDER_ALERTS) return alertEnv.PROVIDER_ALERTS;
  if (env.RATE_LIMITS) return env.RATE_LIMITS;
  return null;
}

/** Truncate a string to `max` chars, appending an ellipsis if cut. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

// `ALERT_SEVERITY` is exported for tests / dashboards that want to display
// the same severity mapping used by the alert dispatcher.
export { ALERT_SEVERITY };
