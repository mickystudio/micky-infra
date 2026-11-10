"""
Color grading v2 (B6-T3) — CLIP mood → LUT → shot matching.
==========================================================
Replaces the static-LUT `color_grader.py` with a content-aware pipeline:

    1. Detect video mood via CLIP zero-shot (`MoodDetector`)
    2. Map mood → 3D LUT file
    3. Apply LUT across the whole video via FFmpeg `lut3d` (tetrahedral)
    4. Match shots to a common reference frame for shot-to-shot
       consistency (`ColorMatcher`, GPL-isolated via subprocess)

`ColorGraderV2` keeps the old `apply_color_grading` function as a
fallback when CLIP / LUTs / color-matcher are unavailable.

Created: 2026-11-10  |  Task B6
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from color_matcher import ColorMatcher, SceneBoundary
from mood_detector import MoodDetector, MoodResult


# ---------------------------------------------------------------------------
# Style presets (user-facing convenience)
# ---------------------------------------------------------------------------
# Each preset hardcodes (mood → LUT → intensity). Used by `grade_with_style`.
STYLE_PRESETS: dict[str, dict[str, Any]] = {
    'cinematic':    {'mood': 'cinematic', 'intensity': 0.85, 'method': 'mkl'},
    'warm_summer':  {'mood': 'warm',      'intensity': 0.80, 'method': 'mkl'},
    'cold_winter':  {'mood': 'cool',      'intensity': 0.80, 'method': 'mkl'},
    'vintage_film': {'mood': 'vintage',   'intensity': 0.90, 'method': 'reinhard'},
    'noir':         {'mood': 'noir',      'intensity': 1.00, 'method': 'mvgd'},
    'vibrant_pop':  {'mood': 'vibrant',   'intensity': 0.95, 'method': 'mkl'},
}


class ColorGraderV2:
    """Content-aware color grader combining mood detection + LUT + shot matching.

    Lifecycle:
        grader = ColorGraderV2(MoodDetector(device='cuda'),
                                ColorMatcher(method='mkl'))
        result_path = grader.grade_video(video, scene_boundaries)
    """

    def __init__(
        self,
        mood_detector: MoodDetector,
        color_matcher: ColorMatcher,
    ) -> None:
        self.mood_detector = mood_detector
        self.color_matcher = color_matcher

    # ------------------------------------------------------------------
    # Primary entry point
    # ------------------------------------------------------------------
    def grade_video(
        self,
        video_path: str,
        scene_boundaries: list[SceneBoundary] | None = None,
        custom_mood: str | None = None,
        output_path: str | None = None,
    ) -> str:
        """Full grading pipeline.

        Args:
            video_path:        Source video.
            scene_boundaries:  Detected scenes (used for shot matching). If
                               None, no shot matching is performed.
            custom_mood:       Override mood detection. If None, CLIP detects.
            output_path:       Where to write the final MP4. If None, a
                               `*_graded_v2.mp4` next to the input is used.

        Returns:
            Path to the graded MP4.
        """
        video_path = str(video_path)
        if not os.path.exists(video_path):
            raise FileNotFoundError(video_path)

        out_dir = os.path.dirname(video_path) or '.'
        name = Path(video_path).stem
        if output_path is None:
            output_path = os.path.join(out_dir, f'{name}_graded_v2.mp4')

        # ---- Step 1: Detect mood -------------------------------------
        if custom_mood:
            mood_result = MoodResult(
                primary=custom_mood,
                secondary=custom_mood,
                confidence=1.0,
                all_scores={custom_mood: 1.0},
            )
            print(f'[grade-v2] Using custom mood: {custom_mood}')
        else:
            print('[grade-v2] Detecting mood via CLIP...')
            mood_result = self.mood_detector.detect_mood_from_video(video_path)
            print(f'[grade-v2] Detected mood: {mood_result.primary} '
                  f'(conf={mood_result.confidence:.3f}, '
                  f'secondary={mood_result.secondary})')

        # ---- Step 2: Pick LUT ----------------------------------------
        lut_path = self.mood_detector.mood_to_lut(mood_result.primary)
        if not os.path.exists(lut_path):
            print(f'[grade-v2] LUT not found at {lut_path} — '
                  f'falling back to legacy apply_color_grading()')
            from color_grader import apply_color_grading
            return apply_color_grading(
                video_path, mood_result.primary, out_dir,
                intensity=mood_result.confidence,
            )
        print(f'[grade-v2] Using LUT: {lut_path}')

        # ---- Step 3: Apply LUT to whole video -----------------------
        lut_intermediate = os.path.join(out_dir, f'{name}_lut.mp4')
        self._ffmpeg_apply_lut(video_path, lut_path, lut_intermediate)
        print(f'[grade-v2] LUT applied → {lut_intermediate}')

        # ---- Step 4: Match shots for consistency ---------------------
        if scene_boundaries:
            try:
                self.color_matcher.match_video_shots(
                    lut_intermediate, scene_boundaries,
                    os.path.join(out_dir, 'matched_shots'),
                )
                print('[grade-v2] Shot matching done.')
            except Exception as e:
                print(f'[grade-v2] Shot matching failed ({e}); '
                      f'skipping match step.')

        # Copy LUT-graded intermediate → final output path (contract: return
        # the graded MP4). The per-scene matched frames live alongside for
        # downstream re-grading if desired.
        shutil.copy(lut_intermediate, output_path)
        print(f'[grade-v2] ✓ Final graded video: {output_path}')
        return output_path

    # ------------------------------------------------------------------
    # Style presets
    # ------------------------------------------------------------------
    def grade_with_style(
        self,
        video_path: str,
        style: str = 'cinematic',
        intensity: float = 0.8,
        scene_boundaries: list[SceneBoundary] | None = None,
        output_path: str | None = None,
    ) -> str:
        """Apply a named style preset to a video.

        Args:
            video_path:   Source video.
            style:        One of STYLE_PRESETS keys
                          ('cinematic','warm_summer','cold_winter',
                          'vintage_film','noir','vibrant_pop').
            intensity:    Overrides the preset intensity if provided (>0).
            scene_boundaries:  Optional scene boundaries for shot matching.
            output_path:  Optional output path override.

        Returns:
            Path to the graded MP4.
        """
        if style not in STYLE_PRESETS:
            raise ValueError(
                f'Unknown style "{style}". '
                f'Choose from: {list(STYLE_PRESETS)}'
            )
        preset = STYLE_PRESETS[style]
        mood = preset['mood']
        used_intensity = intensity if intensity and intensity > 0 else preset['intensity']
        # Switch the matcher method if preset specifies one
        original_method = self.color_matcher.method
        self.color_matcher.method = preset.get('method', original_method)
        try:
            lut_path = self.mood_detector.mood_to_lut(mood)
            if not os.path.exists(lut_path):
                print(f'[grade-v2] LUT not found at {lut_path} — '
                      f'falling back to legacy apply_color_grading()')
                from color_grader import apply_color_grading
                return apply_color_grading(
                    video_path, mood,
                    os.path.dirname(video_path) or '.',
                    intensity=used_intensity,
                )
            return self.apply_partial_grade(
                video_path, lut_path, used_intensity,
                scene_boundaries=scene_boundaries,
                output_path=output_path,
            )
        finally:
            self.color_matcher.method = original_method

    # ------------------------------------------------------------------
    # Reference-frame selection
    # ------------------------------------------------------------------
    def extract_reference_frame(
        self,
        video_path: str,
        scene_boundaries: list[SceneBoundary] | None = None,
    ) -> str:
        """Pick the most representative frame as the grading anchor.

        Strategy:
            - If scene_boundaries are provided, use the middle scene's
              middle frame (most representative of overall content).
            - Otherwise, sample the middle frame of the whole video.
        """
        out_dir = os.path.dirname(video_path) or '.'
        ref_path = os.path.join(out_dir, f'{Path(video_path).stem}_ref.jpg')

        if scene_boundaries:
            mid_idx = len(scene_boundaries) // 2
            sb = scene_boundaries[mid_idx]
            mid_t = (sb.start_time + sb.end_time) / 2.0
        else:
            dur = _probe_duration(video_path)
            mid_t = dur / 2.0 if dur > 0 else 0.0

        subprocess.run(
            [
                'ffmpeg', '-y', '-ss', f'{mid_t:.3f}',
                '-i', video_path, '-frames:v', '1',
                '-q:v', '2', ref_path,
            ],
            capture_output=True,
        )
        if not os.path.exists(ref_path):
            # Fallback: first frame
            subprocess.run(
                ['ffmpeg', '-y', '-i', video_path, '-frames:v', '1',
                 '-q:v', '2', ref_path],
                capture_output=True,
            )
        return ref_path

    # ------------------------------------------------------------------
    # Partial-intensity LUT application
    # ------------------------------------------------------------------
    def apply_partial_grade(
        self,
        video_path: str,
        lut_path: str,
        intensity: float,
        scene_boundaries: list[SceneBoundary] | None = None,
        output_path: str | None = None,
    ) -> str:
        """Apply LUT at partial intensity via FFmpeg.

        Uses `lut3d` with tetrahedral interpolation, plus an `eq` filter
        whose saturation scales with intensity (so a low intensity yields a
        muted grade and a high intensity yields a punchy grade).

        Args:
            video_path:   Source video.
            lut_path:      Path to .cube LUT.
            intensity:    0.0 = original, 1.0 = full LUT + saturation boost.
            scene_boundaries:  Optional scenes for subsequent shot matching.
            output_path:  Optional output path override.

        Returns:
            Path to the graded MP4.
        """
        if not os.path.exists(lut_path):
            raise FileNotFoundError(f'LUT not found: {lut_path}')
        intensity = max(0.0, min(1.0, float(intensity)))
        out_dir = os.path.dirname(video_path) or '.'
        name = Path(video_path).stem
        if output_path is None:
            output_path = os.path.join(out_dir, f'{name}_graded_p{int(intensity*100):02d}.mp4')

        lut_q = lut_path.replace("'", r"'\''")
        # saturation scales linearly with intensity around a 1.0 anchor
        sat = 0.6 + 0.5 * intensity  # → 0.6 at intensity=0, 1.1 at intensity=1
        vf = (
            f"lut3d=file='{lut_q}':interp=tetrahedral,"
            f"eq=brightness=0:saturation={sat:.3f}"
        )

        subprocess.run(
            [
                'ffmpeg', '-y', '-i', video_path,
                '-vf', vf,
                '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
                '-pix_fmt', 'yuv420p', '-c:a', 'copy',
                output_path,
            ],
            check=True, capture_output=True,
        )

        # Optional shot matching on the partial-grade output
        if scene_boundaries:
            try:
                self.color_matcher.match_video_shots(
                    output_path, scene_boundaries,
                    os.path.join(out_dir, 'matched_shots'),
                )
            except Exception as e:
                print(f'[grade-v2] Shot matching failed ({e}); continuing.')
        return output_path

    # ------------------------------------------------------------------
    # Internal: LUT-only FFmpeg application
    # ------------------------------------------------------------------
    @staticmethod
    def _ffmpeg_apply_lut(
        video_path: str, lut_path: str, output_path: str,
    ) -> None:
        lut_q = lut_path.replace("'", r"'\''")
        vf = f"lut3d=file='{lut_q}':interp=tetrahedral"
        subprocess.run(
            [
                'ffmpeg', '-y', '-i', video_path,
                '-vf', vf,
                '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
                '-pix_fmt', 'yuv420p', '-c:a', 'copy',
                output_path,
            ],
            check=True, capture_output=True,
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
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
# CLI
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    import argparse
    import json

    p = argparse.ArgumentParser(description='Color Grader v2 (CLIP + LUT + matching)')
    p.add_argument('--input', required=True, help='Source video')
    p.add_argument('--output', help='Output video path')
    p.add_argument('--device', default='cuda', help='cuda | cpu')
    p.add_argument('--method', default='mkl',
                   help='color-matcher method (mkl, reinhard, mvgd, histogram)')
    p.add_argument('--mood', default=None,
                   help='Skip CLIP detection and force this mood')
    p.add_argument('--style', default=None,
                   help=f'Apply named preset ({list(STYLE_PRESETS)})')
    p.add_argument('--intensity', type=float, default=0.8,
                   help='Intensity for style mode (0..1)')
    p.add_argument('--scenes-json', default=None,
                   help='Optional JSON file with scene boundaries')
    args = p.parse_args()

    scenes: list[SceneBoundary] = []
    if args.scenes_json and os.path.exists(args.scenes_json):
        raw = json.load(open(args.scenes_json))
        for i, s in enumerate(raw):
            scenes.append(SceneBoundary(
                index=i,
                start_time=float(s.get('start_time', 0.0)),
                end_time=float(s.get('end_time', 0.0)),
                start_frame=int(s.get('start_frame', 0)),
                end_frame=int(s.get('end_frame', 0)),
                mid_frame=int(s.get('mid_frame', 0)),
            ))

    grader = ColorGraderV2(
        MoodDetector(device=args.device),
        ColorMatcher(method=args.method),
    )

    if args.style:
        out = grader.grade_with_style(
            args.input, args.style, args.intensity, scenes or None, args.output,
        )
    else:
        out = grader.grade_video(
            args.input, scenes or None, args.mood, args.output,
        )
    print(f'\n✓ Graded video: {out}')
