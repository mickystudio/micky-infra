-- Micky Assistant Unlimited - D1 Schema v1.3 (Brand Assets)
-- Migration: 0004_brand_assets.sql
-- Task B13-retry (scope reduced to schema + manager + overlay).
--
-- Introduces per-user "brand profiles" + a generic "brand assets" table.
-- A brand profile bundles the visual identity used by the montage
-- pipeline (logo URL, colour palette, fonts, intro/outro clips,
-- watermark position + opacity, default platform/style).
--
-- Brand assets (binary blobs for logos / fonts / LUTs / intro-outro
-- clips) live in the BRAND_ASSETS KV namespace keyed by
-- `{userId}/{assetType}/{uuid}`; this table only stores the metadata +
-- pointer URL (keeps D1 rows small and avoids polluting the row-level
-- query cache).
--
-- Idempotent: uses CREATE TABLE/INDEX IF NOT EXISTS, so re-running the
-- migration is safe. Forward-only (no down-migration).

-- ============ Brand profiles ============
CREATE TABLE IF NOT EXISTS brand_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'default',
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

-- ============ Brand assets (logos, fonts, LUTs, intro/outro clips) ============
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

-- ============ Indexes ============
CREATE INDEX IF NOT EXISTS idx_brand_user ON brand_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_assets_user_type ON brand_assets(user_id, asset_type);

-- ============ Done ============
SELECT 'Micky Assistant DB v1.3 (brand_assets) migration applied' AS status;
