"""
Silence trimmer (Layer 2 of the v2 take-selector pipeline).
=================================================

Wraps the `auto-editor` CLI behind a typed facade. Three responsibilities:

    1. `trim_silence`     – cut silence out of a video, return new path.
    2. `export_edl`       – export NLE EDL/XML for DaVinci Resolve, Premiere,
                            FCPX, Shotcut, Kdenlive. CMX 3600 EDL is emitted
                            locally (auto-editor 29.x dropped native support).
    3. `analyze_silence`  – list silence regions with their average dBFS.

The auto-editor dependency is auto-installed on first run via
`pip install auto-editor` inside a `try/except ImportError` block.

Created: 2026-11-10  (Phase P4-T2 upgrade — Agent B1)
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import List, Optional

# ---------------------------------------------------------------------------
# Dataclass — re-imported by take_selector_v2.py
# ---------------------------------------------------------------------------
@dataclass
class SilenceSegment:
    """A contiguous silent region inside the input video."""
    start_sec: float
    end_sec: float
    duration_sec: float
    avg_db: float = -60.0  # dBFS (quiet end of the scale)

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# auto-editor NLE export targets (auto-editor 29.x)
#   resolve / final-cut-pro  → .fcpxml
#   premiere                 → .xml
#   shotcut                  → .mlt
#   kdenlive                 → .kdenlive
#   edl (CMX 3600)           → emitted locally (auto-editor dropped support)
# ---------------------------------------------------------------------------
NLE_EXPORTS: dict[str, tuple[str, str]] = {
    'resolve':       ('resolve',       '.fcpxml'),
    'premiere':      ('premiere',      '.xml'),
    'final-cut-pro': ('final-cut-pro', '.fcpxml'),
    'shotcut':       ('shotcut',       '.mlt'),
    'kdenlive':      ('kdenlive',      '.kdenlive'),
    'edl':           ('__local__',     '.edl'),
}


# ---------------------------------------------------------------------------
# Lazy import helper
# ---------------------------------------------------------------------------
def _ensure_auto_editor() -> str:
    """Return the path to the auto-editor binary (auto-installs on first run)."""
    try:
        import auto_editor  # type: ignore  # noqa: F401
        path = shutil.which('auto-editor')
        if path:
            return path
        return f'{sys.executable} -m auto_editor'
    except ImportError:
        print('[silence_trimmer] Installing auto-editor (one-time)…')
        subprocess.run(
            [sys.executable, '-m', 'pip', 'install', '-q', 'auto-editor'],
            check=True,
        )
        import auto_editor  # type: ignore  # noqa: F401
        return shutil.which('auto-editor') or f'{sys.executable} -m auto_editor'


def _split_cmd(impl: str) -> list[str]:
    """Turn a possibly-space-separated impl ('python -m auto_editor') into argv."""
    return impl.split(' ') if ' ' in impl else [impl]


# ---------------------------------------------------------------------------
# SilenceTrimmer
# ---------------------------------------------------------------------------
class SilenceTrimmer:
    """
    auto-editor facade.

    Typical use::

        st = SilenceTrimmer(threshold_db=-12.0, margin_sec=0.2)
        trimmed_path = st.trim_silence('raw.mp4')
        edl_path     = st.export_edl('raw.mp4', 'resolve')
        silences     = st.analyze_silence('raw.mp4')
    """

    def __init__(
        self,
        threshold_db: float = -12.0,
        margin_sec: float = 0.2,
    ) -> None:
        self.threshold_db = float(threshold_db)
        self.margin_sec = float(margin_sec)

    # ------------------------------------------------------------------
    # 1. trim_silence
    # ------------------------------------------------------------------
    def trim_silence(
        self,
        video_path: str,
        output_path: Optional[str] = None,
    ) -> str:
        """Cut silent sections from `video_path` using auto-editor.

        Args:
            video_path:  Source video path.
            output_path: Optional explicit output. If None, uses
                `{stem}_trimmed{ext}`.

        Returns:
            Path to the trimmed output file.
        """
        if output_path is None:
            p = Path(video_path)
            output_path = str(p.parent / f'{p.stem}_trimmed{p.suffix}')
        cmd = _split_cmd(_ensure_auto_editor()) + [
            video_path,
            '--edit', f'audio:{self.threshold_db}dB',
            '--margin', f'{self.margin_sec}sec',
            '-o', output_path, '--no-open', '-q',
        ]
        print(f'[silence_trimmer] Running: {" ".join(cmd)}')
        r = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if r.returncode != 0 or not os.path.exists(output_path):
            # auto-editor refuses to write if there's nothing to cut
            # ("Timeline is empty"). Fall back to copying the input.
            if 'Timeline is empty' in (r.stderr or r.stdout or ''):
                print('[silence_trimmer] No silence detected — copying input.')
                shutil.copy2(video_path, output_path)
                return output_path
            raise RuntimeError(
                f'auto-editor failed (exit {r.returncode}):\n'
                f'stderr: {(r.stderr or "")[-1200:]}\n'
                f'stdout: {(r.stdout or "")[-600:]}'
            )
        return output_path

    # ------------------------------------------------------------------
    # 2. export_edl
    # ------------------------------------------------------------------
    def export_edl(
        self,
        video_path: str,
        output_format: str = 'resolve',
    ) -> str:
        """Export an NLE-compatible EDL/XML for `video_path`.

        Supported `output_format`: 'resolve', 'premiere', 'final-cut-pro',
        'shotcut', 'kdenlive', 'edl' (CMX 3600 — emitted locally).

        Returns:
            Path to the generated EDL/XML file.
        """
        fmt = output_format.lower().strip()
        if fmt not in NLE_EXPORTS:
            raise ValueError(
                f'Unsupported output_format: {output_format!r}. '
                f'Supported: {sorted(NLE_EXPORTS)}'
            )
        ae_target, ext = NLE_EXPORTS[fmt]
        out_path = str(Path(video_path).with_suffix(ext))
        if ae_target == '__local__':
            return self._emit_cmx_edl(video_path, out_path)
        cmd = _split_cmd(_ensure_auto_editor()) + [
            video_path,
            '--edit', f'audio:{self.threshold_db}dB',
            '--margin', f'{self.margin_sec}sec',
            '--export', ae_target,
            '-o', out_path, '--no-open', '-q',
        ]
        print(f'[silence_trimmer] Running: {" ".join(cmd)}')
        r = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if r.returncode != 0 or not os.path.exists(out_path):
            # auto-editor sometimes names the output differently — search
            # the same directory for the most recent matching ext.
            fallback = self._find_recent_ext(video_path, ext)
            if fallback:
                return fallback
            raise RuntimeError(
                f'auto-editor EDL export failed (exit {r.returncode}):\n'
                f'stderr: {(r.stderr or "")[-1200:]}\n'
                f'stdout: {(r.stdout or "")[-600:]}'
            )
        return out_path

    # ------------------------------------------------------------------
    # 3. analyze_silence
    # ------------------------------------------------------------------
    def analyze_silence(self, video_path: str) -> List[SilenceSegment]:
        """Detect silent regions inside `video_path`.

        Uses ffmpeg's `silencedetect` filter (more reliable than parsing
        auto-editor's `--preview` text output across versions) and computes
        the average dBFS inside each silent window via `astats`.

        Returns:
            List of `SilenceSegment(start, end, duration, avg_db)`.
        """
        cmd = [
            'ffmpeg', '-hide_banner', '-nostats',
            '-i', video_path,
            '-af', f'silencedetect=noise={self.threshold_db}dB:d=0.25',
            '-f', 'null', '-',
        ]
        r = subprocess.run(cmd, capture_output=True, text=True, check=False)
        log = r.stderr or ''
        start_re = re.compile(r'silence_start:\s*([\-\d.]+)')
        end_re = re.compile(
            r'silence_end:\s*([\-\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)'
        )
        regions: List[SilenceSegment] = []
        cur_start: Optional[float] = None
        for line in log.splitlines():
            m = start_re.search(line)
            if m:
                cur_start = float(m.group(1))
                continue
            m = end_re.search(line)
            if m and cur_start is not None:
                end = float(m.group(1))
                dur = float(m.group(2)) if m.lastindex and m.lastindex >= 2 else (end - cur_start)
                regions.append(SilenceSegment(
                    start_sec=cur_start,
                    end_sec=end,
                    duration_sec=dur,
                    avg_db=self._avg_db_for_window(video_path, cur_start, end),
                ))
                cur_start = None
        return regions

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _find_recent_ext(video_path: str, ext: str) -> Optional[str]:
        """Find the most recent file with `ext` in the video's dir."""
        d = Path(video_path).parent
        if not d.is_dir():
            return None
        cands = sorted(
            d.glob(f'*{ext}'),
            key=lambda p: p.stat().st_mtime if p.exists() else 0,
            reverse=True,
        )
        return str(cands[0]) if cands else None

    def _avg_db_for_window(
        self, video_path: str, start: float, end: float,
    ) -> float:
        """Compute mean dBFS of the audio track inside [start, end]."""
        if end <= start:
            return -60.0
        try:
            cmd = [
                'ffmpeg', '-hide_banner', '-nostats',
                '-ss', f'{start:.3f}', '-to', f'{end:.3f}',
                '-i', video_path,
                '-af', ('astats=metadata=1:reset=0,'
                        'ametadata=print:key=lavfi.astats.Overall.RMS_level'),
                '-f', 'null', '-',
            ]
            r = subprocess.run(cmd, capture_output=True, text=True, check=False)
            log = (r.stderr or '') + (r.stdout or '')
            m = re.search(r'RMS_level[:=]\s*([\-\d.]+)', log)
            if m:
                v = float(m.group(1))
                if v == float('-inf') or v != v:  # -inf or NaN
                    return -60.0
                return round(v, 2)
        except Exception:
            pass
        return -60.0

    def _emit_cmx_edl(self, video_path: str, out_path: str) -> str:
        """Generate a minimal but valid CMX 3600 EDL file.

        Each non-silent clip becomes one event with source/record
        in/out timecodes (HH:MM:SS:FF at 30 fps).
        """
        silences = self.analyze_silence(video_path)
        total_dur = self._probe_duration(video_path)
        loud: list[tuple[float, float]] = []
        cursor = 0.0
        for s in silences:
            if s.start_sec > cursor:
                loud.append((cursor, s.start_sec))
            cursor = max(cursor, s.end_sec)
        if cursor < total_dur:
            loud.append((cursor, total_dur))
        if not loud:
            loud = [(0.0, total_dur)]

        def tc(t: float) -> str:
            tf = int(round(t * 30.0))
            h, rem = divmod(tf, 3600 * 30)
            m, rem = divmod(rem, 60 * 30)
            sec, fr = divmod(rem, 30)
            return f'{h:02d}:{m:02d}:{sec:02d}:{fr:02d}'

        clip_name = Path(video_path).stem.upper()[:7] or 'AX'
        lines = ['TITLE: MICKY_AUTO_EDIT', 'FCM: NON-DROP FRAME']
        for idx, (s, e) in enumerate(loud, start=1):
            lines.append(
                f'{idx:03d}  AX       V     C        '
                f'{tc(s)} {tc(e)} {tc(s)} {tc(e)}'
            )
            lines.append(f'FROM CLIP NAME: {clip_name}')
        Path(out_path).write_text('\n'.join(lines) + '\n', encoding='ascii')
        print(f'[silence_trimmer] Wrote CMX 3600 EDL → {out_path}')
        return out_path

    @staticmethod
    def _probe_duration(video_path: str) -> float:
        try:
            r = subprocess.run(
                ['ffprobe', '-v', 'error',
                 '-show_entries', 'format=duration',
                 '-of', 'default=noprint_wrappers=1:nokey=1',
                 video_path],
                capture_output=True, text=True, check=True,
            )
            return float(r.stdout.strip() or 0.0)
        except Exception:
            return 0.0


# ---------------------------------------------------------------------------
# CLI (for debugging)
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: silence_trimmer.py <video> [trim|analyze|edl:<fmt>]')
        sys.exit(1)
    vid = sys.argv[1]
    action = sys.argv[2] if len(sys.argv) > 2 else 'analyze'
    st = SilenceTrimmer()
    if action == 'trim':
        print(f'trimmed → {st.trim_silence(vid)}')
    elif action == 'analyze':
        segs = st.analyze_silence(vid)
        print(f'{len(segs)} silence regions:')
        for s in segs:
            print(f'  {s.start_sec:6.2f} → {s.end_sec:6.2f}'
                  f'  dur={s.duration_sec:5.2f}s  avg_db={s.avg_db}')
    elif action.startswith('edl:'):
        fmt = action.split(':', 1)[1]
        print(f'edl ({fmt}) → {st.export_edl(vid, fmt)}')
    else:
        print(f'Unknown action: {action}')
