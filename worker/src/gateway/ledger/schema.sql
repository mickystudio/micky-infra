-- Micky Assistant Unlimited - D1 Provider Quota Ledger
-- Migration: gateway/ledger/schema.sql
-- Created: 2026-11-10 (Task A2)
-- Database: micky-db (Cloudflare D1, binding "DB", id 3ef44fc8-fdfd-4844-9708-2ee4f923ece9)
--
-- Purpose:
--   Replace the eventually-consistent KV-based rate-limit tracking with a
--   strongly-consistent, atomic D1 ledger. KV cannot do conditional writes
--   (no CAS / If-Match), is eventually consistent (<=60s propagation), and
--   caps at 1 write/sec/key. D1 is backed by a single Durable Object per DB
--   (single-writer) so a conditional `UPDATE ... WHERE remaining > 0 RETURNING`
--   is executed atomically -- no read-then-write race is possible.
--
-- See ledger.ts for the TypeScript API and README.md for the rationale.
--
-- Idempotent: every statement uses IF NOT EXISTS / ON CONFLICT so re-running
-- is safe. This file is also embedded verbatim in init.ts for runtime
-- bootstrap (db.exec).
--
-- SQLite / D1 syntax notes:
--   * RETURNING is supported (SQLite >= 3.35, D1 ships 3.43+).
--   * ON CONFLICT(col) DO UPDATE / DO NOTHING supported (SQLite >= 3.24).
--   * Composite PRIMARY KEY is supported.
--   * No native BOOLEAN -- use INTEGER 0/1 (is_healthy).

-- ============================================================
-- Provider quota ledger with atomic decrement
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
-- Conversation -> provider sticky mapping
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
-- Quality feedback (thumbs up / thumbs down from users)
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
-- Audit log of all provider calls
-- ============================================================
-- Append-only. Powers getProviderStats() (success rate, avg latency, token
-- totals) and per-minute rate calculations (RPM = COUNT WHERE created_at >
-- now - 60s). Pruned periodically by a cleanup cron (not in this migration).
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
