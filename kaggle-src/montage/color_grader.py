"""
Color grading (P4-T4).
==================
Applies cinematic 3D LUTs (Look-Up Tables) via ffmpeg's `lut3d` filter,
plus a small `eq` + `curves` boost.

Available LUTs:
    - teal_orange     Cinematic look — warm highlights, cool shadows.
    - medical_clean   Neutral, high-clarity — good for clinical demo.
    - warm_clinical   Soft warm tones — friendly, patient-facing.

All LUTs protect skin tones (the .cube files are designed with a
skin-tone-preserving node).

Also provides `match_shots()` for color-matching multiple takes to
a reference clip using ffmpeg's `midequalize` (or a stats-based
curves approach as fallback).

Created: 2026-11-10
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

# ---------------------------------------------------------------------------
# LUT catalog
# ---------------------------------------------------------------------------
ASSETS_BASE = os.environ.get('MICKY_ASSETS_DIR', '/kaggle/input/micky-assets')

LUT_PATHS: dict[str, str] = {
    'teal_orange':    os.path.join(ASSETS_BASE, 'luts/teal_orange.cube'),
    'medical_clean':  os.path.join(ASSETS_BASE, 'luts/medical_clean.cube'),
    'warm_clinical':  os.path.join(ASSETS_BASE, 'luts/warm_clinical.cube'),
}


def apply_color_grading(
    video_path: str,
    lut_choice: str,
    output_dir: str,
) -> str:
    """
    Apply a 3D LUT plus a small global grade to the input video.

    Args:
        video_path:  Input video (already matted).
        lut_choice:  Key into LUT_PATHS (falls back to 'medical_clean').
        output_dir:  Output directory.

    Returns:
        Path to color-graded MP4.
    """
    lut_path = LUT_PATHS.get(lut_choice, LUT_PATHS['medical_clean'])
    output_path = os.path.join(output_dir, 'graded_video.mp4')

    if not os.path.exists(lut_path):
        # Fallback: skip LUT, apply only eq + curves so the pipeline never crashes
        print(f"   ⚠️  LUT '{lut_path}' missing — skipping lut3d, using eq+curves only")
        filter_chain = (
            'eq=saturation=1.1:contrast=1.05:brightness=0.02,'
            'curves=preset=increase_contrast'
        )
    else:
        # ffmpeg's lut3d needs the path escaped inside the filtergraph.
        # `:` and `\` and `'` in paths must be escaped. On Linux paths are
        # usually colon-free, so plain quoting works.
        filter_chain = (
            f"lut3d=file='{lut_path}':interp=trilinear,"
            f"eq=saturation=1.1:contrast=1.05:brightness=0.02,"
            f"curves=preset=increase_contrast"
        )

    print(f"   🎨 Applying LUT '{lut_choice}' → {output_path}")
    _run_ffmpeg([
        'ffmpeg', '-y',
        '-i', video_path,
        '-vf', filter_chain,
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '18',                        # visually-lossless
        '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',                      # audio already enhanced upstream
        '-movflags', '+faststart',
        output_path,
    ])
    return output_path


# ---------------------------------------------------------------------------
# Shot matching across takes (P4-T4 sub-task)
# ---------------------------------------------------------------------------
def match_shots(
    video_clips: list[str],
    reference_clip: str,
    output_dir: str,
) -> list[str]:
    """
    Color-match each clip in `video_clips` to `reference_clip`.

    Strategy (in priority order):
        1. ffmpeg `midequalize` filter (two-input, computes mid-tone
           equalization maps). Requires both inputs be the same size.
        2. Fallback: per-clip curves derived from `signalstats` mean values
           (approximate match — better than no match).

    Args:
        video_clips:    List of input clip paths.
        reference_clip:  The reference clip to match against.
        output_dir:     Output directory.

    Returns:
        List of color-matched clip paths (same order as input).
    """
    os.makedirs(output_dir, exist_ok=True)
    matched: list[str] = []

    for clip in video_clips:
        out_path = os.path.join(
            output_dir,
            Path(clip).stem + '_matched.mp4',
        )
        try:
            # Try midequalize — cleanest approach
            print(f"   🎨 match_shots (midequalize): {clip} → {reference_clip}")
            _run_ffmpeg([
                'ffmpeg', '-y',
                '-i', clip, '-i', reference_clip,
                '-filter_complex',
                '[0:v][1:v]midequalize,'
                'format=yuv420p',
                '-map', '0:v:0',
                '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
                '-an',
                out_path,
            ])
        except RuntimeError:
            # Fallback: stats-based curves (less accurate but still useful)
            print(f"   🎨 match_shots (fallback curves): {clip}")
            ref_stats = _signalstats_mean(reference_clip)
            clip_stats = _signalstats_mean(clip)
            if ref_stats and clip_stats:
                # Adjust each channel toward the reference
                master = (
                    f"curves=r={_curve_str(clip_stats[0], ref_stats[0])}:"
                    f"g={_curve_str(clip_stats[1], ref_stats[1])}:"
                    f"b={_curve_str(clip_stats[2], ref_stats[2])}"
                )
                _run_ffmpeg([
                    'ffmpeg', '-y', '-i', clip,
                    '-vf', master,
                    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
                    '-pix_fmt', 'yuv420p', '-c:a', 'copy',
                    out_path,
                ])
            else:
                # Give up on matching — copy original
                import shutil
                shutil.copy(clip, out_path)
        matched.append(out_path)

    return matched


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------
def _signalstats_mean(video_path: str) -> tuple[float, float, float] | None:
    """
    Use ffmpeg's `signalstats` to extract mean YUV values.
    Returns (Ymean, Umean, Vmean) or None on failure.
    """
    try:
        result = subprocess.run(
            [
                'ffmpeg', '-i', video_path,
                '-vf', 'signalstats,format=nv12',
                '-f', 'null', '-',
            ],
            capture_output=True, text=True,
        )
        log = result.stderr
        # Parse last "Y:.. U:.. V:.." line
        import re
        m = re.findall(r'Y:(\d+(?:\.\d+)?)\s+U:(\d+(?:\.\d+)?)\s+V:(\d+(?:\.\d+)?)', log)
        if not m:
            return None
        last = m[-1]
        return float(last[0]), float(last[1]), float(last[2])
    except Exception:
        return None


def _curve_str(src: float, dst: float) -> str:
    """Generate a single ffmpeg curves preset string adjusting src→dst."""
    if src <= 0:
        return "0/0 1/1"
    ratio = dst / src
    # Clamp to a sensible range to avoid extreme shifts
    ratio = max(0.5, min(2.0, ratio))
    return f"0/0 0.5/{0.5 * ratio:.3f} 1/{ratio:.3f}"


def _run_ffmpeg(cmd: list[str]) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg failed (exit {result.returncode}):\n"
            f"command: {' '.join(cmd)}\n"
            f"stderr: {result.stderr[-1500:]}"
        )


# ---------------------------------------------------------------------------
# Standalone CLI (for debugging)
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    import sys

    if len(sys.argv) < 3:
        print('Usage: color_grader.py <video_path> <output_dir> [lut_choice]')
        print('lut_choice options: ' + ', '.join(LUT_PATHS.keys()))
        sys.exit(1)

    _video = sys.argv[1]
    _out_dir = sys.argv[2]
    _lut = sys.argv[3] if len(sys.argv) > 3 else 'medical_clean'
    _result = apply_color_grading(_video, _lut, _out_dir)
    print(f'Graded video → {_result}')
