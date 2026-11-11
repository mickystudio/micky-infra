# Brand Profile System (Task B13-retry)

Per-user brand identity — logo, colour palette, fonts, intro/outro clips,
watermark position + opacity — stored in Cloudflare **D1** (metadata) and
applied to montage videos by the Kaggle pipeline.  This README is the
quick-start for the three files in the B13-retry scope.

## Files in this scope

| File                                       | Role                                                  |
|-------------------------------------------|-------------------------------------------------------|
| `worker/migrations/0004_brand_assets.sql` | D1 schema: `brand_profiles` + `brand_assets` tables + indexes |
| `worker/src/core/brand_profile.ts`        | `BrandProfileManager` class + `BrandProfile` / `BrandAsset` types |
| `kaggle-src/montage/brand_overlay.py`     | `BrandOverlay` class (watermark + intro/outro + ASS restyle) |
| `worker/src/core/README_brand.md`          | this file                                             |

Other agents handle the setup wizard (`worker/src/bot/brand_setup.ts`),
the Telegram `/brand` command router (`worker/src/bot/handlers.ts`), and
the `BRAND_ASSETS` KV binding in `worker/wrangler.toml`.  Those files
are out of scope for B13-retry.

---

## 1. Schema overview

Defined in [`worker/migrations/0004_brand_assets.sql`](../../migrations/0004_brand_assets.sql).
The migration is **idempotent** (every CREATE statement uses
`IF NOT EXISTS`) and creates exactly four objects:

### `brand_profiles`

| column                  | type     | default         | notes                                              |
|-------------------------|----------|-----------------|----------------------------------------------------|
| `id`                    | INTEGER  | AUTOINCREMENT   | PK                                                 |
| `user_id`               | TEXT     | NOT NULL        | Telegram chat_id (as text)                         |
| `name`                  | TEXT     | `'default'`     | profile name; `UNIQUE(user_id, name)`              |
| `logo_url`              | TEXT     | NULL            | URL of the logo image                              |
| `color_primary`         | TEXT     | NULL            | hex `#RRGGBB`                                      |
| `color_secondary`       | TEXT     | NULL            | hex                                                |
| `color_accent`          | TEXT     | NULL            | hex                                                |
| `font_primary`          | TEXT     | NULL            | font name (e.g. `"Anton"`, `"Cairo"`)              |
| `font_secondary`        | TEXT     | NULL            | secondary UI font                                  |
| `intro_video_url`       | TEXT     | NULL            | optional pre-roll clip URL                         |
| `outro_video_url`       | TEXT     | NULL            | optional post-roll clip URL                        |
| `watermark_position`   | TEXT     | `'bottom-right'`| `top-left`/`top-right`/`bottom-left`/`bottom-right`/`center` |
| `watermark_opacity`     | REAL     | `0.3`           | `0.0`–`1.0`                                        |
| `default_platform`      | TEXT     | `'tiktok'`      | `tiktok`/`youtube`/`instagram`/`reels`/`facebook`  |
| `default_style`         | TEXT     | `'bold_pop'`    | `bold_pop`/`karaoke_fill`/`boxed`/`clean_lower`/`hormozi`/`tiktok_default` |
| `created_at`            | INTEGER  | NOT NULL        | epoch seconds                                      |
| `updated_at`            | INTEGER  | NOT NULL        | epoch seconds                                      |

**Constraints:** `UNIQUE(user_id, name)` — each user can have multiple
profiles, each with a unique name.  Default profile is named `"default"`.

### `brand_assets`

Generic per-user binary-asset catalog (multiple logos, fonts, LUTs,
intro/outro clips).  The binary blobs themselves live in the
`BRAND_ASSETS` KV namespace keyed by `{userId}/{assetType}/{uuid}`;
this table only stores the metadata + pointer URL (keeps D1 rows small
— D1's per-row soft cap is 1 MB).

| column                  | type     | notes                                              |
|-------------------------|----------|----------------------------------------------------|
| `id`                    | INTEGER  | PK AUTOINCREMENT                                   |
| `user_id`               | TEXT     | Telegram chat_id                                   |
| `asset_type`            | TEXT     | `logo`, `font`, `intro`, `outro`, `lut`            |
| `asset_name`            | TEXT     | human-readable name                                |
| `asset_url`             | TEXT     | KV key or external URL                             |
| `asset_meta`            | TEXT     | JSON blob: `{mime_type, size, ...}`               |
| `created_at`            | INTEGER  | epoch seconds                                      |

**Constraints:** `UNIQUE(user_id, asset_type, asset_name)`.

### Indexes

```sql
CREATE INDEX IF NOT EXISTS idx_brand_user          ON brand_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_assets_user_type    ON brand_assets(user_id, asset_type);
```

---

## 2. Brand profile is OPTIONAL — works without it

The montage pipeline runs **brandless by default**.  A user without a
brand profile (or with all fields NULL) gets the same montage output as
before B13.  Concretely:

* `BrandProfileManager.getActiveProfile(userId)` returns the profile
  named `"default"`, or if none exists, the first profile (lowest `id`)
  for the user, or `null` if the user has zero profiles.
* When `null`, the Worker passes `brand_profile: null` in the Kaggle
  task payload.
* `brand_overlay_from_dict(None)` and `brand_overlay_from_dict({})`
  both return `None` — the pipeline then skips the brand stages.
* `BrandOverlay({}).has_brand_content` is `False` — every method
  returns its input path unchanged (no-op, no FFmpeg invocation).

This means deploying the B13 schema + manager + overlay is **non-
breaking**: existing users see no change until they explicitly create a
brand profile via the setup wizard (handled by another agent).

---

## 3. How the Kaggle pipeline reads the brand profile

The brand profile flows from D1 → Worker → Kaggle via the **task
payload**.  There is no D1 access from the Kaggle worker (no Cloudflare
D1 binding on Kaggle).  The flow:

```
┌──────────────────────────────────────────────────────────────────────┐
│  1. User triggers a montage task (e.g. /montage command in Telegram) │
│     Worker looks up active brand profile via:                         │
│       BrandProfileManager.getActiveProfile(userId)                    │
│     → BrandProfile (D1 row, including NULL fields if unset).          │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼  (task payload)
┌──────────────────────────────────────────────────────────────────────┐
│  2. Worker posts task spec to the Kaggle runner with:                │
│       input_spec['brand_profile'] = {                                │
│         "name": "default",                                           │
│         "logo_url": "https://...",       # or null                   │
│         "color_primary": "#FF5733",       # or null                   │
│         "color_secondary": "#FFFFFF",                                 │
│         "color_accent": "#FFC300",                                    │
│         "font_primary": "Anton",                                       │
│         "intro_video_url": null,                                      │
│         "outro_video_url": null,                                      │
│         "watermark_position": "bottom-right",                        │
│         "watermark_opacity": 0.3,                                    │
│         "default_platform": "tiktok",                                │
│         "default_style": "bold_pop",                                 │
│       }                                                              │
│     (or null if the user has no profile)                              │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│  3. Kaggle montage pipeline:                                         │
│     overlay = brand_overlay_from_dict(input_spec.get('brand_profile'))│
│     if overlay is not None:                                          │
│         video_path = overlay.apply_brand_to_video(video_path)        │
│         ass_path   = overlay.restyle_captions(ass_path)              │
│     else:                                                            │
│         # brand stage skipped silently                               │
└──────────────────────────────────────────────────────────────────────┘
```

### What `apply_brand_to_video` does

1. **Intro/outro concat** (`apply_intro_outro`) — if
   `intro_video_url` or `outro_video_url` are set, downloads them and
   concatenates `intro + main + outro` via FFmpeg's `concat` demuxer
   (with a copy-mode fast-path and a re-encode fallback).
2. **Logo watermark** (`apply_watermark`) — if `logo_url` is set,
   overlays the logo at `watermark_position` with
   `colorchannelmixer=aa={watermark_opacity}` after scaling to a
   fixed 120-px height.
3. **Caption restyle** (`restyle_captions`) — runs separately on the
   `.ass` file: uses `pysubs2` to rewrite every Style line's
   `Fontname`, `PrimaryColour`, `SecondaryColour`, and the first
   `\1c` / `\2c` override tag in each Dialogue event with the brand
   colours.  Writes a new `<base>_brand.ass` next to the original.

All steps are fail-soft: any FFmpeg / download error is logged and the
original input is returned unchanged so the pipeline never crashes.

### Why KV for binaries?

D1 has a 1 MB per-row soft cap — logos are 200 KB–2 MB, fonts are
50 KB–800 KB, intro clips can be 5–50 MB.  The brand_assets table only
stores the metadata + a pointer URL; the binary itself lives in the
`BRAND_ASSETS` KV namespace (binding handled by another agent in
`wrangler.toml`).

---

## 4. Operational notes

### Running the migration

```bash
wrangler d1 execute micky-db --remote --file=worker/migrations/0004_brand_assets.sql
```

The migration is idempotent (every CREATE statement uses `IF NOT
EXISTS`); re-running it is safe.  Forward-only — no down-migration.

### Constructing a manager in the Worker

```typescript
import { BrandProfileManager } from './core/brand_profile';

// inside a fetch handler:
const manager = new BrandProfileManager(env.DB);
const profile = await manager.getActiveProfile(userId);
// → BrandProfile | null
```

The constructor only takes `env.DB` (no KV) — binary uploads are out of
scope for B13-retry and will be wired up by another agent.

### Smoke test on Kaggle

```bash
cd /kaggle/working/montage
python brand_overlay.py
# → "BrandOverlay: default; primary=#FF5733 has_brand_content=True"
# → "  brand_overlay_from_dict(None/empty) → None ✅"
```

---

## 5. Public API summary

### TypeScript (`worker/src/core/brand_profile.ts`)

```typescript
export interface BrandProfile { /* all schema fields + id */ }
export interface BrandProfileInput { /* subset for create/update */ }
export interface BrandAsset { id, user_id, asset_type, asset_name, asset_url, asset_meta, created_at }
export interface AssetInput { asset_type, asset_name, asset_url, asset_meta? }

export class BrandProfileManager {
  constructor(db: D1Database);
  createProfile(userId, input: BrandProfileInput): Promise<BrandProfile>;
  getProfile(userId, name?: string): Promise<BrandProfile | null>;
  listProfiles(userId): Promise<BrandProfile[]>;
  updateProfile(userId, name, updates: Partial<BrandProfileInput>): Promise<BrandProfile>;
  deleteProfile(userId, name): Promise<void>;
  getActiveProfile(userId): Promise<BrandProfile | null>;  // 'default' or first
  addAsset(userId, asset: AssetInput): Promise<BrandAsset>;
  listAssets(userId, type?: string): Promise<BrandAsset[]>;
  deleteAsset(userId, assetId: number): Promise<void>;
}
```

All D1 queries use bound `?` parameters — no SQL injection.

### Python (`kaggle-src/montage/brand_overlay.py`)

```python
@dataclass
class BrandProfile:
    # All BrandProfile fields default to None / 0 / '' / 'default' /
    # 'bottom-right' / 0.3 / 'tiktok' / 'bold_pop' so a partial D1 dict
    # still constructs a valid profile.
    @classmethod
    def from_dict(cls, d: dict | None) -> BrandProfile | None: ...

class BrandOverlay:
    def __init__(self, brand_profile: dict): ...
    def apply_brand_to_video(self, video_path: str) -> str: ...
    def apply_watermark(self, video_path: str) -> str: ...
    def apply_intro_outro(self, video_path: str) -> str: ...
    def restyle_captions(self, ass_path: str) -> str: ...

def brand_overlay_from_dict(brand_profile: dict | None) -> BrandOverlay | None: ...
```

If `brand_profile` is `None` or empty, `brand_overlay_from_dict` returns
`None` — the pipeline then runs brandless.

---

**Task B13-retry — completed 2026-11-13.**
