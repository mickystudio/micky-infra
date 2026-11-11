"""
LUT downloader (B6-T5).
======================
Downloads free 3D-LUT packs and organises them into the
`/kaggle/input/micky-assets/luts/` library so the rest of the B6 pipeline
can find them by mood.

Sources (all free-of-charge for personal/commercial use — verify the
license of each individual LUT before redistributing):
    - Color Grading Central "Cinematic LUTs" preview pack (100-pack)
    - IWLTBAP "LUTs" free pack (32-pack)

Run as a script:
    python luts_downloader.py --output /kaggle/input/micky-assets/luts --organize

Created: 2026-11-10  |  Task B6
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
import urllib.request
from typing import Iterable


# Mood → canonical LUT filename (kept in sync with mood_detector.MOOD_TO_LUT)
MOOD_TO_LUT_FILE: dict[str, str] = {
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

# Heuristic keyword → mood mapping used by `organize_by_mood` to classify
# arbitrary downloaded LUTs into the canonical mood buckets.
KEYWORD_TO_MOOD: dict[str, str] = {
    'teal': 'warm', 'orange': 'warm', 'warm': 'warm', 'summer': 'warm', 'sunset': 'warm',
    'cool': 'cool', 'cold': 'cool', 'winter': 'cool', 'blue': 'cool', 'bleach': 'cool',
    'vintage': 'vintage', 'film': 'vintage', 'kodak': 'vintage', 'retro': 'vintage',
    'cinematic': 'cinematic', 'movie': 'cinematic', 'hollywood': 'cinematic',
    'noir': 'noir', 'b&w': 'noir', 'bw': 'noir', 'mono': 'noir',
    'vibrant': 'vibrant', 'pop': 'vibrant', 'punch': 'energetic', 'saturat': 'vibrant',
    'muted': 'muted', 'faded': 'muted', 'matte': 'muted',
    'dramatic': 'dramatic', 'contrast': 'dramatic', 'dark': 'dramatic',
    'peaceful': 'peaceful', 'pastel': 'peaceful', 'soft': 'peaceful',
    'energetic': 'energetic', 'bright': 'energetic',
}


class LUTDownloader:
    """Download and organise free LUT packs into the micky-assets library."""

    # These URLs are best-effort; if a pack moves, the function returns 0
    # and prints a warning rather than crashing.
    CGC_100_URL = 'https://groundcontrolcolor.com/products/free-cinematic-luts'
    IWLTBAP_URL = 'https://iwltbap.com/luts-pack/'

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def download_cgc_100(self, output_dir: str) -> int:
        """Download Color Grading Central's free 100-pack of cinematic LUTs.

        Args:
            output_dir: Where to drop the .cube files.

        Returns:
            Number of valid .cube files written (0 if download failed).
        """
        os.makedirs(output_dir, exist_ok=True)
        print(f'[luts] CGC 100-pack → {output_dir}')
        # CGC distributes via a direct zip; the exact URL rotates. We try
        # the well-known mirror first and fall back to a no-op.
        candidates = [
            'https://cdn.groundcontrolcolor.com/free_luts/FreeLUTs.zip',
        ]
        n = self._download_zip_and_extract(candidates, output_dir, label='CGC')
        if n == 0:
            print(f'[luts] WARNING: CGC download failed. '
                  f'Visit {self.CGC_100_URL} manually.')
        return n

    def download_iwltbap_free(self, output_dir: str) -> int:
        """Download IWLTBAP's free 32-LUT pack.

        Args:
            output_dir: Where to drop the .cube files.

        Returns:
            Number of valid .cube files written (0 if download failed).
        """
        os.makedirs(output_dir, exist_ok=True)
        print(f'[luts] IWLTBAP free pack → {output_dir}')
        candidates = [
            'https://iwltbap.com/wp-content/uploads/2019/11/IWLTBAP_LUTS.zip',
        ]
        n = self._download_zip_and_extract(candidates, output_dir, label='IWLTBAP')
        if n == 0:
            print(f'[luts] WARNING: IWLTBAP download failed. '
                  f'Visit {self.IWLTBAP_URL} manually.')
        return n

    # ------------------------------------------------------------------
    # Organisation
    # ------------------------------------------------------------------
    def organize_by_mood(self, luts_dir: str) -> None:
        """Sort every .cube in `luts_dir` into mood subdirectories.

        Uses heuristic keyword matching on the LUT file name. Files whose
        name does not match any keyword are placed under `_unsorted/`.

        Args:
            luts_dir: Directory containing flat .cube files.

        Side effect:
            Creates subdirs named `warm/`, `cool/`, `vintage/`, ... and
            moves the .cube files into them. Existing files are not
            overwritten (a numeric suffix is appended on conflict).
        """
        if not os.path.isdir(luts_dir):
            print(f'[luts] luts_dir not found: {luts_dir}')
            return

        # Build mood buckets
        buckets: dict[str, list[str]] = {m: [] for m in MOOD_TO_LUT_FILE}
        buckets['_unsorted'] = []

        for f in sorted(os.listdir(luts_dir)):
            full = os.path.join(luts_dir, f)
            if not os.path.isfile(full) or not f.lower().endswith('.cube'):
                continue
            if not self.validate_lut(full):
                continue
            mood = self._classify_lut(f)
            buckets[mood].append(full)

        for mood, files in buckets.items():
            mood_dir = os.path.join(luts_dir, mood)
            os.makedirs(mood_dir, exist_ok=True)
            for f in files:
                dst = os.path.join(mood_dir, os.path.basename(f))
                if os.path.exists(dst):
                    stem, ext = os.path.splitext(os.path.basename(f))
                    dst = os.path.join(mood_dir, f'{stem}_1{ext}')
                shutil.move(f, dst)
            if files:
                print(f'[luts] {mood:12s} ← {len(files)} LUTs')

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------
    @staticmethod
    def validate_lut(lut_path: str) -> bool:
        """Return True iff `lut_path` is a valid 3D .cube file.

        Checks performed (cheap, doesn't fully parse):
            - File exists and ends with .cube
            - Has a `LUT_3D_SIZE N` header (1 ≤ N ≤ 65)
            - Has at least N³ RGB triples
        """
        if not lut_path.lower().endswith('.cube'):
            return False
        if not os.path.exists(lut_path):
            return False
        try:
            with open(lut_path, 'r', encoding='utf-8', errors='ignore') as f:
                size: int | None = None
                triple_count = 0
                for line in f:
                    line = line.strip()
                    if not line or line.startswith('#') or line.startswith('"'):
                        continue
                    if line.upper().startswith('LUT_3D_SIZE'):
                        try:
                            size = int(line.split()[1])
                            if size is None or not (1 <= size <= 65):
                                return False
                        except (IndexError, ValueError):
                            return False
                        continue
                    if line.upper().startswith(('TITLE', 'DOMAIN_MIN',
                                                 'DOMAIN_MAX', 'LUT_1D_SIZE')):
                        continue
                    parts = line.split()
                    if len(parts) >= 3:
                        try:
                            float(parts[0]); float(parts[1]); float(parts[2])
                            triple_count += 1
                        except ValueError:
                            continue
                if size is None:
                    return False
                return triple_count >= size ** 3
        except OSError:
            return False

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _classify_lut(filename: str) -> str:
        """Return the mood bucket name for a LUT file based on its name."""
        name = filename.lower()
        for kw, mood in KEYWORD_TO_MOOD.items():
            if kw in name:
                return mood
        return '_unsorted'

    @staticmethod
    def _download_zip_and_extract(
        urls: Iterable[str], output_dir: str, label: str,
    ) -> int:
        """Try each URL in order; extract the first zip that downloads OK.

        Returns the number of valid .cube files now present in `output_dir`.
        """
        import zipfile

        for url in urls:
            zip_path = os.path.join(output_dir, f'_{label.lower()}.zip')
            try:
                print(f'[luts] Downloading {url}')
                urllib.request.urlretrieve(url, zip_path)
            except Exception as e:
                print(f'[luts]   ✗ {e}')
                if os.path.exists(zip_path):
                    os.remove(zip_path)
                continue
            try:
                with zipfile.ZipFile(zip_path) as zf:
                    zf.extractall(output_dir)
                os.remove(zip_path)
                break
            except zipfile.BadZipFile as e:
                print(f'[luts]   ✗ Bad zip: {e}')
                if os.path.exists(zip_path):
                    os.remove(zip_path)
                continue
        else:
            return 0

        # Count valid .cube files now present
        count = 0
        for root, _dirs, files in os.walk(output_dir):
            for f in files:
                if f.lower().endswith('.cube'):
                    full = os.path.join(root, f)
                    if LUTDownloader.validate_lut(full):
                        count += 1
        print(f'[luts]   ✓ {count} valid .cube files in {output_dir}')
        return count


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description='Download free LUT packs and organise by mood.'
    )
    p.add_argument('--output', required=True,
                   help='Output directory for .cube files')
    p.add_argument('--cgc', action='store_true',
                   help='Download Color Grading Central 100-pack')
    p.add_argument('--iwltbap', action='store_true',
                   help='Download IWLTBAP free pack')
    p.add_argument('--organize', action='store_true',
                   help='After download, organise .cube files into mood subdirs')
    p.add_argument('--all', action='store_true',
                   help='Download all known packs + organise')
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    os.makedirs(args.output, exist_ok=True)
    dl = LUTDownloader()

    total = 0
    if args.all or args.cgc:
        total += dl.download_cgc_100(args.output)
    if args.all or args.iwltbap:
        total += dl.download_iwltbap_free(args.output)

    if args.organize or args.all:
        dl.organize_by_mood(args.output)

    if total == 0 and not (args.organize or args.all):
        print('[luts] No download flags set — nothing to do. '
              'Use --cgc, --iwltbap, --all, or --organize.')
    print(f'[luts] Done. Total valid LUTs: {total}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
