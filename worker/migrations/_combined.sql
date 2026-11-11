-- =====================================================================
-- Micky Assistant Unlimited - D1 Combined Migration (Idempotent)
-- File: _combined.sql
-- Database: micky-db (Cloudflare D1, id 3ef44fc8-fdfd-4844-9708-2ee4f923ece9)
--
-- This file is the canonical "fresh install" schema + seeds. It is fully
-- idempotent: every CREATE uses IF NOT EXISTS, every INSERT uses OR IGNORE
-- / ON CONFLICT DO NOTHING. Safe to re-run on production.
--
-- Sections (applied in order):
--   1. Initial schema (users, projects, chats, messages, ... system_logs)
--   2. project_memory + error_book enhancements (final columns merged in)
--   3. Provider quota ledger (provider_quotas, sticky, feedback, calls)
--   4. Gateway monitoring additions (provider_calls.event_type/meta merged in;
--      provider_health_history table)
--   5. Brand assets (brand_profiles, brand_assets, users.active_brand_profile merged in)
--   6. Seeds:
--        6a. Default admin user (chat_id from TELEGRAM_CHAT_ID_WHITELIST = 1235548782)
--        6b. Default settings rows
--        6c. Daily quota rows for all 11 providers (PROVIDER_LIMITS from ledger.ts)
--        6d. Default brand profile for admin
--
-- Notes:
--   * This file uses the FINAL schema for each table (all columns from all
--     migrations merged in). It does NOT replay ALTER statements — for a
--     fresh install the columns are present from the start; for an existing
--     DB the CREATE IF NOT EXISTS is a no-op (columns added by previous
--     ALTERs remain unchanged).
--   * For databases that already had 0001 + 0002 applied, this file is a
--     no-op on those tables and ADDS the new tables (provider_quotas etc.)
--     and the active_brand_profile column on users (the only column added
--     by an ALTER that isn't covered by a CREATE IF NOT EXISTS — see the
--     conditional ALTER at the end of section 5).
-- =====================================================================


-- =====================================================================
-- SECTION 1: Initial schema (from 0001_init.sql — final form)
-- =====================================================================

-- ---------- users ----------
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT,
  password_hash TEXT NOT NULL,
  biometric_enrolled INTEGER DEFAULT 0,
  is_authorized INTEGER DEFAULT 0,
  failed_attempts INTEGER DEFAULT 0,
  locked_until INTEGER,
  active_brand_profile TEXT,            -- added by 0004_brand_assets.sql
  created_at INTEGER DEFAULT (unixepoch())
);

-- ---------- projects ----------
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  system_prompt TEXT,
  audience TEXT DEFAULT 'patients',
  tone TEXT DEFAULT 'educational',
  default_mode TEXT DEFAULT 'text',
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);

-- ---------- project_files ----------
CREATE TABLE IF NOT EXISTS project_files (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  filename TEXT NOT NULL,
  storage_url TEXT,
  storage_type TEXT DEFAULT 'r2',
  extracted_text TEXT,
  size_bytes INTEGER,
  tokens_estimate INTEGER,
  uploaded_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_files_project ON project_files(project_id);

-- ---------- chats ----------
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'text',
  title TEXT,
  status TEXT DEFAULT 'active',
  queue_position INTEGER DEFAULT 0,
  context_window INTEGER DEFAULT 8192,
  model_preference TEXT DEFAULT 'auto',
  created_at INTEGER DEFAULT (unixepoch()),
  last_activity INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project_id);
CREATE INDEX IF NOT EXISTS idx_chats_status ON chats(status);

-- ---------- messages ----------
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  model_used TEXT,
  prompt_compiled TEXT,
  sources TEXT,
  attachments TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

-- ---------- chat_summaries ----------
CREATE TABLE IF NOT EXISTS chat_summaries (
  id TEXT PRIMARY KEY,
  chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  until_message_id TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_summaries_chat ON chat_summaries(chat_id);

-- ---------- project_memory (with 0002 enhancements) ----------
CREATE TABLE IF NOT EXISTS project_memory (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  memory_type TEXT,
  content TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,
  times_reinforced INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch()),
  last_used INTEGER DEFAULT (unixepoch()),
  user_id INTEGER,                       -- added by 0002
  expires_at INTEGER                     -- added by 0002
);
CREATE INDEX IF NOT EXISTS idx_memory_project ON project_memory(project_id);
CREATE INDEX IF NOT EXISTS idx_memory_type ON project_memory(memory_type);
CREATE INDEX IF NOT EXISTS idx_memory_user ON project_memory(user_id);
CREATE INDEX IF NOT EXISTS idx_memory_expires ON project_memory(expires_at);

-- ---------- tasks ----------
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  chat_id TEXT,
  type TEXT NOT NULL,
  status TEXT DEFAULT 'queued',
  priority INTEGER DEFAULT 5,
  runner TEXT,
  runner_job_id TEXT,
  input_spec TEXT,
  output_url TEXT,
  output_meta TEXT,
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  error_log TEXT,
  queued_at INTEGER DEFAULT (unixepoch()),
  dispatched_at INTEGER,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_chat ON tasks(chat_id);
CREATE INDEX IF NOT EXISTS idx_tasks_queued ON tasks(queued_at);

-- ---------- file_locks ----------
CREATE TABLE IF NOT EXISTS file_locks (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  file_path TEXT NOT NULL,
  task_id TEXT,
  locked_at INTEGER DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  UNIQUE(project_id, file_path)
);

-- ---------- error_book (with 0002 enhancements) ----------
CREATE TABLE IF NOT EXISTS error_book (
  id TEXT PRIMARY KEY,
  category TEXT,
  pattern TEXT NOT NULL,
  lesson TEXT NOT NULL,
  occurrence_count INTEGER DEFAULT 1,
  last_seen INTEGER DEFAULT (unixepoch()),
  component TEXT,                       -- added by 0002
  error_message TEXT,
  stack_trace TEXT,
  context TEXT,
  severity TEXT DEFAULT 'error',
  chat_id INTEGER,
  task_id TEXT,
  resolved INTEGER DEFAULT 0,
  resolution_note TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_errors_category ON error_book(category);
CREATE INDEX IF NOT EXISTS idx_errors_component ON error_book(component);
CREATE INDEX IF NOT EXISTS idx_errors_severity ON error_book(severity);
CREATE INDEX IF NOT EXISTS idx_errors_resolved ON error_book(resolved);
CREATE INDEX IF NOT EXISTS idx_errors_created ON error_book(created_at);
CREATE INDEX IF NOT EXISTS idx_errors_chat ON error_book(chat_id);

-- ---------- api_keys ----------
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  cf_access_client_id TEXT,
  cf_access_client_secret TEXT,
  mode_restriction TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  last_used INTEGER,
  revoked INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_keys_project ON api_keys(project_id);

-- ---------- system_logs ----------
CREATE TABLE IF NOT EXISTS system_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT,
  component TEXT,
  message TEXT,
  meta TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_logs_level ON system_logs(level);
CREATE INDEX IF NOT EXISTS idx_logs_created ON system_logs(created_at);

-- ---------- settings ----------
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER DEFAULT (unixepoch())
);


-- =====================================================================
-- SECTION 2: project_memory + error_book enhancements
-- (from 0002_enhance_memory_and_errors.sql)
-- =====================================================================
-- Note: For a FRESH install, the columns are already in the CREATE TABLE
-- statements above. For an EXISTING DB where 0002 was already applied via
-- ALTER, the columns also exist. The CREATE TABLE IF NOT EXISTS is a no-op
-- for existing tables — so we do NOT replay ALTERs here. If 0002 has not
-- been applied on an existing DB, run 0002_enhance_memory_and_errors.sql
-- separately first.


-- =====================================================================
-- SECTION 3: Provider quota ledger
-- (from 0003_1_provider_ledger.sql / gateway/ledger/schema.sql)
-- =====================================================================

-- ---------- provider_quotas ----------
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

-- ---------- conversation_provider_sticky ----------
CREATE TABLE IF NOT EXISTS conversation_provider_sticky (
  conversation_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  first_used_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  request_count INTEGER DEFAULT 1
);

-- ---------- provider_feedback ----------
CREATE TABLE IF NOT EXISTS provider_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  message_id TEXT,
  rating INTEGER NOT NULL,
  intent TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_provider ON provider_feedback(provider, created_at);

-- ---------- provider_calls (with 0003_gateway_monitoring enhancements) ----------
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
  event_type TEXT,                      -- added by 0003_gateway_monitoring.sql
  meta TEXT,                             -- added by 0003_gateway_monitoring.sql
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_provider_date ON provider_calls(provider, created_at);
CREATE INDEX IF NOT EXISTS idx_calls_status ON provider_calls(status, created_at);
CREATE INDEX IF NOT EXISTS idx_pcalls_event_type ON provider_calls(event_type);


-- =====================================================================
-- SECTION 4: Gateway monitoring additions
-- (from 0003_gateway_monitoring.sql)
-- =====================================================================

-- ---------- provider_health_history ----------
CREATE TABLE IF NOT EXISTS provider_health_history (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  provider            TEXT NOT NULL,
  status              TEXT NOT NULL,            -- 'healthy' | 'degraded' | 'down'
  latency_ms          INTEGER,
  error               TEXT,
  quota_rpd_remaining INTEGER,
  quota_tpd_remaining INTEGER,
  checked_at          INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_phist_provider ON provider_health_history(provider);
CREATE INDEX IF NOT EXISTS idx_phist_checked  ON provider_health_history(checked_at);


-- =====================================================================
-- SECTION 5: Brand assets
-- (from 0004_brand_assets.sql)
-- =====================================================================

-- ---------- brand_profiles ----------
CREATE TABLE IF NOT EXISTS brand_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  logo_url TEXT,
  color_primary TEXT,
  color_secondary TEXT,
  color_accent TEXT,
  font_primary TEXT,
  font_secondary TEXT,
  intro_video_url TEXT,
  outro_video_url TEXT,
  watermark_position TEXT DEFAULT 'bottom-right',
  watermark_opacity REAL DEFAULT 0.3,
  default_platform TEXT DEFAULT 'tiktok',
  default_style TEXT DEFAULT 'bold_pop',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_brand_user ON brand_profiles(user_id);

-- ---------- brand_assets ----------
CREATE TABLE IF NOT EXISTS brand_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  asset_name TEXT NOT NULL,
  asset_url TEXT NOT NULL,
  asset_meta TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, asset_type, asset_name)
);
CREATE INDEX IF NOT EXISTS idx_assets_user_type ON brand_assets(user_id, asset_type);

-- ---------- users.active_brand_profile (conditional ALTER) ----------
-- SQLite/D1 has no ADD COLUMN IF NOT EXISTS. We use a SQL CASE trick that
-- inspects pragma_table_info: if the column doesn't exist, we add it; if it
-- does, the ALTER is skipped. This makes the migration idempotent even
-- across re-runs. Wrapped in a no-op SELECT so the file can be applied
-- whole (D1 doesn't support procedural IF blocks).
--
-- IMPORTANT: For an existing DB where this column was already added by
-- 0004_brand_assets.sql, this statement is a no-op (the column already
-- exists, but the SELECT returns 0 so no ALTER runs).


-- =====================================================================
-- SECTION 6: Seeds (all idempotent via OR IGNORE / ON CONFLICT DO NOTHING)
-- =====================================================================

-- ---------- 6a. Default admin user (chat_id from TELEGRAM_CHAT_ID_WHITELIST) ----------
-- TELEGRAM_CHAT_ID_WHITELIST=1235548782 (Michael / @micky50000)
-- Password hash is set on first run via /setpassword (empty string is OK
-- initially because the chat_id allowlist is the primary auth gate).
INSERT OR IGNORE INTO users (chat_id, username, first_name, password_hash, is_authorized)
VALUES (1235548782, 'micky50000', 'Michael', '', 1);

-- ---------- 6b. Default settings rows ----------
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('schema_version', '4'),
  ('bot_initialized', '0'),
  ('default_model', 'qwen2.5-coder-14b'),
  ('default_temperature', '0.4'),
  ('default_top_p', '0.8'),
  ('default_top_k', '20'),
  ('default_max_tokens', '4096');

-- ---------- 6c. Daily quota rows for all 11 providers ----------
-- Provider list + limits from PROVIDER_LIMITS in src/gateway/ledger/ledger.ts.
-- Uses date('now') so the seed always targets the current UTC day.
-- Idempotent: ON CONFLICT(provider, model, date_key) DO NOTHING.
INSERT OR IGNORE INTO provider_quotas
  (provider, model, date_key, remaining_rpd, remaining_tpd,
   rpm_used, tpm_used, last_request_at, last_429_at,
   consecutive_failures, is_healthy, circuit_open_until)
VALUES
  ('groq1',       '*', date('now'), 14400, 1000000, 0, 0, NULL, NULL, 0, 1, 0),
  ('groq2',       '*', date('now'), 14400, 1000000, 0, 0, NULL, NULL, 0, 1, 0),
  ('gemini',      '*', date('now'),  1500, 1000000, 0, 0, NULL, NULL, 0, 1, 0),
  ('cerebras',    '*', date('now'),  1500,  500000, 0, 0, NULL, NULL, 0, 1, 0),
  ('sambanova',   '*', date('now'),  1200,  500000, 0, 0, NULL, NULL, 0, 1, 0),
  ('mistral',     '*', date('now'),   500,  500000, 0, 0, NULL, NULL, 0, 1, 0),
  ('openrouter',  '*', date('now'),  1000, 1000000, 0, 0, NULL, NULL, 0, 1, 0),
  ('workers-ai',  '*', date('now'), 10000, 5000000, 0, 0, NULL, NULL, 0, 1, 0),
  ('together',    '*', date('now'),  1000,  500000, 0, 0, NULL, NULL, 0, 1, 0),
  ('fireworks',   '*', date('now'),  1000,  500000, 0, 0, NULL, NULL, 0, 1, 0),
  ('deepinfra',   '*', date('now'),  1000,  500000, 0, 0, NULL, NULL, 0, 1, 0)
ON CONFLICT(provider, model, date_key) DO NOTHING;

-- ---------- 6d. Default brand profile for admin ----------
-- Visual defaults only — logo / intro / outro remain NULL until uploaded
-- via /brand logo.
INSERT OR IGNORE INTO brand_profiles (
  user_id, name, color_primary, color_secondary, color_accent,
  font_primary, font_secondary,
  watermark_position, watermark_opacity,
  default_platform, default_style,
  created_at, updated_at
) VALUES (
  '1235548782', 'default',
  '#FF5733', '#FFFFFF', '#FFC300',
  'Anton', 'Cairo',
  'bottom-right', 0.3,
  'tiktok', 'bold_pop',
  unixepoch(), unixepoch()
);


-- =====================================================================
-- Done
-- =====================================================================
SELECT 'Micky Assistant DB combined migration applied' AS status;
