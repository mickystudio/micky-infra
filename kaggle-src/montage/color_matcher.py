"""
Shot-to-shot color matching (B6-T2).
====================================
Wraps the `color-matcher` PyPI package (GPL-3.0) via a **subprocess**
boundary so its license does not become viral on the rest of the
micky-assistant codebase.

Public API:
    - SceneBoundary    : dataclass describing a detected scene
    - ColorMatcher     : matches frames/shots to a reference frame

`color-matcher` is invoked through its CLI (`color-matcher -s ... -r ... -m
... -o ...`) so the GPL-licensed code never runs inside our Python process.
If the package is missing it is auto-installed via pip on first use.

Created: 2026-11-10  |  Task B6
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Public data types
# ---------------------------------------------------------------------------
@dataclass
class SceneBoundary:
    """Description of a single detected scene (shot) inside a longer video.

    Attributes:
        index:        Scene number (0-based).
        start_time:   Start time in seconds.
        end_time:     End time in seconds.
        start_frame:  Start frame index (int).
        end_frame:    End frame index (int).
        mid_frame:    Representative middle frame index.
        first_frame_path:  Path to extracted first-frame JPG (set after
                           `extract_first_frames` is called).
        mid_frame_path:    Path to extracted mid-frame JPG (representative
                           anchor frame — used as reference).
    """
    index: int
    start_time: float
    end_time: float
    start_frame: int
    end_frame: int
    mid_frame: int = 0
    first_frame_path: str = ''
    mid_frame_path: str = ''
    metadata: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# ColorMatcher
# ---------------------------------------------------------------------------
class ColorMatcher:
    """Match per-shot color to a reference frame using the color-matcher CLI.

    Supported methods (passed through to color-matcher):
        - 'mkl'        Monge-Kantorovich Linearisation (default, balanced)
        - 'reinhard'   Reinhard et al. colour transfer
        - 'mvgd'       Mean-Variance Gaussian Distribution transfer
        - 'histogram'  Histogram-matching transfer
    """

    SUPPORTED_METHODS = ('mkl', 'reinhard', 'mvgd', 'histogram')

    def __init__(self, method: str = 'mkl') -> None:
        if method not in self.SUPPORTED_METHODS:
            raise ValueError(
                f'Unknown method "{method}". '
                f'Choose one of: {self.SUPPORTED_METHODS}'
            )
        self.method = method
        self._cli_ready: bool | None = None

    # ------------------------------------------------------------------
    # CLI presence / auto-install
    # ------------------------------------------------------------------
    def _ensure_cli(self) -> None:
        if self._cli_ready:
            return
        if shutil.which('color-matcher') is None:
            print('[match] color-matcher CLI not found — installing...')
            subprocess.check_call(
                [sys.executable, '-m', 'pip', 'install', '-q', 'color-matcher>=1.0']
            )
            if shutil.which('color-matcher') is None:
                # Some installs put the script in a non-PATH location —
                # try resolving via python -m
                mod_check = subprocess.run(
                    [sys.executable, '-c', 'import color_matcher; print(color_matcher.__file__)'],
                    capture_output=True, text=True,
                )
                if mod_check.returncode != 0:
                    raise RuntimeError(
                        'color-matcher install succeeded but CLI is missing. '
                        'Try running `pip install color-matcher` manually.'
                    )
        self._cli_ready = True

    @staticmethod
    def _run_color_matcher(args: list[str]) -> None:
        cmd = ['color-matcher'] + args
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(
                f'color-matcher failed (exit {result.returncode}):\n'
                f'command: {" ".join(cmd)}\n'
                f'stderr: {result.stderr[-1200:]}'
            )

    # ------------------------------------------------------------------
    # Frame-directory matching
    # ------------------------------------------------------------------
    def match_shots(
        self,
        shots_dir: str,
        reference_frame: str | None = None,
        output_dir: str | None = None,
    ) -> list[str]:
        """Color-match every image frame in `shots_dir` to a reference frame.

        Args:
            shots_dir:        Directory of input frames (.jpg/.png).
            reference_frame:  Anchor frame. If None, the median frame in
                              directory order is used.
            output_dir:       Where to write matched frames. If None, a
                              `_matched/` subdir is created under `shots_dir`.

        Returns:
            List of matched-frame paths (same order as input glob).
        """
        self._ensure_cli()
        if not os.path.isdir(shots_dir):
            raise FileNotFoundError(f'shots_dir not found: {shots_dir}')

        exts = ('.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff')
        frames = sorted(
            os.path.join(shots_dir, f)
            for f in os.listdir(shots_dir)
            if f.lower().endswith(exts)
        )
        if not frames:
            raise ValueError(f'No image frames found in {shots_dir}')

        if reference_frame is None:
            reference_frame = frames[len(frames) // 2]
        if output_dir is None:
            output_dir = os.path.join(shots_dir, '_matched')
        os.makedirs(output_dir, exist_ok=True)

        matched: list[str] = []
        for f in frames:
            out_path = os.path.join(
                output_dir,
                Path(f).stem + '_matched' + Path(f).suffix,
            )
            if f == reference_frame:
                # Reference frame → just copy (no transform needed)
                shutil.copy(f, out_path)
            else:
                self._run_color_matcher([
                    '-s', f,
                    '-r', reference_frame,
                    '-m', self.method,
                    '-o', out_path,
                ])
            matched.append(out_path)
        return matched

    # ------------------------------------------------------------------
    # Whole-video shot matching
    # ------------------------------------------------------------------
    def match_video_shots(
        self,
        video_path: str,
        scene_boundaries: list[SceneBoundary],
        output_dir: str,
    ) -> list[str]:
        """Extract the first frame of every scene, pick a reference, match.

        Args:
            video_path:        Source video.
            scene_boundaries:  Detected scene boundaries (from scene detect).
            output_dir:        Where to drop matched frames.

        Returns:
            List of matched-frame paths (one per scene).
        """
        self._ensure_cli()
        os.makedirs(output_dir, exist_ok=True)

        # Step 1: extract first frame of every scene
        frames_dir = os.path.join(output_dir, 'scene_frames')
        os.makedirs(frames_dir, exist_ok=True)
        for sb in scene_boundaries:
            fp = os.path.join(frames_dir, f'scene_{sb.index:03d}_first.jpg')
            subprocess.run(
                [
                    'ffmpeg', '-y', '-ss', f'{sb.start_time:.3f}',
                    '-i', video_path, '-frames:v', '1',
                    '-q:v', '2', fp,
                ],
                capture_output=True,
            )
            sb.first_frame_path = fp
            # Also extract mid-frame (used as the "representative" anchor)
            mid_t = (sb.start_time + sb.end_time) / 2.0
            mp = os.path.join(frames_dir, f'scene_{sb.index:03d}_mid.jpg')
            subprocess.run(
                [
                    'ffmpeg', '-y', '-ss', f'{mid_t:.3f}',
                    '-i', video_path, '-frames:v', '1',
                    '-q:v', '2', mp,
                ],
                capture_output=True,
            )
            sb.mid_frame_path = mp

        # Step 2: pick reference = middle scene's mid-frame
        if not scene_boundaries:
            raise ValueError('scene_boundaries is empty')
        mid_idx = len(scene_boundaries) // 2
        reference = scene_boundaries[mid_idx].mid_frame_path
        if not reference or not os.path.exists(reference):
            # Fallback to first scene's first frame
            reference = scene_boundaries[0].first_frame_path

        # Step 3: match each scene's mid-frame to reference
        matched_dir = os.path.join(output_dir, 'matched_frames')
        os.makedirs(matched_dir, exist_ok=True)
        matched: list[str] = []
        for sb in scene_boundaries:
            src = sb.mid_frame_path
            if not src:
                continue
            out = os.path.join(matched_dir, f'scene_{sb.index:03d}_matched.jpg')
            if src == reference:
                shutil.copy(src, out)
            else:
                self._run_color_matcher([
                    '-s', src, '-r', reference,
                    '-m', self.method, '-o', out,
                ])
            matched.append(out)
        return matched

    # ------------------------------------------------------------------
    # Combined: LUT + per-shot match
    # ------------------------------------------------------------------
    def apply_lut_with_match(
        self,
        video_path: str,
        lut_path: str,
        scenes: list[SceneBoundary],
        output_path: str,
    ) -> str:
        """Two-step colour pipeline:

            1. Apply the 3D LUT across the whole video via FFmpeg `lut3d`
               (tetrahedral interpolation).
            2. Extract one frame per scene and colour-match them to a
               common reference frame (using color-matcher subprocess).

        Step 1 produces `intermediate.mp4`. Step 2 currently writes matched
        *frames* (one per scene) — they are intended as anchors for the
        final re-grade pass. The returned path points to the intermediate
        LUT-graded video; downstream code can optionally rebuild the final
        video from the per-scene matched frames via FFmpeg overlay.

        Args:
            video_path:   Source video.
            lut_path:     Path to a .cube LUT file.
            scenes:       Detected scenes (used for step 2).
            output_path:  Final video output path.

        Returns:
            Path to the LUT-graded intermediate video (always produced).
        """
        if not os.path.exists(lut_path):
            raise FileNotFoundError(f'LUT not found: {lut_path}')

        out_dir = os.path.dirname(output_path) or '.'
        os.makedirs(out_dir, exist_ok=True)

        # Step 1: LUT-grade the whole video via FFmpeg
        intermediate = os.path.join(out_dir, f'{Path(video_path).stem}_lut.mp4')
        lut_q = lut_path.replace("'", r"'\''")
        vf = f"lut3d=file='{lut_q}':interp=tetrahedral"
        subprocess.run(
            [
                'ffmpeg', '-y', '-i', video_path,
                '-vf', vf,
                '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
                '-pix_fmt', 'yuv420p',
                '-c:a', 'copy',
                intermediate,
            ],
            check=True, capture_output=True,
        )

        # Step 2: per-shot colour-match (writes frames to disk, returns paths)
        # If no scenes were provided, skip step 2 and use the LUT-only result.
        if scenes:
            try:
                frames_out = os.path.join(out_dir, 'matched_frames')
                _ = self.match_video_shots(intermediate, scenes, frames_out)
                # `intermediate` is the LUT-graded video; per-scene matched
                # frames live in `frames_out/` and can be used by the caller
                # for further re-grading. Copy intermediate → output_path so
                # the contract (returns final video path) holds.
                shutil.copy(intermediate, output_path)
            except Exception as e:
                print(f'[match] Step 2 (per-shot match) failed: {e}; '
                      f'returning LUT-only intermediate')
                shutil.copy(intermediate, output_path)
        else:
            shutil.copy(intermediate, output_path)

        return output_path


# ---------------------------------------------------------------------------
# CLI for quick testing
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    import argparse

    p = argparse.ArgumentParser(description='Shot-to-shot color matcher (subprocess-isolated)')
    sub = p.add_subparsers(dest='cmd', required=True)
    p_shots = sub.add_parser('shots', help='Match frames in a directory')
    p_shots.add_argument('--shots-dir', required=True)
    p_shots.add_argument('--reference')
    p_shots.add_argument('--output-dir')
    p_shots.add_argument('--method', default='mkl')
    p_video = sub.add_parser('video', help='Match scenes of a video')
    p_video.add_argument('--video', required=True)
    p_video.add_argument('--output', required=True)
    p_video.add_argument('--method', default='mkl')
    args = p.parse_args()

    cm = ColorMatcher(method=args.method)
    if args.cmd == 'shots':
        results = cm.match_shots(args.shots_dir, args.reference, args.output_dir)
    else:
        # Without scene detection we just take the whole video as one scene
        scenes = [SceneBoundary(0, 0.0, 1e6, 0, 1, 0)]
        out = os.path.join(args.output, 'matched.mp4')
        results = cm.apply_lut_with_match(args.video, '', scenes, out)
    print(results)
