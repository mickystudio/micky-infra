-- Micky Assistant Unlimited - D1 Provider Quota Ledger
-- Migration: 0003_1_provider_ledger.sql
-- Created: 2026-11-10 (Task A2)
-- Database: micky-db (Cloudflare D1, binding "DB", id 3ef44fc8-fdfd-4844-9708-2ee4f923ece9)
--
-- Canonical source-of-truth for the provider quota ledger tables. Mirrors
-- `src/gateway/ledger/schema.sql` and the embedded SCHEMA_SQL string in
-- `src/gateway/ledger/init.ts` — keep all three in sync.
--
-- Why this file exists separately from 0003_gateway_monitoring.sql:
--   * 0003_gateway_monitoring.sql ALTERs `provider_calls` (adds event_type /
--     meta columns) and creates `provider_health_history`. It assumes the
--     ledger tables already exist.
--   * This file (0003_1_*) creates those ledger tables so that 0003_gateway_monitoring
--     can run safely. The "1" suffix guarantees alphabetical sort BEFORE
--     0003_gateway_monitoring.sql so the deploy script applies this first.
--
-- Tables created here are required by `src/gateway/ledger/ledger.ts`:
--   1. provider_quotas                 — atomic daily quota tracking (single-writer D1)
--   2. conversation_provider_sticky    — conversation_id -> provider mapping (TTL'd)
--   3. provider_feedback               — thumbs-up / thumbs-down ratings
--   4. provider_calls                  — append-only call audit log (latency, tokens, status)
--
-- Idempotent: every statement uses IF NOT EXISTS / ON CONFLICT so re-running
-- is safe. This file is also embedded verbatim in init.ts for runtime
-- bootstrap (db.exec) — keep them identical.
--
-- SQLite / D1 syntax notes:
--   * RETURNING is supported (SQLite >= 3.35, D1 ships 3.43+).
--   * ON CONFLICT(col) DO UPDATE / DO NOTHING supported (SQLite >= 3.24).
--   * Composite PRIMARY KEY is supported.
--   * No native BOOLEAN -- use INTEGER 0/1 (is_healthy).

-- ============================================================
-- provider_quotas: atomic daily quota ledger
-- ============================================================
-- One row per (provider, model, date_key). `model = '*'` is the provider-wide
-- aggregate; specific models may be tracked separately if a caller passes a
-- non-'*' model. remaining_rpd / remaining_tpd are NULL = unlimited.
CREATE TABLE IF NOT EXISTS provider_quotas (
  provider TEXT NOT NULL,           -- 'groq1', 'groq2', 'gemini', 'cerebras', ...
  model TEXT NOT NULL DEFAULT '*',  -- '*' for provider-wide, or specific model
  date_key TEXT NOT NULL,           -- YYYY-MM-DD UTC
  remaining_rpd INTEGER,            -- requests remaining today; NULL = unlimited
  remaining_tpd INTEGER,            -- tokens remaining today; NULL = unlimited
  rpm_used INTEGER DEFAULT 0,       -- requests accumulated today (RPM via provider_calls)
  tpm_used INTEGER DEFAULT 0,       -- tokens accumulated today
  last_request_at INTEGER,          -- epoch ms
  last_429_at INTEGER,              -- epoch ms; if recent, circuit-breaker hint
  consecutive_failures INTEGER DEFAULT 0,
  is_healthy INTEGER DEFAULT 1,     -- 0=disabled (circuit open)
  circuit_open_until INTEGER DEFAULT 0,  -- epoch ms when circuit re-closes
  PRIMARY KEY (provider, model, date_key)
);

CREATE INDEX IF NOT EXISTS idx_quotas_date ON provider_quotas(date_key);
CREATE INDEX IF NOT EXISTS idx_quotas_healthy ON provider_quotas(is_healthy, provider);

-- ============================================================
-- conversation_provider_sticky: conversation -> provider sticky mapping
-- ============================================================
-- Once a conversation has used a provider, we prefer to keep it there so the
-- provider sees a coherent conversation history (some models reward
-- consistency). The gateway calls getStickyProvider() before picking, and
-- setStickyProvider() after a successful first call.
CREATE TABLE IF NOT EXISTS conversation_provider_sticky (
  conversation_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  first_used_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  request_count INTEGER DEFAULT 1
);

-- ============================================================
-- provider_feedback: quality feedback (thumbs up / thumbs down)
-- ============================================================
CREATE TABLE IF NOT EXISTS provider_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  message_id TEXT,                 -- Telegram message id
  rating INTEGER NOT NULL,         -- +1 (good) or -1 (bad)
  intent TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_provider ON provider_feedback(provider, created_at);

-- ============================================================
-- provider_calls: append-only audit log of all provider calls
-- ============================================================
-- Powers getProviderStats() (success rate, avg latency, token totals) and
-- per-minute rate calculations (RPM = COUNT WHERE created_at > now - 60s).
-- Pruned periodically by a cleanup cron (not in this migration).
-- NOTE: 0003_gateway_monitoring.sql adds event_type + meta columns to this
-- table after this migration runs.
CREATE TABLE IF NOT EXISTS provider_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT,
  conversation_id TEXT,
  intent TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,
  status TEXT,                     -- 'success', '429', '5xx', 'timeout'
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_calls_provider_date ON provider_calls(provider, created_at);
CREATE INDEX IF NOT EXISTS idx_calls_status ON provider_calls(status, created_at);

-- ============================================================
-- Done
-- ============================================================
SELECT 'provider quota ledger schema applied' AS status;
