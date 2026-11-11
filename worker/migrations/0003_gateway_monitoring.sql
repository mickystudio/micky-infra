-- Micky Assistant Unlimited - D1 Schema v1.2
-- Migration: 0003_gateway_monitoring.sql
-- Agent: A9 (background health checking + monitoring)
--
-- This migration is ADDITIVE on top of the gateway/ledger schema
-- (gateway/ledger/schema.sql — Agent A2). It does NOT recreate A2's tables
-- (provider_quotas / provider_calls / provider_feedback /
-- conversation_provider_sticky); it only:
--
--   1. Adds two columns to `provider_calls` so it can double as the metric
--      event log (the cascade router already writes call rows there; the
--      monitoring layer writes additional non-call events: fallback_triggered,
--      circuit_opened, quota_depleted).
--         event_type TEXT   — 'call_success' | 'call_failure' |
--                             'fallback_triggered' | 'circuit_opened' |
--                             'quota_depleted' | 'feedback_received'
--                             (NULL when the row is a normal call audit row
--                             written by QuotaLedger.recordCall — backward
--                             compatible with A2's writes).
--         meta TEXT         — JSON blob for ad-hoc structured fields.
--
--   2. Creates `provider_health_history` — one row per health-check probe.
--      Used for trend charts (latency / status over time). Pruned by a
--      future cleanup cron (not in this migration).
--
-- SQLite / D1 does NOT support `IF NOT EXISTS` on `ADD COLUMN`; running
-- this migration twice will fail on the duplicate column. That is expected
-- behaviour for a forward-only D1 migration (matches migration 0002).
--
-- Created: 2026-11-10
-- Phase: A9

-- ============ provider_calls enhancements ============
ALTER TABLE provider_calls ADD COLUMN event_type TEXT;
ALTER TABLE provider_calls ADD COLUMN meta TEXT;

CREATE INDEX IF NOT EXISTS idx_pcalls_event_type ON provider_calls(event_type);

-- ============ provider_health_history (trend analysis) ============
CREATE TABLE IF NOT EXISTS provider_health_history (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  provider            TEXT NOT NULL,           -- cascade_types.ProviderId
  status              TEXT NOT NULL,            -- 'healthy' | 'degraded' | 'down'
  latency_ms          INTEGER,
  error               TEXT,
  quota_rpd_remaining INTEGER,                    -- requests-per-day remaining at probe time (NULL = unlimited)
  quota_tpd_remaining INTEGER,                    -- tokens-per-day remaining at probe time (NULL = unlimited)
  checked_at          INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_phist_provider ON provider_health_history(provider);
CREATE INDEX IF NOT EXISTS idx_phist_checked  ON provider_health_history(checked_at);

-- ============ Done ============
SELECT 'Micky Assistant DB v1.2 migration applied (gateway monitoring — additive)' AS status;
