"""
Scene detection layer (Layer 1 of the v2 take-selector pipeline).
=====================================================

Wraps PySceneDetect (`detect`, `ContentDetector`, `AdaptiveDetector`,
`ThresholdDetector`) behind a small typed facade and caches results to
disk so that the rest of the micky-assistant montage pipeline can call
it repeatedly without paying the per-frame cost twice.

Design
------
* The returned `SceneBoundary` list uses *seconds* (float) and *frame
  counts* (int) — the two units downstream code (auto-editor, whisper,
  ffmpeg) actually understands.
* PySceneDetect's frame-timecode objects expose `.seconds` /
  `.frame_num` properties (and deprecated `.get_seconds()` /
  `.get_frames()` aliases on older versions). We use the new property
  names with a try/except fallback so the wrapper works across
  scenedetect 0.6.x / 0.7.x.
* Results are JSON-cached at `/tmp/micky_cache/scenes_<sha1>.json` keyed
  by `(video_path, mtime, size, threshold, min_scene_len, mode)` — so a
  second call to `detect_scenes` on the same file is a no-op.
* Heavy dependency (`scenedetect`) is auto-installed on first run via
  `pip install scenedetect` inside a `try/except ImportError` block.

Created: 2026-11-10  (Phase P4-T2 upgrade — Agent B1)
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, List

CACHE_DIR = Path('/tmp/micky_cache')
CACHE_DIR.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Dataclasses (shared with take_selector_v2.py — re-imported there)
# ---------------------------------------------------------------------------
@dataclass
class SceneBoundary:
    """A single detected scene segment."""
    start_sec: float
    end_sec: float
    frame_count: int
    score: float = 0.0
    is_silence: bool = False

    @property
    def duration_sec(self) -> float:
        return max(0.0, self.end_sec - self.start_sec)

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# Lazy import helper
# ---------------------------------------------------------------------------
def _ensure_scenedetect() -> Any:
    """Import scenedetect, installing on first run if necessary."""
    try:
        from scenedetect import (  # type: ignore
            detect, ContentDetector, AdaptiveDetector, ThresholdDetector,
        )
        return detect, ContentDetector, AdaptiveDetector, ThresholdDetector
    except ImportError:
        print('[scene_detector] Installing scenedetect (one-time)…')
        subprocess.run(
            [sys.executable, '-m', 'pip', 'install', '-q', 'scenedetect'],
            check=True,
        )
        from scenedetect import (  # type: ignore
            detect, ContentDetector, AdaptiveDetector, ThresholdDetector,
        )
        return detect, ContentDetector, AdaptiveDetector, ThresholdDetector


def _tc_seconds(tc: Any) -> float:
    """Robustly extract seconds from a PySceneDetect FrameTimecode."""
    # Prefer the new `.seconds` property; fall back to the deprecated
    # `.get_seconds()` method on older scenedetect versions.
    v = getattr(tc, 'seconds', None)
    if v is not None and not callable(v):
        return float(v)
    g = getattr(tc, 'get_seconds', None)
    if callable(g):
        return float(g())
    return 0.0


def _tc_frames(tc: Any) -> int:
    """Robustly extract frame index from a PySceneDetect FrameTimecode."""
    v = getattr(tc, 'frame_num', None)
    if v is not None and not callable(v):
        return int(v)
    g = getattr(tc, 'get_frames', None)
    if callable(g):
        return int(g())
    return 0


# ---------------------------------------------------------------------------
# SceneDetector
# ---------------------------------------------------------------------------
class SceneDetector:
    """
    PySceneDetect facade for the micky-assistant montage pipeline.

    Typical use::

        det = SceneDetector(threshold=27.0, min_scene_len_sec=1.0)
        boundaries = det.detect_scenes('input.mp4')
        boundaries = det.detect_adaptive('sports_action.mp4')
        fades      = det.detect_fades('interview_with_fades.mp4')
    """

    def __init__(
        self,
        threshold: float = 27.0,
        min_scene_len_sec: float = 1.0,
    ) -> None:
        self.threshold = float(threshold)
        self.min_scene_len_sec = float(min_scene_len_sec)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def detect_scenes(self, video_path: str) -> List[SceneBoundary]:
        """
        ContentDetector-based scene detection — best for talking-head,
        interview, and lecture footage (default).
        """
        detect, ContentDetector, _, _ = _ensure_scenedetect()
        min_scene_len = self._sec_to_min_len(video_path)
        detector = ContentDetector(
            threshold=self.threshold,
            min_scene_len=min_scene_len,
        )
        raw = self._run_detect(video_path, detector)
        return self._postprocess(raw, video_path, mode='content')

    def detect_adaptive(self, video_path: str) -> List[SceneBoundary]:
        """
        AdaptiveDetector — better for fast-motion / sports / action
        footage where ContentDetector over-segments due to rapid
        pixel changes. Uses a sliding-window frame comparison.
        """
        detect, _, AdaptiveDetector, _ = _ensure_scenedetect()
        min_scene_len = self._sec_to_min_len(video_path)
        detector = AdaptiveDetector(
            adaptive_threshold=3.0,
            min_scene_len=min_scene_len,
            min_content_val=15.0,
            window_width=2,
        )
        raw = self._run_detect(video_path, detector)
        return self._postprocess(raw, video_path, mode='adaptive')

    def detect_fades(self, video_path: str) -> List[SceneBoundary]:
        """
        ThresholdDetector — for fade-in / fade-out detection. Captures
        the gradual brightness ramps at clip start/end (common in
        multi-take interview recordings).
        """
        detect, _, _, ThresholdDetector = _ensure_scenedetect()
        min_scene_len = max(1, int(self.min_scene_len_sec * 15))  # ~half-fps
        detector = ThresholdDetector(
            threshold=12.0,
            min_scene_len=min_scene_len,
            add_final_scene=True,
        )
        raw = self._run_detect(video_path, detector)
        return self._postprocess(raw, video_path, mode='fades')

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _sec_to_min_len(self, video_path: str) -> int:
        """Convert `min_scene_len_sec` to frames using the video's fps."""
        fps = self._probe_fps(video_path)
        return max(1, int(self.min_scene_len_sec * fps))

    @staticmethod
    def _probe_fps(video_path: str) -> float:
        """ffprobe the input video's frame rate (default 30.0)."""
        try:
            r = subprocess.run(
                ['ffprobe', '-v', 'error',
                 '-select_streams', 'v:0',
                 '-show_entries', 'stream=r_frame_rate',
                 '-of', 'default=noprint_wrappers=1:nokey=1',
                 video_path],
                capture_output=True, text=True, check=True,
            )
            s = r.stdout.strip()
            if '/' in s:
                num, den = s.split('/')
                return float(num) / float(den) if float(den) > 0 else 30.0
            return float(s) if s else 30.0
        except Exception:
            return 30.0

    @staticmethod
    def _run_detect(video_path: str, detector: Any) -> List[tuple]:
        """Call `scenedetect.detect()` and return raw scene tuples."""
        from scenedetect import detect as _detect  # type: ignore
        try:
            return _detect(video_path, detector, show_progress=False)
        except TypeError:
            # Older API: detect(video_path, detector) — no kwargs.
            return _detect(video_path, detector)

    def _postprocess(
        self,
        raw_scenes: List[tuple],
        video_path: str,
        mode: str,
    ) -> List[SceneBoundary]:
        """Convert raw (start_tc, end_tc) tuples → SceneBoundary list.

        Results are JSON-cached so the next call for the same video /
        threshold / mode is instant.
        """
        cache_path = self._cache_path(video_path, mode)
        if cache_path.exists():
            try:
                data = json.loads(cache_path.read_text(encoding='utf-8'))
                return [SceneBoundary(**d) for d in data.get('scenes', [])]
            except (json.JSONDecodeError, TypeError):
                pass  # cache corrupt → recompute

        boundaries: List[SceneBoundary] = []
        for start_tc, end_tc in raw_scenes:
            s = _tc_seconds(start_tc)
            e = _tc_seconds(end_tc)
            sf = _tc_frames(start_tc)
            ef = _tc_frames(end_tc)
            fc = max(0, ef - sf)
            # score = average content/delta value reported by scenedetect
            # if available; otherwise duration-normalized heuristic.
            score = 0.0
            try:
                # PySceneDetect sometimes attaches a `metrics` dict.
                metrics = getattr(end_tc, 'metrics', None) or {}
                score = float(metrics.get('delta_hue', 0.0)
                              + metrics.get('delta_sat', 0.0)
                              + metrics.get('delta_lum', 0.0))
            except Exception:
                score = 0.0
            boundaries.append(SceneBoundary(
                start_sec=s, end_sec=e, frame_count=fc, score=round(score, 4),
            ))

        # Persist cache
        try:
            cache_path.write_text(
                json.dumps({
                    'video': video_path,
                    'mode': mode,
                    'threshold': self.threshold,
                    'min_scene_len_sec': self.min_scene_len_sec,
                    'scenes': [b.to_dict() for b in boundaries],
                }, indent=2, ensure_ascii=False),
                encoding='utf-8',
            )
        except OSError:
            pass  # cache write failure is non-fatal
        return boundaries

    def _cache_path(self, video_path: str, mode: str) -> Path:
        """Stable cache file path keyed by file identity + params."""
        try:
            st = os.stat(video_path)
            fingerprint = (
                f'{video_path}|{st.st_mtime_ns}|{st.st_size}|'
                f'{self.threshold}|{self.min_scene_len_sec}|{mode}'
            )
        except OSError:
            fingerprint = f'{video_path}|{self.threshold}|{mode}'
        h = hashlib.sha1(fingerprint.encode('utf-8')).hexdigest()[:16]
        return CACHE_DIR / f'scenes_{h}.json'


# ---------------------------------------------------------------------------
# CLI (for debugging)
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: scene_detector.py <video> [content|adaptive|fades]')
        sys.exit(1)
    vid = sys.argv[1]
    m = sys.argv[2] if len(sys.argv) > 2 else 'content'
    d = SceneDetector()
    if m == 'adaptive':
        result = d.detect_adaptive(vid)
    elif m == 'fades':
        result = d.detect_fades(vid)
    else:
        result = d.detect_scenes(vid)
    print(f'{len(result)} scenes ({m}):')
    for b in result:
        print(f'  {b.start_sec:6.2f} → {b.end_sec:6.2f}  '
              f'({b.frame_count:4d}f  score={b.score})')
