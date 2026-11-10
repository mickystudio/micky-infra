-- Micky Assistant Unlimited - D1 Schema v1.1
-- Migration: 0002_enhance_memory_and_errors.sql
-- Created: 2026-11-10
-- Database: micky-db (Cloudflare D1)
--
-- Extends two existing tables to support the new Project Memory + Error Book
-- subsystems (tasks A13 + A14):
--
--   project_memory : adds user_id (so memories can be scoped to a Telegram
--                    user when no project_id is known) and expires_at
--                    (optional TTL — memories that have aged out are filtered
--                    on read).
--
--   error_book     : adds operational-logging columns (component, error_message,
--                    stack_trace, context JSON, severity, chat_id, task_id,
--                    resolved, resolution_note, created_at). The pre-existing
--                    "lesson learning" columns (category / pattern / lesson /
--                    occurrence_count / last_seen) are kept untouched so the
--                    existing recordError / getRelevantErrors APIs continue
--                    to work.
--
-- Note: SQLite (D1) does not support `IF NOT EXISTS` on `ADD COLUMN`. Running
-- this migration twice will fail on the duplicate column. That is expected
-- behaviour for a forward-only D1 migration.

-- ============ project_memory enhancements ============
ALTER TABLE project_memory ADD COLUMN user_id INTEGER;
ALTER TABLE project_memory ADD COLUMN expires_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_memory_user ON project_memory(user_id);
CREATE INDEX IF NOT EXISTS idx_memory_expires ON project_memory(expires_at);

-- ============ error_book enhancements ============
ALTER TABLE error_book ADD COLUMN component TEXT;
ALTER TABLE error_book ADD COLUMN error_message TEXT;
ALTER TABLE error_book ADD COLUMN stack_trace TEXT;
ALTER TABLE error_book ADD COLUMN context TEXT;
ALTER TABLE error_book ADD COLUMN severity TEXT DEFAULT 'error';
ALTER TABLE error_book ADD COLUMN chat_id INTEGER;
ALTER TABLE error_book ADD COLUMN task_id TEXT;
ALTER TABLE error_book ADD COLUMN resolved INTEGER DEFAULT 0;
ALTER TABLE error_book ADD COLUMN resolution_note TEXT;
ALTER TABLE error_book ADD COLUMN created_at INTEGER DEFAULT (unixepoch());

CREATE INDEX IF NOT EXISTS idx_errors_component ON error_book(component);
CREATE INDEX IF NOT EXISTS idx_errors_severity ON error_book(severity);
CREATE INDEX IF NOT EXISTS idx_errors_resolved ON error_book(resolved);
CREATE INDEX IF NOT EXISTS idx_errors_created ON error_book(created_at);
CREATE INDEX IF NOT EXISTS idx_errors_chat ON error_book(chat_id);

-- ============ Done ============
SELECT 'Micky Assistant DB v1.1 migration applied' AS status;
