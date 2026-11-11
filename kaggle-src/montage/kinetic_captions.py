"""
Kinetic subtitles generator (B5).
=================================
High-level pipeline: WhisperX word timestamps → animated ASS subtitles
(CapCut-style) → FFmpeg libass burn-in.

    WhisperX dict ─► generate_ass ─► .ass file ─► burn_into_video ─► .mp4

Six styles (see README_kinetic.md for visual descriptions):
    bold_pop        white text, 6px black outline, active word → #FFE500
    karaoke_fill    words fill green #31E981 progressively as spoken (\\kf)
    boxed           solid black box (BorderStyle=3), active word red #FF3030
    clean_lower     minimal lower-third, no animation
    hormozi         high-contrast bold, 90ms pop-in, yellow emphasis, 1.20x bounce
    tiktok_default  white text + black stroke, chunk-level pop + \\kf fill

Arabic / RTL: set ``font_name`` to a shaping-aware font (``Cairo``,
``Tajawal``).  libass + harfbuzz handle ligatures and bidi automatically.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ass_builder import (  # noqa: E402
    ASSBuilder, ASSLine, CaptionConfig, WordTimestamp,
    hex_to_ass_color, hex_to_color,
)

# Optional pyonfx (for advanced KFX) — silently skip if missing
try:  # pragma: no cover
    import pyonfx  # type: ignore  # noqa: F401
    _HAS_PYONFX = True
except Exception:  # pragma: no cover
    _HAS_PYONFX = False


# ---------------------------------------------------------------------------
# Style presets (JSON-serialisable for future templating)
# ---------------------------------------------------------------------------
STYLE_PRESETS: dict[str, dict[str, Any]] = {
    "bold_pop":        {"font_name": "Anton", "font_size": 110,
                        "primary_color": "FFFFFF", "outline_color": "000000",
                        "outline_width": 6, "shadow": 2, "position": 2,
                        "margin_v": 300, "border_style": 1,
                        "active_color": "FFE500", "scale": 1.18,
                        "pop_duration_ms": 180},
    "karaoke_fill":    {"font_name": "Anton", "font_size": 100,
                        "primary_color": "31E981", "outline_color": "000000",
                        "outline_width": 5, "shadow": 1, "position": 2,
                        "margin_v": 300, "border_style": 1,
                        "fill_color": "31E981", "base_color": "FFFFFF",
                        "pop_duration_ms": 0},
    "boxed":           {"font_name": "Anton", "font_size": 96,
                        "primary_color": "FFFFFF", "outline_color": "000000",
                        "outline_width": 0, "shadow": 0, "position": 2,
                        "margin_v": 280, "border_style": 3,
                        "back_color": "000000",
                        "active_color": "FF3030", "scale": 1.0,
                        "pop_duration_ms": 0},
    "clean_lower":     {"font_name": "Anton", "font_size": 72,
                        "primary_color": "FFFFFF", "outline_color": "000000",
                        "outline_width": 3, "shadow": 1, "position": 2,
                        "margin_v": 180, "border_style": 1,
                        "pop_duration_ms": 0, "no_kf": True},
    "hormozi":         {"font_name": "Anton", "font_size": 120,
                        "primary_color": "FFFFFF", "outline_color": "000000",
                        "outline_width": 8, "shadow": 3, "position": 2,
                        "margin_v": 320, "border_style": 1,
                        "active_color": "FFE500", "scale": 1.20,
                        "pop_duration_ms": 90},
    "tiktok_default":  {"font_name": "Anton", "font_size": 100,
                        "primary_color": "FFFFFF", "outline_color": "000000",
                        "outline_width": 5, "shadow": 2, "position": 2,
                        "margin_v": 300, "border_style": 1,
                        "active_color": "FFFFFF", "scale": 1.10,
                        "pop_duration_ms": 120},
}
VALID_STYLES = set(STYLE_PRESETS.keys())


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
_ARABIC_RE = re.compile(r"[\u0600-\u06FF\u0750-\u077F]")


def is_arabic_text(text: str) -> bool:
    """True if >30% of alpha chars fall in the Arabic Unicode block."""
    if not text:
        return False
    total = sum(1 for ch in text if ch.isalpha())
    arabic = sum(1 for ch in text if ch.isalpha() and _ARABIC_RE.match(ch))
    return total > 0 and (arabic / total) > 0.30


def _ffmpeg_has_libass() -> bool:
    """Return True iff the installed ffmpeg exposes the ``ass`` filter."""
    try:
        out = subprocess.run(
            ["ffmpeg", "-filters"], capture_output=True, text=True, check=True
        ).stdout
    except Exception:
        return False
    return re.search(r"\bass\b\s+V->V", out) is not None


# ---------------------------------------------------------------------------
# KineticCaptionGenerator
# ---------------------------------------------------------------------------
class KineticCaptionGenerator:
    """High-level kinetic-caption orchestrator.

    Wraps :class:`ASSBuilder` with style presets, WhisperX ingestion, chunk
    grouping, and FFmpeg libass burn-in.
    """

    STYLES = VALID_STYLES

    def __init__(self, style: str = "bold_pop", font_name: str = "Anton",
                 font_size: int = 110):
        if style not in STYLE_PRESETS:
            raise ValueError(
                f"unknown style {style!r}; valid: {sorted(VALID_STYLES)}"
            )
        self.style = style
        self.font_name = font_name
        self.font_size = font_size

    # ------------------------------------------------------------------
    # WhisperX ingestion
    # ------------------------------------------------------------------
    @staticmethod
    def extract_words(whisperx_result: dict) -> list[WordTimestamp]:
        """Flatten WhisperX result → list[WordTimestamp].

        Accepts both ``segments[*].words[*]`` and top-level ``word_segments``
        (align-only output).
        """
        out: list[WordTimestamp] = []
        segments = whisperx_result.get("segments", []) or []
        for seg in segments:
            speaker = seg.get("speaker")
            for w in seg.get("words", []) or []:
                word_text = (w.get("word") or "").strip()
                if not word_text:
                    continue
                try:
                    start = float(w.get("start") or w.get("timestamp") or 0.0)
                except (TypeError, ValueError):
                    start = 0.0
                try:
                    end = float(w.get("end") or (start + 0.2))
                except (TypeError, ValueError):
                    end = start + 0.2
                if end < start:
                    end = start + 0.1
                conf = float(w.get("score") or w.get("confidence") or 1.0)
                out.append(WordTimestamp(word_text, start, end,
                                         speaker=speaker, confidence=conf))
        if not out and "word_segments" in whisperx_result:
            for w in whisperx_result["word_segments"]:
                word_text = (w.get("word") or w.get("text") or "").strip()
                if not word_text:
                    continue
                start = float(w.get("start") or 0.0)
                end = float(w.get("end") or start + 0.2)
                out.append(WordTimestamp(word_text, start, end,
                                         speaker=w.get("speaker"),
                                         confidence=1.0))
        return out

    # ------------------------------------------------------------------
    # Chunking — group words into caption-friendly chunks
    # ------------------------------------------------------------------
    @staticmethod
    def chunk_words(words: list[WordTimestamp], max_words: int = 4,
                    max_gap: float = 0.4, max_chars: int = 32
                    ) -> list[list[WordTimestamp]]:
        """Group words into chunks (≤4 words, gap ≤0.4s, ≤32 chars)."""
        chunks: list[list[WordTimestamp]] = []
        current: list[WordTimestamp] = []
        char_count = 0
        for w in words:
            gap = (w.start - current[-1].end) if current else 0.0
            too_long = (
                len(current) >= max_words
                or gap > max_gap
                or (char_count + len(w.word) + 1) > max_chars
            )
            if too_long and current:
                chunks.append(current)
                current = []
                char_count = 0
            current.append(w)
            char_count += len(w.word) + 1
        if current:
            chunks.append(current)
        return chunks

    # ------------------------------------------------------------------
    # Style application — returns list of ASSLine (one per chunk)
    # ------------------------------------------------------------------
    def apply_style(self, words: list[WordTimestamp],
                    style: str) -> list[ASSLine]:
        """Apply ``style`` to a flat word list → chunked ASSLines.

        Each branch builds ASSLine objects with style-appropriate override
        tags, delegating tag generation to :class:`ASSBuilder`.
        """
        if style not in STYLE_PRESETS:
            raise ValueError(f"unknown style {style!r}")
        preset = STYLE_PRESETS[style]
        chunks = self.chunk_words(words)
        cfg = self._make_config(style, preset)
        builder = ASSBuilder(cfg)

        lines: list[ASSLine] = []
        for chunk in chunks:
            start_ms = max(0, int(chunk[0].start * 1000) - 60)
            end_ms = int(chunk[-1].end * 1000) + 60

            if style == "clean_lower":
                # Minimal: fade in/out, no per-word fill, no pop.
                text = " ".join(w.word for w in chunk)
                lines.append(ASSLine(
                    start_ms=start_ms, end_ms=end_ms,
                    text=f"{{\\fad(150,150)}}{text}",
                ))
                continue

            if style == "karaoke_fill":
                ev = builder.add_karaoke_line(
                    chunk, fill_color=preset["fill_color"],
                    base_color=preset["base_color"], padding_ms=0,
                )
            else:
                # bold_pop, boxed, hormozi, tiktok_default all use pop_line
                ev = builder.add_pop_line(
                    chunk,
                    active_color=preset.get("active_color", "FFE500"),
                    scale=preset.get("scale", 1.0),
                    padding_ms=0,
                    pop_duration_ms=preset.get("pop_duration_ms", 0) or 60,
                )
            lines.append(self._ev_to_line(ev, start_ms, end_ms))
        return lines

    # ------------------------------------------------------------------
    # Top-level: generate_ass
    # ------------------------------------------------------------------
    def generate_ass(self, whisperx_result: dict, output_path: str,
                     video_resolution: tuple[int, int] = (1080, 1920)) -> str:
        """Generate a .ass file from WhisperX output.  Returns the path."""
        words = self.extract_words(whisperx_result)
        if not words:
            print("[kinetic] no words extracted from whisperx result")
            os.makedirs(os.path.dirname(os.path.abspath(output_path)) or ".",
                        exist_ok=True)
            Path(output_path).write_text(
                "[Script Info]\nScriptType: v4.00+\n"
                f"PlayResX: {video_resolution[0]}\n"
                f"PlayResY: {video_resolution[1]}\n"
                "[Events]\nFormat: Layer, Start, End, Style, Name, "
                "MarginL, MarginR, MarginV, Effect, Text\n",
                encoding="utf-8",
            )
            return output_path

        # Auto-detect RTL → switch to shaping-aware font if needed
        rtl = is_arabic_text(" ".join(w.word for w in words))
        preset = STYLE_PRESETS[self.style]
        font_name = "Cairo" if (rtl and self.font_name in ("Anton", "Impact")) \
            else self.font_name

        cfg = self._make_config(self.style, preset)
        cfg.font_name = font_name
        cfg.font_size = self.font_size or preset["font_size"]
        cfg.play_res_x, cfg.play_res_y = video_resolution

        builder = ASSBuilder(cfg)
        for line in self.apply_style(words, self.style):
            builder.add_line(line)
        builder.save(output_path)
        print(f"[kinetic] wrote {output_path}  "
              f"({len(words)} words, {builder.event_count} chunks, "
              f"rtl={rtl}, font={font_name})")
        return output_path

    # ------------------------------------------------------------------
    # FFmpeg libass burn-in
    # ------------------------------------------------------------------
    def burn_into_video(self, video_path: str, ass_path: str,
                       output_path: str, crf: int = 18,
                       preset: str = "medium") -> str:
        """Burn .ass subtitles into video via FFmpeg libass.

        Verifies libass support first; raises RuntimeError if missing.
        """
        if not _ffmpeg_has_libass():
            raise RuntimeError(
                "FFmpeg lacks libass support — install with "
                "`apt install ffmpeg libass-dev` or rebuild with --enable-libass"
            )
        if not os.path.exists(video_path):
            raise FileNotFoundError(video_path)
        if not os.path.exists(ass_path):
            raise FileNotFoundError(ass_path)

        # libass needs absolute paths; escape ':' and ',' for the filter parser
        ass_abs = os.path.abspath(ass_path).replace("\\", "/")
        ass_filter = ass_abs.replace(":", r"\:").replace(",", r"\,")
        vf = f"ass='{ass_filter}'"
        fontsdir = self._find_fonts_dir(ass_path)
        if fontsdir:
            fontsdir_abs = os.path.abspath(fontsdir).replace("\\", "/")
            vf += f":fontsdir='{fontsdir_abs}'"

        cmd = [
            "ffmpeg", "-y", "-i", video_path,
            "-vf", vf,
            "-c:v", "libx264", "-crf", str(crf), "-preset", preset,
            "-c:a", "copy", "-movflags", "+faststart",
            output_path,
        ]
        print(f"[kinetic] burning subtitles: {' '.join(cmd[:6])} ...")
        t0 = time.time()
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            stderr_tail = (result.stderr or "")[-2000:]
            raise RuntimeError(
                f"ffmpeg burn-in failed (exit {result.returncode}):\n{stderr_tail}"
            )
        elapsed = time.time() - t0
        size_mb = (os.path.getsize(output_path) / (1024 * 1024)
                   if os.path.exists(output_path) else 0)
        print(f"[kinetic] ✅ burned in {elapsed:.1f}s, output "
              f"{size_mb:.1f}MB → {output_path}")
        return output_path

    # ------------------------------------------------------------------
    # Style preview
    # ------------------------------------------------------------------
    def get_style_preview(self, style: str) -> str:
        """Return an ASS snippet showing the style on a sample chunk."""
        if style not in STYLE_PRESETS:
            raise ValueError(f"unknown style {style!r}")
        sample = [
            WordTimestamp("This",    0.0,  0.35),
            WordTimestamp("is",      0.35, 0.55),
            WordTimestamp("a",       0.55, 0.65),
            WordTimestamp("preview", 0.65, 1.05),
        ]
        cfg = self._make_config(style, STYLE_PRESETS[style])
        builder = ASSBuilder(cfg)
        for line in self.apply_style(sample, style):
            builder.add_line(line)
        return builder.to_string()

    # ------------------------------------------------------------------
    # Style auto-detect (for caption_generator.py integration)
    # ------------------------------------------------------------------
    @staticmethod
    def detect_style(whisperx_result: dict,
                     hint: str | None = None) -> str:
        """Pick a kinetic style based on content type.

        ``hint`` overrides auto-detection ('vlog', 'podcast', 'promotional',
        or any of the 6 style names).  Otherwise samples words-per-minute
        to classify: high WPM → hormozi, low → clean_lower, mid → bold_pop.
        """
        if hint:
            if hint in STYLE_PRESETS:
                return hint
            h = hint.lower()
            if h in ("vlog", "vlogger", "casual"):
                return "bold_pop"
            if h in ("podcast", "interview", "talking_head"):
                return "clean_lower"
            if h in ("promo", "promotional", "ad", "advertising"):
                return "hormozi"

        words = KineticCaptionGenerator.extract_words(whisperx_result)
        if not words:
            return "bold_pop"
        duration = max(1.0, words[-1].end - words[0].start)
        wpm = len(words) / (duration / 60.0)
        if wpm > 180:
            return "hormozi"
        if wpm < 120:
            return "clean_lower"
        return "bold_pop"

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------
    def _make_config(self, style: str, preset: dict[str, Any]) -> CaptionConfig:
        """Build a CaptionConfig from the preset dict."""
        return CaptionConfig(
            style=style,
            font_name=preset.get("font_name", self.font_name),
            font_size=preset.get("font_size", self.font_size),
            primary_color=preset.get("primary_color", "FFFFFF"),
            outline_color=preset.get("outline_color", "000000"),
            outline_width=preset.get("outline_width", 6),
            shadow=preset.get("shadow", 2),
            position=preset.get("position", 2),
            margin_v=preset.get("margin_v", 300),
            margin_l=preset.get("margin_l", 80),
            margin_r=preset.get("margin_r", 80),
            border_style=preset.get("border_style", 1),
            back_color=preset.get("back_color", "000000"),
        )

    @staticmethod
    def _ev_to_line(ev, start_ms: int, end_ms: int) -> ASSLine:
        """Convert a pysubs2 SSAEvent to a portable ASSLine."""
        return ASSLine(
            start_ms=start_ms, end_ms=end_ms,
            text=ev.text, style=ev.style or "Default",
            layer=ev.layer,
        )

    @staticmethod
    def _find_fonts_dir(ass_path: str) -> str | None:
        """Look for a sibling ``fonts/`` directory (Kaggle dataset convention)."""
        here = Path(ass_path).resolve().parent
        candidates = [here / "fonts", here.parent / "fonts",
                      here.parent.parent / "fonts"]
        for c in candidates:
            if c.is_dir() and any(c.iterdir()):
                return str(c)
        return None


__all__ = [
    "KineticCaptionGenerator",
    "STYLE_PRESETS",
    "VALID_STYLES",
    "is_arabic_text",
]


# ---------------------------------------------------------------------------
# Standalone CLI
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(description="Kinetic subtitles generator")
    p.add_argument("whisperx_json", help="Path to WhisperX result JSON")
    p.add_argument("--style", default="bold_pop",
                   choices=sorted(VALID_STYLES))
    p.add_argument("--out", default="/tmp/kinetic.ass")
    p.add_argument("--video", default=None,
                   help="If given, burn the .ass into this video")
    p.add_argument("--burned-out", default="/tmp/kinetic_burned.mp4")
    p.add_argument("--font", default="Anton")
    p.add_argument("--size", type=int, default=110)
    p.add_argument("--preview", action="store_true",
                   help="Print an ASS snippet showing the style")
    args = p.parse_args()

    gen = KineticCaptionGenerator(style=args.style, font_name=args.font,
                                   font_size=args.size)
    if args.preview:
        print(gen.get_style_preview(args.style))
        sys.exit(0)
    with open(args.whisperx_json, "r", encoding="utf-8") as f:
        wx = json.load(f)
    ass_path = gen.generate_ass(wx, args.out)
    print(f"\n✅ ASS saved to: {ass_path}")
    if args.video:
        out = gen.burn_into_video(args.video, ass_path, args.burned_out)
        print(f"✅ Burned video: {out}")
