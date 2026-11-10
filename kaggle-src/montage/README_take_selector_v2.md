# Take Selector v2 — PySceneDetect + auto-editor + LLM scoring prep

> Agent B1 upgrade for the micky-assistant montage pipeline.
> Replaces the OpenCV-only `take_selector.py` (rated 4/10) with a
> 3-layer pipeline that emits both a selected-takes list and a frame
> bundle ready for downstream VLM scoring (Agent B7).

## Files added / changed

| File | Type | Lines | Purpose |
|------|------|-------|---------|
| `scene_detector.py` | NEW | 310 | Layer 1 — PySceneDetect wrapper + disk cache |
| `silence_trimmer.py` | NEW | 365 | Layer 2 — auto-editor CLI wrapper + NLE EDL export |
| `take_selector_v2.py` | NEW | 399 | Layer 3 — 6-criterion scoring + VLM frame extractor |
| `pipeline.py` | EDIT | +60 | Additive: try v2, fall back to v1, write `scene_detection.json` |
| `requirements.txt` | NEW | 2 | `scenedetect>=0.7`, `auto-editor>=30.0.1` |
| `README_take_selector_v2.md` | NEW | this | Architecture, weights, B7 hand-off |
| `take_selector.py` | UNCHANGED | 602 | Kept intact as fallback (legacy v1) |

## Old vs new

| Aspect | v1 (`take_selector.py`) | v2 (`take_selector_v2.py`) |
|---|---|---|
| Scene boundaries | none (1s sliding window) | PySceneDetect `ContentDetector` |
| Silence filter | ffmpeg `silencedetect` only | auto-editor CLI + `analyze_silence` |
| Score criteria | audio 40% + speech 30% + motion 30% | 6 criteria (see weights below) |
| Face detection | none | Haar → YuNet → skin-tone heuristic |
| Composition | none | Rule-of-thirds balance + exposure |
| Whisper integration | none (uniform speech density) | per-segment words/sec |
| NLE hand-off | none | EDL/XML export (Resolve, Premiere, FCPX, Shotcut, Kdenlive, CMX 3600) |
| VLM hand-off | none | middle-frame PNG → `/tmp/micky_cache/frame_<idx>.png` |
| Caching | none | `scenes_<sha1>.json` per video + params |
| Auto-install | partial | all heavy deps auto-`pip install` inside `try/except ImportError` |

## 3-layer pipeline diagram

```
                ┌────────────────────────────────────────────┐
                │             Source video (mp4)              │
                └────────────────────┬───────────────────────┘
                                     │
   ┌─────────────────────────────────┼─────────────────────────────┐
   │ Layer 1: SceneDetector          │                             │
   │   scene_detector.detect_scenes  │                             │
   │   (PySceneDetect ContentDetector)│                             │
   │   detect_adaptive  ← sports     │                             │
   │   detect_fades     ← interviews │                             │
   │   cache → /tmp/micky_cache/scenes_<hash>.json                 │
   └─────────────────────────────────┬─────────────────────────────┘
                                     │
                                     ▼  List[SceneBoundary]
   ┌─────────────────────────────────────────────────────────────┐
   │ Layer 2: SilenceTrimmer                                     │
   │   silence_trimmer.analyze_silence  → List[SilenceSegment]  │
   │   silence_trimmer.trim_silence     → trimmed mp4            │
   │   silence_trimmer.export_edl       → .fcpxml / .xml / .mlt /│
   │                                       .kdenlive / .edl      │
   │   (auto-editor 29.x CLI under the hood)                    │
   └─────────────────────────────────┬───────────────────────────┘
                                     │  silence regions
                                     ▼  scenes × silence
   ┌─────────────────────────────────────────────────────────────┐
   │ Layer 3: TakeSelectorV2                                     │
   │   for each non-silent SceneBoundary within [3s, 30s]:      │
   │     audio_rms        0.25  ffmpeg loudnorm (LUFS)           │
   │     speech_density   0.25  whisper words/sec                │
   │     length_score     0.15  Gaussian peak at 10s             │
   │     face_score       0.15  Haar → YuNet → skin heuristic    │
   │     motion_score     0.10  cv2.absdiff mean                 │
   │     composition      0.10  rule-of-thirds + exposure       │
   │   extract_frame_for_vlm → /tmp/micky_cache/frame_<idx>.png  │
   └─────────────────────────────────┬───────────────────────────┘
                                     │
                                     ▼  List[Take] (top-N)
                          ┌──────────────────────┐
                          │  pipeline.py output  │
                          │  scene_detection.json│
                          └──────────┬───────────┘
                                     │
                                     ▼  Agent B7 (VLM) consumes
                                     │  the frame PNGs + JSON
```

## Score weights rationale

| Criterion | Weight | Why |
|---|---|---|
| Audio RMS | 0.25 | Single biggest predictor of "useful" vs "throwaway" take — silent or near-silent segments are unwatchable. Computed via ffmpeg `loudnorm` summary (`Input Integrated` LUFS), normalized so `-10 LUFS` → 1.0 and `-40 LUFS` → 0.0. |
| Speech density | 0.25 | Words/sec from Whisper; 3 wps ≈ max. Together with audio RMS, these two account for 50% — matching the talking-head nature of dental reels. |
| Length | 0.15 | Gaussian peak at 10 s (σ = 5 s). Reels prefer 5–15 s clips; outside that range is either too short to land a point or too long for a hook. |
| Face presence | 0.15 | Sampled at 5 frames per scene. Strategy cascade: Haar cascade (OpenCV 4.x default on Kaggle) → YuNet ONNX (OpenCV 5.x, auto-downloaded from OpenCV Zoo) → skin-tone HSV heuristic (final fallback). |
| Motion energy | 0.10 | Mean `cv2.absdiff` between consecutive grayscale frames, normalized to 10% diff = 1.0. Talking-head footage has low motion by design — we want some, but not too much. |
| Composition | 0.10 | Mean brightness across a 3×3 grid (rule of thirds) + overall exposure distance from 0.5. Penalizes extreme under/over-exposure and off-center framing. |

Total weight = 1.00. Each criterion is clamped to `[0, 1]` before weighting.

## How the VLM (Agent B7) plugs in next

`TakeSelectorV2.extract_frame_for_vlm()` is called for **every** scored take
inside `select_best_takes()`. It writes a single PNG of the scene's middle
frame to `/tmp/micky_cache/frame_<scene_idx:04d>.png` and records the path
on `Take.frame_path`.

After `select_best_takes` returns, the pipeline writes a `scene_detection.json`
in the output directory containing:

```json
{
  "scenes": [
    {"start_sec": 0.0, "end_sec": 3.0, "frame_count": 90, "score": 0.0, "is_silence": false},
    ...
  ],
  "selected_takes": [
    {
      "path": "input.mp4", "start": 0.0, "end": 3.0, "scene_idx": 0,
      "frame_path": "/tmp/micky_cache/frame_0000.png",
      "score": {
        "overall": 0.386, "audio_rms": 1.0, "speech_density": 0.0,
        "length_score": 0.38, "face_score": 0.0,
        "motion_score": 0.0, "composition_score": 0.80
      }
    },
    ...
  ],
  "silence_segments": [
    {"start_sec": 5.0, "end_sec": 7.0, "duration_sec": 2.0, "avg_db": -45.53}
  ]
}
```

Agent B7 (VLM scorer) consumes the `frame_path` PNGs + JSON to:
1. Verify the take's visual quality (lighting, framing, emotion).
2. Compute a semantic score (e.g., "is the dentist smiling? is the patient
   visibly engaged?") and merge it into the take's overall score.
3. Optionally re-rank the takes for the final cut list.

## Auto-install behaviour

All heavy dependencies auto-install on first run inside `try/except
ImportError`:

```python
# scene_detector.py
try:
    from scenedetect import detect, ContentDetector, AdaptiveDetector, ThresholdDetector
except ImportError:
    subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', 'scenedetect'], check=True)
    from scenedetect import detect, ContentDetector, AdaptiveDetector, ThresholdDetector

# silence_trimmer.py
try:
    import auto_editor
    return shutil.which('auto-editor') or f'{sys.executable} -m auto_editor'
except ImportError:
    subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', 'auto-editor'], check=True)
    ...

# take_selector_v2.py — face detector (YuNet ONNX, OpenCV 5.x)
if not os.path.exists(model_path):
    urllib.request.urlretrieve(_YUNET_URL, model_path)
```

This means a fresh Kaggle kernel can `import take_selector_v2` with zero
manual installation; the first call incurs a one-time `pip install` cost
(~10 s for `scenedetect`, ~5 s for `auto-editor`, ~1 s for the YuNet ONNX
download).

## Backward compatibility

* `take_selector.py` is **unchanged** and still importable.
* `pipeline.py` tries `take_selector_v2` first; if `ImportError`, it
  prints a warning and falls back to the old `select_best_takes`
  function. The pipeline never blocks on a missing optional dep.
* The v2 path sets `selected_video = input_video_path` (it does not
  auto-concatenate the best takes — downstream stages still process the
  full source). The selected-takes list is preserved in
  `stats['selected_takes']` and the `scene_detection.json` file.

## Usage examples

```python
from scene_detector import SceneDetector
from silence_trimmer import SilenceTrimmer
from take_selector_v2 import TakeSelectorV2

det = SceneDetector(threshold=27.0, min_scene_len_sec=1.0)
trimmer = SilenceTrimmer(threshold_db=-12.0, margin_sec=0.2)
sel = TakeSelectorV2(det, trimmer, whisper_result=transcript_dict)

takes = sel.select_best_takes(
    'input.mp4', target_count=10, min_duration=3.0, max_duration=30.0,
)
for t in takes:
    print(f'#{t.scene_idx} {t.start:.2f}→{t.end:.2f} '
          f'overall={t.score.overall:.3f}  frame={t.frame_path}')
```

```bash
# CLI debug
python3 scene_detector.py input.mp4 content
python3 silence_trimmer.py input.mp4 analyze
python3 silence_trimmer.py input.mp4 edl:resolve
python3 take_selector_v2.py input.mp4 --target 5
```
