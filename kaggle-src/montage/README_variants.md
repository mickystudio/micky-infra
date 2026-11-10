# B12 — A/B Variants + Platform Adaptation

> Pro editors don't deliver one master. They deliver **2–3 variants** for
> the client to choose from, plus a **platform-adapted master** for each
> destination (TikTok 9:16 ≤ 60s fast / YouTube 16:9 ≤ 15 min medium /
> Reels 9:16 ≤ 90s / Shorts / square / landscape).

This module adds both capabilities to the Micky Assistant montage
pipeline. It is **off by default** (each variant costs ~60s of T4
render time, so the pipeline keeps single-master output unless the
caller opts in).

---

## Why A/B variants matter

| Pro editor behaviour                                   | What B12 does |
|---------------------------------------------------------|---------------|
| Delivers 2–3 cuts of every clip for client review      | `ABVariantGenerator.generate_variants(count=2)` |
| Varies one production dimension per variant             | `different_take_order`, `different_pacing`, `different_music`, `different_color_grade` |
| Flags the "best" variant for the client                 | `pick_best_variant()` scores each variant's mid-frame via B7's `VLMScorer` |
| Builds a side-by-side comparison sheet                  | `compare_variants()` writes a hstack JPG to `/tmp/micky_variants/comparison_<hash>.jpg` |
| One master per platform (TikTok vs YouTube vs Reels)    | `PlatformAdapter.adapt_video()` re-encodes + smart reframes + paces |

A single `run_pipeline` call can now produce:

```
output_dir/
├── master.mp4                                  # Stage 7/8/9 result
├── master_tiktok_adapted.mp4                   # B12: TikTok 9:16 ≤ 60s
├── master_youtube_adapted.mp4                  # B12: YouTube 16:9 ≤ 15min
├── master_reels_adapted.mp4                    # B12: Reels 9:16 ≤ 90s
├── variants/
│   ├── variant_take_order.mp4                  # reverse chronological
│   ├── variant_pacing_medium.mp4               # 3–5s cuts
│   ├── variant_music.mp4                        # alternate BGM track
│   ├── variant_color_cinematic.mp4             # alt LUT/mood
│   └── comparison_<hash>.jpg                    # side-by-side preview
└── captions.json
```

---

## The 4 variation strategies

Each strategy varies exactly one production dimension (so the client
sees *why* a variant differs from the master, not a muddle of all
changes at once).

### 1. `different_take_order`

Re-orders the selected takes from B1/B7. Two modes:

- **With `scene_boundaries`** (provided by B1's `SceneDetector`):
  reverses the chronological order so the climax plays first (good for
  TikTok hooks). All takes preserved, just re-ordered.
- **Without boundaries**: splits the master into 3 even chunks and
  reverses them (deterministic fallback).

Re-render cost: ~30s on T4 (re-encode + concat).

### 2. `different_pacing`

Re-cuts the master to a different average shot length via
`PlatformAdapter.adjust_pacing`:

| Pacing | Cut interval   | Use case                          |
|--------|----------------|-----------------------------------|
| fast   | 1–2s           | TikTok / Reels retention curve    |
| medium | 3–5s           | YouTube talking-head norm         |
| slow   | 6–10s          | cinematic / interview             |

When `beat_times` are provided, cuts snap to the nearest beat within
±0.5s (preserves musical sync).

Re-render cost: ~40s on T4 (segment + concat per cut).

### 3. `different_music`

Swaps the background music track using B4's `MusicLibrary` index:

- Picks a track with a different mood (e.g., calm → energetic).
- Falls back to ffmpeg sidechain duck if the music library is empty:
  -3 dB bass boost + 2 dB treble cut for a "live acoustic" feel.

Re-render cost: ~15s on T4 (audio-only swap; video stream is `-c:v
copy`).

### 4. `different_color_grade`

Applies a different LUT/mood preset via B6's `ColorGraderV2.grade_with_style`:

- Mood rotation: `cinematic → warm → cool → vintage → noir → vibrant`
- Falls back to ffmpeg `curves` filter when B6 is unavailable (no LUT
  file needed; per-mood curves baked into the variant generator).

Re-render cost: ~50s on T4 (full re-encode with LUT).

---

## Platform spec table

| Platform   | Aspect | Resolution    | Max duration | Pacing  | FPS | Video bitrate | Audio bitrate |
|------------|--------|---------------|--------------|---------|-----|----------------|---------------|
| `tiktok`   | 9:16   | 1080 × 1920   | 60s          | fast    | 30  | 5 Mbps         | 128 kbps      |
| `youtube`  | 16:9   | 1920 × 1080   | 900s (15m)   | medium  | 30  | 8 Mbps         | 192 kbps      |
| `reels`    | 9:16   | 1080 × 1920   | 90s          | fast    | 30  | 4 Mbps         | 128 kbps      |
| `shorts`   | 9:16   | 1080 × 1920   | 60s          | fast    | 60  | 6 Mbps         | 192 kbps      |
| `square`   | 1:1    | 1080 × 1080   | 120s         | medium  | 30  | 4 Mbps         | 128 kbps      |
| `landscape`| 16:9   | 1920 × 1080   | 600s (10m)   | medium  | 30  | 6 Mbps         | 160 kbps      |

Implementation: `platform_adapter.PLATFORM_SPECS`. Each entry also
carries `hashtags` (platform-default hashtags appended to LLM-generated
captions) and `caption_max` (truncation length, e.g. TikTok ≤ 2200
chars).

---

## Smart reframe algorithm (face-aware)

When the source aspect differs from the target (e.g. 9:16 → 16:9 for
YouTube), `PlatformAdapter.reframe_smart()` performs a **subject-aware
crop** instead of a dumb center crop:

```
1. Extract the middle frame (ffmpeg -ss mid -frames:v 1).
2. Try subject detection (in order):
   a. RVM alpha matte centroid  ←  preferred (B4 background_remover)
   b. OpenCV YuNet face detector ←  B1 already downloads the .onnx
   c. Center crop (0.5, 0.5)      ←  last resort
3. Compute crop rectangle:
   - keep the longer dimension
   - crop the shorter dimension to target aspect ratio
   - center the crop on the detected subject (clamped to frame bounds)
4. ffmpeg crop=W:H:x_off:y_off → re-encode (libx264, CRF 20).
```

**Why RVM over MediaPipe?** The pipeline already runs Robust Video
Matting in Stage 4 (background removal), so the alpha matte is in
cache. Re-using it for reframe detection:

- Saves a model load (~2 GB VRAM)
- Is more reliable for talking-head footage (RVM handles occlusions;
  MediaPipe loses the face when the speaker turns sideways)
- Gives a subject centroid, not just a face box (so hand-gestures,
  props, etc. stay in frame)

**Edge cases handled:**

- No face detected → center crop (deterministic, no crash)
- Source already at target aspect → no-op crop (just re-encode)
- Crop dimensions odd (libx264 requires even) → round down to even
- ffmpeg crop filter fails → fall back to center crop with `crop=W:H`
  (no offset)
- Subject near edge → clamp `x_off`/`y_off` to `[0, src_dim - crop_dim]`
  so the crop stays fully inside the source frame

---

## Caption generation (LLM via micky gateway)

`PlatformAdapter.generate_caption_for_platform(transcript, platform)`
calls back into Micky Assistant's own LLM gateway
(`micky-assistant.cources01.workers.dev/v1/chat/completions`, model
`qwen3-32b`) — the same endpoint B3 uses for highlight scoring. The
gateway is OpenAI-compatible, so the call shape is a standard chat
completion.

Each platform gets a distinct system prompt:

| Platform | Caption style                                                  | Length cap |
|----------|----------------------------------------------------------------|------------|
| TikTok   | Short, punchy, 2-3 emojis, ≤5 hashtags                        | 150 chars  |
| YouTube  | SEO description, hook line, 2-3 MM:SS timestamps, 3-5 keywords| 800 chars  |
| Reels    | Medium, one emoji, ≤5 hashtags                                 | 300 chars  |
| Shorts   | Short, punchy, one emoji, ≤5 hashtags                         | 200 chars  |

**Defensive fallback:** if the gateway is unreachable (network error,
HTTP non-200, missing `requests` package), the adapter falls back to a
deterministic template caption with the first transcript line +
platform-default hashtags. The pipeline never blocks on caption gen.

**24h disk cache** (same as B3): `~/.cache/micky/llm/<sha256>.json`,
TTL = 24h. Re-running on the same video + platform is free.

---

## Pipeline integration

### Options (added to `run_pipeline`)

| Option               | Type        | Default     | Description |
|----------------------|-------------|-------------|-------------|
| `adapt_platforms`    | `list[str]` | `['tiktok']`| B12 platform names to adapt the final video to. Pass `[]` to disable Stage 10. |
| `generate_variants`  | `int`       | `1` (= off) | Number of A/B variants for the primary platform. Clamped to `[1, 3]`. |
| `variant_criteria`   | `str`       | `'virality'`| `pick_best_variant` scoring: `virality` \| `composition` \| `lighting`. |

CLI:

```bash
# Default: just TikTok adaptation, no variants
python pipeline.py --input raw.mp4 --output /tmp/out

# YouTube + TikTok adaptation, 2 variants
python pipeline.py --input raw.mp4 --output /tmp/out \
    --adapt-platforms tiktok,youtube --variants 2

# Or via JSON spec file
python pipeline.py --spec spec.json
```

`spec.json`:
```json
{
  "file_url": "/tmp/raw.mp4",
  "output_dir": "/tmp/out",
  "adapt_platforms": ["tiktok", "youtube", "reels"],
  "generate_variants": 3,
  "variant_criteria": "composition"
}
```

### Stage 10 — Platform adaptation + A/B variants

Runs after Stage 9 (legacy `export_multi_platform`). The flow:

```
animated_video ──► Stage 9 legacy multi_export ──► outputs[]
            │
            └─► Stage 10 B12 PlatformAdapter ──► adapted_outputs[]
                              │
                              └─► if variants > 1 ──► ABVariantGenerator
                                                       ├── variant_take_order.mp4
                                                       ├── variant_pacing_medium.mp4
                                                       ├── variant_music.mp4
                                                       ├── variant_color_cinematic.mp4
                                                       └── comparison_<hash>.jpg
```

### `MultiExporter` (new in `multi_export.py`)

For programmatic callers who want both legacy + B12 in one call:

```python
from multi_export import MultiExporter

exporter = MultiExporter(legacy_export=True, variant_criteria='virality')
result = exporter.export_with_variants(
    video_path='/tmp/master.mp4',
    platforms=['tiktok', 'youtube'],
    variant_count=2,
    output_dir='/tmp/out',
    takes=[...],                # B1 Take objects (optional)
    beat_times=[0.5, 1.0, ...], # optional
    options={'transcript_text': '...'},
)
# result = {
#   'platforms': {'tiktok': {...}, 'youtube': {...}},
#   'legacy':    {'tiktok': {...}, 'youtube': {...}},  # legacy multi_export
#   'variants':  [{'id', 'description', 'video_path', 'score', 'is_best'}, ...],
#   'comparison_image': '/tmp/.../comparison_<hash>.jpg',
#   'best_variant_id': 'v01_different_take_order',
#   'all_files':   [...],   # all MP4s + comparison JPG
#   'total_size_mb': 124.5,
# }
```

---

## Performance notes

| Operation                                | Wall-time on T4 (60s source) | Notes |
|------------------------------------------|------------------------------|-------|
| Per-platform adaptation (1 platform)     | ~25s                          | Smart reframe + re-encode |
| Per-platform adaptation (6 platforms)    | ~90s                          | Sequential; could parallelise via ThreadPool |
| Variant: `different_take_order`         | ~30s                          | Re-encode + concat |
| Variant: `different_pacing`              | ~40s                          | Segment + concat per cut |
| Variant: `different_music`              | ~15s                          | Audio-only swap (`-c:v copy`) |
| Variant: `different_color_grade`         | ~50s                          | Full re-encode with LUT |
| `pick_best_variant` (VLM scoring)       | ~20s × N variants             | Qwen2.5-VL-7B frame scoring; cached 24h |
| `compare_variants` (hstack JPG)         | ~2s                           | ffmpeg hstack filter |

**Total cost for `generate_variants=3` on one platform:**
~135s (45s per variant avg) + 60s VLM scoring + 2s compare = **~200s**
on top of the base pipeline (~8 min on T4 for a 60s source).

---

## Defensive behaviour

Every method degrades gracefully when optional deps are unavailable:

| Failure mode                          | Fallback                                          |
|---------------------------------------|---------------------------------------------------|
| `platform_adapter` module missing     | Stage 10 skipped with warning; pipeline continues  |
| `ab_variant_generator` module missing | Variants skipped; platform adaptation still runs  |
| `VLMScorer` unavailable              | `pick_best_variant` returns first variant (score=5.0) |
| RVM model unavailable                 | Falls back to YuNet → falls back to center crop   |
| OpenCV YuNet unavailable              | Falls back to center crop (0.5, 0.5)              |
| Micky LLM gateway down               | Template caption (first transcript line + tags)   |
| Music library empty                  | ffmpeg sidechain duck with EQ change              |
| ColorGraderV2 missing                | ffmpeg `curves` filter (no LUT file needed)       |

The pipeline never crashes for lack of a GPU, optional Python package,
or network access — every variant simply produces the closest
deterministic alternative.

---

## File map

| File                              | Responsibility                                  |
|-----------------------------------|--------------------------------------------------|
| `platform_adapter.py`             | `PlatformAdapter` + smart reframe + LLM captions |
| `ab_variant_generator.py`         | `ABVariantGenerator` + `Variant` dataclass       |
| `pipeline.py` (Stage 10)          | Pipeline integration of both above               |
| `multi_export.py` (`MultiExporter`)| Programmatic multi-platform + variants entry    |
| `README_variants.md` (this file)   | Docs + perf table + spec table                  |

---

## Future work

- **Parallel platform adaptation**: current Stage 10 is sequential
  across platforms. Could be parallelised via ThreadPoolExecutor (each
  PlatformAdapter is independent).
- **VLM scoring of full variant videos** (not just mid-frame): would
  sample N frames across each variant for a more robust score.
  Currently ~5× slower per variant.
- **Audio ducking improvements**: the `different_music` variant uses a
  fixed -3 dB sidechain; should adapt to the source's speech density.
- **Variant metadata JSON**: write `variants/manifest.json` with all
  variant scores + parameters used, so the client UI can present a
  picker.

---

Created: 2026-11-25  |  Agent B12  |  Phase P4 (T8 + variants)
