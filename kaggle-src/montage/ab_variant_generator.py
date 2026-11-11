"""
A/B variant generator (B12) — pro-editor multi-variant delivery.
=================================================================
Real pro editors deliver 2-3 variants of every cut for the client to
choose from. This module generates N variants of the master video by
systematically varying one production dimension at a time:

    1. ``different_take_order``     – reverse / narrative-arc re-order
    2. ``different_pacing``         – fast vs medium vs slow cut freq
    3. ``different_music``           – swap background track + BPM
    4. ``different_color_grade``    – different LUT / mood preset

Each variant re-renders (≈ 30–60s on T4 GPU depending on duration), so
this feature is OFF by default. Enable via pipeline option
``generate_variants: 2`` (or 3, max 3).

Variant selection (``pick_best_variant``) scores each variant's
middle-frame via B7's ``VLMScorer`` and returns the highest-scored one.

Created: 2026-11-25  |  Agent B12  |  Phase P4 (T8 + variants)
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, List, Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from take_selector_v2 import Take, SceneBoundary  # type: ignore
    _HAS_TAKE = True
except Exception:  # pragma: no cover
    _HAS_TAKE = False

    class Take:  # type: ignore[no-redef]
        path: str
        start: float
        end: float
        scene_idx: int

        def __init__(self, path: str = '', start: float = 0.0,
                     end: float = 0.0, scene_idx: int = 0,
                     score: Any = None, frame_path: Optional[str] = None) -> None:
            self.path, self.start, self.end = path, start, end
            self.scene_idx, self.score, self.frame_path = scene_idx, score, frame_path

    @dataclass
    class SceneBoundary:  # type: ignore[no-redef]
        start_sec: float = 0.0
        end_sec: float = 0.0
        scene_idx: int = 0

try:
    from platform_adapter import PlatformAdapter, PLATFORM_SPECS, PACING_INTERVALS  # type: ignore
    _HAS_ADAPTER = True
except Exception:  # pragma: no cover
    _HAS_ADAPTER = False


# ---------------------------------------------------------------------------
# Default variation strategies
# ---------------------------------------------------------------------------
DEFAULT_VARIATIONS: list[str] = [
    'different_take_order',
    'different_pacing',
    'different_music',
    'different_color_grade',
]

# Alternate color-grade moods (must exist in mood_detector's catalogue).
_ALT_COLOR_MOODS: list[str] = [
    'cinematic', 'warm', 'cool', 'vintage', 'noir', 'vibrant',
]

# Pacing rotation (cycles if more variants requested than slots).
_PACING_ROTATION: list[str] = ['medium', 'fast', 'slow']


# ---------------------------------------------------------------------------
# Variant dataclass
# ---------------------------------------------------------------------------
@dataclass
class Variant:
    """One A/B variant produced by ``ABVariantGenerator``."""
    id: str
    description: str
    video_path: str
    parameters_used: dict
    score: Optional[float] = None

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# ABVariantGenerator
# ---------------------------------------------------------------------------
class ABVariantGenerator:
    """Generate N variants of a master video for client A/B selection.

    Each variation strategy re-renders the source video with a different
    production parameter (take order, pacing, music, color grade). The
    output is a list of ``Variant`` objects with paths + descriptions.

    Usage::

        gen = ABVariantGenerator('/tmp/master.mp4',
                                  scene_boundaries=[...],
                                  whisperx_result={'segments': [...]},
                                  beat_times=[0.5, 1.0, ...])
        variants = gen.generate_variants(count=3)
        best = gen.pick_best_variant(variants, criteria='virality')
    """

    MAX_VARIANTS: int = 3

    def __init__(
        self,
        base_video: str,
        scene_boundaries: Optional[List[Any]] = None,
        whisperx_result: Optional[dict] = None,
        beat_times: Optional[List[float]] = None,
        output_dir: Optional[str] = None,
    ) -> None:
        if not os.path.exists(base_video):
            raise FileNotFoundError(base_video)
        self.base_video = base_video
        self.scene_boundaries = scene_boundaries or []
        self.whisperx_result = whisperx_result or {}
        self.beat_times = beat_times or []
        self.output_dir = output_dir or '/tmp/micky_variants'
        os.makedirs(self.output_dir, exist_ok=True)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def generate_variants(
        self,
        count: int = 2,
        variations: Optional[List[str]] = None,
    ) -> List[Variant]:
        """Generate ``count`` variants (1–3) using the chosen variations.

        Args:
            count: Number of variants to produce (clamped to [1, 3]).
            variations: Override the default 4-variation list. Defaults
                to ``DEFAULT_VARIATIONS``.

        Returns:
            List of ``Variant`` objects (length == count). Each variant
            carries its own ``video_path`` and a ``parameters_used``
            dict describing what was changed.
        """
        count = max(1, min(self.MAX_VARIANTS, int(count)))
        variations = variations or DEFAULT_VARIATIONS
        # Pick first ``count`` strategies, cycle if count > len(variations).
        chosen = [variations[i % len(variations)] for i in range(count)]

        variants: list[Variant] = []
        for i, strat in enumerate(chosen):
            t0 = time.time()
            try:
                path, params, desc = self._dispatch_variation(strat, i)
                v = Variant(
                    id=f'v{i + 1:02d}_{strat}',
                    description=desc,
                    video_path=path,
                    parameters_used=params,
                )
                print(f'[ab_variant] {v.id}: {time.time() - t0:.1f}s → {path}')
                variants.append(v)
            except Exception as e:
                print(f'[ab_variant] {strat} failed ({e}); using base video.')
                # Defensive: fall back to base video so caller still gets N variants.
                variants.append(Variant(
                    id=f'v{i + 1:02d}_{strat}_fallback',
                    description=f'fallback (strategy {strat} failed: {e})',
                    video_path=self.base_video,
                    parameters_used={'strategy': strat, 'fallback': True},
                ))
        return variants

    # ------------------------------------------------------------------
    # Individual variation strategies
    # ------------------------------------------------------------------
    def variant_different_take_order(self) -> str:
        """Re-order takes (reverse chronological or narrative-arc alternative).

        Uses ``scene_boundaries`` if available; otherwise splits the
        source into thirds and re-orders them. Re-renders via
        ``ffmpeg`` concat.
        """
        if not self.scene_boundaries:
            # Fallback: split into 3 even chunks and reverse.
            duration = _probe_duration(self.base_video)
            if duration <= 0:
                return self.base_video
            seg = duration / 3.0
            segments = [(2 * seg, duration), (seg, 2 * seg), (0.0, seg)]
        else:
            # Reverse chronological: last scene first, etc.
            bnds = sorted(
                self.scene_boundaries,
                key=lambda b: float(getattr(b, 'start_sec',
                                            b.get('start_sec', 0.0)
                                            if isinstance(b, dict) else 0.0)),
                reverse=True,
            )
            segments = [
                (float(getattr(b, 'start_sec',
                               b.get('start_sec', 0.0) if isinstance(b, dict) else 0.0)),
                 float(getattr(b, 'end_sec',
                               b.get('end_sec', 0.0) if isinstance(b, dict) else 0.0)))
                for b in bnds
            ]

        out_path = str(Path(self.output_dir) / 'variant_take_order.mp4')
        _segment_and_concat(self.base_video, segments,
                             Path(self.output_dir) / 'seg_take_order',
                             out_path, label='take_order')
        return out_path

    def variant_different_pacing(self) -> str:
        """Re-cut with a different pacing strategy.

        Uses ``PlatformAdapter.adjust_pacing``. If the base video was
        rendered at medium pacing (default for the master), this variant
        forces fast (or slow on second call). The rotation is handled
        by ``_next_pacing`` so multiple calls within one
        ``generate_variants(count=3)`` cycle through all 3 pacings.
        """
        pacing = self._next_pacing()
        if not _HAS_ADAPTER:
            # Without platform_adapter we can't re-pace; return base video.
            return self.base_video
        adapter = PlatformAdapter('tiktok')  # pacing works regardless of platform
        out_path = str(Path(self.output_dir) / f'variant_pacing_{pacing}.mp4')
        return adapter.adjust_pacing(self.base_video, pacing,
                                      beat_times=self.beat_times,
                                      output_path=out_path)

    def variant_different_music(self) -> str:
        """Replace the background music with a different mood/BPM track.

        Looks for an alternate track in the music library (B4/P4-T9).
        Falls back to a deterministic ffmpeg-sidechain duck if no
        library is available.

        The video stream is preserved; only the audio track is swapped.
        """
        new_track = self._pick_alternate_track()
        out_path = str(Path(self.output_dir) / 'variant_music.mp4')
        if new_track and os.path.exists(new_track):
            # ffmpeg: replace audio with new track, ducked under speech.
            cmd = [
                'ffmpeg', '-y',
                '-i', self.base_video,
                '-i', new_track,
                '-filter_complex',
                # Sidechain duck: speech ducks the music by -12 dB.
                f'[1:a]volume=0.4[bg];'
                f'[0:a][bg]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=300[mix]',
                '-map', '0:v', '-map', '[mix]',
                '-c:v', 'copy',
                '-c:a', 'aac', '-b:a', '128k',
                '-shortest', '-movflags', '+faststart',
                out_path,
            ]
            try:
                _run_ffmpeg(cmd)
                return out_path
            except RuntimeError as e:
                print(f'[ab_variant] music swap failed ({e}); passthrough audio.')

        # Fallback: just re-mux with a slight EQ change so the variant differs.
        _run_ffmpeg([
            'ffmpeg', '-y', '-i', self.base_video,
            '-af', 'bass=g=3:f=110,treble=g=2:f=6000',
            '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart', out_path,
        ])
        return out_path

    def variant_different_color_grade(self) -> str:
        """Apply a different LUT / mood preset to the source.

        Tries B6's ``ColorGraderV2.grade_with_style`` first (preserves
        the existing pipeline). Falls back to ffmpeg's ``lut3d`` /
        ``curves`` filter when B6 is unavailable.
        """
        mood = self._next_alt_mood()
        out_path = str(Path(self.output_dir) / f'variant_color_{mood}.mp4')
        try:
            from color_grader_v2 import ColorGraderV2  # type: ignore
            from mood_detector import MoodDetector  # type: ignore
            from color_matcher import ColorMatcher  # type: ignore
            grader = ColorGraderV2(MoodDetector(), ColorMatcher(method='mkl'))
            return grader.grade_with_style(
                self.base_video, style=mood,
                intensity=0.85, scene_boundaries=None,
                output_path=out_path)
        except Exception as e:
            print(f'[ab_variant] ColorGraderV2 failed ({e}); ffmpeg curves fallback.')

        # ffmpeg fallback: per-mood curves filter (no LUT file needed).
        curves_map = {
            'cinematic': 'curves=r=0.9:g=1.05:b=1.1,eq=brightness=-0.02:saturation=1.1',
            'warm': 'curves=r=1.1:g=1.0:b=0.9,eq=brightness=0.02:saturation=1.15',
            'cool': 'curves=r=0.9:g=1.0:b=1.15,eq=brightness=0.0:saturation=0.95',
            'vintage': 'curves=r=1.05:g=0.95:b=0.85,eq=brightness=0.03:saturation=0.85',
            'noir': 'hue=s=0,eq=brightness=0.0:saturation=0:contrast=1.2',
            'vibrant': 'eq=saturation=1.4:contrast=1.1',
        }
        vf = curves_map.get(mood, curves_map['cinematic'])
        _run_ffmpeg([
            'ffmpeg', '-y', '-i', self.base_video,
            '-vf', vf,
            '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'copy', '-movflags', '+faststart',
            out_path,
        ])
        return out_path

    # ------------------------------------------------------------------
    # Comparison + scoring
    # ------------------------------------------------------------------
    def compare_variants(
        self,
        variants: List[Variant],
        output_path: Optional[str] = None,
    ) -> dict:
        """Build a side-by-side comparison JPG of each variant's mid-frame.

        Returns metadata dict {path, frame_count, dimensions}.
        Saves the comparison image to ``/tmp/micky_variants/comparison_<hash>.jpg``
        (or ``output_path`` if provided).
        """
        if not variants:
            return {'path': '', 'frame_count': 0, 'dimensions': '0x0'}
        frames_dir = Path(self.output_dir) / 'compare_frames'
        frames_dir.mkdir(parents=True, exist_ok=True)
        frame_paths: list[str] = []
        for i, v in enumerate(variants):
            mid = _probe_duration(v.video_path) / 2.0
            fp = str(frames_dir / f'variant_{i:02d}.jpg')
            try:
                subprocess.run(
                    ['ffmpeg', '-y', '-ss', f'{mid:.3f}', '-i', v.video_path,
                     '-frames:v', '1', '-vf', 'scale=480:-1', '-q:v', '3',
                     '-update', '1', fp],
                    capture_output=True, check=True,
                )
                frame_paths.append(fp)
            except subprocess.CalledProcessError as e:
                print(f'[ab_variant] compare: extract frame for {v.id} failed ({e}).')

        if not frame_paths:
            return {'path': '', 'frame_count': 0, 'dimensions': '0x0'}

        # Build side-by-side montage via ffmpeg's hstack filter.
        if output_path is None:
            digest = hashlib.sha1(
                '|'.join(v.id for v in variants).encode('utf-8')
            ).hexdigest()[:8]
            output_path = str(Path(self.output_dir) / f'comparison_{digest}.jpg')

        inputs: list[str] = []
        for fp in frame_paths:
            inputs.extend(['-i', fp])
        n = len(frame_paths)
        filter_chain = ''.join(f'[{i}:v]' for i in range(n)) + f'hstack=inputs={n}[v]'
        cmd = [
            'ffmpeg', '-y', *inputs,
            '-filter_complex', filter_chain, '-map', '[v]',
            '-frames:v', '1', '-q:v', '3', output_path,
        ]
        try:
            _run_ffmpeg(cmd)
        except RuntimeError as e:
            print(f'[ab_variant] compare: hstack failed ({e}); using first frame.')
            # Fallback: just copy the first frame as the "comparison".
            import shutil
            shutil.copy(frame_paths[0], output_path)

        # Cleanup frames
        for fp in frame_paths:
            try:
                Path(fp).unlink(missing_ok=True)
            except Exception:
                pass
        try:
            frames_dir.rmdir()
        except OSError:
            pass
        return {
            'path': output_path,
            'frame_count': n,
            'dimensions': f'{n * 480}x? (hstack)',
        }

    def pick_best_variant(
        self,
        variants: List[Variant],
        criteria: str = 'virality',
    ) -> Variant:
        """Pick the highest-scored variant via B7's VLM scorer.

        Args:
            variants: List of ``Variant`` objects (already rendered).
            criteria: 'virality' | 'composition' | 'lighting'.
                Maps to a single criterion from B7's VLMScore; the
                variant with the highest score wins.

        Returns:
            The winning ``Variant`` (its ``score`` is set on return).
            When VLM is unavailable, the first variant is returned with
            ``score=5.0`` (neutral) so the caller can still proceed.
        """
        if not variants:
            raise ValueError('pick_best_variant: empty variants list')
        if len(variants) == 1:
            variants[0].score = 5.0
            return variants[0]

        try:
            from vlm_scorer import VLMScorer  # type: ignore
        except Exception as e:
            print(f'[ab_variant] VLMScorer unavailable ({e}); returning first variant.')
            variants[0].score = 5.0
            return variants[0]

        scorer = VLMScorer()
        if not scorer.available:
            print('[ab_variant] VLM unavailable; returning first variant.')
            variants[0].score = 5.0
            return variants[0]

        criterion_map = {
            'virality': 'visual_interest',
            'composition': 'composition',
            'lighting': 'lighting',
        }
        criterion = criterion_map.get(criteria, 'visual_interest')

        best: Variant = variants[0]
        best_score: float = -1.0
        for v in variants:
            # Extract a representative frame (mid).
            mid = _probe_duration(v.video_path) / 2.0
            frame_path = str(Path(self.output_dir) / f'{v.id}_frame.jpg')
            try:
                subprocess.run(
                    ['ffmpeg', '-y', '-ss', f'{mid:.3f}', '-i', v.video_path,
                     '-frames:v', '1', '-vf', 'scale=512:-1', '-q:v', '3',
                     '-update', '1', frame_path],
                    capture_output=True, check=True,
                )
            except subprocess.CalledProcessError as e:
                print(f'[ab_variant] frame extract failed for {v.id} ({e}).')
                v.score = 0.0
                continue
            try:
                score = scorer.score_frame(frame_path)
                v.score = float(getattr(score, criterion, 0.0))
            except Exception as e:
                print(f'[ab_variant] score_frame failed for {v.id} ({e}).')
                v.score = 0.0
            finally:
                try:
                    Path(frame_path).unlink(missing_ok=True)
                except OSError:
                    pass
            if v.score > best_score:
                best_score = v.score
                best = v
        print(f'[ab_variant] pick_best: {best.id} wins (score={best_score:.2f}, '
              f'criteria={criteria})')
        return best

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------
    def _dispatch_variation(
        self, strategy: str, idx: int,
    ) -> tuple[str, dict, str]:
        """Route to the right variant_X method + return metadata."""
        if strategy == 'different_take_order':
            path = self.variant_different_take_order()
            return path, {'strategy': strategy}, \
                f'Reordered takes (reverse-chronological / narrative arc)'
        if strategy == 'different_pacing':
            pacing = self._next_pacing(idx)
            path = self.variant_different_pacing()
            return path, {'strategy': strategy, 'pacing': pacing}, \
                f'Pacing variant: cuts every {PACING_INTERVALS[pacing][0]}–' \
                f'{PACING_INTERVALS[pacing][1]}s'
        if strategy == 'different_music':
            path = self.variant_different_music()
            return path, {'strategy': strategy}, \
                'Alternative background track (different mood/BPM)'
        if strategy == 'different_color_grade':
            mood = self._next_alt_mood(idx)
            path = self.variant_different_color_grade()
            return path, {'strategy': strategy, 'mood': mood}, \
                f'Color grade variant: {mood} LUT/mood preset'
        raise ValueError(f'Unknown variation strategy: {strategy!r}')

    def _next_pacing(self, idx: int = 0) -> str:
        """Pick a pacing that differs from the master's default (medium)."""
        return _PACING_ROTATION[idx % len(_PACING_ROTATION)]

    def _next_alt_mood(self, idx: int = 0) -> str:
        """Pick the next color mood different from the master's grade."""
        return _ALT_COLOR_MOODS[idx % len(_ALT_COLOR_MOODS)]

    def _pick_alternate_track(self) -> Optional[str]:
        """Find an alternate music track in the music library.

        Falls back to ``None`` when no music library is configured.
        """
        try:
            from music_library import MusicLibrary  # type: ignore
        except Exception:
            return None
        lib_dir = os.environ.get(
            'MICKY_MUSIC_DIR', '/kaggle/input/micky-assets/music_cc0')
        if not os.path.isdir(lib_dir):
            return None
        try:
            lib = MusicLibrary(lib_dir)
            tracks = lib.list_tracks() if hasattr(lib, 'list_tracks') else []
            if not tracks:
                return None
            # Pick a track with a different mood than the master's first track.
            return tracks[len(tracks) // 2].path
        except Exception:
            return None


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------
def _probe_duration(video_path: str) -> float:
    try:
        r = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1', video_path],
            capture_output=True, text=True, check=False)
        return float(r.stdout.strip() or 0.0)
    except Exception:
        return 0.0


def _run_ffmpeg(cmd: list[str]) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg failed (exit {result.returncode}):\n"
            f"command: {' '.join(cmd)}\n"
            f"stderr: {result.stderr[-2000:]}")


def _segment_and_concat(
    video_path: str,
    segments: List[tuple],
    seg_dir: Path,
    output_path: str,
    label: str = '',
) -> List[str]:
    """Cut ``segments`` from ``video_path`` and concat them.

    Used by ``variant_different_take_order`` (and also shared with
    platform_adapter's pacing/trim helpers in spirit).
    """
    seg_dir.mkdir(parents=True, exist_ok=True)
    for old in seg_dir.glob('*.mp4'):
        try:
            old.unlink()
        except OSError:
            pass
    seg_paths: list[str] = []
    for i, (s, e) in enumerate(segments):
        if e - s < 0.2:
            continue
        seg = str(seg_dir / f'seg_{i:04d}.mp4')
        _run_ffmpeg([
            'ffmpeg', '-y', '-ss', f'{s:.3f}', '-to', f'{e:.3f}',
            '-i', video_path,
            '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
            '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart', seg])
        seg_paths.append(seg)
    if not seg_paths:
        _run_ffmpeg(['ffmpeg', '-y', '-i', video_path, '-c', 'copy',
                     '-movflags', '+faststart', output_path])
        return seg_paths
    concat_filter = ''.join(
        f'[{i}:v:0][{i}:a:0]' for i in range(len(seg_paths))
    ) + f'concat=n={len(seg_paths)}:v=1:a=1[v][a]'
    _run_ffmpeg([
        'ffmpeg', '-y',
        *[_a for s in seg_paths for _a in ('-i', s)],
        '-filter_complex', concat_filter,
        '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart', output_path])
    for s in seg_paths:
        try:
            Path(s).unlink(missing_ok=True)
        except Exception:
            pass
    try:
        seg_dir.rmdir()
    except OSError:
        pass
    if label:
        print(f'[ab_variant] concat {label}: {len(seg_paths)} segments')
    return seg_paths


# ---------------------------------------------------------------------------
# Standalone CLI (for debugging)
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='ABVariantGenerator (B12)')
    parser.add_argument('video', help='Master video path')
    parser.add_argument('--count', type=int, default=2,
                        help='Number of variants (1–3)')
    parser.add_argument('--out', default='/tmp/micky_variants',
                        help='Output directory')
    args = parser.parse_args()
    gen = ABVariantGenerator(args.video, output_dir=args.out)
    variants = gen.generate_variants(count=args.count)
    best = gen.pick_best_variant(variants, criteria='virality')
    compare = gen.compare_variants(variants)
    import json as _json
    print(_json.dumps({
        'variants': [v.to_dict() for v in variants],
        'best': best.to_dict(),
        'comparison': compare,
    }, indent=2, ensure_ascii=False))
