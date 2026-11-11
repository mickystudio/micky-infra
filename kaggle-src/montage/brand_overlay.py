"""Brand overlay (Task B13-retry — brand_profile + montage integration).

Applies a user's brand identity (logo watermark, brand colours, brand
fonts, intro/outro pre-roll) to a finished montage video.  The brand
profile dict comes from the Worker's D1 row.  If `brand_profile` is
None/empty, every method returns its input unchanged (no-op).

Public surface:
    @dataclass BrandProfile        (Python mirror of the TS interface)
    class BrandOverlay
        .apply_brand_to_video(video_path) -> str   (watermark + intro/outro)
        .apply_watermark(video_path)     -> str   (FFmpeg overlay)
        .apply_intro_outro(video_path)   -> str   (FFmpeg concat)
        .restyle_captions(ass_path)      -> str   (pysubs2 ASS rewrite)
    brand_overlay_from_dict(profile) -> BrandOverlay | None
Created: 2026-11-13 (Task B13-retry)
"""
from __future__ import annotations

import os
import re
import subprocess
import tempfile
import urllib.request
from dataclasses import dataclass, fields
from typing import Any, Optional

try:
    import pysubs2  # type: ignore  (declared in requirements.txt, B5)
    _PYSUBS2_AVAILABLE = True
except ImportError:  # pragma: no cover
    _PYSUBS2_AVAILABLE = False


# ============ Constants ============

_LOGO_TARGET_HEIGHT = 120   # px — logo is scaled to this height
_WATERMARK_PRESETS: dict[str, tuple[str, str]] = {
    # FFmpeg overlay x/y accept expressions like W-w-16
    'top-left':     ('16',       '16'),
    'top-right':    ('W-w-16',   '16'),
    'bottom-left':  ('16',       'H-h-16'),
    'bottom-right': ('W-w-16',   'H-h-16'),
    'center':       ('(W-w)/2',  '(H-h)/2'),
}
_HEX_RE = re.compile(r'^#?[0-9A-Fa-f]{6}$')
_COLOR_TAG_RE = re.compile(r'\\([12])c&H[0-9A-Fa-f]{6,8}&?')


# ============ BrandProfile dataclass ============

@dataclass
class BrandProfile:
    """Python mirror of `worker/src/core/brand_profile.ts:BrandProfile`.
    Fields default to empty/None so partial D1 dicts still construct
    valid profiles; `from_dict(...)` filters unknown keys."""
    id: int = 0
    user_id: str = ''
    name: str = 'default'
    logo_url: Optional[str] = None
    color_primary: Optional[str] = None
    color_secondary: Optional[str] = None
    color_accent: Optional[str] = None
    font_primary: Optional[str] = None
    font_secondary: Optional[str] = None
    intro_video_url: Optional[str] = None
    outro_video_url: Optional[str] = None
    watermark_position: str = 'bottom-right'
    watermark_opacity: float = 0.3
    default_platform: str = 'tiktok'
    default_style: str = 'bold_pop'
    created_at: int = 0
    updated_at: int = 0

    @classmethod
    def from_dict(cls, d: Optional[dict[str, Any]]) -> Optional['BrandProfile']:
        """Build from a (possibly None) dict, ignoring unknown keys.
        Returns None when `d` is None/empty."""
        if not d:
            return None
        valid = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in d.items() if k in valid})


# ============ Helpers ============

def _normalize_hex(h: Optional[str]) -> Optional[str]:
    """Return '#RRGGBB' (uppercase) or None.  Silently drops malformed colours."""
    if not h: return None
    s = str(h).strip()
    if not s.startswith('#'): s = '#' + s
    if not _HEX_RE.match(s): return None
    return s.upper()


def _hex_to_ass(h: Optional[str]) -> Optional[str]:
    """'#RRGGBB' → '&H00BBGGRR' (ASS BGR colour).  None passthrough."""
    norm = _normalize_hex(h)
    if norm is None: return None
    r, g, b = int(norm[1:3], 16), int(norm[3:5], 16), int(norm[5:7], 16)
    return f'&H00{b:02X}{g:02X}{r:02X}'


def _coerce_opacity(raw: Any, default: float = 0.3) -> float:
    """Clamp an arbitrary value to [0.0, 1.0]."""
    try:
        n = float(raw)
    except (TypeError, ValueError):
        return default
    return max(0.0, min(1.0, n))


def _coerce_position(raw: Any) -> str:
    s = str(raw or '').lower()
    return s if s in _WATERMARK_PRESETS else 'bottom-right'


def _fetch_asset(url: str, cache_dir: str = '/tmp/micky-brand-assets') -> Optional[str]:
    """Resolve a brand-asset URL to a local file path.  Supports
    `http(s)://...` URLs (downloaded to `cache_dir`) and local
    filesystem paths (returned as-is).  Returns None on failure."""
    if not url: return None
    if os.path.exists(url): return url
    if not (url.startswith('http://') or url.startswith('https://')): return None
    os.makedirs(cache_dir, exist_ok=True)
    cache_name = url.split('/')[-1].split('?')[0] or 'brand_asset'
    cache_path = os.path.join(cache_dir, cache_name)
    try:
        urllib.request.urlretrieve(url, cache_path)
        return cache_path
    except Exception as e:
        print(f'[brand_overlay] ⚠️  fetch failed ({url}): {e}')
        return None


def _sibling(path: str, suffix: str) -> str:
    """Return `<dir>/<basename>_<suffix>.<ext>` next to `path`."""
    root, ext = os.path.splitext(path)
    return f'{root}{suffix}{ext}'


# ============ BrandOverlay ============

class BrandOverlay:
    """Apply a brand identity (logo watermark + brand-coloured captions +
    intro/outro pre-roll) to a montage video.

    Construction is cheap; FFmpeg / pysubs2 work happens in the
    `apply_*` methods.  Each method writes its output next to the input
    with a `_wm` / `_intro` / `_brand` suffix and returns the new path.
    Fail-soft: any error is logged and the original input is returned
    unchanged so the pipeline never crashes."""

    def __init__(self, brand_profile: dict[str, Any]):
        if brand_profile is None:
            raise TypeError('brand_profile must be a dict (got None)')
        if not isinstance(brand_profile, dict):
            raise TypeError(f'brand_profile must be dict, got {type(brand_profile).__name__}')
        self.profile: BrandProfile = BrandProfile.from_dict(brand_profile) or BrandProfile()
        self.logo_url = self.profile.logo_url
        self.color_primary = _normalize_hex(self.profile.color_primary)
        self.color_secondary = _normalize_hex(self.profile.color_secondary)
        self.color_accent = _normalize_hex(self.profile.color_accent)
        self.font_primary = self.profile.font_primary or 'Anton'
        self.font_secondary = self.profile.font_secondary or 'Cairo'
        self.intro_url = self.profile.intro_video_url
        self.outro_url = self.profile.outro_video_url
        self.watermark_position = _coerce_position(self.profile.watermark_position)
        self.watermark_opacity = _coerce_opacity(self.profile.watermark_opacity)

    @property
    def has_logo(self) -> bool: return bool(self.logo_url)
    @property
    def has_intro(self) -> bool: return bool(self.intro_url)
    @property
    def has_outro(self) -> bool: return bool(self.outro_url)
    @property
    def has_brand_colors(self) -> bool:
        return any([self.color_primary, self.color_secondary, self.color_accent])
    @property
    def has_brand_content(self) -> bool:
        """True if the profile contains anything to apply."""
        return self.has_logo or self.has_intro or self.has_outro or self.has_brand_colors

    # -- top-level entry --

    def apply_brand_to_video(self, video_path: str) -> str:
        """Apply watermark + intro/outro to `video_path`.  Caption restyle
        is separate (see `restyle_captions`).  Returns the final branded
        video path (or `video_path` itself if nothing could be applied)."""
        if not self.has_brand_content:
            return video_path
        if not video_path or not os.path.exists(video_path):
            return video_path
        out = video_path
        try:
            if self.has_intro or self.has_outro:
                out = self.apply_intro_outro(out)
            if self.has_logo:
                out = self.apply_watermark(out)
        except Exception as e:
            print(f'[brand_overlay] ⚠️  apply_brand_to_video failed ({e}); '
                  f'returning best-effort path {out}')
        return out

    # -- watermark --------------------------------------------------------

    def apply_watermark(self, video_path: str) -> str:
        """Overlay the brand logo at the configured position with the
        configured opacity.  Logo is scaled to a fixed 120-px height.
        PNGs with alpha supported; JPEGs get hard alpha."""
        if not self.has_logo:
            return video_path
        logo_local = _fetch_asset(self.logo_url or '')
        if not logo_local or not os.path.exists(logo_local):
            print(f'[brand_overlay] ⚠️  logo not fetchable ({self.logo_url}); skipping watermark.')
            return video_path

        out_path = _sibling(video_path, '_wm')
        x_expr, y_expr = _WATERMARK_PRESETS[self.watermark_position]
        opacity = self.watermark_opacity
        scale = f'scale=-2:{_LOGO_TARGET_HEIGHT}:force_original_aspect_ratio=decrease'
        if opacity >= 1.0:
            fc = f'[1:v]{scale}[logo];[0:v][logo]overlay={x_expr}:{y_expr}:format=auto[v]'
        else:
            fc = (f'[1:v]{scale},format=rgba,colorchannelmixer=aa={opacity:.3f}[logo];'
                  f'[0:v][logo]overlay={x_expr}:{y_expr}:format=auto[v]')
        cmd = [
            'ffmpeg', '-y', '-loglevel', 'error',
            '-i', video_path, '-i', logo_local,
            '-filter_complex', fc,
            '-map', '[v]', '-map', '0:a?',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
            '-c:a', 'copy', '-movflags', '+faststart', out_path,
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True)
            print(f'[brand_overlay] ✅ watermark applied → {out_path}')
            return out_path
        except subprocess.CalledProcessError as e:
            print(f'[brand_overlay] ⚠️  ffmpeg watermark failed: '
                  f'{e.stderr.decode(errors="replace")[:400]}')
            return video_path

    # -- intro / outro concat --

    def apply_intro_outro(self, video_path: str) -> str:
        """Concatenate intro + main video + outro into a single MP4.

        Uses the FFmpeg `concat` demuxer with a temporary file list.
        Intro/outro segments are re-encoded to libx264 + AAC so the
        concat demuxer's `-c copy` path works even when sources have
        different codecs."""
        if not (self.has_intro or self.has_outro):
            return video_path

        segments: list[str] = []
        for label, url, has in [('intro', self.intro_url, self.has_intro),
                                 ('outro', self.outro_url, self.has_outro)]:
            if not has:
                continue
            local = _fetch_asset(url or '')
            if local and os.path.exists(local):
                segments.append(self._normalize_segment(local, label, video_path))
            else:
                print(f'[brand_overlay] ⚠️  {label} not fetchable ({url}); skipping.')
        segments.append(video_path)  # main video kept as-is
        if len(segments) < 2:
            return video_path  # nothing to concat

        list_fd, list_path = tempfile.mkstemp(suffix='.txt', prefix='brand_concat_')
        out_path = _sibling(video_path, '_intro')
        try:
            with os.fdopen(list_fd, 'w') as f:
                for seg in segments:
                    f.write(f"file '{seg}'\n")
            # Try copy-mode concat first (fast); fall back to re-encode.
            base = ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat',
                    '-safe', '0', '-i', list_path, '-movflags', '+faststart']
            copy_cmd = base + ['-c', 'copy', out_path]
            reenc_cmd = base + ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
                                '-c:a', 'aac', '-b:a', '192k', out_path]
            try:
                subprocess.run(copy_cmd, check=True, capture_output=True)
            except subprocess.CalledProcessError:
                subprocess.run(reenc_cmd, check=True, capture_output=True)
            print(f'[brand_overlay] ✅ intro/outro concat → {out_path}')
            return out_path
        except subprocess.CalledProcessError as e:
            print(f'[brand_overlay] ⚠️  intro/outro concat failed: '
                  f'{e.stderr.decode(errors="replace")[:400]}')
            return video_path
        finally:
            try: os.unlink(list_path)
            except OSError: pass

    def _normalize_segment(self, src_path: str, label: str, ref_video: str) -> str:
        """Re-encode an intro/outro clip to libx264 + AAC so the concat
        demuxer's `-c copy` path works."""
        out = _sibling(ref_video, f'_{label}')
        cmd = [
            'ffmpeg', '-y', '-loglevel', 'error', '-i', src_path,
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
            '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out,
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True)
            return out
        except subprocess.CalledProcessError as e:
            print(f'[brand_overlay] ⚠️  _normalize_segment({label}) failed: '
                  f'{e.stderr.decode(errors="replace")[:400]}')
            return src_path  # best-effort

    # -- caption restyle (pysubs2) --

    def restyle_captions(self, ass_path: str) -> str:
        """Rewrite an .ass file with the brand's primary/secondary colours
        and primary font, using `pysubs2` for parse/serialise.

          * Every Style: Fontname → brand font_primary, PrimaryColour →
            brand color_primary (ASS BGR), SecondaryColour → brand
            color_secondary (or accent).
          * Every Dialogue event: replace the FIRST inline `\\1c` / `\\2c`
            override tag with the brand primary / secondary colours.

        Returns the restyled .ass path (`<base>_brand.ass`), or the
        original `ass_path` if there was nothing to restyle or pysubs2
        is unavailable.
        """
        if not ass_path or not os.path.exists(ass_path): return ass_path
        if not self.has_brand_colors: return ass_path
        if not _PYSUBS2_AVAILABLE:
            print('[brand_overlay] ⚠️  pysubs2 not installed; skipping caption restyle.')
            return ass_path

        primary_ass = _hex_to_ass(self.color_primary) or '&H00FFFFFF'
        secondary_ass = (_hex_to_ass(self.color_secondary)
                         or _hex_to_ass(self.color_accent) or '&H000000FF')
        try:
            subs = pysubs2.load(ass_path)
        except Exception as e:
            print(f'[brand_overlay] ⚠️  pysubs2 cannot read .ass ({e}); skipping restyle.')
            return ass_path
        # 1) Rewrite Style lines (fontname + primary + secondary).
        for style in subs.styles.values():
            style.fontname = self.font_primary
            style.primarycolor = primary_ass
            style.secondarycolor = secondary_ass
        # 2) Replace the first \\1c / \\2c inline colour tags on each Dialogue line.
        for ev in subs.events:
            if ev.text:
                ev.text = self._rewrite_inline_colors(ev.text, primary_ass, secondary_ass)
        out_path = _sibling(ass_path, '_brand')
        try:
            subs.save(out_path)
            print(f'[brand_overlay] ✅ caption restyle → {out_path}')
            return out_path
        except Exception as e:
            print(f'[brand_overlay] ⚠️  pysubs2 save failed ({e}); keeping original .ass.')
            return ass_path

    @staticmethod
    def _rewrite_inline_colors(text: str, primary_ass: str, secondary_ass: str) -> str:
        """Replace the first `\\1c&H...` / `\\2c&H...` inline colour tags in
        `text` with the brand colours.  Other override tags (\\fad, \\pos,
        \\kf, …) are preserved.  Lambda form avoids re.sub's regex
        group-reference escaping on `&H00...` literals."""
        return _COLOR_TAG_RE.sub(
            lambda m: f'\\{m.group(1)}c{primary_ass if m.group(1) == "1" else secondary_ass}',
            text, count=1,
        )


# ============ Convenience: None-safe constructor ============

def brand_overlay_from_dict(brand_profile: Optional[dict[str, Any]]) -> Optional[BrandOverlay]:
    """Construct a BrandOverlay, or return None if `brand_profile` is
    falsy.  Pipeline callers use this to optionally apply branding."""
    if not brand_profile:
        return None
    try:
        return BrandOverlay(brand_profile)
    except Exception as e:
        print(f'[brand_overlay] ⚠️  failed to construct BrandOverlay ({e}); skipping.')
        return None


__all__ = ['BrandProfile', 'BrandOverlay', 'brand_overlay_from_dict']


# ============ Smoke test ============
if __name__ == '__main__':  # pragma: no cover
    profile = {'name': 'default', 'color_primary': '#FF5733', 'color_secondary': '#FFFFFF',
              'color_accent': '#FFC300', 'font_primary': 'Cairo',
              'watermark_position': 'bottom-right', 'watermark_opacity': 0.3}
    bo = BrandOverlay(profile)
    print(f'BrandOverlay: {bo.profile.name}; primary={bo.color_primary} has_brand_content={bo.has_brand_content}')
    assert brand_overlay_from_dict(None) is None and brand_overlay_from_dict({}) is None
    print('  brand_overlay_from_dict(None/empty) → None ✅')
