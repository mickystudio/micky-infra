/**
 * Micky Assistant Unlimited - Brand Profile Manager (Task B13-retry)
 *
 * Per-user "brand profiles" + brand-asset metadata, stored in Cloudflare
 * D1. Binary blobs themselves live in the `BRAND_ASSETS` KV namespace
 * (handled elsewhere); this module owns the D1 row lifecycle only.
 * All queries use bound `?` parameters — no SQL injection.
 *
 * Created: 2026-11-13 (Task B13-retry)
 */

// ============ Constants ============

/** Allowed asset types. */
export const VALID_ASSET_TYPES = ['logo', 'font', 'intro', 'outro', 'lut'] as const;
export type AssetType = (typeof VALID_ASSET_TYPES)[number];

/** Allowed watermark positions (matches brand_overlay.py's parser). */
export const VALID_WATERMARK_POSITIONS = [
  'top-left', 'top-right', 'bottom-left', 'bottom-right', 'center',
] as const;
export type WatermarkPosition = (typeof VALID_WATERMARK_POSITIONS)[number];

/** Allowed default platforms. */
export const VALID_PLATFORMS = ['tiktok', 'youtube', 'instagram', 'reels', 'facebook'] as const;

/** Allowed caption styles (mirrors kinetic_captions.py VALID_STYLES). */
export const VALID_STYLES = [
  'bold_pop', 'karaoke_fill', 'boxed', 'clean_lower', 'hormozi', 'tiktok_default',
] as const;

// ============ Types ============

/**
 * A saved brand profile row from D1. Also serves as the raw D1 row
 * type — D1 returns plain strings for TEXT columns, which we coerce
 * to the literal-union / bounded-number types via `rowToProfile`.
 */
export interface BrandProfile {
  id: number;
  user_id: string;
  name: string;
  logo_url: string | null;
  color_primary: string | null;
  color_secondary: string | null;
  color_accent: string | null;
  font_primary: string | null;
  font_secondary: string | null;
  intro_video_url: string | null;
  outro_video_url: string | null;
  watermark_position: WatermarkPosition;
  watermark_opacity: number;
  default_platform: string;
  default_style: string;
  created_at: number;
  updated_at: number;
}

/** Subset of fields a caller may pass when creating/updating a profile. */
export interface BrandProfileInput {
  name: string;
  logo_url?: string | null;
  color_primary?: string | null;
  color_secondary?: string | null;
  color_accent?: string | null;
  font_primary?: string | null;
  font_secondary?: string | null;
  intro_video_url?: string | null;
  outro_video_url?: string | null;
  watermark_position?: WatermarkPosition;
  watermark_opacity?: number;
  default_platform?: string;
  default_style?: string;
}

/** A saved brand asset row from D1. */
export interface BrandAsset {
  id: number;
  user_id: string;
  asset_type: AssetType;
  asset_name: string;
  asset_url: string;
  asset_meta: string | null;
  created_at: number;
}

/** Input shape for `addAsset` (id + timestamps filled in by the manager). */
export interface AssetInput {
  asset_type: AssetType;
  asset_name: string;
  asset_url: string;
  asset_meta?: Record<string, unknown> | null;
}

// ============ Errors ============

export class BrandProfileNotFoundError extends Error {
  constructor(userId: string, name: string) {
    super(`brand profile not found: user=${userId} name=${name}`);
    this.name = 'BrandProfileNotFoundError';
  }
}

export class BrandAssetNotFoundError extends Error {
  constructor(userId: string, assetId: number) {
    super(`brand asset not found: user=${userId} assetId=${assetId}`);
    this.name = 'BrandAssetNotFoundError';
  }
}

export class InvalidAssetTypeError extends Error {
  constructor(type: string) {
    super(`invalid asset type: ${type} (valid: ${VALID_ASSET_TYPES.join(', ')})`);
    this.name = 'InvalidAssetTypeError';
  }
}

// ============ Helpers ============

const VALID_ASSET_TYPES_STR: readonly string[] = VALID_ASSET_TYPES;
const VALID_WM_POS_STR: readonly string[] = VALID_WATERMARK_POSITIONS;
const VALID_HEX_RE = /^#[0-9A-Fa-f]{6}$/;

/** Current Unix time in seconds (matches D1 `unixepoch()`). */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Coerce a raw string into a WatermarkPosition (defaults to bottom-right). */
function coerceWatermarkPosition(raw: unknown): WatermarkPosition {
  const s = String(raw ?? '');
  return VALID_WM_POS_STR.includes(s) ? (s as WatermarkPosition) : 'bottom-right';
}

/** Coerce an arbitrary value into a number in [0,1]. */
function coerceOpacity(raw: unknown): number {
  const n = Number(raw);
  return isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.3;
}

/** Validate hex colour ("#RRGGBB" or "RRGGBB"). Returns normalised uppercase "#RRGGBB" or null.
 *  Throws on malformed non-empty input. */
function normalizeHex(input: string | null | undefined): string | null {
  if (!input) return null;
  let h = String(input).trim();
  if (!h.startsWith('#')) h = '#' + h;
  if (!VALID_HEX_RE.test(h)) throw new Error(`invalid hex colour: ${input} (expected #RRGGBB)`);
  return h.toUpperCase();
}

/** Map a raw D1 row to the public BrandProfile interface. */
function rowToProfile(row: BrandProfile): BrandProfile {
  return {
    ...row,
    watermark_position: coerceWatermarkPosition(row.watermark_position),
    watermark_opacity: coerceOpacity(row.watermark_opacity),
    default_platform: row.default_platform || 'tiktok',
    default_style: row.default_style || 'bold_pop',
    created_at: Number(row.created_at ?? 0),
    updated_at: Number(row.updated_at ?? 0),
  };
}

/** Map a raw D1 row to the public BrandAsset interface. */
function rowToAsset(row: BrandAsset): BrandAsset {
  return {
    ...row,
    asset_type: (String(row.asset_type) as AssetType),
    created_at: Number(row.created_at ?? 0),
  };
}

// ============ BrandProfileManager ============

/**
 * Owns all D1 access for brand profiles + brand assets. Constructed once
 * per request with `env.DB`.  All queries use bound `?` parameters — no
 * SQL injection.
 */
export class BrandProfileManager {
  constructor(private readonly db: D1Database) {}

  // ---------------- Profiles ----------------

  /** Create a new brand profile. Throws on UNIQUE(user_id, name) conflict. */
  async createProfile(userId: string, input: BrandProfileInput): Promise<BrandProfile> {
    if (!userId) throw new Error('createProfile: userId is required');
    if (!input?.name) throw new Error('createProfile: input.name is required');

    const now = nowSeconds();
    const wp = coerceWatermarkPosition(input.watermark_position ?? 'bottom-right');
    const op = coerceOpacity(input.watermark_opacity ?? 0.3);
    const platform = input.default_platform || 'tiktok';
    const style = input.default_style || 'bold_pop';

    // Normalise hex colours (throws on malformed input).
    const cp = normalizeHex(input.color_primary);
    const cs = normalizeHex(input.color_secondary);
    const ca = normalizeHex(input.color_accent);

    const result = await this.db.prepare(
      `INSERT INTO brand_profiles (
         user_id, name, logo_url,
         color_primary, color_secondary, color_accent,
         font_primary, font_secondary,
         intro_video_url, outro_video_url,
         watermark_position, watermark_opacity,
         default_platform, default_style,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    ).bind(
      userId, input.name, input.logo_url ?? null,
      cp, cs, ca,
      input.font_primary ?? null, input.font_secondary ?? null,
      input.intro_video_url ?? null, input.outro_video_url ?? null,
      wp, op, platform, style, now, now,
    ).first<BrandProfile>();

    if (!result) throw new Error('createProfile: INSERT did not return a row (UNIQUE conflict?)');
    return rowToProfile(result);
  }

  /** Fetch a single profile by (user_id, name).  Returns null if missing. */
  async getProfile(userId: string, name: string = 'default'): Promise<BrandProfile | null> {
    const row = await this.db.prepare(
      'SELECT * FROM brand_profiles WHERE user_id = ? AND name = ? LIMIT 1',
    ).bind(userId, name).first<BrandProfile>();
    return row ? rowToProfile(row) : null;
  }

  /** List all profiles for a user (ordered by id ascending). */
  async listProfiles(userId: string): Promise<BrandProfile[]> {
    const r = await this.db.prepare(
      'SELECT * FROM brand_profiles WHERE user_id = ? ORDER BY id ASC',
    ).bind(userId).all<BrandProfile>();
    return (r.results ?? []).map(rowToProfile);
  }

  /**
   * Patch a brand profile.  Only the supplied fields are written; the rest
   * remain untouched.  Throws `BrandProfileNotFoundError` if the profile is missing.
   */
  async updateProfile(
    userId: string,
    name: string,
    updates: Partial<BrandProfileInput>,
  ): Promise<BrandProfile> {
    const existing = await this.getProfile(userId, name);
    if (!existing) throw new BrandProfileNotFoundError(userId, name);

    // Whitelist columns to avoid SQL injection via user-controlled names.
    const cols: string[] = [];
    const vals: unknown[] = [];
    const push = (col: string, val: unknown) => { cols.push(`${col} = ?`); vals.push(val); };

    if (updates.logo_url !== undefined)          push('logo_url', updates.logo_url ?? null);
    if (updates.color_primary !== undefined)      push('color_primary', normalizeHex(updates.color_primary));
    if (updates.color_secondary !== undefined)    push('color_secondary', normalizeHex(updates.color_secondary));
    if (updates.color_accent !== undefined)       push('color_accent', normalizeHex(updates.color_accent));
    if (updates.font_primary !== undefined)      push('font_primary', updates.font_primary ?? null);
    if (updates.font_secondary !== undefined)     push('font_secondary', updates.font_secondary ?? null);
    if (updates.intro_video_url !== undefined)    push('intro_video_url', updates.intro_video_url ?? null);
    if (updates.outro_video_url !== undefined)    push('outro_video_url', updates.outro_video_url ?? null);
    if (updates.watermark_position !== undefined) push('watermark_position', coerceWatermarkPosition(updates.watermark_position));
    if (updates.watermark_opacity !== undefined)   push('watermark_opacity', coerceOpacity(updates.watermark_opacity));
    if (updates.default_platform !== undefined)    push('default_platform', updates.default_platform);
    if (updates.default_style !== undefined)       push('default_style', updates.default_style);

    if (cols.length === 0) return existing;  // Nothing to update.

    cols.push('updated_at = ?');
    vals.push(nowSeconds());
    vals.push(userId, name);

    await this.db
      .prepare(`UPDATE brand_profiles SET ${cols.join(', ')} WHERE user_id = ? AND name = ?`)
      .bind(...vals)
      .run();

    return (await this.getProfile(userId, name)) as BrandProfile;
  }

  /** Delete a profile by (user_id, name).  No-op if the profile is missing. */
  async deleteProfile(userId: string, name: string): Promise<void> {
    await this.db.prepare(
      'DELETE FROM brand_profiles WHERE user_id = ? AND name = ?',
    ).bind(userId, name).run();
  }

  /**
   * Returns the active brand profile for a user.  Resolution order:
   *   1. the profile literally named "default"
   *   2. else the first profile (lowest id) the user owns
   *   3. else null (pipeline runs brandless)
   */
  async getActiveProfile(userId: string): Promise<BrandProfile | null> {
    const namedDefault = await this.getProfile(userId, 'default');
    if (namedDefault) return namedDefault;

    const r = await this.db.prepare(
      'SELECT * FROM brand_profiles WHERE user_id = ? ORDER BY id ASC LIMIT 1',
    ).bind(userId).first<BrandProfile>();
    return r ? rowToProfile(r) : null;
  }

  // ---------------- Assets ----------------

  /**
   * Insert a brand asset metadata row.  The binary blob itself must
   * already be stored (e.g. in the BRAND_ASSETS KV namespace by the
   * setup wizard); this method only records the metadata + pointer URL.
   * Throws on UNIQUE(user_id, asset_type, asset_name) conflict.
   */
  async addAsset(userId: string, asset: AssetInput): Promise<BrandAsset> {
    if (!userId) throw new Error('addAsset: userId is required');
    if (!asset?.asset_type) throw new Error('addAsset: asset.asset_type is required');
    if (!VALID_ASSET_TYPES_STR.includes(asset.asset_type)) throw new InvalidAssetTypeError(asset.asset_type);
    if (!asset.asset_name) throw new Error('addAsset: asset.asset_name is required');
    if (!asset.asset_url) throw new Error('addAsset: asset.asset_url is required');

    const meta = asset.asset_meta ? JSON.stringify(asset.asset_meta) : null;
    const row = await this.db.prepare(
      `INSERT INTO brand_assets (
         user_id, asset_type, asset_name, asset_url, asset_meta, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`,
    ).bind(
      userId, asset.asset_type, asset.asset_name, asset.asset_url, meta, nowSeconds(),
    ).first<BrandAsset>();

    if (!row) {
      throw new Error(
        `addAsset: INSERT did not return a row (UNIQUE conflict on ` +
        `user_id=${userId}, asset_type=${asset.asset_type}, asset_name=${asset.asset_name}?)`,
      );
    }
    return rowToAsset(row);
  }

  /** List brand assets for a user, optionally filtered by asset_type. */
  async listAssets(userId: string, type?: string): Promise<BrandAsset[]> {
    if (type && !VALID_ASSET_TYPES_STR.includes(type)) throw new InvalidAssetTypeError(type);
    const stmt = type
      ? this.db.prepare('SELECT * FROM brand_assets WHERE user_id = ? AND asset_type = ? ORDER BY id ASC').bind(userId, type)
      : this.db.prepare('SELECT * FROM brand_assets WHERE user_id = ? ORDER BY id ASC').bind(userId);
    const r = await stmt.all<BrandAsset>();
    return (r.results ?? []).map(rowToAsset);
  }

  /** Delete a brand asset by id.  Throws `BrandAssetNotFoundError` if missing. */
  async deleteAsset(userId: string, assetId: number): Promise<void> {
    const row = await this.db.prepare(
      'SELECT * FROM brand_assets WHERE id = ? AND user_id = ? LIMIT 1',
    ).bind(assetId, userId).first<BrandAsset>();
    if (!row) throw new BrandAssetNotFoundError(userId, assetId);

    await this.db.prepare(
      'DELETE FROM brand_assets WHERE id = ? AND user_id = ?',
    ).bind(assetId, userId).run();
  }
}
