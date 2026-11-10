"""
Micky Assistant — Multi-Camera Switcher (Agent B15)
====================================================

Given an `AlignmentResult` from `multicam_sync.py`, generates a *cut plan*
(when to switch to which camera) and renders the final multi-cam-switched
video via FFmpeg.

Switching modes
---------------
* ``smart``      — pick the camera with the highest overall score at each
                  segment (face presence + motion + audio + composition).
* ``round_robin``— cycle through cameras every N seconds (default 5s).
* ``beat_sync``  — switch on `beat_times` (e.g. music beats from
                  `beat_sync.py`). Falls back to round_robin if beats
                  aren't provided.
* ``speaker``    — switch to whichever camera has the loudest audio
                  (active-speaker detection via per-camera RMS).

Output: a single MP4 with cuts (optional crossfade) drawn from segments
of each input camera, all properly time-aligned to wall-clock t=0.

Created: 2026-11-15 (Agent B15)
"""
from __future__ import annotations

import math
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, List, Optional

# Lazy-imported so this module loads even if heavy deps are absent.
try:
    from multicam_sync import AlignmentResult  # type: ignore[import-not-found]
except Exception:  # pragma: no cover
    AlignmentResult = None  # type: ignore[assignment, misc]


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------
@dataclass
class CutDecision:
    """A single cut in the multi-cam timeline.

    cam_idx:     Which camera (index into video_paths) is active.
    start_sec:   Wall-clock start time (sec, relative to alignment t=0).
    end_sec:     Wall-clock end time (sec).
    reason:      Human-readable reason for the cut (e.g. 'smart:score=0.87').
    transition:  Optional transition ('crossfade' or None for hard cut).
    """
    cam_idx: int
    start_sec: float
    end_sec: float
    reason: str = ''
    transition: Optional[str] = None

    @property
    def duration(self) -> float:
        return max(0.0, self.end_sec - self.start_sec)

    def to_dict(self) -> dict:
        return {
            'cam_idx': self.cam_idx,
            'start_sec': self.start_sec,
            'end_sec': self.end_sec,
            'reason': self.reason,
            'transition': self.transition,
        }


@dataclass
class CameraScore:
    """Per-camera score for a given time window.

    overall = weighted sum (face 0.4 + motion 0.2 + audio 0.3 + comp 0.1).
    Each sub-score is 0.0–1.0.
    """
    overall: float = 0.0
    face_presence: float = 0.0
    motion_energy: float = 0.0
    audio_energy: float = 0.0
    composition: float = 0.0

    def to_dict(self) -> dict:
        return {
            'overall': round(self.overall, 3),
            'face_presence': round(self.face_presence, 3),
            'motion_energy': round(self.motion_energy, 3),
            'audio_energy': round(self.audio_energy, 3),
            'composition': round(self.composition, 3),
        }


# ---------------------------------------------------------------------------
# MultiCamSwitcher
# ---------------------------------------------------------------------------
class MultiCamSwitcher:
    """Generate cut plans & render multi-cam-switched videos.

    Parameters
    ----------
    alignment : AlignmentResult
        Output of `MultiCamSync.align_videos()` — provides offsets & paths.
    scene_boundaries : list | None
        Optional scene-boundary list (from take_selector_v2/v3) for
        smart mode to use as cut points.
    beat_times : list | None
        Optional beat timestamps (sec) for beat_sync mode.
    segment_sec : float
        Round-robin segment length (default 5s).
    crossfade_sec : float
        Crossfade duration between cuts (default 0.3s; 0.0 = hard cuts).
    work_dir : str | None
        Where to drop intermediate segment files. Defaults to temp dir.
    """

    def __init__(
        self,
        alignment: "AlignmentResult",
        scene_boundaries: Optional[List[Any]] = None,
        beat_times: Optional[List[float]] = None,
        segment_sec: float = 5.0,
        crossfade_sec: float = 0.3,
        work_dir: Optional[str] = None,
    ) -> None:
        if alignment is None:
            raise ValueError("alignment (AlignmentResult) is required")
        self.alignment = alignment
        self.scene_boundaries = scene_boundaries or []
        self.beat_times = list(beat_times or [])
        self.segment_sec = float(segment_sec)
        self.crossfade_sec = float(crossfade_sec)
        self.work_dir = work_dir or tempfile.mkdtemp(prefix='multicam_sw_')
        os.makedirs(self.work_dir, exist_ok=True)

    # ------------------------------------------------------------------
    # generate_cut_plan
    # ------------------------------------------------------------------
    def generate_cut_plan(self, mode: str = 'smart') -> List[CutDecision]:
        """Generate the cut plan based on the chosen switching mode.

        Returns a list of CutDecision (sorted by start_sec) covering the
        full overlap window of all aligned cameras.
        """
        if not self.alignment.video_paths:
            return []
        # Compute the overlap window: from latest start to earliest end.
        offsets = self.alignment.offsets_sec
        durations = [_probe_duration(p) for p in self.alignment.video_paths]
        # Each camera's wall-clock end = offset + duration.
        starts = offsets
        ends = [o + d for o, d in zip(offsets, durations)]
        if not ends or max(starts) >= min(ends):
            return []  # No common overlap.
        t0 = max(starts)
        t1 = min(ends)
        if t1 - t0 < 0.1:
            return []

        if mode == 'smart':
            return self._plan_smart(t0, t1)
        if mode == 'round_robin':
            return self._plan_round_robin(t0, t1)
        if mode == 'beat_sync':
            return self._plan_beat_sync(t0, t1)
        if mode == 'speaker':
            return self._plan_speaker(t0, t1)
        raise ValueError(
            f"Unknown mode {mode!r}; expected one of "
            "smart|round_robin|beat_sync|speaker"
        )

    # ---------------- smart ----------------
    def _plan_smart(self, t0: float, t1: float) -> List[CutDecision]:
        """Switch to the camera with the highest overall score per segment.

        Cut points are derived from scene_boundaries if available; otherwise
        the timeline is split into `segment_sec` chunks.
        """
        # Build cut points (wall-clock start times of each segment).
        cut_points: List[float] = [t0]
        if self.scene_boundaries:
            for sb in self.scene_boundaries:
                # SceneBoundary-like: dict or object with start_time
                start = sb.get('start_time') if isinstance(sb, dict) \
                    else getattr(sb, 'start_time', None)
                if start is not None and t0 < start < t1:
                    cut_points.append(float(start))
        # If too few scene boundaries, subdivide into segment_sec chunks.
        if len(cut_points) < 2:
            t = t0
            while t < t1 - 0.1:
                t += self.segment_sec
                if t < t1:
                    cut_points.append(t)
        cut_points = sorted(set(cut_points))
        cut_points.append(t1)

        # Score each camera in each segment.
        decisions: List[CutDecision] = []
        for i in range(len(cut_points) - 1):
            seg_start, seg_end = cut_points[i], cut_points[i + 1]
            if seg_end - seg_start < 0.2:
                continue
            best_cam, best_score, reason = 0, -1.0, 'fallback'
            for cam_idx, vp in enumerate(self.alignment.video_paths):
                # Convert wall-clock to per-video timeline.
                vid_start = seg_start - self.alignment.offsets_sec[cam_idx]
                vid_end = seg_end - self.alignment.offsets_sec[cam_idx]
                if vid_start < 0 or vid_end <= vid_start:
                    continue
                score = self.compute_camera_score(vp, vid_start, vid_end)
                if score.overall > best_score:
                    best_score = score.overall
                    best_cam = cam_idx
                    reason = (
                        f"smart:score={score.overall:.2f} "
                        f"(face={score.face_presence:.2f},"
                        f"motion={score.motion_energy:.2f},"
                        f"audio={score.audio_energy:.2f},"
                        f"comp={score.composition:.2f})"
                    )
            decisions.append(CutDecision(
                cam_idx=best_cam,
                start_sec=seg_start,
                end_sec=seg_end,
                reason=reason,
                transition='crossfade' if self.crossfade_sec > 0 else None,
            ))
        # Avoid switching between two consecutive identical cameras.
        return _collapse_consecutive(decisions)

    # ---------------- round_robin ----------------
    def _plan_round_robin(self, t0: float, t1: float) -> List[CutDecision]:
        n_cams = len(self.alignment.video_paths)
        decisions: List[CutDecision] = []
        cam_idx = 0
        t = t0
        while t < t1:
            end = min(t + self.segment_sec, t1)
            decisions.append(CutDecision(
                cam_idx=cam_idx % n_cams,
                start_sec=t,
                end_sec=end,
                reason=f'round_robin:{self.segment_sec}s',
                transition='crossfade' if self.crossfade_sec > 0 else None,
            ))
            cam_idx += 1
            t = end
        return decisions

    # ---------------- beat_sync ----------------
    def _plan_beat_sync(self, t0: float, t1: float) -> List[CutDecision]:
        if not self.beat_times:
            print("[multicam_switcher] beat_sync requested but no beat_times "
                  "provided; falling back to round_robin.")
            return self._plan_round_robin(t0, t1)
        # Use beat timestamps within [t0, t1] as cut points; assign cameras
        # in round-robin order between beats.
        beats = [b for b in self.beat_times if t0 < b < t1]
        cut_points = [t0] + beats + [t1]
        cut_points = sorted(set(cut_points))
        n_cams = len(self.alignment.video_paths)
        decisions: List[CutDecision] = []
        cam_idx = 0
        for i in range(len(cut_points) - 1):
            seg_start, seg_end = cut_points[i], cut_points[i + 1]
            if seg_end - seg_start < 0.05:
                continue
            decisions.append(CutDecision(
                cam_idx=cam_idx % n_cams,
                start_sec=seg_start,
                end_sec=seg_end,
                reason=f'beat_sync:{seg_end - seg_start:.2f}s',
                transition='crossfade' if self.crossfade_sec > 0 else None,
            ))
            cam_idx += 1
        return decisions

    # ---------------- speaker ----------------
    def _plan_speaker(self, t0: float, t1: float) -> List[CutDecision]:
        """Switch to whichever camera has the loudest audio (active speaker).

        Splits the timeline into `segment_sec` chunks and picks the loudest
        camera in each chunk.
        """
        # Pre-extract per-camera audio RMS over short windows.
        # Use segment_sec chunks (smaller = more responsive).
        chunk_sec = max(0.5, self.segment_sec / 2)
        decisions: List[CutDecision] = []
        t = t0
        while t < t1:
            end = min(t + chunk_sec, t1)
            best_cam, best_rms = 0, -1.0
            for cam_idx, vp in enumerate(self.alignment.video_paths):
                vid_start = t - self.alignment.offsets_sec[cam_idx]
                vid_end = end - self.alignment.offsets_sec[cam_idx]
                if vid_start < 0 or vid_end <= vid_start:
                    continue
                rms = _compute_audio_rms(vp, vid_start, vid_end)
                if rms > best_rms:
                    best_rms = rms
                    best_cam = cam_idx
            decisions.append(CutDecision(
                cam_idx=best_cam,
                start_sec=t,
                end_sec=end,
                reason=f'speaker:rms={best_rms:.3f}',
                transition='crossfade' if self.crossfade_sec > 0 else None,
            ))
            t = end
        return _collapse_consecutive(decisions)

    # ------------------------------------------------------------------
    # compute_camera_score
    # ------------------------------------------------------------------
    def compute_camera_score(
        self,
        video_path: str,
        start_sec: float,
        end_sec: float,
    ) -> CameraScore:
        """Score a video segment on 4 dimensions:

            * Face presence (via OpenCV Haar cascade; falls back to
              background_remover if available).
            * Motion energy (cv2.absdiff mean).
            * Audio energy (RMS).
            * Composition (rule-of-thirds — face near an intersection of
              thirds lines scores higher; otherwise 0.5 default).
        """
        score = CameraScore()
        if not os.path.exists(video_path) or end_sec <= start_sec:
            score.overall = 0.0
            return score

        try:
            face, motion, comp = _score_visual(video_path, start_sec, end_sec)
            score.face_presence = face
            score.motion_energy = motion
            score.composition = comp
        except Exception as e:
            print(f"[multicam_switcher] visual score failed ({e}).")
            score.face_presence = 0.5
            score.motion_energy = 0.3
            score.composition = 0.5
        try:
            score.audio_energy = _compute_audio_rms(video_path, start_sec, end_sec)
        except Exception:
            score.audio_energy = 0.3

        # Weighted overall: face most important, then audio, then motion, then comp.
        score.overall = (
            0.4 * score.face_presence +
            0.3 * score.audio_energy +
            0.2 * score.motion_energy +
            0.1 * score.composition
        )
        return score

    # ------------------------------------------------------------------
    # render_multicam_video
    # ------------------------------------------------------------------
    def render_multicam_video(
        self,
        video_paths: List[str],
        cut_plan: List[CutDecision],
        output_path: str,
        crossfade: bool = True,
    ) -> str:
        """Render the final multi-cam-switched video using FFmpeg.

        Strategy:
            1. For each CutDecision, extract the corresponding segment from
               the source camera (with proper offset applied).
            2. Re-encode each segment to a uniform codec/resolution so they
               can be concatenated.
            3. If crossfade is requested and there are >1 cuts, use FFmpeg's
               xfade filter chain; otherwise plain concat.

        Args:
            video_paths: List of original video paths (cam_idx indexes into this).
            cut_plan:    List of CutDecision (from generate_cut_plan()).
            output_path: Where to write the final MP4.
            crossfade:   If True, apply 0.3s crossfade transitions (default).

        Returns:
            Path to the rendered multi-cam video.
        """
        if not cut_plan:
            raise ValueError("cut_plan is empty — nothing to render")
        if not video_paths:
            raise ValueError("video_paths is empty")

        os.makedirs(os.path.dirname(os.path.abspath(output_path)) or '.', exist_ok=True)

        # Step 1: extract each segment into its own normalised MP4.
        seg_paths: List[str] = []
        for i, cut in enumerate(cut_plan):
            src = video_paths[cut.cam_idx]
            if not os.path.exists(src):
                print(f"[multicam_switcher] missing src for cam {cut.cam_idx}; "
                      "skipping segment.")
                continue
            # Convert wall-clock to per-video timeline (subtract this camera's offset).
            offset = self.alignment.offsets_sec[cut.cam_idx] \
                if cut.cam_idx < len(self.alignment.offsets_sec) else 0.0
            seg_start = cut.start_sec - offset
            seg_end = cut.end_sec - offset
            seg_dur = max(0.1, seg_end - seg_start)
            seg_path = os.path.join(
                self.work_dir,
                f"seg_{i:04d}_cam{cut.cam_idx}.mp4",
            )
            cmd = [
                'ffmpeg', '-y',
                '-ss', f'{max(0.0, seg_start):.3f}',
                '-i', src,
                '-t', f'{seg_dur:.3f}',
                # Normalise: 1080x1920, 30fps, libx264, AAC.
                '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,'
                       'pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,fps=30',
                '-c:v', 'libx264', '-preset', 'ultrafast',
                '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
                seg_path,
            ]
            try:
                subprocess.run(cmd, check=True, capture_output=True)
                seg_paths.append(seg_path)
            except subprocess.CalledProcessError as e:
                print(f"[multicam_switcher] segment {i} extract failed ({e}); "
                      "skipping.")
                continue

        if not seg_paths:
            raise RuntimeError("All segment extractions failed.")

        # Step 2: stitch.
        if crossfade and len(seg_paths) > 1 and self.crossfade_sec > 0:
            return self._stitch_with_xfade(seg_paths, output_path)
        return self._stitch_concat(seg_paths, output_path)

    # ------------------------------------------------------------------
    # Internal stitching helpers
    # ------------------------------------------------------------------
    def _stitch_concat(self, seg_paths: List[str], output_path: str) -> str:
        """Plain concat (no transitions). Fast path."""
        concat_list = os.path.join(self.work_dir, 'concat_list.txt')
        with open(concat_list, 'w', encoding='utf-8') as f:
            for p in seg_paths:
                # FFmpeg's concat demuxer resolves paths relative to the
                # list file's directory, NOT the cwd — so use absolute paths
                # to avoid the "sw/./sw/seg.mp4" bug.
                abs_p = os.path.abspath(p)
                safe = abs_p.replace("'", r"'\''")
                f.write(f"file '{safe}'\n")
        cmd = [
            'ffmpeg', '-y', '-f', 'concat', '-safe', '0',
            '-i', concat_list, '-c', 'copy', output_path,
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True)
        except subprocess.CalledProcessError as e:
            # Stream-copy concat can fail if segments have different
            # codec params; re-encode in that case.
            print(f"[multicam_switcher] stream-copy concat failed ({e}); "
                  "re-encoding full output.")
            reencode_cmd = [
                'ffmpeg', '-y', '-f', 'concat', '-safe', '0',
                '-i', concat_list,
                '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', output_path,
            ]
            subprocess.run(reencode_cmd, check=True, capture_output=True)
        return output_path

    def _stitch_with_xfade(
        self, seg_paths: List[str], output_path: str,
    ) -> str:
        """Crossfade-stitch using FFmpeg's xfade filter.

        Builds an -filter_complex chain: [0:v][1:v]xfade=duration=0.3...
        Audio is also crossfaded via acrossfade.
        """
        # Probe first segment for resolution (all segments are normalised).
        probe = _probe_video_stream(seg_paths[0])
        w = probe.get('width', 1080)
        h = probe.get('height', 1920)
        fade = max(0.1, self.crossfade_sec)

        # Build inputs list.
        cmd = ['ffmpeg', '-y']
        for p in seg_paths:
            cmd.extend(['-i', p])

        n = len(seg_paths)
        fc_parts: List[str] = []
        # Video xfade chain.
        prev_v = '[0:v]'
        offset = 0.0
        # We need segment durations to compute cumulative offsets.
        seg_durs: List[float] = []
        for p in seg_paths:
            seg_durs.append(_probe_duration(p))
        for i in range(1, n):
            offset += seg_durs[i - 1] - fade
            out_label = f'[v{i}]' if i < n - 1 else '[vout]'
            fc_parts.append(
                f"{prev_v}[{i}:v]xfade=transition=fade:duration={fade:.3f}"
                f":offset={offset:.3f}{out_label}"
            )
            prev_v = out_label
        if n == 1:
            prev_v = '[0:v]'
            fc_parts = []  # No xfade needed for single segment.
        # Audio acrossfade chain.
        prev_a = '[0:a]'
        a_parts: List[str] = []
        for i in range(1, n):
            out_label = f'[a{i}]' if i < n - 1 else '[aout]'
            a_parts.append(
                f"{prev_a}[{i}:a]acrossfade=d={fade:.3f}{out_label}"
            )
            prev_a = out_label
        if n == 1:
            prev_a = '[0:a]'
            a_parts = []

        filter_complex = ';'.join(fc_parts + a_parts) if (fc_parts or a_parts) else None
        if filter_complex:
            cmd.extend(['-filter_complex', filter_complex])
            if fc_parts:
                cmd.extend(['-map', '[vout]' if n > 1 else '[0:v]'])
            if a_parts:
                cmd.extend(['-map', '[aout]' if n > 1 else '[0:a]'])
            else:
                # No audio crossfade — just take first seg's audio.
                cmd.extend(['-map', '0:a?'])
        else:
            # Single segment — just copy.
            cmd.extend(['-i', seg_paths[0], '-c', 'copy'])

        cmd.extend([
            '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k',
            '-s', f'{w}x{h}', '-r', '30',
            output_path,
        ])
        try:
            subprocess.run(cmd, check=True, capture_output=True)
        except subprocess.CalledProcessError as e:
            print(f"[multicam_switcher] xfade stitch failed ({e}); "
                  "falling back to plain concat.")
            return self._stitch_concat(seg_paths, output_path)
        return output_path


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------
def _collapse_consecutive(decisions: List[CutDecision]) -> List[CutDecision]:
    """Merge adjacent decisions that share the same camera index."""
    if not decisions:
        return []
    merged: List[CutDecision] = [decisions[0]]
    for d in decisions[1:]:
        last = merged[-1]
        if d.cam_idx == last.cam_idx and abs(d.start_sec - last.end_sec) < 0.01:
            last.end_sec = d.end_sec
            last.reason = last.reason + ' | ' + d.reason
        else:
            merged.append(d)
    return merged


def _probe_duration(video_path: str) -> float:
    """Probe video duration via ffprobe."""
    try:
        out = subprocess.run(
            ['ffprobe', '-v', 'error',
             '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1', video_path],
            capture_output=True, text=True, check=True,
        )
        return float(out.stdout.strip() or 0.0)
    except Exception:
        return 0.0


def _probe_video_stream(video_path: str) -> dict:
    try:
        import json
        out = subprocess.run(
            ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
             '-show_entries', 'stream=width,height,r_frame_rate',
             '-of', 'json', video_path],
            capture_output=True, text=True, check=True,
        )
        meta = json.loads(out.stdout)
        st = meta.get('streams', [{}])[0]
        return {
            'width': int(st.get('width', 1080)),
            'height': int(st.get('height', 1920)),
            'fps': 30.0,
        }
    except Exception:
        return {'width': 1080, 'height': 1920, 'fps': 30.0}


def _compute_audio_rms(
    video_path: str, start_sec: float, end_sec: float,
) -> float:
    """Compute normalised RMS audio energy (0.0–1.0) for a video segment.

    Uses ffmpeg's `volumedetect` filter to get mean volume, then maps to
    a 0–1 score where -30 dB ≈ 0.0 and 0 dB ≈ 1.0.
    """
    dur = max(0.1, end_sec - start_sec)
    cmd = [
        'ffmpeg', '-y',
        '-ss', f'{max(0.0, start_sec):.3f}',
        '-i', video_path,
        '-t', f'{dur:.3f}',
        '-vn', '-ac', '1',
        '-af', 'volumedetect',
        '-f', 'null', '-',
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, check=False)
        # volumedetect writes to stderr.
        err = out.stderr or ''
        mean_db = None
        for line in err.splitlines():
            if 'mean_volume' in line:
                # e.g. "    mean_volume: -23.4 dB"
                parts = line.split(':')
                if len(parts) >= 2:
                    val = parts[-1].replace('dB', '').strip()
                    try:
                        mean_db = float(val)
                    except ValueError:
                        pass
                break
        if mean_db is None:
            return 0.3
        # Map -50..0 dB → 0..1.
        score = max(0.0, min(1.0, (mean_db + 50.0) / 50.0))
        return float(score)
    except Exception:
        return 0.3


def _score_visual(
    video_path: str, start_sec: float, end_sec: float,
) -> tuple:
    """Compute (face_presence, motion_energy, composition) for a video segment.

    face_presence: fraction of sampled frames with a detectable face.
    motion_energy:  normalised cv2.absdiff mean.
    composition:    rule-of-thirds score (face near thirds intersections).
    """
    import numpy as np  # type: ignore[import-not-found]
    try:
        import cv2  # type: ignore[import-not-found]
    except ImportError:
        subprocess.check_call(
            [sys.executable, '-m', 'pip', 'install', '-q', 'opencv-python']
        )
        import cv2  # type: ignore[import-not-found]

    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    if total > 0:
        # Use the duration estimate from total/fps if start/end are at risk.
        vid_dur = total / fps
        end_sec = min(end_sec, vid_dur)
    start_frame = max(0, int(start_sec * fps))
    end_frame = max(start_frame + 1, int(end_sec * fps))
    # Sample up to 5 frames evenly spaced.
    sample_count = min(5, max(1, end_frame - start_frame))
    sample_idxs = [
        start_frame + int((i + 0.5) * (end_frame - start_frame) / sample_count)
        for i in range(sample_count)
    ]

    # Face detector (Haar cascade; falls back to None).
    detector = _build_haar_detector()
    prev_gray = None
    motion_acc = 0.0
    face_hits = 0
    sampled = 0
    comp_acc = 0.0
    for idx in sample_idxs:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, frame = cap.read()
        if not ok or frame is None:
            continue
        sampled += 1
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        if prev_gray is not None and prev_gray.shape == gray.shape:
            diff = cv2.absdiff(prev_gray, gray)
            motion_acc += float(diff.mean()) / 255.0
        prev_gray = gray
        if detector is not None:
            faces = detector.detectMultiScale(
                gray, scaleFactor=1.1, minNeighbors=4,
                minSize=(60, 60), maxSize=(int(gray.shape[1]*0.8),
                                            int(gray.shape[0]*0.8)),
            )
            if len(faces) > 0:
                face_hits += 1
                # Composition: face center proximity to thirds intersection.
                fx, fy, fw, fh = faces[0]
                fcx = (fx + fw / 2) / gray.shape[1]
                fcy = (fy + fh / 2) / gray.shape[0]
                # thirds lines at 1/3 and 2/3.
                thirds_x = [1/3, 2/3]
                thirds_y = [1/3, 2/3]
                min_dx = min(abs(fcx - x) for x in thirds_x)
                min_dy = min(abs(fcy - y) for y in thirds_y)
                # Closer to a thirds intersection → higher score.
                # 0 distance = 1.0; 0.5 distance = 0.0.
                comp = max(0.0, 1.0 - 2.0 * (min_dx + min_dy) / 2.0)
                comp_acc += comp
    cap.release()

    face_score = (face_hits / sampled) if sampled else 0.5
    motion_score = (motion_acc / max(1, sampled - 1)) if sampled > 1 else 0.3
    # Normalise motion: 0.05 mean diff ≈ 1.0 (clap-heavy footage).
    motion_score = min(1.0, motion_score / 0.05)
    comp_score = (comp_acc / sampled) if sampled else 0.5
    return face_score, motion_score, comp_score


def _build_haar_detector():
    """OpenCV Haar cascade face detector (best-effort)."""
    try:
        import cv2  # type: ignore[import-not-found]
        base = getattr(getattr(cv2, 'data', None), 'haarcascades', '') or ''
        cp = os.path.join(base, 'haarcascade_frontalface_default.xml')
        if os.path.exists(cp):
            cascade = cv2.CascadeClassifier(cp)
            if not cascade.empty():
                return cascade
    except Exception:
        pass
    return None
