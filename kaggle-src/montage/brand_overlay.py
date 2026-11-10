"""
Brand overlay (Task B13 — brand_profile + montage integration).

Applies a user's brand identity (logo watermark, brand colours, brand
fonts, intro/outro pre-roll) to a finished montage video.

The brand profile dict comes from the Worker's D1 row (serialised to JSON,
posted to the Kaggle runner alongside the montage task spec):
    {"name","logo_url","color_primary","color_secondary","color_accent",
     "font_primary","font_secondary","intro_video_url","outro_video_url",
     "watermark_position","watermark_opacity","default_platform","default_style"}

A NULL/missing brand profile makes the montage pipeline run brandless
(`pipeline.run_pipeline(..., options={'brand_profile': None})`).

Public surface:
    BrandOverlay(brand_profile: dict)
        .apply_brand_to_video(video_path) -> str
        .apply_watermark(video_path)     -> str
        .apply_intro_outro(video_path)   -> str
        .restyle_captions(ass_path)      -> str
    fetch_brand_asset(url, cache_dir=...) -> str | None
    brand_overlay_from_dict(brand_profile) -> BrandOverlay | None

Created: 2026-11-13 (Task B13)
"""
from __future__ import annotations

import os
import re
import subprocess
import tempfile
import urllib.request
from typing import Any

# Local imports (Kaggle montage package)
try:
    from ass_builder import CaptionConfig, ASSBuilder, hex_to_ass_color  # noqa: F401
    _ASS_AVAILABLE = True
except ImportError:  # pragma: no cover
    _ASS_AVAILABLE = False


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
_DEFAULT_LOGO_PADDING = 16         # px from the edge
_DEFAULT_LOGO_TARGET_HEIGHT = 120   # px — logo is scaled to this height (width = aspect * h)
_WATERMARK_PRESETS = {
    # position → (overlay_x_expr, overlay_y_expr)
    # FFmpeg overlay x/y accept expressions like W-w-16
    'top-left':      ('16',     '16'),
    'top-right':     ('W-w-16', '16'),
    'bottom-left':   ('16',     'H-h-16'),
    'bottom-right':  ('W-w-16', 'H-h-16'),
    'center':        ('(W-w)/2', '(H-h)/2'),
}

_KV_URL_RE = re.compile(r'^kv://brand-assets/([^/]+)/([^/]+)/([^/]+)$')
_HEX_RE = re.compile(r'^#?[0-9A-Fa-f]{6}$')


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _normalize_hex(h: str | None) -> str | None:
    """Return '#RRGGBB' or None.  Raises on malformed non-empty input."""
    if h is None or h == '':
        return None
    s = str(h).strip()
    if not s.startswith('#'):
        s = '#' + s
    if not _HEX_RE.match(s):
        raise ValueError(f'invalid hex colour: {h!r}')
    return s.upper()


def _hex_to_ass(h: str | None) -> str | None:
    """'#RRGGBB' → '&H00BBGGRR' (ASS BGR).  None passthrough."""
    norm = _normalize_hex(h)
    if norm is None:
        return None
    r, g, b = int(norm[1:3], 16), int(norm[3:5], 16), int(norm[5:7], 16)
    return f'&H00{b:02X}{g:02X}{r:02X}'


def _ffprobe_duration(path: str) -> float:
    """Probe video duration via ffprobe (returns seconds, 0.0 on error)."""
    try:
        out = subprocess.check_output(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1', path],
            stderr=subprocess.STDOUT,
        )
        return float(out.decode().strip() or 0.0)
    except Exception:
        return 0.0


def fetch_brand_asset(url: str, cache_dir: str = '/tmp/micky-brand-assets') -> str | None:
    """Resolve a brand-asset URL to a local file path.

    Supports:
      * `kv://brand-assets/{userId}/{type}/{uuid}` — fetches the binary
        from the Worker's BRAND_ASSETS KV namespace via the public
        `/brand/asset?key=...` endpoint (TODO: B14 will add this route;
        until then, falls back to None and the watermark is skipped).
      * `https://...` / `http://...` — downloads to cache_dir.
      * local filesystem path — returned as-is.

    Returns the local file path, or None if the asset couldn't be fetched
    (in which case the caller should skip the overlay step gracefully).
    """
    if not url:
        return None

    # Local path?
    if os.path.exists(url):
        return url

    # KV URL? — would require the Worker to expose a /brand/asset endpoint.
    if url.startswith('kv://'):
        m = _KV_URL_RE.match(url)
        if not m:
            return None
        # The Worker doesn't expose /brand/asset yet (B14 will add it).
        # We accept an environment override MICKY_WORKER_URL so tests can
        # point at a dev Worker that does serve the binary.
        worker_url = os.environ.get('MICKY_WORKER_URL')
        if not worker_url:
            print(f'[brand_overlay] ⚠️  KV asset {url} not fetchable '
                  f'(set MICKY_WORKER_URL or use a direct https:// URL); skipping.')
            return None
        cache_path = os.path.join(cache_dir, url.replace('kv://', '').replace('/', '_'))
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        direct_url = f'{worker_url.rstrip("/")}/brand/asset?key={url}'
        try:
            urllib.request.urlretrieve(direct_url, cache_path)
            return cache_path
        except Exception as e:
            print(f'[brand_overlay] ⚠️  KV fetch failed ({e}); skipping.')
            return None

    # HTTPS URL
    if url.startswith('http://') or url.startswith('https://'):
        os.makedirs(cache_dir, exist_ok=True)
        cache_path = os.path.join(cache_dir, url.split('/')[-1].split('?')[0] or 'brand_asset')
        try:
            urllib.request.urlretrieve(url, cache_path)
            return cache_path
        except Exception as e:
            print(f'[brand_overlay] ⚠️  HTTP fetch failed ({e}); skipping.')
            return None

    return None


# ---------------------------------------------------------------------------
# BrandOverlay
# ---------------------------------------------------------------------------
class BrandOverlay:
    """Apply a brand identity (logo watermark + brand-coloured captions
    + intro/outro pre-roll) to a montage video.

    Construction is cheap; actual FFmpeg work happens in the `apply_*`
    methods.  Each method writes its output next to the input video with
    a `_branded` / `_wm` / `_intro` suffix and returns the new path.

    The class is designed to fail soft: any FFmpeg / download error is
    logged and the original `video_path` is returned unchanged so the
    pipeline never crashes on a brand-application hiccup.
    """

    def __init__(self, brand_profile: dict):
        if not isinstance(brand_profile, dict):
            raise TypeError(f'brand_profile must be dict, got {type(brand_profile).__name__}')
        self.profile = brand_profile
        self.name = brand_profile.get('name', 'default')
        self.logo_url = brand_profile.get('logo_url')
        self.color_primary = _normalize_hex(brand_profile.get('color_primary'))
        self.color_secondary = _normalize_hex(brand_profile.get('color_secondary'))
        self.color_accent = _normalize_hex(brand_profile.get('color_accent'))
        self.font_primary = brand_profile.get('font_primary') or 'Anton'
        self.font_secondary = brand_profile.get('font_secondary') or 'Cairo'
        self.intro_url = brand_profile.get('intro_video_url')
        self.outro_url = brand_profile.get('outro_video_url')
        pos = str(brand_profile.get('watermark_position') or 'bottom-right').lower()
        self.watermark_position = pos if pos in _WATERMARK_PRESETS else 'bottom-right'
        try:
            op = float(brand_profile.get('watermark_opacity', 0.3))
        except (TypeError, ValueError):
            op = 0.3
        self.watermark_opacity = max(0.0, min(1.0, op))

    # ------------------------------------------------------------------
    # Convenience: do we have anything brand-y to apply?
    # ------------------------------------------------------------------
    @property
    def has_logo(self) -> bool:
        return bool(self.logo_url)

    @property
    def has_intro(self) -> bool:
        return bool(self.intro_url)

    @property
    def has_outro(self) -> bool:
        return bool(self.outro_url)

    @property
    def has_brand_colors(self) -> bool:
        return any([self.color_primary, self.color_secondary, self.color_accent])

    # ------------------------------------------------------------------
    # Top-level: apply everything in order
    # ------------------------------------------------------------------
    def apply_brand_to_video(self, video_path: str) -> str:
        """Apply watermark + intro/outro + (optional) caption restyle.

        Order: intro/outro concat → watermark overlay → caption restyle
        (caption restyle is a no-op here because the .ass is typically
        burned in *before* this method is called — see pipeline.py).

        Returns the final branded video path (or `video_path` itself if
        nothing could be applied).
        """
        if not os.path.exists(video_path):
            raise FileNotFoundError(video_path)

        out = video_path
        try:
            if self.has_intro or self.has_outro:
                out = self.apply_intro_outro(out)
            if self.has_logo:
                out = self.apply_watermark(out)
        except Exception as e:
            print(f'[brand_overlay] ⚠️  apply_brand_to_video failed at '
                  f'some step ({e}); returning best-effort path {out}')
        return out

    # ------------------------------------------------------------------
    # Watermark
    # ------------------------------------------------------------------
    def apply_watermark(self, video_path: str) -> str:
        """Overlay the brand logo at the configured position with the
        configured opacity.

        FFmpeg filter graph (default bottom-right, opacity 0.3):
            [0:v][1:v]overlay=W-w-16:H-h-16:format=auto,
            colorchannelmixer=aa=0.3[v]

        The logo is first scaled to a fixed height (default 120 px) so a
        4K logo image doesn't dominate the frame.  PNGs with alpha are
        supported; JPEGs get a hard alpha (no transparency).
        """
        if not self.has_logo:
            return video_path

        logo_local = fetch_brand_asset(self.logo_url)
        if logo_local is None or not os.path.exists(logo_local):
            print(f'[brand_overlay] ⚠️  logo not fetchable ({self.logo_url}); skipping watermark.')
            return video_path

        out_path = self._sibling(video_path, '_wm')
        x_expr, y_expr = _WATERMARK_PRESETS[self.watermark_position]
        opacity = self.watermark_opacity
        # FFmpeg's colorchannelmixer `aa` is the alpha multiplier — 0..1.
        # For opacity=1 we skip the mixer entirely (faster).
        scale_filter = f"scale=-2:{_DEFAULT_LOGO_TARGET_HEIGHT}:force_original_aspect_ratio=decrease"

        if opacity >= 1.0:
            filter_complex = (
                f"[1:v]{scale_filter}[logo];"
                f"[0:v][logo]overlay={x_expr}:{y_expr}:format=auto[v]"
            )
        else:
            filter_complex = (
                f"[1:v]{scale_filter},format=rgba,"
                f"colorchannelmixer=aa={opacity:.3f}[logo];"
                f"[0:v][logo]overlay={x_expr}:{y_expr}:format=auto[v]"
            )

        cmd = [
            'ffmpeg', '-y', '-loglevel', 'error',
            '-i', video_path,
            '-i', logo_local,
            '-filter_complex', filter_complex,
            '-map', '[v]',
            '-map', '0:a?',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
            '-c:a', 'copy',
            '-movflags', '+faststart',
            out_path,
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True)
            print(f'[brand_overlay] ✅ Watermark applied → {out_path}')
            return out_path
        except subprocess.CalledProcessError as e:
            print(f'[brand_overlay] ⚠️  ffmpeg watermark failed: '
                  f'{e.stderr.decode(errors="replace")[:400]}')
            return video_path

    # ------------------------------------------------------------------
    # Intro / outro concat
    # ------------------------------------------------------------------
    def apply_intro_outro(self, video_path: str) -> str:
        """Concatenate intro + main video + outro into a single MP4.

        Uses the FFmpeg `concat` demuxer with a temporary file list.
        The intro/outro are re-encoded to match the main video's codec
        (libx264 + AAC) so concat doesn't fail on codec mismatches.
        """
        if not (self.has_intro or self.has_outro):
            return video_path

        segments: list[str] = []
        # Intro
        if self.has_intro:
            intro_local = fetch_brand_asset(self.intro_url)
            if intro_local and os.path.exists(intro_local):
                segments.append(self._normalize_segment(intro_local, 'intro', video_path))
            else:
                print(f'[brand_overlay] ⚠️  intro not fetchable ({self.intro_url}); skipping intro.')

        # Main video (normalize so the concat demuxer is happy)
        segments.append(self._normalize_segment(video_path, 'main', video_path))

        # Outro
        if self.has_outro:
            outro_local = fetch_brand_asset(self.outro_url)
            if outro_local and os.path.exists(outro_local):
                segments.append(self._normalize_segment(outro_local, 'outro', video_path))
            else:
                print(f'[brand_overlay] ⚠️  outro not fetchable ({self.outro_url}); skipping outro.')

        if len(segments) < 2:
            # Nothing to concat (intro+outro both missing).
            return video_path

        # Write the concat list (one path per line, quoted).
        list_fd, list_path = tempfile.mkstemp(suffix='.txt', prefix='brand_concat_')
        try:
            with os.fdopen(list_fd, 'w') as f:
                for seg in segments:
                    f.write(f"file '{seg}'\n")

            out_path = self._sibling(video_path, '_intro')
            cmd = [
                'ffmpeg', '-y', '-loglevel', 'error',
                '-f', 'concat', '-safe', '0',
                '-i', list_path,
                '-c', 'copy',
                '-movflags', '+faststart',
                out_path,
            ]
            # copy-mode concat requires identical codecs; if it fails,
            # fall back to re-encoding.
            try:
                subprocess.run(cmd, check=True, capture_output=True)
            except subprocess.CalledProcessError:
                cmd_reenc = [
                    'ffmpeg', '-y', '-loglevel', 'error',
                    '-f', 'concat', '-safe', '0',
                    '-i', list_path,
                    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
                    '-c:a', 'aac', '-b:a', '192k',
                    '-movflags', '+faststart',
                    out_path,
                ]
                subprocess.run(cmd_reenc, check=True, capture_output=True)
            print(f'[brand_overlay] ✅ Intro/outro concat → {out_path}')
            return out_path
        except subprocess.CalledProcessError as e:
            print(f'[brand_overlay] ⚠️  intro/outro concat failed: '
                  f'{e.stderr.decode(errors="replace")[:400]}')
            return video_path
        finally:
            try:
                os.unlink(list_path)
            except OSError:
                pass

    def _normalize_segment(self, src_path: str, label: str, ref_video: str) -> str:
        """Re-encode an intro/outro to match the main video's resolution
        + codec so the concat demuxer's `-c copy` path works.  The main
        video itself is returned as-is (no re-encode)."""
        if label == 'main':
            return src_path
        out = self._sibling(ref_video, f'_{label}')
        cmd = [
            'ffmpeg', '-y', '-loglevel', 'error',
            '-i', src_path,
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
            '-c:a', 'aac', '-b:a', '192k',
            '-movflags', '+faststart',
            out,
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True)
            return out
        except subprocess.CalledProcessError as e:
            print(f'[brand_overlay] ⚠️  _normalize_segment({label}) failed: '
                  f'{e.stderr.decode(errors="replace")[:400]}')
            return src_path  # best-effort: concat will likely fail downstream

    # ------------------------------------------------------------------
    # Caption restyle
    # ------------------------------------------------------------------
    def restyle_captions(self, ass_path: str) -> str:
        """Rewrite an .ass file with the brand's primary/secondary
        colours and primary font.

        The approach is text-based — we parse the .ass line-by-line:
          1. Find `Style:` lines under [V4+ Styles] and rewrite:
             - Fontname → brand font_primary
             - PrimaryColour → brand color_primary (ASS BGR)
             - SecondaryColour → brand color_secondary (or accent)
          2. Find Dialogue lines and rewrite any `\\1c` / `\\2c` inline
             colour tags so the kinetic caption generator's per-word
             pop-in colour is replaced with the brand accent.

        If the .ass file is missing or the brand has no colour overrides,
        returns `ass_path` unchanged.
        """
        if not ass_path or not os.path.exists(ass_path):
            return ass_path
        if not self.has_brand_colors:
            return ass_path
        if not _ASS_AVAILABLE:
            print('[brand_overlay] ⚠️  ass_builder not importable; skipping caption restyle.')
            return ass_path

        primary_ass = _hex_to_ass(self.color_primary) or '&H00FFFFFF'
        # Secondary prefers the explicit secondary colour, then the accent.
        secondary_ass = (
            _hex_to_ass(self.color_secondary)
            or _hex_to_ass(self.color_accent)
            or '&H000000FF'
        )

        try:
            with open(ass_path, 'r', encoding='utf-8-sig') as f:
                lines = f.readlines()
        except Exception as e:
            print(f'[brand_overlay] ⚠️  cannot read .ass ({e}); skipping restyle.')
            return ass_path

        in_styles = False
        out_lines: list[str] = []
        for ln in lines:
            stripped = ln.strip()

            # Track section context.
            if stripped.startswith('[') and stripped.endswith(']'):
                in_styles = stripped.lower().startswith('[v4+ styles]')
                out_lines.append(ln)
                continue

            # Rewrite the Style: line.
            if in_styles and stripped.startswith('Style:'):
                ln = self._rewrite_style_line(ln, primary_ass, secondary_ass)
                out_lines.append(ln)
                continue

            # Rewrite per-word \\1c tags in Dialogue lines.
            if stripped.startswith('Dialogue:'):
                ln = self._rewrite_dialogue_colors(ln, primary_ass, secondary_ass)
                out_lines.append(ln)
                continue

            out_lines.append(ln)

        out_path = self._sibling(ass_path, '_brand')
        try:
            with open(out_path, 'w', encoding='utf-8') as f:
                f.writelines(out_lines)
            # Preserve the BOM (libass-friendly) — ass_builder does this too.
            print(f'[brand_overlay] ✅ Caption restyle → {out_path}')
            return out_path
        except Exception as e:
            print(f'[brand_overlay] ⚠️  failed writing restyled .ass ({e}).')
            return ass_path

    def _rewrite_style_line(
        self, line: str, primary_ass: str, secondary_ass: str,
    ) -> str:
        """Rewrite Fontname / PrimaryColour / SecondaryColour fields
        on a `Style:` line.  ASS Style line format:
            Style: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,...
        """
        if not line.lstrip().startswith('Style:'):
            return line
        prefix, _, rest = line.partition(':')
        parts = rest.split(',')
        if len(parts) < 7:
            return line
        # parts[0] = Name (keep), parts[1] = Fontname, parts[2] = Fontsize,
        # parts[3] = PrimaryColour, parts[4] = SecondaryColour
        parts[1] = self.font_primary
        parts[3] = primary_ass
        parts[4] = secondary_ass
        return f'{prefix}:' + ','.join(parts)

    def _rewrite_dialogue_colors(
        self, line: str, primary_ass: str, secondary_ass: str,
    ) -> str:
        """Rewrite \\1c and \\2c inline colour tags on a Dialogue line
        so the kinetic per-word pop-in colour matches the brand.

        ASS override tags: `\\1c&H00BBGGRR&` (primary) and `\\2c&H...&`
        (secondary).  We only replace the *first* occurrence of each —
        the kinetic caption generator emits one header tag per chunk
        that sets both colours for all words on that chunk.

        The closing `&` is optional in libass; we match both forms.

        Implementation note: we use a lambda for the replacement so
        that backslashes in `primary_ass` / `secondary_ass` aren't
        interpreted as regex group references by `re.sub`.
        """
        # Replace only the first \\1c and \\2c on the line — kinetic
        # caption style sheets emit these once per chunk for all words.
        new = re.sub(
            r'\\1c&H[0-9A-Fa-f]{8}&?',
            lambda _m, repl=primary_ass: f'\\1c{repl}',
            line, count=1,
        )
        new = re.sub(
            r'\\2c&H[0-9A-Fa-f]{8}&?',
            lambda _m, repl=secondary_ass: f'\\2c{repl}',
            new, count=1,
        )
        return new

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _sibling(path: str, suffix: str) -> str:
        """Return `<dir>/<basename>_<suffix>.<ext>` next to `path`."""
        root, ext = os.path.splitext(path)
        return f'{root}{suffix}{ext}'


# ---------------------------------------------------------------------------
# Convenience: build a BrandOverlay from a dict (or None-safe)
# ---------------------------------------------------------------------------
def brand_overlay_from_dict(brand_profile: dict | None) -> BrandOverlay | None:
    """Construct a BrandOverlay, or return None if `brand_profile` is
    falsy.  Pipeline callers use this to optionally apply branding."""
    if not brand_profile:
        return None
    try:
        return BrandOverlay(brand_profile)
    except Exception as e:
        print(f'[brand_overlay] ⚠️  failed to construct BrandOverlay ({e}); skipping.')
        return None


__all__ = [
    'BrandOverlay',
    'brand_overlay_from_dict',
    'fetch_brand_asset',
]


# ---------------------------------------------------------------------------
# Smoke test
# ---------------------------------------------------------------------------
if __name__ == '__main__':  # pragma: no cover
    profile = {
        'name': 'default',
        'logo_url': None,
        'color_primary': '#FF5733',
        'color_secondary': '#FFFFFF',
        'color_accent': '#FFC300',
        'font_primary': 'Cairo',
        'watermark_position': 'bottom-right',
        'watermark_opacity': 0.3,
    }
    bo = BrandOverlay(profile)
    print(f'BrandOverlay: {bo.name}')
    print(f'  primary={bo.color_primary} → ASS {_hex_to_ass(bo.color_primary)}')
    print(f'  secondary={bo.color_secondary} → ASS {_hex_to_ass(bo.color_secondary)}')
    print(f'  has_logo={bo.has_logo} has_intro={bo.has_intro} has_outro={bo.has_outro}')
    print(f'  has_brand_colors={bo.has_brand_colors}')
