# Multi-Camera Sync & Switching (Agent B15)

This sub-module of the Micky Assistant montage pipeline adds **multi-camera
synchronisation and automatic switching** — when the user uploads multiple
videos that recorded the same event from different angles (e.g. two phones
at a dental talk, a wide + close-up at a concert), the pipeline auto-aligns
them by audio and renders a single switched MP4 that picks the best camera
for each moment.

Two new modules:

1. **`multicam_sync.py`** — `MultiCamSync` aligns multiple videos by
   audio (FFT cross-correlation or clap-detection spectral flux).
2. **`multicam_switcher.py`** — `MultiCamSwitcher` generates a cut plan
   (when to switch to which camera) and renders the final stitched video
   via FFmpeg.

Pipeline integration in `pipeline.py`: if `options['multicam_mode']` is
set and `options['multicam_videos']` is provided, the pipeline runs
sync+switch first, then rebinds `input_video_path` to the switched MP4 so
all downstream stages (Whisper → audio enhance → bg removal → color →
captions → animation → multi-platform export) operate on the switched
output as if it were a single-camera take.

Telegram bot (`worker/src/bot/handlers.ts`) detects when a user sends
multiple videos in a short window and prompts them to pick a sync method
+ switching mode before queuing the montage task.

---

## Multi-cam workflow

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  Camera A    │   │  Camera B    │   │  Camera C    │
│  (reference) │   │  (wide)      │   │  (close-up)  │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │                  │                  │
       ▼                  ▼                  ▼
 ┌─────────────────────────────────────────────────────┐
 │  1. extract_audio()  →  16 kHz mono WAV per camera  │
 └─────────────────────────────────────────────────────┘
       │
       ▼
 ┌─────────────────────────────────────────────────────┐
 │  2. align_videos()  →  AlignmentResult             │
 │     ├─ cross_correlation : scipy.signal.correlate  │
 │     ├─ clap_detection   : librosa spectral flux     │
 │     └─ auto            : clap → cross-correlation  │
 └─────────────────────────────────────────────────────┘
       │
       ▼
 ┌─────────────────────────────────────────────────────┐
 │  3. (optional) sync_preview()  →  side-by-side MP4  │
 │     low-res 30s preview so the user can confirm.   │
 └─────────────────────────────────────────────────────┘
       │
       ▼
 ┌─────────────────────────────────────────────────────┐
 │  4. MultiCamSwitcher.generate_cut_plan(mode)        │
 │     ├─ smart        : pick best camera per segment  │
 │     ├─ round_robin  : cycle every N seconds         │
 │     ├─ beat_sync     : switch on beat_times         │
 │     └─ speaker      : pick loudest camera           │
 └─────────────────────────────────────────────────────┘
       │
       ▼
 ┌─────────────────────────────────────────────────────┐
 │  5. render_multicam_video()                         │
 │     FFmpeg per-segment extract + concat (or xfade)  │
 │     → /output/multicam_switched.mp4                 │
 └─────────────────────────────────────────────────────┘
       │
       ▼
 ┌─────────────────────────────────────────────────────┐
 │  6. Pipeline rebinds input_video_path to switched   │
 │     MP4 and runs Whisper → enhance → RVM → color   │
 │     → captions → animation → multi-platform export  │
 │     on the switched output (single-cam path).       │
 └─────────────────────────────────────────────────────┘
```

---

## Alignment methods

Choose with `options['multicam_alignment_method']`:

### `auto` (default)

Tries **clap detection** first (precise when a slate / hand-clap was used
to mark sync); if no clap is found or confidence is low, falls back to
FFT cross-correlation. This is the recommended default.

### `cross_correlation`

FFT-based cross-correlation via `scipy.signal.correlate(mode='full',
method='fft')`. General purpose — works on any pair of audio streams
that share *some* content (same event, same ambient noise, same speaker).
Handles offsets up to `max_offset_sec=60` (festival / concert scenarios
where one camera was started before the other).

* Confidence ≈ 0.7 when the offset is within the search range.
* Falls back to pure-numpy `fft.rfft/irfft` if scipy is unavailable.
* Returns **signed** offset (positive = B starts after A).

### `clap_detection`

Spectral-flux based transient detection. Uses `librosa.stft` to compute
half-wave-rectified spectral differences; the first frame whose flux
exceeds `median × 6` is returned as the clap timestamp. Falls back to
`scipy.signal.spectrogram`-based energy-onset detection when librosa is
missing.

* Confidence ≈ 0.9 when both videos have a detectable clap.
* More accurate than cross-correlation when:
  * The event is music-heavy or noisy (FFT correlation gets confused by
    similar repeating audio).
  * A slate / clap was used (classic film / live-event sync).

### When to use which

| Scenario                                   | Recommended method      |
| ------------------------------------------ | ----------------------- |
| Two phones recording a dental talk         | `auto` (clap or xcorr)  |
| Concert with one camera started early      | `cross_correlation`     |
| Filmed with a slate / clap                 | `clap_detection`        |
| Sports event, lots of crowd noise          | `auto` (likely xcorr)  |
| Noisy audio / one camera in another room   | `clap_detection` (slate)|

---

## Switching modes

Choose with `options['multicam_mode']`:

### `smart` — best camera per segment

Splits the timeline at scene boundaries (or evenly into `segment_sec`
chunks) and, for each segment, picks the camera with the highest
**overall score**:

```
overall = 0.4 × face_presence
        + 0.3 × audio_energy
        + 0.2 × motion_energy
        + 0.1 × composition
```

| Sub-score        | How it's computed                                     |
| ---------------- | ----------------------------------------------------- |
| `face_presence`  | Haar-cascade detector on sampled frames (fraction with a face). |
| `motion_energy`  | `cv2.absdiff` mean between consecutive frames, normalised to 5% mean diff = 1.0. |
| `audio_energy`   | RMS via `ffmpeg -af volumedetect` (mapped from -50..0 dB → 0..1). |
| `composition`    | Rule-of-thirds: distance from face centre to nearest thirds intersection. |

Adjacent segments that pick the same camera are merged (no pointless
re-cuts) by `_collapse_consecutive()`.

**Use when:** you want the bot to "direct" the edit itself. Best for
talking-head / interview footage where the active speaker moves between
cameras.

### `round_robin` — cycle every N seconds

Cuts every `segment_sec` seconds (default 5s) and cycles through
cameras in order. Simple and predictable. Good as a fallback when
`smart` mode scoring is unreliable (e.g. all cameras have similar
face presence / motion).

**Use when:** you want a "music-video" feel with regular camera
changes, regardless of content.

### `beat_sync` — switch on music beats

Uses `options['beat_times']` (a list of timestamps in seconds,
typically produced by `beat_sync.py`) as cut points. Cameras are
assigned in round-robin order between beats. If `beat_times` is empty,
falls back to `round_robin`.

**Use when:** you've already run beat detection on the music bed and
want every camera cut to land on a beat (most energetic, most
professional-feeling result).

### `speaker` — active-speaker detection

Splits the timeline into `segment_sec/2`-second chunks and picks the
camera with the loudest audio (highest RMS) in each chunk. This
effectively tracks the active speaker across cameras — when the speaker
on camera B starts talking, the cut moves to camera B.

**Use when:** multi-cam interview / panel format where the active
speaker moves between cameras and you don't have a separate audio
mixdown per speaker.

---

## Quick start (Python)

```python
from multicam_sync import MultiCamSync
from multicam_switcher import MultiCamSwitcher

# 1. Align
syncer = MultiCamSync(alignment_method='auto')
alignment = syncer.align_videos(['cam_a.mp4', 'cam_b.mp4', 'cam_c.mp4'])
print(alignment.to_dict())
# {'offsets_sec': [0.0, 5.313, 2.102], 'reference_idx': 0,
#  'confidence': 0.85, 'method_used': 'clap_detection'}

# 2. (optional) Preview
preview = syncer.sync_preview(
    alignment.video_paths, alignment.offsets_sec,
    max_duration_sec=30, height=320,
)

# 3. Cut plan
switcher = MultiCamSwitcher(
    alignment=alignment,
    scene_boundaries=None,  # or load from take_selector_v2/v3
    beat_times=[1.5, 3.0, 5.0],  # for beat_sync mode
    crossfade_sec=0.3,
)
plan = switcher.generate_cut_plan(mode='smart')
for c in plan[:5]:
    print(f"[{c.start_sec:.2f}-{c.end_sec:.2f}] cam{c.cam_idx} ({c.reason})")

# 4. Render
switcher.render_multicam_video(
    alignment.video_paths, plan,
    output_path='/out/multicam_switched.mp4',
    crossfade=True,
)
```

---

## Pipeline integration

Pass multi-cam options to `run_pipeline()` or `run_pipeline_from_spec()`:

```python
from pipeline import run_pipeline

run_pipeline(
    input_video_path='cam_a.mp4',          # reference camera
    output_dir='/out',
    options={
        'multicam_mode': 'smart',          # or 'round_robin' | 'beat_sync' | 'speaker'
        'multicam_videos': ['cam_b.mp4', 'cam_c.mp4'],
        'multicam_alignment_method': 'auto',  # or 'cross_correlation' | 'clap_detection'
        'multicam_sync_preview': True,     # write a 30s side-by-side preview MP4
        'multicam_crossfade_sec': 0.3,     # 0.0 = hard cuts
        'beat_times': [1.5, 3.0, 5.0, 7.5],  # for beat_sync mode
        # ...single-cam options still apply downstream (background, lut, caption_style, ...)
    },
)
```

Output stats include:

```python
stats['multicam_used']          # True if multi-cam pipeline ran
stats['multicam_mode']          # 'smart' | 'round_robin' | 'beat_sync' | 'speaker'
stats['multicam_alignment']      # AlignmentResult.to_dict()
stats['multicam_cut_plan']       # List[CutDecision.to_dict()]
stats['multicam_sync_preview']   # path to preview MP4 (if requested)
```

When multi-cam runs successfully, `input_video_path` is rebound to the
switched MP4 (`output_dir/multicam_switched.mp4`) so all downstream
stages see a single video.

---

## Telegram bot UX

1. User sends two or more videos within a 60-second window.
2. Bot detects the multi-cam upload (`handleMulticamVideoUpload`) and
   shows the **multi-cam sync keyboard**:
   * 🎯 Audio cross-correlation (auto)
   * 👏 Clap detection
   * ✏️ Manual offset
   * ⏭️ Skip (treat each video as an independent montage job)
3. After picking a sync method, the bot shows the **switching-mode
   keyboard**:
   * 🧠 Smart
   * 🔁 Round-robin
   * 🎵 Beat-sync (requires beat_times — produced by `beat_sync.py`)
   * 🗣️ Active speaker
4. On switch-mode selection, `handleMulticamSwitchModeChoice` enqueues
   a single montage task with `multicam_mode` + `multicam_videos` set
   in `input_spec`. The Kaggle runner downloads all videos to local
   paths and calls `run_pipeline_from_spec(input_spec)`.

The first video in the upload order is treated as the **reference**
camera (offset 0); others are aligned relative to it. The actual
reference (earliest-starting) camera may differ — `align_videos()`
auto-picks the earliest as the true t=0.

---

## Constraints & defaults

* **Python 3.10+, full type hints, files < 500 lines** (soft target —
  comparable to `vlm_scorer.py` at 646 lines).
* **Auto-installs** numpy, scipy, librosa on first use (Kaggle
  first-run only).
* **Multi-cam is OPTIONAL** — if `multicam_mode` is `None` (default),
  the pipeline runs the existing single-cam path with zero changes.
* **Cross-correlation handles up to 60s offset** (festival / concert
  scenarios). Raise `max_offset_sec` to extend the search range.
* **Pure CPU** — runs alongside GPU-heavy pipeline stages (Whisper,
  RVM, Qwen2.5-VL) without VRAM contention.
* **FFmpeg >= 4.x** required (concat demuxer + xfade / acrossfade
  filters).
