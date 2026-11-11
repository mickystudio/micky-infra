/**
 * initLedger — idempotent runtime bootstrap for the provider quota ledger.
 *
 * Cloudflare Workers cannot read the local filesystem at runtime, so the
 * canonical `schema.sql` (used for `wrangler d1 execute --file=schema.sql`
 * migrations) is mirrored below as `SCHEMA_SQL` and applied via `db.exec()`.
 * Keep the two in sync; the README documents this constraint.
 *
 * After the schema is in place, today's quota row is seeded for every known
 * provider (11 providers) using PROVIDER_LIMITS. All statements are
 * idempotent (CREATE IF NOT EXISTS / ON CONFLICT DO NOTHING), so initLedger
 * is safe to call on every cold start.
 *
 * Task: A2
 */

import { QuotaLedger, PROVIDER_LIMITS, KNOWN_PROVIDERS } from './ledger';

// ============================================================
// Schema SQL — mirror of ./schema.sql
// ============================================================
// Workers can't `import schema from './schema.sql'` without a wrangler
// `[[rules]]` text-loader entry, so we embed the SQL here for runtime
// bootstrap. The canonical migration file is schema.sql (run via
// `wrangler d1 execute --file=schema.sql`); this string must stay identical.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS provider_quotas (
  provider TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '*',
  date_key TEXT NOT NULL,
  remaining_rpd INTEGER,
  remaining_tpd INTEGER,
  rpm_used INTEGER DEFAULT 0,
  tpm_used INTEGER DEFAULT 0,
  last_request_at INTEGER,
  last_429_at INTEGER,
  consecutive_failures INTEGER DEFAULT 0,
  is_healthy INTEGER DEFAULT 1,
  circuit_open_until INTEGER DEFAULT 0,
  PRIMARY KEY (provider, model, date_key)
);
CREATE INDEX IF NOT EXISTS idx_quotas_date ON provider_quotas(date_key);
CREATE INDEX IF NOT EXISTS idx_quotas_healthy ON provider_quotas(is_healthy, provider);

CREATE TABLE IF NOT EXISTS conversation_provider_sticky (
  conversation_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  first_used_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  request_count INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS provider_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  message_id TEXT,
  rating INTEGER NOT NULL,
  intent TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_provider ON provider_feedback(provider, created_at);

CREATE TABLE IF NOT EXISTS provider_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT,
  conversation_id TEXT,
  intent TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,
  status TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_provider_date ON provider_calls(provider, created_at);
CREATE INDEX IF NOT EXISTS idx_calls_status ON provider_calls(status, created_at);
`;

/** Current UTC date as YYYY-MM-DD (matches ledger.ts helper). */
function todayKeyUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Initialise the provider quota ledger on the given D1 binding.
 *
 * 1. Applies the schema via `db.exec(SCHEMA_SQL)` (idempotent).
 * 2. Seeds today's quota row for every provider in PROVIDER_LIMITS with full
 *    daily limits (idempotent via ON CONFLICT DO NOTHING).
 *
 * Safe to call on every cold start. Returns a ready-to-use QuotaLedger.
 */
export async function initLedger(db: D1Database): Promise<QuotaLedger> {
  // 1) Apply schema (CREATE IF NOT EXISTS — idempotent).
  await db.exec(SCHEMA_SQL);

  // 2) Seed today's rows for all 11 providers (ON CONFLICT DO NOTHING).
  const dateKey = todayKeyUTC();
  const seedStmts = KNOWN_PROVIDERS.map((provider) => {
    const lim = PROVIDER_LIMITS[provider];
    return db
      .prepare(
        `INSERT INTO provider_quotas
           (provider, model, date_key, remaining_rpd, remaining_tpd,
            rpm_used, tpm_used, last_request_at, last_429_at,
            consecutive_failures, is_healthy, circuit_open_until)
         VALUES (?, '*', ?, ?, ?, 0, 0, NULL, NULL, 0, 1, 0)
         ON CONFLICT(provider, model, date_key) DO NOTHING`
      )
      .bind(provider, dateKey, lim.rpd, lim.tpd);
  });
  await db.batch(seedStmts);

  // 3) Return a ready ledger instance.
  return new QuotaLedger(db);
}

// Re-export the API surface so callers can `import { initLedger, QuotaLedger,
// PROVIDER_LIMITS } from '.../ledger/init'` from one place if they prefer.
export { QuotaLedger, PROVIDER_LIMITS, KNOWN_PROVIDERS } from './ledger';
export type {
  QuotaState,
  ProviderCall,
  ProviderStats,
  DecrementResult,
  ProviderLimit,
} from './ledger';
