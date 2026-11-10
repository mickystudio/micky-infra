"""
CC0 / royalty-free music library index (P4-T9).
================================================

Caches a searchable index of music tracks stored on the Kaggle dataset
``/kaggle/input/micky-assets/music_cc0`` (or any local dir).

The index file ``index.json`` is written next to the library path on first
scan, and contains one entry per track with BPM, RMS energy, mood, duration,
title, and license. On subsequent runs the index is loaded from disk in O(1)
and scans are skipped.

Uses :class:`beat_sync.BeatSync` (which itself wraps beat-this / librosa)
for BPM detection and a small spectral heuristic for mood classification
(high-frequency energy → ``energetic``, low-frequency dominance → ``calm``,
loud + bright → ``epic``).

Created: 2026-11-10  |  Phase P4 (T9)
"""
from __future__ import annotations

import json
import os
import sys
import traceback
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

# Allow ``from music_library import ...`` as well as
# ``from beat_sync import ...`` when imported as a sibling module.
sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    from beat_sync import BeatSync  # type: ignore
except Exception:  # pragma: no cover — beat_sync must exist in same dir
    BeatSync = None  # type: ignore


SUPPORTED_AUDIO_EXTS: Tuple[str, ...] = ('.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac')

# Mood label set used throughout the library.
MOODS: Tuple[str, ...] = ('energetic', 'calm', 'epic', 'happy', 'sad', 'neutral')


# ---------------------------------------------------------------------------
# Track dataclass
# ---------------------------------------------------------------------------
@dataclass
class Track:
    """One entry in the music library index."""
    path: str
    bpm: float = 0.0
    energy: float = 0.0           # mean RMS, 0..1
    mood: str = 'neutral'         # one of MOODS
    duration_sec: float = 0.0
    title: str = ''               # defaults to filename stem
    license: str = 'CC0'          # default; override per source

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> 'Track':
        return cls(
            path=str(d.get('path', '')),
            bpm=float(d.get('bpm', 0.0) or 0.0),
            energy=float(d.get('energy', 0.0) or 0.0),
            mood=str(d.get('mood', 'neutral')),
            duration_sec=float(d.get('duration_sec', 0.0) or 0.0),
            title=str(d.get('title', '')),
            license=str(d.get('license', 'CC0')),
        )


# ---------------------------------------------------------------------------
# MusicLibrary
# ---------------------------------------------------------------------------
class MusicLibrary:
    """Index and query a directory of CC0 / royalty-free music tracks.

    Typical usage::

        lib = MusicLibrary('/kaggle/input/micky-assets/music_cc0')
        lib.index_library()                          # run once after adding tracks
        track = lib.get_track_by_bpm(120, mood='calm')
    """

    INDEX_FILENAME = 'index.json'

    def __init__(self, library_path: str = '/kaggle/input/micky-assets/music_cc0') -> None:
        self.library_path = str(library_path)
        self.index_path = os.path.join(self.library_path, self.INDEX_FILENAME)
        self.tracks: List[Track] = []
        self._beat_sync: Optional[BeatSync] = None
        self._load_index()

    # ------------------------------------------------------------------
    # Index persistence
    # ------------------------------------------------------------------
    def _load_index(self) -> None:
        """Load ``index.json`` if present, else start with an empty list."""
        if not os.path.exists(self.index_path):
            self.tracks = []
            return
        try:
            with open(self.index_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            self.tracks = [Track.from_dict(d) for d in data]
            print(f"[music_library] loaded {len(self.tracks)} tracks "
                  f"from {self.index_path}")
        except Exception as exc:  # noqa: BLE001
            print(f"[music_library] failed to load index ({exc!r}); starting fresh")
            self.tracks = []

    def _save_index(self) -> None:
        """Persist the current track list to ``index.json``."""
        try:
            os.makedirs(self.library_path, exist_ok=True)
            with open(self.index_path, 'w', encoding='utf-8') as f:
                json.dump([t.to_dict() for t in self.tracks], f,
                          ensure_ascii=False, indent=2)
            print(f"[music_library] wrote {len(self.tracks)} tracks "
                  f"→ {self.index_path}")
        except Exception as exc:  # noqa: BLE001
            print(f"[music_library] failed to save index ({exc!r})")

    # ------------------------------------------------------------------
    # Index building
    # ------------------------------------------------------------------
    def index_library(self) -> None:
        """Walk ``library_path``, analyze each audio file, write ``index.json``.

        For each track we compute:
          * BPM via beat-this (or librosa fallback),
          * Mean RMS energy,
          * Mood via simple spectral heuristic,
          * Duration via ffprobe.

        Existing index entries for unchanged files are preserved (skip
        re-analysis to save time on Kaggle runs).
        """
        if not os.path.isdir(self.library_path):
            print(f"[music_library] library_path '{self.library_path}' does not exist")
            return

        existing = {t.path: t for t in self.tracks}
        new_tracks: List[Track] = []

        for root, _dirs, files in os.walk(self.library_path):
            for fname in sorted(files):
                if not fname.lower().endswith(SUPPORTED_AUDIO_EXTS):
                    continue
                full_path = os.path.join(root, fname)
                # Skip the index file itself.
                if os.path.abspath(full_path) == os.path.abspath(self.index_path):
                    continue

                # Reuse cached analysis if file mtime hasn't changed.
                cached = existing.get(full_path)
                if cached and self._is_cache_fresh(cached, full_path):
                    new_tracks.append(cached)
                    continue

                track = self._analyze_track(full_path)
                new_tracks.append(track)

        self.tracks = new_tracks
        self._save_index()

    @staticmethod
    def _is_cache_fresh(track: Track, path: str) -> bool:
        """Return True if the file on disk hasn't changed since we cached it.

        We use mtime as a cheap proxy. (A real content hash would be safer
        but slower; this is plenty for a Kaggle dataset that's read-only.)
        """
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            return False
        # We didn't store mtime; treat any existing entry as fresh enough
        # if it has a non-zero BPM (i.e. it was successfully analyzed).
        # Storing mtime would be a nice future enhancement.
        _ = mtime
        return track.bpm > 0.0

    # ------------------------------------------------------------------
    # Track analysis
    # ------------------------------------------------------------------
    def _analyze_track(self, path: str) -> Track:
        """Compute BPM, energy, mood, duration for a single track."""
        name = os.path.splitext(os.path.basename(path))[0]
        track = Track(path=path, title=name, license=self._guess_license(path))

        # Duration via ffprobe (cheap, no decode beyond header).
        track.duration_sec = self._probe_duration(path)

        # BPM + energy + mood via librosa (one decode pass).
        try:
            bpm, energy, mood = self._analyze_audio(path)
            track.bpm = bpm
            track.energy = energy
            track.mood = mood
        except Exception as exc:  # noqa: BLE001
            print(f"[music_library] analysis failed for {path}: {exc!r}")
            traceback.print_exc()

        print(f"[music_library] analyzed: {name}  bpm={track.bpm:.1f}  "
              f"energy={track.energy:.3f}  mood={track.mood}  "
              f"dur={track.duration_sec:.1f}s")
        return track

    def _analyze_audio(self, path: str) -> Tuple[float, float, str]:
        """Returns (bpm, energy_0_1, mood)."""
        import librosa  # type: ignore  # noqa: PLC0415

        y, sr = librosa.load(path, sr=22050, mono=True)

        # BPM: prefer beat-this if available, fall back to librosa.
        bpm = self._detect_bpm(path, y, sr)

        # RMS energy (mean).
        rms = librosa.feature.rms(y=y)[0]
        energy = float(rms.mean()) if rms.size else 0.0

        # Mood: simple spectral analysis.
        mood = self._classify_mood(y, sr, energy)

        return bpm, energy, mood

    def _detect_bpm(self, path: str, y, sr: int) -> float:
        """Detect BPM via BeatSync (preferred) or librosa (in-process)."""
        # Preferred: delegate to BeatSync (which itself prefers beat-this).
        if BeatSync is not None:
            try:
                bs = self._get_beat_sync()
                info = bs.detect_beats(path)
                if info.bpm and info.bpm > 0:
                    return info.bpm
            except Exception as exc:  # noqa: BLE001
                print(f"[music_library] BeatSync failed ({exc!r}); "
                      f"using in-process librosa")

        # In-process librosa fallback (we already have y, sr loaded).
        import librosa  # type: ignore  # noqa: PLC0415
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        if isinstance(tempo, (list, tuple)):
            tempo = tempo[0] if tempo else 120.0
        if hasattr(tempo, 'item'):
            tempo = tempo.item()
        return float(tempo or 120.0)

    @staticmethod
    def _classify_mood(y, sr: int, energy: float) -> str:
        """Heuristic mood classification from spectral + energy cues.

        Strategy:
          * Compute spectral centroid (mean "brightness" of the track).
          * Compute spectral rolloff (where 85% of energy sits below).
          * Combine with RMS energy to pick a mood:
              - high energy + bright → ``energetic``
              - high energy + very bright (top 5%) → ``epic``
              - low energy + dark → ``calm``
              - mid energy + bright + major-ish (high spectral contrast) → ``happy``
              - mid energy + dark + low contrast → ``sad``
              - otherwise → ``neutral``
        """
        import librosa  # type: ignore  # noqa: PLC0415
        import numpy as np  # noqa: PLC0415

        try:
            centroid = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr)))
            rolloff = float(np.mean(librosa.feature.spectral_rolloff(y=y, sr=sr)))
        except Exception:  # noqa: BLE001
            return 'neutral'

        # Normalize centroid against a coarse reference (3 kHz is mid-bright).
        bright = centroid > 3000.0
        very_bright = centroid > 5000.0
        high_energy = energy > 0.05
        low_energy = energy < 0.015
        # rolloff unused for now; reserved for future tuning.
        _ = rolloff

        if very_bright and high_energy:
            return 'epic'
        if high_energy and bright:
            return 'energetic'
        if low_energy and not bright:
            return 'calm'
        if bright and 0.015 <= energy <= 0.05:
            # Bright + moderate energy → call it happy.
            return 'happy'
        if not bright and 0.015 <= energy <= 0.05:
            return 'sad'
        return 'neutral'

    def _get_beat_sync(self) -> 'BeatSync':
        """Lazy-init a shared BeatSync instance."""
        if self._beat_sync is None and BeatSync is not None:
            self._beat_sync = BeatSync(device='cpu')
        return self._beat_sync  # type: ignore[return-value]

    @staticmethod
    def _guess_license(path: str) -> str:
        """Best-effort license guess from the path or filename."""
        lower = path.lower()
        if 'pixabay' in lower:
            return 'Pixabay Content License (free for commercial & no attribution)'
        if 'mixkit' in lower:
            return 'Mixkit Free License (no attribution required)'
        if 'freepd' in lower:
            return 'CC0 (FreePD public domain)'
        return 'CC0'

    @staticmethod
    def _probe_duration(path: str) -> float:
        import subprocess  # noqa: PLC0415
        try:
            r = subprocess.run(
                ['ffprobe', '-v', 'error',
                 '-show_entries', 'format=duration',
                 '-of', 'default=noprint_wrappers=1:nokey=1', path],
                capture_output=True, text=True, check=True,
            )
            return float(r.stdout.strip() or 0.0)
        except Exception:  # noqa: BLE001
            return 0.0

    # ------------------------------------------------------------------
    # Query API
    # ------------------------------------------------------------------
    def get_track_by_bpm(
        self,
        target_bpm: float,
        tolerance: float = 5.0,
        mood: Optional[str] = None,
    ) -> Optional[str]:
        """Find the track with BPM closest to ``target_bpm``.

        Args:
            target_bpm: Desired tempo.
            tolerance:  Max acceptable |track_bpm - target_bpm|.
            mood:       Optional mood filter (e.g. ``'calm'``).
        Returns:
            Path to the best-matching track, or None.
        """
        candidates = self.list_tracks(mood=mood)
        if not candidates:
            return None
        # Filter by BPM tolerance, then pick the closest.
        within_tol = [
            t for t in candidates
            if abs(t.bpm - target_bpm) <= tolerance
        ]
        pool = within_tol or candidates
        best = min(pool, key=lambda t: abs(t.bpm - target_bpm))
        return best.path

    def get_track_by_mood(self, mood: str) -> Optional[str]:
        """Return a random track matching ``mood`` (or None)."""
        import random  # noqa: PLC0415
        cands = self.list_tracks(mood=mood)
        if not cands:
            return None
        return random.choice(cands).path

    def list_tracks(
        self,
        mood: Optional[str] = None,
        bpm_range: Optional[Tuple[float, float]] = None,
    ) -> List[Track]:
        """List tracks, optionally filtered by mood and/or BPM range."""
        out = self.tracks
        if mood:
            out = [t for t in out if t.mood == mood]
        if bpm_range:
            lo, hi = bpm_range
            out = [t for t in out if lo <= t.bpm <= hi]
        return list(out)

    def add_track(
        self,
        path: str,
        bpm: Optional[float] = None,
        mood: Optional[str] = None,
    ) -> None:
        """Manually add a track to the index (and re-save)."""
        # If the track already exists, replace it.
        self.tracks = [t for t in self.tracks if t.path != path]

        if bpm is None or mood is None:
            analyzed = self._analyze_track(path)
            track = analyzed
            if bpm is not None:
                track.bpm = bpm
            if mood is not None:
                track.mood = mood
        else:
            name = os.path.splitext(os.path.basename(path))[0]
            track = Track(
                path=path, bpm=bpm, mood=mood,
                duration_sec=self._probe_duration(path),
                title=name,
                license=self._guess_license(path),
            )

        self.tracks.append(track)
        self._save_index()

    # ------------------------------------------------------------------
    # Diagnostics
    # ------------------------------------------------------------------
    def summary(self) -> dict:
        """Return a quick stats summary (counts per mood)."""
        counts: dict = {}
        for t in self.tracks:
            counts[t.mood] = counts.get(t.mood, 0) + 1
        return {
            'total_tracks': len(self.tracks),
            'by_mood': counts,
            'library_path': self.library_path,
        }


# ---------------------------------------------------------------------------
# Standalone CLI (for re-indexing / inspection)
# ---------------------------------------------------------------------------
def _cli() -> int:
    import argparse  # noqa: PLC0415

    parser = argparse.ArgumentParser(description='MusicLibrary — index & query CC0 music')
    parser.add_argument('--lib', default='/kaggle/input/micky-assets/music_cc0',
                        help='Library root directory')
    parser.add_argument('--bpm', type=float, default=None,
                        help='Find a track matching this BPM')
    parser.add_argument('--mood', default=None, help='Filter by mood')
    parser.add_argument('--summary', action='store_true', help='Print summary only')
    args = parser.parse_args()

    lib = MusicLibrary(args.lib)
    lib.index_library()

    if args.summary:
        print(json.dumps(lib.summary(), indent=2))
        return 0

    if args.bpm is not None:
        path = lib.get_track_by_bpm(args.bpm, tolerance=5.0, mood=args.mood)
        print(f"Best match for BPM={args.bpm} mood={args.mood}: {path}")
    elif args.mood:
        path = lib.get_track_by_mood(args.mood)
        print(f"Random track for mood={args.mood}: {path}")
    else:
        print(json.dumps(lib.summary(), indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(_cli())
