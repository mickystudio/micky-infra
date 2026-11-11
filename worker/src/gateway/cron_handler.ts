/**
 * Micky Assistant Unlimited — Gateway Cron Handler (Agent A9)
 *
 * Thin dispatcher that the Worker's `scheduled()` handler calls. Maps the
 * Cloudflare Cron Trigger's `event.cron` string to the right gateway job:
 *
 *   every 30 min  → runHealthCheckCron(env, ctx)
 *                  Probes every provider, updates the ledger, sends alerts.
 *   daily midnight → resetDailyQuotas(env)
 *                  Seeds today's fresh quota rows for all 11 providers
 *                  (delegated to A2's QuotaLedger.resetDailyQuotas).
 *
 * The existing every-5-min trigger continues to poll stale Kaggle tasks
 * (handled by the existing `handleScheduled()` in src/cron.ts).
 *
 * Created: 2026-11-10
 * Phase: A9
 */

import type { Env } from '../index';
import { QuotaLedger } from './ledger/ledger';
import { runHealthCheckCron } from './health_checker';

// ============ Cron trigger strings ============

/** Every 30 minutes — health-check cadence. */
export const CRON_HEALTH_CHECK = '*/30 * * * *';

/** Daily at UTC midnight — quota reset. */
export const CRON_DAILY_RESET = '0 0 * * *';

// ============ Public API ============

/**
 * Dispatch a cron trigger to the right gateway job.
 *
 * Returns true if the cron was handled by the gateway layer (so the caller
 * can skip the default Kaggle-poll path).
 */
export async function dispatchGatewayCron(
  cron: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<boolean> {
  if (cron === CRON_HEALTH_CHECK) {
    await runHealthCheckCron(env, ctx);
    return true;
  }
  if (cron === CRON_DAILY_RESET) {
    await resetDailyQuotas(env);
    return true;
  }
  return false;
}

/**
 * Daily UTC-midnight quota reset.
 *
 * Seeds today's rows for every provider in A2's PROVIDER_LIMITS with full
 * daily limits (idempotent — ON CONFLICT DO NOTHING). Old days' rows are
 * retained for analytics.
 *
 * Also runs a low-quota sweep: any provider still flagged 'unhealthy' from
 * the previous day is re-marked healthy (a new day = a fresh chance — the
 * 30-min health-check cron will re-flag it if it's actually still down).
 */
export async function resetDailyQuotas(env: Env): Promise<void> {
  console.log('[cron] resetDailyQuotas — seeding today\'s rows for all providers');
  const ledger = new QuotaLedger(env.DB);
  try {
    await ledger.resetDailyQuotas();
    console.log('[cron] resetDailyQuotas complete');
  } catch (err) {
    console.error(`[cron] resetDailyQuotas failed: ${String(err)}`);
  }
}

// Re-export runHealthCheckCron so callers can import everything from
// cron_handler.ts rather than reaching into health_checker.ts.
export { runHealthCheckCron } from './health_checker';
