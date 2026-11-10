"""
Take selector v2 — 3-layer pipeline (PySceneDetect → auto-editor → scoring).
===========================================================================

    Layer 1: `scene_detector.SceneDetector`   — boundaries via PySceneDetect
    Layer 2: `silence_trimmer.SilenceTrimmer`  — silence filter via auto-editor
    Layer 3: `TakeSelectorV2` (this file)      — 6-criterion scoring +
                                                 frame extraction for VLM (B7)

Score weights (sum = 1.0): audio_rms 0.25, speech_density 0.25, length 0.15,
face 0.15, motion 0.10, composition 0.10.

`Take` / `TakeScore` are defined here. `SceneBoundary` and `SilenceSegment`
are re-exported from `scene_detector` and `silence_trimmer`.

Created: 2026-11-10  (Phase P4-T2 upgrade — Agent B1)
"""
from __future__ import annotations

import math
import os
import subprocess
import sys
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, List, Optional

# Layer 1 + Layer 2 — both shipped in the same package.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from scene_detector import SceneDetector, SceneBoundary        # noqa: E402
from silence_trimmer import SilenceSegment, SilenceTrimmer      # noqa: E402

# Re-export so callers can `from take_selector_v2 import SceneBoundary`.
__all__ = ['TakeSelectorV2', 'Take', 'TakeScore',
           'SceneBoundary', 'SilenceSegment']

CACHE_DIR = Path('/tmp/micky_cache')
CACHE_DIR.mkdir(parents=True, exist_ok=True)
_YUNET_URL = ('https://github.com/opencv/opencv_zoo/raw/main/'
              'models/face_detection_yunet/'
              'face_detection_yunet_2023mar.onnx')


@dataclass
class TakeScore:
    """Per-criterion + overall score for a single take."""
    overall: float
    audio_rms: float
    speech_density: float
    length_score: float
    face_score: float
    motion_score: float
    composition_score: float

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Take:
    """A single selected take from the source video."""
    path: str
    start: float
    end: float
    score: TakeScore
    scene_idx: int
    frame_path: Optional[str] = None

    def to_dict(self) -> dict:
        d = asdict(self)
        d['score'] = self.score.to_dict()
        return d


class TakeSelectorV2:
    """3-layer take selector: scene_detector + silence_trimmer + 6-criterion scoring.

    Args:
        scene_detector:   SceneDetector instance (Layer 1).
        silence_trimmer:  SilenceTrimmer instance (Layer 2).
        whisper_result:   Optional Whisper transcript dict with `segments`
                          (each having `start`, `end`, `text`).
    """

    W_AUDIO: float = 0.25
    W_SPEECH: float = 0.25
    W_LENGTH: float = 0.15
    W_FACE: float = 0.15
    W_MOTION: float = 0.10
    W_COMPOSITION: float = 0.10

    def __init__(
        self,
        scene_detector: SceneDetector,
        silence_trimmer: SilenceTrimmer,
        whisper_result: Optional[dict] = None,
    ) -> None:
        self.scene_detector = scene_detector
        self.silence_trimmer = silence_trimmer
        self.whisper_result = whisper_result or {}

    def select_best_takes(
        self, video_path: str, target_count: int = 10,
        min_duration: float = 3.0, max_duration: float = 30.0,
    ) -> List[Take]:
        """Return the top-N best takes from `video_path`, sorted by score."""
        # --- Layer 1: detect scenes ----------------------------------
        boundaries: List[SceneBoundary] = (
            self.scene_detector.detect_scenes(video_path)
        )
        # --- Layer 2: filter silence --------------------------------
        silences = self.silence_trimmer.analyze_silence(video_path)
        for b in boundaries:
            if any(self._overlap(b, s) for s in silences):
                b.is_silence = True
        # --- Layer 3: score each non-silent boundary in range -------
        whisper_segs = self.whisper_result.get('segments', [])
        takes: List[Take] = []
        for idx, b in enumerate(boundaries):
            dur = b.duration_sec
            if b.is_silence or dur < min_duration or dur > max_duration:
                continue
            ts = self.score_take(b, video_path, whisper_segs)
            frame_path = self.extract_frame_for_vlm(video_path, b, scene_idx=idx)
            takes.append(Take(
                path=video_path, start=b.start_sec, end=b.end_sec,
                score=ts, scene_idx=idx, frame_path=frame_path,
            ))
        takes.sort(key=lambda t: t.score.overall, reverse=True)
        return takes[:target_count]

    def score_take(
        self, scene: SceneBoundary, video_path: str,
        whisper_segments: Optional[list] = None,
    ) -> TakeScore:
        """Compute the 6-criterion score for a single scene segment."""
        a = self._score_audio_rms(video_path, scene)
        s = self._score_speech_density(
            scene, whisper_segments or self.whisper_result.get('segments', []),
        )
        l = self._score_length(scene.duration_sec)
        f = self._score_face(video_path, scene)
        m = self._score_motion(video_path, scene)
        c = self._score_composition(video_path, scene)
        overall = (self.W_AUDIO * a + self.W_SPEECH * s + self.W_LENGTH * l
                   + self.W_FACE * f + self.W_MOTION * m
                   + self.W_COMPOSITION * c)
        return TakeScore(
            overall=round(overall, 4), audio_rms=round(a, 4),
            speech_density=round(s, 4), length_score=round(l, 4),
            face_score=round(f, 4), motion_score=round(m, 4),
            composition_score=round(c, 4),
        )

    def extract_frame_for_vlm(
        self, video_path: str, scene: SceneBoundary, scene_idx: int = 0,
    ) -> str:
        """Extract the middle frame of `scene` as a PNG (for VLM B7)."""
        mid = (scene.start_sec + scene.end_sec) / 2.0
        out_path = str(CACHE_DIR / f'frame_{scene_idx:04d}.png')
        cmd = ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
               '-ss', f'{mid:.3f}', '-i', video_path,
               '-frames:v', '1', '-update', '1', out_path]
        try:
            subprocess.run(cmd, check=True, capture_output=True)
        except subprocess.CalledProcessError as e:
            print(f'[take_selector_v2] frame extract failed: '
                  f'{e.stderr.decode()[-300:] if e.stderr else e}')
            return ''
        return out_path

    @staticmethod
    def _overlap(scene: SceneBoundary, sil: SilenceSegment) -> bool:
        return (scene.start_sec < sil.end_sec) and (scene.end_sec > sil.start_sec)

    @staticmethod
    def _clamp01(x: float) -> float:
        return max(0.0, min(1.0, float(x)))

    def _score_audio_rms(self, video_path: str, scene: SceneBoundary) -> float:
        """Mean RMS level of the audio inside [start, end], normalized 0..1."""
        import re as _re
        try:
            cmd = ['ffmpeg', '-hide_banner', '-nostats',
                   '-ss', f'{scene.start_sec:.3f}',
                   '-to', f'{scene.end_sec:.3f}',
                   '-i', video_path,
                   '-af', 'loudnorm=print_format=summary',
                   '-f', 'null', '-']
            r = subprocess.run(cmd, capture_output=True, text=True, check=False)
            m = _re.search(r'Input Integrated:\s*([\-\d.]+)\s*LUFS',
                           r.stderr or '')
            if m:
                lufs = float(m.group(1))
                # -40 LUFS → 0.0 ; -23 LUFS → 0.57 ; -10 LUFS → 1.0
                return self._clamp01((lufs + 40.0) / 30.0)
        except Exception:
            pass
        return 0.5

    def _score_speech_density(
        self, scene: SceneBoundary, whisper_segments: list,
    ) -> float:
        """Words-per-second from whisper segments overlapping this scene."""
        if not whisper_segments:
            return 0.0
        words = 0
        for seg in whisper_segments:
            try:
                s = float(seg.get('start', 0)); e = float(seg.get('end', 0))
            except (TypeError, ValueError):
                continue
            if e < scene.start_sec or s > scene.end_sec:
                continue
            words += len((seg.get('text') or '').strip().split())
        dur = max(0.1, scene.duration_sec)
        return self._clamp01((words / dur) / 3.0)  # 3 wps = max density

    def _score_length(self, duration_sec: float) -> float:
        """Gaussian peak at 10s, sigma=5s."""
        if duration_sec <= 0:
            return 0.0
        z = (duration_sec - 10.0) / 5.0
        return self._clamp01(math.exp(-0.5 * z * z))

    def _score_face(self, video_path: str, scene: SceneBoundary) -> float:
        """Fraction of sampled frames that contain a face (Haar → YuNet → heuristic)."""
        try:
            import cv2  # type: ignore
            import numpy as np  # type: ignore
            cap = cv2.VideoCapture(video_path)
            fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
            start_f = int(scene.start_sec * fps)
            end_f = int(scene.end_sec * fps)
            sample = min(5, max(1, end_f - start_f))
            detector = self._build_face_detector()
            hits = sampled = 0
            for i in range(sample):
                f_idx = start_f + int(
                    (i + 0.5) * (end_f - start_f) / max(1, sample)
                )
                cap.set(cv2.CAP_PROP_POS_FRAMES, f_idx)
                ok, frame = cap.read()
                if not ok or frame is None:
                    continue
                sampled += 1
                if self._frame_has_face(frame, detector):
                    hits += 1
            cap.release()
            return self._clamp01(hits / sampled) if sampled else 0.5
        except Exception as e:
            print(f'[take_selector_v2] face score failed: {e}')
            return 0.5

    @staticmethod
    def _build_face_detector() -> Any:
        """Haar cascade → YuNet (auto-downloads ONNX) → skin heuristic."""
        import cv2  # type: ignore
        # 1) Haar cascade (OpenCV 4.x)
        if hasattr(cv2, 'CascadeClassifier'):
            try:
                base = getattr(getattr(cv2, 'data', None), 'haarcascades', '') or ''
                cp = os.path.join(base, 'haarcascade_frontalface_default.xml')
                if os.path.exists(cp):
                    cascade = cv2.CascadeClassifier(cp)
                    if not cascade.empty():
                        return ('haar', cascade)
            except Exception:
                pass
        # 2) YuNet (OpenCV 5.x)
        if hasattr(cv2, 'FaceDetectorYN_create'):
            mp = str(CACHE_DIR / 'yunet.onnx')
            if not os.path.exists(mp):
                try:
                    urllib.request.urlretrieve(_YUNET_URL, mp)
                except Exception as e:
                    print(f'[take_selector_v2] YuNet download failed: {e}')
                    return ('heuristic', None)
            try:
                return ('yunet', cv2.FaceDetectorYN_create(
                    mp, '', (320, 320), score_threshold=0.5))
            except Exception:
                pass
        # 3) heuristic
        return ('heuristic', None)

    @staticmethod
    def _frame_has_face(frame: Any, detector: Any) -> bool:
        """Run the configured detector on a BGR frame; True if ≥1 face."""
        import cv2  # type: ignore
        import numpy as np  # type: ignore
        kind, impl = detector
        if kind == 'haar':
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = impl.detectMultiScale(
                gray, scaleFactor=1.1, minNeighbors=4, minSize=(40, 40),
            )
            return len(faces) > 0
        if kind == 'yunet':
            h, w = frame.shape[:2]
            try:
                impl.setInputSize((w, h))
                _, faces = impl.detect(frame)
                return faces is not None and len(faces) > 0
            except Exception:
                return False
        # heuristic: count skin-tone pixels in upper-center third
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        h, w = frame.shape[:2]
        roi = hsv[h // 6: h // 2, w // 4: 3 * w // 4]
        lower = np.array([0, 30, 60]); upper = np.array([25, 170, 255])
        mask = cv2.inRange(roi, lower, upper)
        density = float(np.count_nonzero(mask)) / float(mask.size + 1e-9)
        return density > 0.10

    # --- motion energy -----------------------------------------------
    def _score_motion(self, video_path: str, scene: SceneBoundary) -> float:
        """Mean frame-to-frame pixel diff in the scene (normalized 0..1)."""
        try:
            import cv2  # type: ignore
            import numpy as np  # type: ignore
            cap = cv2.VideoCapture(video_path)
            fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
            start_f = int(scene.start_sec * fps)
            end_f = int(scene.end_sec * fps)
            cap.set(cv2.CAP_PROP_POS_FRAMES, start_f)
            prev = None
            diffs: list[float] = []
            for _ in range(min(30, end_f - start_f)):
                ok, frame = cap.read()
                if not ok or frame is None:
                    break
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                if prev is not None:
                    d = float(np.mean(cv2.absdiff(gray, prev)))
                    diffs.append(d / 255.0)
                prev = gray
            cap.release()
            if not diffs:
                return 0.5
            return self._clamp01(sum(diffs) / len(diffs) / 0.10)  # 10% = max
        except Exception:
            return 0.5

    # --- composition (rule of thirds + exposure) ---------------------
    def _score_composition(self, video_path: str, scene: SceneBoundary) -> float:
        """Rule-of-thirds balance + exposure midpoint (0..1)."""
        try:
            import cv2  # type: ignore
            import numpy as np  # type: ignore
            cap = cv2.VideoCapture(video_path)
            fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
            mid_f = int(((scene.start_sec + scene.end_sec) / 2.0) * fps)
            cap.set(cv2.CAP_PROP_POS_FRAMES, mid_f)
            ok, frame = cap.read()
            cap.release()
            if not ok or frame is None:
                return 0.5
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            h, w = gray.shape
            thirds = [
                gray[0:h//3, 0:w//3],     gray[0:h//3, w//3:2*w//3],     gray[0:h//3, 2*w//3:],
                gray[h//3:2*h//3, 0:w//3], gray[h//3:2*h//3, w//3:2*w//3], gray[h//3:2*h//3, 2*w//3:],
                gray[2*h//3:, 0:w//3],    gray[2*h//3:, w//3:2*w//3],    gray[2*h//3:, 2*w//3:],
            ]
            means = [float(np.mean(t)) / 255.0 for t in thirds]
            balance = 1.0 - min(1.0, float(np.std(means)) * 2.0)
            overall_mean = float(np.mean(means))
            exposure = 1.0 - min(1.0, abs(overall_mean - 0.5) * 2.0)
            return self._clamp01(0.5 * balance + 0.5 * exposure)
        except Exception:
            return 0.5


# ---------------------------------------------------------------------------
# CLI (debug only)
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    import json
    if len(sys.argv) < 2:
        print('Usage: take_selector_v2.py <video> [--target N] [--whisper json]'); sys.exit(1)
    vid, target, whisper = sys.argv[1], 5, None
    for i, a in enumerate(sys.argv[2:], 2):
        if a == '--target' and i + 1 < len(sys.argv):
            target = int(sys.argv[i + 1])
        elif a == '--whisper' and i + 1 < len(sys.argv):
            with open(sys.argv[i + 1], 'r', encoding='utf-8') as f:
                whisper = json.load(f)
    sel = TakeSelectorV2(SceneDetector(), SilenceTrimmer(), whisper)
    takes = sel.select_best_takes(vid, target_count=target)
    print(f'{len(takes)} takes (target={target}):')
    for i, t in enumerate(takes):
        s = t.score
        print(f'  #{i+1} idx={t.scene_idx} {t.start:.2f}→{t.end:.2f} overall={s.overall:.3f}  '
              f'aud={s.audio_rms:.2f} spch={s.speech_density:.2f} '
              f'len={s.length_score:.2f} face={s.face_score:.2f} '
              f'mot={s.motion_score:.2f} cmp={s.composition_score:.2f}')
        print(f'       frame: {t.frame_path}')
