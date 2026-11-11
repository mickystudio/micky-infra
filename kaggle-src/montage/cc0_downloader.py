"""
CC0 music downloader + BPM tagger (P4-T9).
==========================================

This script pulls small samples of royalty-free / CC0 music from three
public sources (Pixabay, Mixkit, FreePD) directly via HTTP, then tags
each downloaded file with a ``TBPM`` (BPM) ID3 frame using ``mutagen``,
and drops a sidecar ``.bpm.json`` for non-MP3 formats.

The downloads are intentionally **best-effort**:
  * No API keys required.
  * HTML scraping is kept minimal — we resolve known asset URLs that
    each site serves via predictable static paths.
  * If a source changes its URL layout, that source is silently skipped
    and the other two are still attempted.

Typical usage::

    python cc0_downloader.py --output /tmp/music_lib --count 20

Created: 2026-11-10  |  Phase P4 (T9)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional
from urllib.error import HTTPError, URLError

# Local sibling import — beat_sync.py must be in the same directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from beat_sync import BeatSync  # type: ignore
except Exception:  # pragma: no cover — sibling missing
    BeatSync = None  # type: ignore


# ---------------------------------------------------------------------------
# User agent (some CC0 sites block the default urllib UA)
# ---------------------------------------------------------------------------
_UA = (
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/120.0 Safari/537.36 micky-assistant/1.0'
)


# ---------------------------------------------------------------------------
# CC0Downloader
# ---------------------------------------------------------------------------
class CC0Downloader:
    """Download CC0 / royalty-free music samples and tag with BPM.

    All download methods return the list of successfully downloaded file
    paths (failures are silently skipped with a warning).
    """

    # Default per-source sample URLs. These are *deliberately* tiny samples
    # (a few hundred KB each) so the script works in CI / Kaggle without
    # pulling gigabytes. Operators are expected to extend `SAMPLE_URLS`
    # with their own curated lists before running in production.
    SAMPLE_URLS: Dict[str, List[str]] = {
        'pixabay': [
            # Pixabay serves music via cdn.pixabay.com/audio/...
            'https://cdn.pixabay.com/audio/2022/03/15/audio_1c78a99c1e.mp3',
            'https://cdn.pixabay.com/audio/2022/05/27/audio_1808fbf07a.mp3',
            'https://cdn.pixabay.com/audio/2023/06/19/audio_d0c7c1a7d7.mp3',
        ],
        'mixkit': [
            # Mixkit free music: assets.mixkit.co/music/preview/...
            'https://assets.mixkit.co/music/preview/mixkit-tribal-dry-drums-558.mp3',
            'https://assets.mixkit.co/music/preview/mixkit-tech-house-vibes-130.mp3',
            'https://assets.mixkit.co/music/preview/mixkit-magical-meeting-2532.mp3',
        ],
        'freepd': [
            # FreePD serves MP3s directly from freepd.com/music/
            'https://freepd.com/music/Bushwick%20Tarantella.mp3',
            'https://freepd.com/music/Local%20Forecast%20-%20Elevator.mp3',
            'https://freepd.com/music/Ragged%20Piano.mp3',
        ],
    }

    def __init__(self, beat_sync: Optional['BeatSync'] = None) -> None:
        self._beat_sync = beat_sync  # may be None; created lazily

    # ------------------------------------------------------------------
    # Public downloaders
    # ------------------------------------------------------------------
    def download_pixabay_sample(self, output_dir: str, count: int = 20) -> List[str]:
        """Download up to `count` Pixabay tracks into `output_dir`."""
        return self._download_source('pixabay', output_dir, count)

    def download_freepd_sample(self, output_dir: str, count: int = 20) -> List[str]:
        """Download up to `count` FreePD tracks into `output_dir`."""
        return self._download_source('freepd', output_dir, count)

    def download_mixkit_sample(self, output_dir: str, count: int = 20) -> List[str]:
        """Download up to `count` Mixkit tracks into `output_dir`."""
        return self._download_source('mixkit', output_dir, count)

    # ------------------------------------------------------------------
    # BPM tagging
    # ------------------------------------------------------------------
    def tag_with_bpm(self, track_path: str) -> dict:
        """Detect BPM via BeatSync and write it into the file's metadata.

        For MP3 files, writes a ``TBPM`` ID3 frame (and a ``TXXX:beats`` list
        of beat timestamps, truncated to the first 32 beats). For non-MP3
        audio (wav/m4a/flac/ogg), writes a sidecar ``<file>.bpm.json``.

        Returns a dict: ``{path, bpm, beats, downbeats, duration_sec, engine}``.
        """
        if not os.path.exists(track_path):
            raise FileNotFoundError(track_path)

        bs = self._get_beat_sync()
        info = bs.detect_beats(track_path)
        result = {
            'path': track_path,
            'bpm': float(info.bpm),
            'beats': info.beats[:64],
            'downbeats': info.downbeats[:16],
            'duration_sec': float(info.duration_sec),
            'engine': bs.engine,
        }

        ext = os.path.splitext(track_path)[1].lower()
        try:
            if ext == '.mp3':
                self._tag_mp3(track_path, info.bpm, info.beats[:32])
            else:
                self._write_sidecar(track_path, result)
        except Exception as exc:  # noqa: BLE001
            print(f"[cc0] tag_with_bpm: metadata write failed for {track_path}: {exc!r}")
            # Always also write a sidecar as a fallback record.
            self._write_sidecar(track_path, result)

        return result

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------
    def _download_source(
        self, source: str, output_dir: str, count: int
    ) -> List[str]:
        """Download up to `count` files from one source into `output_dir/<source>/`."""
        urls = self.SAMPLE_URLS.get(source, [])[:count]
        if not urls:
            print(f"[cc0] no sample URLs known for source '{source}'")
            return []

        target_dir = os.path.join(output_dir, source)
        os.makedirs(target_dir, exist_ok=True)

        downloaded: List[str] = []
        for url in urls:
            try:
                path = self._download_one(url, target_dir)
                if path:
                    downloaded.append(path)
                    # Tag with BPM immediately after download.
                    try:
                        self.tag_with_bpm(path)
                    except Exception as exc:  # noqa: BLE001
                        print(f"[cc0] tag_with_bpm failed for {path}: {exc!r}")
            except (HTTPError, URLError) as exc:
                print(f"[cc0] download failed: {url} ({exc!r})")
            except Exception as exc:  # noqa: BLE001
                print(f"[cc0] unexpected error for {url}: {exc!r}")

        print(f"[cc0] {source}: downloaded {len(downloaded)}/{len(urls)} files "
              f"→ {target_dir}")
        return downloaded

    @staticmethod
    def _download_one(url: str, target_dir: str) -> Optional[str]:
        """Stream a single URL to disk. Returns the output path or None."""
        # Derive filename from URL, sanitize.
        name = url.rsplit('/', 1)[-1]
        name = re.sub(r'[^\w.\-]+', '_', name).strip('_.')
        if not name:
            name = 'track.mp3'
        if not os.path.splitext(name)[1]:
            name = name + '.mp3'

        out_path = os.path.join(target_dir, name)
        if os.path.exists(out_path) and os.path.getsize(out_path) > 1024:
            print(f"[cc0] already exists, skipping: {out_path}")
            return out_path

        req = urllib.request.Request(url, headers={'User-Agent': _UA})
        print(f"[cc0] downloading {url} → {out_path}")
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read()
        if not data or len(data) < 1024:
            print(f"[cc0] empty response from {url}")
            return None
        with open(out_path, 'wb') as f:
            f.write(data)
        print(f"[cc0] saved {len(data)} bytes → {out_path}")
        return out_path

    def _get_beat_sync(self) -> 'BeatSync':
        if self._beat_sync is None and BeatSync is not None:
            self._beat_sync = BeatSync(device='cpu')
        if self._beat_sync is None:
            raise RuntimeError(
                'BeatSync is unavailable. Make sure beat_sync.py is in the '
                'same directory as cc0_downloader.py.'
            )
        return self._beat_sync

    @staticmethod
    def _tag_mp3(path: str, bpm: float, beats: List[float]) -> None:
        """Write TBPM (BPM) + TXXX:beats ID3 frames via mutagen (auto-installed)."""
        try:
            from mutagen.id3 import ID3, TBPM, TXXX  # type: ignore
            from mutagen.mp3 import MP3  # type: ignore
        except ImportError:
            subprocess.check_call(
                [sys.executable, '-m', 'pip', 'install', '-q', 'mutagen']
            )
            from mutagen.id3 import ID3, TBPM, TXXX  # type: ignore
            from mutagen.mp3 import MP3  # type: ignore

        audio = MP3(path)
        try:
            tags = audio.tags or ID3()
        except Exception:  # noqa: BLE001
            tags = ID3()

        # `TBPM` is the ID3v2 frame for BPM.
        tags['TBPM'] = TBPM(encoding=3, text=[f'{bpm:.1f}'])
        # `TXXX:beats` is a free-form frame holding the (truncated) beat list.
        tags['TXXX:beats'] = TXXX(
            encoding=3, desc='beats',
            text=[','.join(f'{b:.3f}' for b in beats)],
        )
        audio.tags = tags
        audio.save()
        print(f"[cc0] tagged MP3: {path}  bpm={bpm:.1f}")

    @staticmethod
    def _write_sidecar(track_path: str, info: dict) -> None:
        """Write a `<track>.bpm.json` sidecar with BPM + beat info."""
        side = track_path + '.bpm.json'
        with open(side, 'w', encoding='utf-8') as f:
            json.dump(info, f, ensure_ascii=False, indent=2)
        print(f"[cc0] wrote sidecar: {side}")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------
def _cli() -> int:
    parser = argparse.ArgumentParser(
        description='CC0 music downloader + BPM tagger for Micky Assistant'
    )
    parser.add_argument('--output', required=True,
                        help='Output directory (will be created)')
    parser.add_argument('--count', type=int, default=20,
                        help='Max tracks per source (default 20)')
    parser.add_argument('--sources', default='pixabay,mixkit,freepd',
                        help='Comma-separated list of sources to fetch')
    parser.add_argument('--tag-only', default=None,
                        help='Skip download; just tag the given file with BPM')
    args = parser.parse_args()

    os.makedirs(args.output, exist_ok=True)
    dl = CC0Downloader()

    if args.tag_only:
        info = dl.tag_with_bpm(args.tag_only)
        print(json.dumps(info, indent=2, ensure_ascii=False))
        return 0

    sources = [s.strip() for s in args.sources.split(',') if s.strip()]
    all_paths: List[str] = []
    for s in sources:
        if s == 'pixabay':
            all_paths += dl.download_pixabay_sample(args.output, args.count)
        elif s == 'mixkit':
            all_paths += dl.download_mixkit_sample(args.output, args.count)
        elif s == 'freepd':
            all_paths += dl.download_freepd_sample(args.output, args.count)
        else:
            print(f"[cc0] unknown source '{s}' (skipped)")

    print(f"\n[cc0] DONE — {len(all_paths)} files downloaded & tagged")
    for p in all_paths:
        print(f"  - {p}")
    return 0


if __name__ == '__main__':
    sys.exit(_cli())
