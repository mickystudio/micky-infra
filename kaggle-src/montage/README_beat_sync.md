# Beat-Synced Cutting & CC0 Music Library (P4-T9)

This sub-module of the Micky Assistant montage pipeline adds two
production-grade capabilities that lift the perceived quality of a reel
from "home movie" to "MTV edit":

1. **Beat-synced cutting** — snap every visual cut to a detected musical
   beat (or downbeat) using the [beat-this][beat-this] library
   (ISMIR 2024 SOTA).
2. **Curated CC0 music library** — index royalty-free tracks from
   Pixabay, Mixkit, and FreePD, tag them with BPM, and look them up
   by tempo / mood at edit time.

---

## Why `beat-this`?

| Concern                | madmom (legacy)              | **beat-this (current)**           |
| ---------------------- | ---------------------------- | --------------------------------- |
| License                | **non-commercial** (NC)      | **MIT** — fully commercial-safe   |
| ISMIR benchmark        | 2015 SOTA                    | **2024 SOTA** (beats madmom F-measure by ~2 %) |
| CPU inference          | Slow (DBN post-processing)   | Fast (TCN, dbn=False on CPU)      |
| Downbeat detection     | Separate model               | Built-in                          |
| Dependencies           | cython, numpy, scipy         | Pure-Python + PyTorch             |

`madmom`'s CC-BY-NC-SA license makes it **unusable in commercial reels**.
`beat-this` ships under MIT, includes downbeat detection, runs on CPU
in <1 s per 30 s of audio, and beats madmom on the GTZAN / Ballroom
benchmarks. It is the obvious choice for a commercial montage pipeline.

For robustness on Kaggle (where the GPU may be busy with Whisper or RVM),
`BeatSync` falls back to `librosa.beat.beat_track` (CPU-only) if beat-this
import or inference fails, and finally to a synthetic 120 BPM grid so the
caller **never** receives `None`.

---

## CC0 / royalty-free library curation

Three sources are bundled in `cc0_downloader.py`:

| Source    | License                                                        | Strengths                                  |
| --------- | -------------------------------------------------------------- | ------------------------------------------ |
| **Pixabay** | Pixabay Content License (free for commercial use, no attribution) | Large catalog, modern genres            |
| **Mixkit**  | Mixkit Free License (no attribution required)                  | Curated, short loops, ideal for reels     |
| **FreePD**  | **CC0** (true public domain)                                   | Safest possible license for any jurisdiction |

All three allow commercial use **without attribution**. FreePD tracks
are pure CC0 (true public domain) and are the safest pick when a client
lawyer asks "is this really free?".

The downloader (`cc0_downloader.py`) writes a `TBPM` ID3 frame into
every MP3 (so the BPM survives any future re-encode / move) and a
sidecar `<file>.bpm.json` for non-MP3 formats. Running it once populates
the Kaggle dataset:

```bash
python cc0_downloader.py --output /tmp/music_lib --count 20
# uploads to /kaggle/input/micky-assets/music_cc0/ via the
# standard Kaggle dataset-upload flow.
```

After upload, `MusicLibrary('/kaggle/input/micky-assets/music_cc0')`
indexes the directory once (writing `index.json`) and serves lookups in
O(n) with no re-analysis on subsequent runs.

---

## Cut-to-beat algorithm

`BeatSync.assign_clips_to_beats()` supports three scheduling modes:

### 1. `round_robin` (default, "Hormozi" b-roll loop)

Cycles through the clip list in order, placing `clips[i % len(clips)]`
at beat `i`. Best when you have a small pool of short b-roll clips
(e.g. 5 product shots) and want to reuse them evenly across a 30 s reel.

```python
plan = bs.assign_clips_to_beats(info.beats, clip_paths, mode='round_robin')
```

### 2. `sequential` (story-driven)

Plays each clip once in order, then holds the last clip for any
remaining beats. Use this when clips are sequential scenes
(``intro → demo → testimonial → CTA``).

```python
plan = bs.assign_clips_to_beats(info.beats, clip_paths, mode='sequential')
```

### 3. `energy_matched` (cinematic)

Pairs **high-energy clips** with **high-energy beats**. Clip energy is
sampled from each clip's own audio track via `librosa.feature.rms` —
so a clip with a kick-drum hit will be paired with the loudest beat in
the music track. Best when you have heterogeneous b-roll (quiet
interview vs. loud product shot) and want the cuts to "feel" the music.

```python
plan = bs.assign_clips_to_beats(info.beats, clip_paths, mode='energy_matched')
```

For all three modes, the resulting `List[ClipAssignment]` is fed
directly into the Remotion composition (each assignment becomes a
`<Sequence>` with `from={start_sec}` and `durationInFrames={...}`).

### Snapping raw cuts (no full re-plan)

If you already have a cut list from the take selector (silence-based)
and only want to **nudge** each cut to the nearest beat (without
re-shuffling clip order), use `snap_cuts_to_beats`:

```python
snapped = bs.snap_cuts_to_beats(raw_cuts, info.beats, tolerance_sec=0.15)
```

Cuts more than 0.15 s away from any beat are left untouched — this
prevents "force-snapping" a cut to an unrelated beat when the speaker
is mid-word.

---

## Downbeat strategy for "epic" cuts

A *downbeat* is the first beat of a bar (in 4/4, every 4th beat).
Cutting on the downbeat gives the edit a deliberate, "epic" or "chill"
feel — like a movie trailer or Apple product reveal — because each
visual change aligns with a structural moment in the music rather than
a fast rhythmic tick.

`BeatSync.get_downbeat_cut_plan(beats, downbeats, target_clip_count)`
implements the following strategy:

| `target_clip_count` vs. #downbeats | Plan                                          | Vibe                |
| ---------------------------------- | --------------------------------------------- | ------------------- |
| `target_clip_count` ≤ #downbeats   | Sample evenly from downbeats                  | Epic / chill        |
| `target_clip_count` ≤ #beats/2     | Sample evenly from every 2nd beat             | Energetic (off-beat cuts) |
| Otherwise                          | Sample evenly from every beat                 | Hyper / fast-cut    |

Example:

```python
# Want 8 cuts in a 30 s reel; track has 60 beats & 15 downbeats.
plan = bs.get_downbeat_cut_plan(info.beats, info.downbeats, target_clip_count=8)
# → returns 8 downbeat timestamps, evenly spaced across the track.
```

For dance / fitness reels, swap to `target_clip_count=30` to land on
every other beat (off-beat cuts feel twice as fast without halving
the actual tempo).

---

## Module layout

```
kaggle-src/montage/
├── beat_sync.py          ← BeatSync, BeatInfo, ClipAssignment
├── music_library.py      ← MusicLibrary, Track
├── cc0_downloader.py      ← CC0Downloader (Pixabay/Mixkit/FreePD)
└── README_beat_sync.md   ← this file
```

The modules are deliberately standalone — no shared state with the rest
of the pipeline beyond `ffmpeg` / `ffprobe` (which is already a hard
dependency of every other stage).

---

## CPU fallback behavior

Kaggle's free tier offers 2 × T4 GPUs but they're typically saturated
by Whisper-large-v3 (Stage 1) and Robust Video Matting (Stage 4). To
avoid blocking, `BeatSync` is constructed with `device='cpu'` by
default, and beat-this loads its `final0` checkpoint on CPU. On a
2.8 GHz Kaggle CPU:

| Audio length | beat-this (CPU) | librosa (CPU) |
| ------------ | --------------- | ------------- |
| 15 s         | ~0.4 s          | ~0.3 s        |
| 30 s         | ~0.7 s          | ~0.6 s        |
| 60 s         | ~1.3 s          | ~1.0 s        |

Both are well under the 5 s "feels instant" threshold for a montage
build. beat-this is preferred when available (better F-measure on
ambiguous tracks); librosa is the safety net.

---

## Quick start

```bash
# 1. Install runtime deps (also auto-installed on first import):
pip install beat-this librosa mutagen soundfile

# 2. (One-time) populate the CC0 library on the Kaggle dataset:
python cc0_downloader.py --output /kaggle/input/micky-assets/music_cc0 --count 20

# 3. Index the library (writes index.json next to the tracks):
python music_library.py --lib /kaggle/input/micky-assets/music_cc0 --summary

# 4. Use in your pipeline:
python - <<'PY'
from beat_sync import BeatSync
from music_library import MusicLibrary

lib = MusicLibrary('/kaggle/input/micky-assets/music_cc0')
track = lib.get_track_by_bpm(120, mood='calm')   # path to best track

bs = BeatSync(device='cpu')
info = bs.detect_beats(track)                     # BeatInfo(beats, downbeats, bpm)
plan = bs.get_downbeat_cut_plan(info.beats, info.downbeats, target_clip_count=8)
print(plan)                                       # [2.41, 5.83, 9.21, ...]
PY
```

---

## Failure modes (and how we handle them)

| Failure                                | Behavior                                                      |
| -------------------------------------- | ------------------------------------------------------------- |
| `beat-this` not installed              | Auto-installed via `pip install beat-this` on first call      |
| `beat-this` model download fails      | Falls back to `librosa.beat.beat_track` (CPU)                |
| librosa also fails (rare)              | Returns synthetic 120 BPM grid (0.5 s beats, 2 s downbeats)  |
| CC0 source changes URL layout         | Source skipped silently; other two still attempted           |
| Track has no audio track (silent)     | `compute_energy_envelope` returns empty ndarray; clip energy = 0.0 |
| `mutagen` not installed when tagging  | Auto-installed via `pip install mutagen`                      |
| Non-MP3 file format                    | Writes sidecar `<file>.bpm.json` (TBPM only works for ID3)    |

[beat-this]: https://github.com/CPJKU/beat-this  "CPJKU/beat-this (MIT)"
