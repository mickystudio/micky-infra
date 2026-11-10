"""
Beat synchronization for the Micky Assistant montage pipeline (P4-T9).
=====================================================================

Wraps the **beat-this** library (ISMIR 2024 SOTA, MIT-licensed) to detect
beats + downbeats in any audio file, snap raw cut times to the nearest
beat, schedule clips onto beats (3 modes), and pick downbeat-level "epic"
cut plans. Falls back to ``librosa.beat.beat_track`` (CPU) when beat-this
is unavailable, and to a synthetic 120 BPM grid as a last resort.

Created: 2026-11-10  |  Phase P4 (T9)
"""
from __future__ import annotations

import subprocess
import sys
from dataclasses import dataclass
from typing import List, Optional, Sequence

import numpy as np


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------
@dataclass
class BeatInfo:
    """Output of ``BeatSync.detect_beats``."""
    beats: List[float]
    downbeats: List[float]
    bpm: float
    duration_sec: float = 0.0


@dataclass
class ClipAssignment:
    """A clip scheduled to play at a particular beat."""
    clip_path: str
    start_sec: float
    duration_sec: float
    beat_index: int = -1


# ---------------------------------------------------------------------------
# BeatSync
# ---------------------------------------------------------------------------
class BeatSync:
    """Wrap beat-this (with librosa fallback) for beat-synced cutting.

    Typical usage::

        bs = BeatSync(device='cpu')
        info = bs.detect_beats('/path/to/audio.wav')
        cuts = bs.snap_cuts_to_beats(raw_cut_times, info.beats)
        plan = bs.assign_clips_to_beats(info.beats, clip_paths, mode='round_robin')
    """

    _FALLBACK_BPM: float = 120.0  # last-resort synthetic grid tempo

    def __init__(self, device: str = 'cpu') -> None:
        self.device = device
        self._file2beats = None  # lazy
        self._librosa_warned = False
        self._engine: str = 'unknown'  # 'beat_this' | 'librosa' | 'fallback'

    # ------------------------------------------------------------------
    # Beat detection
    # ------------------------------------------------------------------
    def detect_beats(self, audio_path: str) -> BeatInfo:
        """Detect beats + downbeats in ``audio_path``.

        Uses ``beat_this.inference.File2Beats`` if available (auto-installing
        on first run). On any failure, falls back to ``librosa.beat.beat_track``.
        As a last resort, returns a synthetic 120 BPM grid so the caller
        never has to handle None.
        """
        duration = self._probe_duration(audio_path)

        # --- Attempt 1: beat-this ---------------------------------------
        try:
            beats, downbeats = self._detect_with_beat_this(audio_path)
            if beats:
                self._engine = 'beat_this'
                return BeatInfo(
                    beats=[float(b) for b in beats],
                    downbeats=[float(b) for b in downbeats],
                    bpm=self.estimate_bpm(beats),
                    duration_sec=duration,
                )
        except Exception as exc:  # noqa: BLE001 — explicit fallback chain
            print(f"[beat_sync] beat-this failed ({exc!r}); trying librosa fallback")

        # --- Attempt 2: librosa ----------------------------------------
        try:
            beats, downbeats, bpm = self._detect_with_librosa(audio_path)
            if beats:
                self._engine = 'librosa'
                return BeatInfo(
                    beats=[float(b) for b in beats],
                    downbeats=[float(b) for b in downbeats],
                    bpm=float(bpm),
                    duration_sec=duration,
                )
        except Exception as exc:  # noqa: BLE001
            print(f"[beat_sync] librosa fallback failed ({exc!r}); using synthetic grid")

        # --- Attempt 3: synthetic 120 BPM grid -------------------------
        self._engine = 'fallback'
        beats, downbeats = self._synthetic_grid(duration)
        return BeatInfo(
            beats=beats, downbeats=downbeats,
            bpm=self._FALLBACK_BPM, duration_sec=duration,
        )

    # ------------------------------------------------------------------
    # BPM estimation
    # ------------------------------------------------------------------
    def estimate_bpm(self, beats: Sequence[float]) -> float:
        """Median inter-beat interval → BPM. Robust vs. missed/doubled beats."""
        beats = sorted(float(b) for b in beats)
        if len(beats) < 2:
            return self._FALLBACK_BPM
        intervals = np.diff(beats)
        intervals = intervals[intervals >= 0.2]  # drop doubled beats (>300 BPM)
        if intervals.size == 0:
            return self._FALLBACK_BPM
        median_interval = float(np.median(intervals))
        if median_interval <= 0:
            return self._FALLBACK_BPM
        return 60.0 / median_interval

    # ------------------------------------------------------------------
    # Snap cuts to nearest beat
    # ------------------------------------------------------------------
    def snap_cuts_to_beats(
        self,
        cut_times: Sequence[float],
        beat_times: Sequence[float],
        tolerance_sec: float = 0.15,
    ) -> List[float]:
        """Snap each cut time to the nearest beat if within ``tolerance_sec``."""
        if not beat_times:
            return [float(t) for t in cut_times]
        beats_arr = np.asarray(beat_times, dtype=np.float64)
        snapped: List[float] = []
        for t in cut_times:
            t = float(t)
            idx = int(np.argmin(np.abs(beats_arr - t)))
            nearest = float(beats_arr[idx])
            snapped.append(nearest if abs(nearest - t) <= tolerance_sec else t)
        return snapped

    # ------------------------------------------------------------------
    # Assign clips to beats (3 modes)
    # ------------------------------------------------------------------
    def assign_clips_to_beats(
        self,
        beat_times: Sequence[float],
        clips: Sequence[str],
        mode: str = 'round_robin',
    ) -> List[ClipAssignment]:
        """Schedule clips onto beat times.

        Modes:
          * ``round_robin``    — ``clips[i % len(clips)]`` at ``beat_times[i]``.
          * ``sequential``    — ``clips[min(i, len(clips)-1)]`` (plays each clip
                                in order; last clip repeats to fill).
          * ``energy_matched``— pairs high-energy clips with high-energy beats.

        Returns one ``ClipAssignment`` per beat.
        """
        if not clips or not beat_times:
            return []

        beats = [float(b) for b in beat_times]
        n = len(beats)
        # Default duration = interval to next beat (or 0.5s on last beat).
        durations = [
            max(0.05, beats[i + 1] - beats[i]) if i + 1 < n else 0.5
            for i in range(n)
        ]

        if mode == 'sequential':
            return [
                ClipAssignment(clips[min(i, len(clips) - 1)], beats[i],
                              durations[i], i)
                for i in range(n)
            ]
        if mode == 'energy_matched':
            return self._assign_energy_matched(beats, list(clips), durations)
        # default → round_robin
        return [
            ClipAssignment(clips[i % len(clips)], beats[i], durations[i], i)
            for i in range(n)
        ]

    # ------------------------------------------------------------------
    # Downbeat cut plan ("epic" / "chill" style)
    # ------------------------------------------------------------------
    def get_downbeat_cut_plan(
        self,
        beats: Sequence[float],
        downbeats: Sequence[float],
        target_clip_count: int,
    ) -> List[float]:
        """Pick a cut plan that lands on downbeats (or every 2nd beat).

        If ``target_clip_count`` <= #downbeats → sample from downbeats
        (bar boundaries, epic/chill style). Otherwise every 2nd beat
        (higher energy). Last resort: every beat.
        """
        beats = sorted(float(b) for b in beats)
        downbeats = sorted(float(b) for b in downbeats)

        if downbeats and target_clip_count <= len(downbeats):
            return self._even_sample(downbeats, target_clip_count)

        every_other = beats[::2]
        if target_clip_count <= len(every_other):
            return self._even_sample(every_other, target_clip_count)

        return self._even_sample(beats, target_clip_count)

    # ------------------------------------------------------------------
    # Energy envelope (librosa RMS) — for ducking & energy_matched mode
    # ------------------------------------------------------------------
    def compute_energy_envelope(
        self,
        audio_path: str,
        frame_length: int = 2048,
        hop_length: int = 512,
    ) -> np.ndarray:
        """Per-frame RMS energy envelope (librosa). Used for ducking + energy_matched."""
        try:
            import librosa  # type: ignore
        except ImportError:
            subprocess.check_call(
                [sys.executable, '-m', 'pip', 'install', '-q', 'librosa']
            )
            import librosa  # type: ignore

        y, sr = librosa.load(audio_path, sr=None, mono=True)
        rms = librosa.feature.rms(
            y=y, frame_length=frame_length, hop_length=hop_length
        )[0]
        return np.asarray(rms, dtype=np.float64)

    # ==================================================================
    #  Internals
    # ==================================================================
    def _detect_with_beat_this(
        self, audio_path: str
    ) -> 'tuple[List[float], List[float]]':
        """Run beat-this File2Beats. Returns (beats, downbeats)."""
        if self._file2beats is None:
            try:
                from beat_this.inference import File2Beats  # type: ignore
            except ImportError:
                print("[beat_sync] Installing beat-this (first run only)...")
                subprocess.check_call(
                    [sys.executable, '-m', 'pip', 'install', '-q', 'beat-this']
                )
                from beat_this.inference import File2Beats  # type: ignore

            # `final0` = published ensemble checkpoint (ISMIR 2024).
            # dbn=False: skip the dynamic Bayesian network post-processor
            # (faster on CPU, marginally less accurate on ambiguous tracks).
            self._file2beats = File2Beats(
                checkpoint_path='final0', device=self.device, dbn=False,
            )

        beats, downbeats = self._file2beats(audio_path)
        # beat-this returns numpy arrays / tensors — coerce to lists.
        beats_list = [float(b) for b in np.asarray(beats).flatten()]
        downbeats_list = [float(b) for b in np.asarray(downbeats).flatten()]
        return beats_list, downbeats_list

    def _detect_with_librosa(
        self, audio_path: str
    ) -> 'tuple[List[float], List[float], float]':
        """CPU-only fallback via librosa.beat.beat_track.

        librosa doesn't separate downbeats, so we synthesize them as every
        4th beat (4/4 time signature assumption).
        """
        if not self._librosa_warned:
            print("[beat_sync] using librosa.beat.beat_track (CPU fallback)")
            self._librosa_warned = True

        import librosa  # type: ignore

        y, sr = librosa.load(audio_path, sr=None, mono=True)
        tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
        # librosa 0.10+ may return tempo as a 1-D array.
        if isinstance(tempo, np.ndarray):
            tempo = float(tempo[0]) if tempo.size else self._FALLBACK_BPM
        else:
            tempo = float(tempo or self._FALLBACK_BPM)

        beat_times = [float(b) for b in librosa.frames_to_time(beat_frames, sr=sr).tolist()]
        downbeats = beat_times[::4] if len(beat_times) >= 4 else beat_times[:1]
        return beat_times, downbeats, tempo

    def _synthetic_grid(self, duration: float) -> 'tuple[List[float], List[float]]':
        """Last-resort 120 BPM grid if everything else fails."""
        if duration <= 0:
            duration = 30.0
        interval = 60.0 / self._FALLBACK_BPM  # 0.5s per beat
        beats: List[float] = []
        t = 0.0
        while t < duration:
            beats.append(round(t, 4))
            t += interval
        return beats, beats[::4]

    def _assign_energy_matched(
        self,
        beats: List[float],
        clips: List[str],
        durations: List[float],
    ) -> List[ClipAssignment]:
        """Pair high-energy clips with high-energy beats.

        Clip energy = mean RMS of the clip's audio (or 0.0 if no audio).
        Beat energy = index-based proxy (later beats often climactic).
        """
        n = len(beats)
        if len(clips) == 1:
            # Degenerate: just round-robin the single clip.
            return [
                ClipAssignment(clips[0], beats[i], durations[i], i)
                for i in range(n)
            ]

        # Score each clip's energy.
        clip_energy: List[float] = []
        for path in clips:
            try:
                rms = self.compute_energy_envelope(path)
                clip_energy.append(float(np.mean(rms)) if rms.size else 0.0)
            except Exception:  # noqa: BLE001 — never fail assignment
                clip_energy.append(0.0)

        # Score each beat (use index as proxy).
        beat_energy = np.linspace(0.3, 1.0, n).tolist()

        # Sort clips by descending energy; assign greedily to highest-energy
        # beats while rotating within the sorted clip list (so every clip gets used).
        order_clips = sorted(range(len(clips)), key=lambda i: -clip_energy[i])
        order_beats = sorted(range(n), key=lambda i: -beat_energy[i])

        clip_for_beat: List[str] = [''] * n
        for k, beat_idx in enumerate(order_beats):
            clip_for_beat[beat_idx] = clips[order_clips[k % len(order_clips)]]

        return [
            ClipAssignment(clip_for_beat[i], beats[i], durations[i], i)
            for i in range(n)
        ]

    @staticmethod
    def _even_sample(sorted_times: List[float], n: int) -> List[float]:
        """Evenly sample ``n`` timestamps from a sorted list."""
        if n <= 0:
            return []
        if n >= len(sorted_times):
            return list(sorted_times)
        if n == 1:
            return [sorted_times[len(sorted_times) // 2]]
        idxs = np.linspace(0, len(sorted_times) - 1, n).astype(int)
        return [sorted_times[i] for i in idxs]

    @staticmethod
    def _probe_duration(audio_path: str) -> float:
        """Return audio duration in seconds via ffprobe (0.0 on failure)."""
        try:
            result = subprocess.run(
                ['ffprobe', '-v', 'error',
                 '-show_entries', 'format=duration',
                 '-of', 'default=noprint_wrappers=1:nokey=1',
                 audio_path],
                capture_output=True, text=True, check=True,
            )
            return float(result.stdout.strip() or 0.0)
        except Exception:  # noqa: BLE001
            return 0.0

    @property
    def engine(self) -> str:
        """Which backend was used by the last ``detect_beats`` call."""
        return self._engine


# ---------------------------------------------------------------------------
# Standalone CLI (for debugging)
# ---------------------------------------------------------------------------
def _cli() -> int:
    import argparse
    import json

    parser = argparse.ArgumentParser(description='BeatSync — beat detection + cut snapping')
    parser.add_argument('audio', help='Path to an audio file (wav/mp3/m4a)')
    parser.add_argument('--device', default='cpu', help='cpu | cuda')
    parser.add_argument('--cuts', default='',
                        help='Comma-separated raw cut times to snap (seconds)')
    parser.add_argument('--json', action='store_true', help='Print as JSON')
    args = parser.parse_args()

    bs = BeatSync(device=args.device)
    info = bs.detect_beats(args.audio)
    print(f"[beat_sync] engine={bs.engine}  bpm={info.bpm:.1f}  "
          f"beats={len(info.beats)}  downbeats={len(info.downbeats)}  "
          f"duration={info.duration_sec:.2f}s")

    if args.cuts:
        raw_cuts = [float(x) for x in args.cuts.split(',') if x.strip()]
        snapped = bs.snap_cuts_to_beats(raw_cuts, info.beats)
        if args.json:
            print(json.dumps({
                'engine': bs.engine, 'bpm': info.bpm,
                'beats': info.beats[:50], 'downbeats': info.downbeats[:20],
                'raw_cuts': raw_cuts, 'snapped_cuts': snapped,
            }, indent=2))
        else:
            for r, s in zip(raw_cuts, snapped):
                print(f"  {r:7.3f}  →  {s:7.3f}   "
                      f"({'snapped' if abs(r - s) > 1e-6 else 'unchanged'})")
    elif args.json:
        print(json.dumps({
            'engine': bs.engine, 'bpm': info.bpm,
            'beats': info.beats, 'downbeats': info.downbeats,
            'duration_sec': info.duration_sec,
        }, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(_cli())
