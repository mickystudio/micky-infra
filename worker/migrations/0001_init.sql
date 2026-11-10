-- Micky Assistant Unlimited - D1 Schema v1.0
-- Migration: 0001_init.sql
-- Created: 2026-11-10
-- Database: micky-db (Cloudflare D1)

-- ============ Users ============
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
  created_at INTEGER DEFAULT (unixepoch())
);

-- ============ Projects ============
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

-- ============ Project Files ============
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

-- ============ Chats ============
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

-- ============ Messages ============
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

-- ============ Chat Summaries (Context Management) ============
CREATE TABLE IF NOT EXISTS chat_summaries (
  id TEXT PRIMARY KEY,
  chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  until_message_id TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_summaries_chat ON chat_summaries(chat_id);

-- ============ Project Memory (Long-term Learning) ============
CREATE TABLE IF NOT EXISTS project_memory (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  memory_type TEXT,
  content TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,
  times_reinforced INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch()),
  last_used INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_memory_project ON project_memory(project_id);
CREATE INDEX IF NOT EXISTS idx_memory_type ON project_memory(memory_type);

-- ============ Tasks (Async Execution) ============
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

-- ============ File Locks (Concurrency Control) ============
CREATE TABLE IF NOT EXISTS file_locks (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  file_path TEXT NOT NULL,
  task_id TEXT,
  locked_at INTEGER DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,
  UNIQUE(project_id, file_path)
);

-- ============ Error Book (Learning from Mistakes) ============
CREATE TABLE IF NOT EXISTS error_book (
  id TEXT PRIMARY KEY,
  category TEXT,
  pattern TEXT NOT NULL,
  lesson TEXT NOT NULL,
  occurrence_count INTEGER DEFAULT 1,
  last_seen INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_errors_category ON error_book(category);

-- ============ API Keys (BYOK) ============
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

-- ============ System Logs ============
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

-- ============ Initial Admin User (chat_id=1235548782 = Micky) ============
-- Password hash will be set on first run via /setpassword
INSERT OR IGNORE INTO users (chat_id, username, first_name, is_authorized) 
VALUES (1235548782, 'micky50000', 'Michael', 1);

-- ============ Settings ============
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO settings (key, value) VALUES 
  ('schema_version', '1'),
  ('bot_initialized', '0'),
  ('default_model', 'qwen2.5-coder-14b'),
  ('default_temperature', '0.4'),
  ('default_top_p', '0.8'),
  ('default_top_k', '20'),
  ('default_max_tokens', '4096');

-- ============ Done ============
SELECT 'Micky Assistant DB initialized successfully' as status;
