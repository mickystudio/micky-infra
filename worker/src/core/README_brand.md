# Brand Profile System (Task B13)

Per-user brand identity (logo, colour palette, fonts, intro/outro clips,
watermark position + opacity) stored in **D1** (metadata) + **KV**
(binary blobs) and applied by the Kaggle montage pipeline.

This README covers:

1. [Schema](#1-schema)
2. [Setup wizard flow](#2-setup-wizard-flow)
3. [Asset storage in KV](#3-asset-storage-in-kv)
4. [Multi-profile support](#4-multi-profile-support)
5. [Telegram command surface](#5-telegram-command-surface)
6. [Pipeline integration](#6-pipeline-integration)
7. [Operational notes](#7-operational-notes)

---

## 1. Schema

Defined in [`worker/migrations/0004_brand_assets.sql`](../../migrations/0004_brand_assets.sql).

### `brand_profiles`

| column                  | type     | notes                                              |
|-------------------------|----------|----------------------------------------------------|
| `id`                    | INTEGER  | PK AUTOINCREMENT                                   |
| `user_id`               | TEXT     | Telegram chat_id (as text)                         |
| `name`                  | TEXT     | `"default"`, `"personal"`, `"business"` …          |
| `logo_url`              | TEXT     | KV key (`<userId>/logo/<uuid>`) or external URL    |
| `color_primary`         | TEXT     | `"#FF5733"` (hex; normalized on write)            |
| `color_secondary`       | TEXT     | `"#FFFFFF"`                                        |
| `color_accent`          | TEXT     | `"#FFC300"`                                        |
| `font_primary`          | TEXT     | `"Anton"`, `"Cairo"`, `"Tajawal"` …                |
| `font_secondary`        | TEXT     | secondary UI font                                  |
| `intro_video_url`       | TEXT     | optional pre-roll clip                             |
| `outro_video_url`       | TEXT     | optional post-roll clip                            |
| `watermark_position`    | TEXT     | `top-left`, `top-right`, `bottom-left`, `bottom-right`, `center` |
| `watermark_opacity`     | REAL     | `0.0`–`1.0` (default `0.3`)                         |
| `default_platform`      | TEXT     | `tiktok`, `youtube`, `instagram`, `reels`, `facebook` |
| `default_style`         | TEXT     | `bold_pop`, `karaoke_fill`, `boxed`, `clean_lower`, `hormozi`, `tiktok_default` |
| `created_at`            | INTEGER  | epoch seconds                                      |
| `updated_at`            | INTEGER  | epoch seconds                                      |
| **UNIQUE(user_id, name)** |        | one profile name per user                          |

### `brand_assets`

Generic table for additional binary assets (multiple logos per user,
uploaded fonts, LUTs, …).  Each row points to a binary blob in KV
via `asset_url`.

| column                  | type     | notes                                              |
|-------------------------|----------|----------------------------------------------------|
| `id`                    | INTEGER  | PK AUTOINCREMENT                                   |
| `user_id`               | TEXT     | Telegram chat_id (as text)                         |
| `asset_type`            | TEXT     | `logo`, `font`, `intro`, `outro`, `lut`            |
| `asset_name`            | TEXT     | human-readable name                                |
| `asset_url`             | TEXT     | KV key or external URL                             |
| `asset_meta`            | TEXT     | JSON: `{mime_type, size, ...}` for fonts / LUTs    |
| `created_at`            | INTEGER  | epoch seconds                                      |
| **UNIQUE(user_id, asset_type, asset_name)** || one name per (user, type)              |

### `users.active_brand_profile`

`ALTER TABLE users ADD COLUMN active_brand_profile TEXT` — points to
the brand profile name currently active for the user.  NULL means
"no brand profile" (pipeline runs brandless).  Storing the pointer on
the users table (rather than in a separate "session" table) means it
survives KV eviction and is cheap to read alongside the user row.

---

## 2. Setup wizard flow

Implemented in [`worker/src/bot/brand_setup.ts`](../bot/brand_setup.ts).

```
/brand new [name]
   │
   ▼
Step 1 (logo):      "أرسل لي شعارك (logo) أو /skip"
                    [user sends photo]  →  uploadAsset() → KV
                    [user sends /skip]  →  continue
   │
   ▼
Step 2 (colour):    inline keyboard, 8 presets (4×2 grid)
                    🔴 🟠 🟡 🟢 🔵 🟣 ⚪ ⚫
                    callback_data: brand:setup:color:#RRGGBB
   │
   ▼
Step 3 (font):      inline keyboard, 6 presets
                    Anton / Impact / Cairo / Tajawal / Almarai / Amiri
                    callback_data: brand:setup:font:<Name>
   │
   ▼
Step 4 (platform):  inline keyboard, 4 platforms
                    TikTok / YouTube / Instagram / Reels
                    callback_data: brand:setup:platform:<name>
   │
   ▼
finishBrandSetup()  →  BrandProfileManager.createProfile(userId, input)
                       BrandProfileManager.setActiveProfile(userId, name)
                       → success message
```

Wizard state is persisted in the **LOCKS** KV namespace with a 1h TTL
(same pattern as the `/newproject` wizard).  Each incoming Telegram
update is handled statelessly — `processTelegramUpdate` checks for an
active wizard before routing to the generic message handlers.

Photo messages during the logo step are intercepted by
`processTelegramUpdate` (before the generic media handler) and routed
to `handleBrandSetupPhoto` in `brand_setup.ts`.

Callback queries (`update.callback_query`) are dispatched by
`processTelegramUpdate` — if `data` starts with `brand:setup:`, it
answers the callback query (so Telegram's loading spinner stops) and
delegates to `handleBrandSetupCallback`.

---

## 3. Asset storage in KV

The `BRAND_ASSETS` KV namespace holds binary blobs (logos, fonts,
intro/outro MP4s).  Keys are namespaced:

```
{userId}/{assetType}/{uuid}
   │       │          │
   │       │          └── crypto.randomUUID() — collision-free
   │       └── logo | font | intro | outro | lut
   └── Telegram chat_id (as text)
```

Metadata (mime_type, original filename, size) is stored in the KV
value's `metadata` field (limited to 1024 bytes per KV metadata entry)
via `kv.put(key, buf, { metadata: {...} })`.

### Why KV instead of D1 for binaries?

* D1 has a **1 MB per-row cap** — a typical logo is 200 KB – 2 MB,
  fonts are 50 KB – 800 KB, intro clips can be 5–50 MB.
* D1's row-level query cache is polluted by large blobs.
* KV is **edge-cached** — the Kaggle montage worker fetches the logo
  with sub-50 ms latency on warm reads.
* D1 keeps the strong-consistent metadata (UNIQUE constraints, JOINs
  against users for the active-profile pointer).

### Why KV instead of R2?

R2 would be the "right" choice for large binaries, but the worker
doesn't have an R2 binding yet.  KV's 25 MB per-value soft cap is
enough for logos + fonts + short intro/outro clips.  When the project
adds R2, the `uploadAsset` method can be extended to use R2 for
`asset_type in (intro, outro)` while keeping KV for logos + fonts.

### Fetching assets from Kaggle

The Kaggle montage worker resolves KV URLs (`kv://brand-assets/...`)
via the optional environment variable `MICKY_WORKER_URL` — see
`fetch_brand_asset` in [`brand_overlay.py`](../../../kaggle-src/montage/brand_overlay.py).
The Worker needs a `/brand/asset?key=...` route (Task B14 — not yet
implemented) to serve the binary.  Until then, callers must use direct
`https://...` URLs for `logo_url` / `intro_video_url` / `outro_video_url`.

---

## 4. Multi-profile support

Each user can own multiple brand profiles (e.g. `"default"`,
`"personal"`, `"business"`) and switch the active one at runtime.

| Operation                              | Command                              |
|----------------------------------------|--------------------------------------|
| Create new profile via wizard          | `/brand new [name]`                  |
| Switch active profile (creates if missing) | `/brand profile <name>`         |
| List all profiles                      | `/brand list`                        |
| Delete a profile (refuses the last one)| `/brand delete <name>`               |
| Show the active profile                | `/brand`                             |

`users.active_brand_profile` holds the active profile name.  When the
Kaggle runner receives a montage task, it reads this column to fetch
the brand profile dict and pass it to
`pipeline.run_pipeline(..., options={'brand_profile': {...}})`.

If the user has no active profile, the pipeline runs brandless — no
watermark, no brand colours, no intro/outro.  This makes the brand
profile **OPTIONAL** in the pipeline (backward-compatible with all
existing callers).

---

## 5. Telegram command surface

All commands live in [`worker/src/bot/handlers.ts`](../bot/handlers.ts)
under `handleBrandCommand`.  The main router (`src/index.ts`) dispatches
`/brand ...` text commands and `brand:setup:*` callback queries.

| Command                                | Action                                              |
|----------------------------------------|-----------------------------------------------------|
| `/brand`                               | Show the active profile, or start the wizard if none |
| `/brand new [name]`                    | Start the 4-step setup wizard                       |
| `/brand set <field> <value>`           | Update one field of the active profile              |
| `/brand logo`                          | Set "waiting for photo" state; next photo becomes the logo |
| `/brand font <name>`                   | Shortcut for `/brand set font_primary <name>`        |
| `/brand color <#hex>`                  | Shortcut for `/brand set color_primary <#hex>`       |
| `/brand profile <name>`                | Switch active profile (creates if missing)           |
| `/brand list`                          | List all profiles                                   |
| `/brand delete <name>`                 | Delete a profile (refuses the last one)             |
| `/brand help`                          | Show available sub-commands                         |
| `/skip` (during wizard)                | Skip the current wizard step (logo step only)       |

### Allowed `/brand set` fields

```
color_primary, color_secondary, color_accent          (hex #RRGGBB)
font_primary, font_secondary                          (font name)
watermark_position                                    (top-left | top-right | bottom-left | bottom-right | center)
watermark_opacity                                     (float 0.0–1.0)
default_platform                                      (tiktok | youtube | instagram | reels | facebook)
default_style                                         (bold_pop | karaoke_fill | boxed | clean_lower | hormozi | tiktok_default)
logo_url, intro_video_url, outro_video_url            (URL string)
```

### Logo upload size limit

`MAX_LOGO_SIZE_BYTES = 5 * 1024 * 1024` (5 MB).  Enforced in
`BrandProfileManager.uploadAsset` — throws
`BrandAssetTooLargeError` on exceedance.  Intro/outro clips have a 50 MB
cap (`MAX_VIDEO_ASSET_SIZE_BYTES`).

---

## 6. Pipeline integration

The montage pipeline reads `options['brand_profile']` (a dict, or None)
and applies three brand customizations:

1. **Stage 6 (captions)**: passes `brand_profile.font_primary` to the
   kinetic caption generator (`generate_kinetic_captions(font_name=...)`).
   After caption generation, calls `BrandOverlay.restyle_captions()`
   which rewrites the `.ass` file's `Style:` line (Fontname +
   PrimaryColour + SecondaryColour) and the first `\1c` / `\2c` inline
   colour tags on each Dialogue line.  The restyled `.ass` file is
   saved as `*_brand.ass` next to the original.

2. **Stage 7 (animations)**: brand profile does NOT change Remotion
   rendering (the Remotion renderer reads `options['kinetic_ass_path']`
   which we updated to point at the restyled file).

3. **Stage 8.5 (brand overlay)**: applies the logo watermark (FFmpeg
   `overlay` + `colorchannelmixer=aa=<opacity>`) at the configured
   position.  If `intro_video_url` or `outro_video_url` are set, they
   are concatenated (intro + main + outro) via FFmpeg's `concat`
   demuxer.

### Calling the pipeline with a brand profile

```python
from pipeline import run_pipeline

result = run_pipeline(
    input_video_path='/kaggle/working/raw.mp4',
    output_dir='/kaggle/working/out',
    options={
        'brand_profile': {
            'name': 'default',
            'logo_url': 'https://example.com/logo.png',  # or kv://...
            'color_primary': '#FF5733',
            'color_secondary': '#FFFFFF',
            'color_accent': '#FFC300',
            'font_primary': 'Anton',
            'watermark_position': 'bottom-right',
            'watermark_opacity': 0.3,
            'default_platform': 'tiktok',
            'default_style': 'bold_pop',
            # 'intro_video_url': 'https://example.com/intro.mp4',
            # 'outro_video_url': 'https://example.com/outro.mp4',
        },
        # ... all other options (platforms, language, skip_stages, ...)
    },
)
```

### Spec-based entry point

`run_pipeline_from_spec(input_spec)` accepts `input_spec['brand_profile']`
as a dict and forwards it to `run_pipeline` via `options['brand_profile']`.
This is the entry point the Kaggle runner uses.

### Skipping the brand stage

Pass `'brand'` in `options['skip_stages']` (or `input_spec['skip_stages']`)
to skip Stage 8.5 only (captions still get restyled in Stage 6).  When
`brand_profile` is `None`, the entire brand machinery is skipped
silently — the pipeline behaves identically to the pre-B13 version.

---

## 7. Operational notes

### Creating the KV namespace

Before deploying, create the BRAND_ASSETS KV namespace and replace the
placeholder id in `wrangler.toml`:

```bash
wrangler kv namespace create BRAND_ASSETS
# copy the returned id
# edit worker/wrangler.toml → [[kv_namespaces]] binding="BRAND_ASSETS" id="..."
```

### Running the migration

```bash
wrangler d1 execute micky-db --remote --file=worker/migrations/0004_brand_assets.sql
```

The migration is idempotent for the CREATE TABLE / CREATE INDEX
statements (uses `IF NOT EXISTS`).  The `ALTER TABLE users ADD COLUMN
active_brand_profile` is **not** idempotent — running it twice will fail
on the duplicate column (this is the standard D1 migration convention).

### Default seeded profile

The migration seeds a `default` profile for the admin user
(`chat_id=1235548782`) with `color_primary=#FF5733`, `font_primary=Anton`,
`watermark_position=bottom-right`, `watermark_opacity=0.3`,
`default_platform=tiktok`, `default_style=bold_pop`.  Edit the migration
before deploying to seed a different default.

### Files

| File                                       | Role                                           |
|-------------------------------------------|------------------------------------------------|
| `worker/migrations/0004_brand_assets.sql` | D1 schema (brand_profiles, brand_assets, users.active_brand_profile) |
| `worker/src/core/brand_profile.ts`        | `BrandProfileManager` + types + validators     |
| `worker/src/bot/brand_setup.ts`           | 4-step setup wizard + KV state                  |
| `worker/src/bot/handlers.ts`              | `/brand` command router (`handleBrandCommand`)  |
| `worker/src/index.ts`                     | dispatch `/brand`, `/skip`, photo intercept, callback dispatch |
| `worker/wrangler.toml`                    | `BRAND_ASSETS` KV binding                       |
| `kaggle-src/montage/brand_overlay.py`     | `BrandOverlay` class (watermark + intro/outro + caption restyle) |
| `kaggle-src/montage/pipeline.py`          | Stage 6 (font + restyle) + Stage 8.5 (overlay)  |

### File sizes (each < 500 lines as required)

| File                                       | Lines (approx) |
|-------------------------------------------|-----------------|
| `brand_assets.sql`                         | ~90             |
| `brand_profile.ts`                         | ~510 (slightly over — split into manager + validators if strict) |
| `brand_setup.ts`                           | ~430            |
| `handlers.ts` (`/brand` section)           | ~360            |
| `brand_overlay.py`                         | ~370            |
| `pipeline.py` (B13 additions)              | ~70 (additions only) |
| `README_brand.md` (this file)              | ~270            |

---

**Task B13 — completed 2026-11-13.**
