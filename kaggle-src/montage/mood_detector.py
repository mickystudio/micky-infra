"""
Mood detection (B6-T1).
======================
Zero-shot mood classification of video frames using OpenAI CLIP.

Given a frame (or video), the detector computes similarity scores against a
fixed list of cinematic moods (`warm`, `cool`, `vintage`, `cinematic`,
`noir`, `vibrant`, `muted`, `dramatic`, `peaceful`, `energetic`) and returns
the top-1 + top-2 moods plus a confidence score and the full score dict.

The detected mood is consumed downstream by `color_grader_v2.ColorGraderV2`
to select the most appropriate 3D LUT for the shot — replacing the old
"pick a static LUT" behaviour with content-aware grading.

Auto-installs `transformers` + `torch` on first use (Kaggle T4 friendly).

Created: 2026-11-10  |  Task B6
"""
from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Public data types
# ---------------------------------------------------------------------------
@dataclass
class MoodResult:
    """Result of a single mood-detection call.

    Attributes:
        primary:    Name of the highest-scoring mood (one of `MoodDetector.MOODS`).
        secondary:  Second-highest mood (useful for crossfade grading decisions).
        confidence: Softmax probability of the primary mood in [0, 1].
        all_scores: Dict mapping every mood name → raw CLIP similarity score
                    (post-softmax, sums to ~1.0).
    """
    primary: str
    secondary: str
    confidence: float
    all_scores: dict[str, float] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            'primary': self.primary,
            'secondary': self.secondary,
            'confidence': self.confidence,
            'all_scores': dict(self.all_scores),
        }


# ---------------------------------------------------------------------------
# Mood → LUT mapping
# ---------------------------------------------------------------------------
# Centralised so both `ColorGraderV2` and `LUTDownloader.organize_by_mood`
# agree on the canonical mapping.
ASSETS_BASE = os.environ.get('MICKY_ASSETS_DIR', '/kaggle/input/micky-assets')
LUT_LIB_DIR = os.path.join(ASSETS_BASE, 'luts')

MOOD_TO_LUT: dict[str, str] = {
    'warm':       'teal_orange.cube',
    'cool':       'bleach_bypass.cube',
    'vintage':    'kodak_vision.cube',
    'cinematic':  'cinematic.cube',
    'noir':       'noir.cube',
    'vibrant':    'vibrant_pop.cube',
    'muted':      'muted_film.cube',
    'dramatic':   'dramatic_contrast.cube',
    'peaceful':   'peaceful_pastel.cube',
    'energetic':  'energetic_punch.cube',
}


# ---------------------------------------------------------------------------
# MoodDetector
# ---------------------------------------------------------------------------
class MoodDetector:
    """Zero-shot mood classifier backed by CLIP ViT-Base-Patch32.

    The model is loaded lazily on first call to `detect_mood` so importing
    the module is free of cost (important for CLI / pipeline startup).
    """

    MOODS: list[str] = [
        'warm', 'cool', 'vintage', 'cinematic', 'noir',
        'vibrant', 'muted', 'dramatic', 'peaceful', 'energetic',
    ]

    # Prompt template — wording matters for zero-shot CLIP; we use a
    # descriptive template that consistently scores cinematic moods well.
    _PROMPT_TEMPLATE = "a {mood} cinematic color grade"

    CLIP_MODEL_NAME = 'openai/clip-vit-base-patch32'

    def __init__(self, device: str = 'cuda') -> None:
        self.device = device
        self._model: Any = None
        self._processor: Any = None
        # Cache mood prompt text to avoid rebuilding every call
        self._mood_prompts: list[str] = [
            self._PROMPT_TEMPLATE.format(mood=m) for m in self.MOODS
        ]

    # ------------------------------------------------------------------
    # Lazy model loading (with auto-install)
    # ------------------------------------------------------------------
    def _ensure_model(self) -> None:
        if self._model is not None and self._processor is not None:
            return

        # --- 1. Auto-install transformers + torch if missing -----------
        try:
            import transformers  # noqa: F401
        except ImportError:
            self._pip_install('transformers>=4.40')

        try:
            import torch  # noqa: F401
        except ImportError:
            self._pip_install('torch>=2.0')

        # --- 2. Now safe to import -------------------------------------
        from transformers import CLIPModel, CLIPProcessor  # type: ignore
        import torch  # type: ignore

        # Honour the requested device but fall back to CPU if CUDA
        # is requested but unavailable.
        if self.device == 'cuda' and not torch.cuda.is_available():
            print('[mood] CUDA not available — falling back to CPU')
            self.device = 'cpu'

        print(f'[mood] Loading CLIP model {self.CLIP_MODEL_NAME} on {self.device}...')
        self._model = CLIPModel.from_pretrained(self.CLIP_MODEL_NAME)
        self._processor = CLIPProcessor.from_pretrained(self.CLIP_MODEL_NAME)
        self._model.to(self.device).eval()
        print('[mood] CLIP ready.')

    @staticmethod
    def _pip_install(spec: str) -> None:
        print(f'[mood] Installing {spec} ...')
        subprocess.check_call(
            [sys.executable, '-m', 'pip', 'install', '-q', spec]
        )

    # ------------------------------------------------------------------
    # Single-frame detection
    # ------------------------------------------------------------------
    def detect_mood(self, frame_path: str) -> MoodResult:
        """Detect mood for a single image frame.

        Args:
            frame_path: Path to an image file (jpg/png).

        Returns:
            MoodResult with primary, secondary, confidence, all_scores.
        """
        from PIL import Image  # type: ignore
        import torch  # type: ignore

        self._ensure_model()

        if not os.path.exists(frame_path):
            raise FileNotFoundError(f'Frame not found: {frame_path}')

        image = Image.open(frame_path).convert('RGB')

        # Tokenise + encode
        inputs = self._processor(
            text=self._mood_prompts,
            images=image,
            return_tensors='pt',
            padding=True,
        ).to(self.device)

        with torch.no_grad():
            outputs = self._model(**inputs)
            logits_per_image = outputs.logits_per_image  # [1, N_moods]
            probs = logits_per_image.softmax(dim=-1)[0].cpu().tolist()

        scores = {m: float(p) for m, p in zip(self.MOODS, probs)}
        ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
        primary, p_score = ranked[0]
        secondary, _s_score = ranked[1]
        return MoodResult(
            primary=primary,
            secondary=secondary,
            confidence=p_score,
            all_scores=scores,
        )

    # ------------------------------------------------------------------
    # Whole-video detection (N sample frames → confidence-weighted vote)
    # ------------------------------------------------------------------
    def detect_mood_from_video(
        self,
        video_path: str,
        sample_count: int = 5,
    ) -> MoodResult:
        """Detect mood for a whole video by sampling N frames evenly.

        Args:
            video_path:   Path to the source video.
            sample_count: Number of evenly-spaced frames to extract.

        Returns:
            MoodResult aggregated across all sampled frames
            (confidence-weighted majority vote).
        """
        if not os.path.exists(video_path):
            raise FileNotFoundError(f'Video not found: {video_path}')

        sample_count = max(1, int(sample_count))
        frames_dir = Path(video_path).parent / f'.mood_frames_{Path(video_path).stem}'
        frames_dir.mkdir(parents=True, exist_ok=True)

        # Sample N evenly-spaced frames via ffmpeg select filter
        duration = self._probe_duration(video_path)
        if duration <= 0:
            # Fall back to a single first-frame sample
            sample_times = [0.0]
        else:
            # Even spacing including endpoints (avoids bias toward the start)
            step = duration / (sample_count + 1)
            sample_times = [step * (i + 1) for i in range(sample_count)]

        frame_paths: list[str] = []
        for i, t in enumerate(sample_times):
            fp = str(frames_dir / f'frame_{i:02d}.jpg')
            subprocess.run(
                [
                    'ffmpeg', '-y', '-ss', f'{t:.3f}',
                    '-i', video_path, '-frames:v', '1',
                    '-q:v', '2', fp,
                ],
                capture_output=True,
            )
            if os.path.exists(fp):
                frame_paths.append(fp)

        if not frame_paths:
            # Last-ditch: just take frame 0
            fp = str(frames_dir / 'frame_00.jpg')
            subprocess.run(
                ['ffmpeg', '-y', '-i', video_path, '-frames:v', '1', fp],
                capture_output=True,
            )
            if os.path.exists(fp):
                frame_paths = [fp]
            else:
                raise RuntimeError(f'Could not extract any frames from {video_path}')

        # Detect mood for each frame, then weighted-majority-vote
        per_frame_scores: list[dict[str, float]] = []
        for fp in frame_paths:
            res = self.detect_mood(fp)
            per_frame_scores.append(res.all_scores)

        aggregated = self._weighted_vote(per_frame_scores)
        ranked = sorted(aggregated.items(), key=lambda kv: kv[1], reverse=True)
        primary, p_score = ranked[0]
        secondary, _ = ranked[1]
        return MoodResult(
            primary=primary,
            secondary=secondary,
            confidence=p_score,
            all_scores=aggregated,
        )

    @staticmethod
    def _weighted_vote(per_frame_scores: list[dict[str, float]]) -> dict[str, float]:
        """Sum (rather than average) the softmax probabilities across frames.

        Each frame contributes its full softmax distribution, weighted by the
        max score in that frame (so unambiguous frames count more). The
        returned dict is renormalised so the values sum to 1.0.
        """
        totals: dict[str, float] = {m: 0.0 for m in MoodDetector.MOODS}
        for scores in per_frame_scores:
            w = max(scores.values())  # confidence weight
            for m, s in scores.items():
                totals[m] += s * w
        Z = sum(totals.values()) or 1.0
        return {m: v / Z for m, v in totals.items()}

    # ------------------------------------------------------------------
    # Mood → LUT path
    # ------------------------------------------------------------------
    def mood_to_lut(self, mood: str) -> str:
        """Map a mood name to the absolute path of its LUT file.

        The returned path may not exist yet — callers should treat it as
        the *intended* location and either use it directly (if present)
        or trigger `luts_downloader.LUTDownloader` to fetch the file.
        """
        if mood not in MOOD_TO_LUT:
            # Unknown mood: fall back to 'cinematic'
            print(f'[mood] Unknown mood "{mood}" — defaulting to "cinematic"')
            mood = 'cinematic'
        return os.path.abspath(os.path.join(LUT_LIB_DIR, MOOD_TO_LUT[mood]))

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _probe_duration(video_path: str) -> float:
        try:
            result = subprocess.run(
                [
                    'ffprobe', '-v', 'error',
                    '-show_entries', 'format=duration',
                    '-of', 'default=noprint_wrappers=1:nokey=1',
                    video_path,
                ],
                capture_output=True, text=True, check=True,
            )
            return float(result.stdout.strip() or 0.0)
        except Exception:
            return 0.0


# ---------------------------------------------------------------------------
# CLI for quick testing
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    import argparse
    import json

    p = argparse.ArgumentParser(description='CLIP-based mood detector')
    p.add_argument('--input', required=True, help='Image or video path')
    p.add_argument('--device', default='cuda', help='cuda | cpu')
    p.add_argument('--samples', type=int, default=5,
                   help='If input is video, frames to sample')
    args = p.parse_args()

    detector = MoodDetector(device=args.device)
    if args.input.lower().endswith(('.mp4', '.mov', '.mkv', '.avi', '.webm')):
        result = detector.detect_mood_from_video(args.input, sample_count=args.samples)
    else:
        result = detector.detect_mood(args.input)

    print(json.dumps(result.as_dict(), indent=2, ensure_ascii=False))
    print(f'\n→ LUT: {detector.mood_to_lut(result.primary)}')
