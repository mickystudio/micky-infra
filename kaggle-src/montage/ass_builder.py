"""
ASS builder (B5 — kinetic subtitles pipeline).
==============================================
Low-level ASS (Advanced SubStation Alpha) file construction on top of
``pysubs2``.  This module is intentionally thin — it knows about ASS
override tags (``\\k``, ``\\t``, ``\\fad``, ``\\move``, ``\\c``, ``\\fscx`` …)
but nothing about WhisperX, FFmpeg or pipeline orchestration.  The higher
level :mod:`kinetic_captions` module composes these primitives into the six
kinetic styles (``bold_pop``, ``karaoke_fill``, …).

Why pysubs2?
-------------
* Pure-Python, no C extension → installs in 0.1s on Kaggle.
* Round-trips ASS without mangling override tags.
* Handles Arabic / RTL through libass at render time (ffmpeg ``ass`` filter).

Color format
------------
ASS stores colours as ``&H{AA}{BB}{GG}{RR}`` (alpha + BGR, alpha 0 = opaque).
pysubs2's ``Color(r, g, b, a=0)`` accepts ordinary RGB with ``a=0`` meaning
opaque, matching the ASS convention.  Hex strings (``"FFE500"``) are accepted
everywhere and converted internally.

Per-word emphasis
-----------------
The reliable way to get *per-word* color emphasis on a single Dialogue line
in libass is the ``\\kf`` (karaoke fill) tag.  ``\\kf{n}`` schedules a
syllable of ``n`` centi-seconds during which the syllable's color transitions
from *secondary* (``\\2c``) to *primary* (``\\1c``).  After the syllable
ends, the word stays in primary colour — this is the canonical CapCut-style
"lights up as you speak" kinetic look.

Naively stacking per-word ``\\t`` transitions on a single line *does not*
work for colour/scale emphasis because override blocks in ASS affect all
text after them on the line — a transition scheduled at word N's position
would also pull words N+1, N+2, … into the same colour.  ``\\kf`` sidesteps
this because libass tracks karaoke syllables independently per word.

Public surface
--------------
    ASSBuilder(config: CaptionConfig)
        .set_style(name, **kwargs)              -> SSAStyle
        .add_line(line: ASSLine)                -> SSAEvent
        .add_karaoke_line(words, fill_color)    -> SSAEvent
        .add_pop_line(words, active_color, scale) -> SSAEvent
        .save(path)                             -> str
"""
from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from typing import Any

# ---------------------------------------------------------------------------
# Auto-install pysubs2 (Kaggle first-run safety net).
# ---------------------------------------------------------------------------
try:
    import pysubs2  # noqa: F401
    from pysubs2 import SSAFile, SSAStyle, SSAEvent, make_time, Color
except ImportError:  # pragma: no cover - runtime fallback
    print("[ass_builder] pysubs2 missing — auto-installing…")
    subprocess.check_call(
        [sys.executable, "-m", "pip", "install", "-q", "pysubs2>=1.7.0"]
    )
    import pysubs2  # noqa: F401
    from pysubs2 import SSAFile, SSAStyle, SSAEvent, make_time, Color


# ---------------------------------------------------------------------------
# Dataclasses shared with kinetic_captions.py
# ---------------------------------------------------------------------------
@dataclass
class WordTimestamp:
    """A single word with timing metadata (WhisperX-shaped)."""
    word: str
    start: float
    end: float
    speaker: str | None = None
    confidence: float = 1.0

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)

    @property
    def duration_ms(self) -> int:
        """Centi-seconds (``\\k`` tag uses 1/100 s ticks)."""
        return max(1, int(self.duration * 100))


@dataclass
class ASSLine:
    """A ready-to-emit dialogue line — text already contains override tags."""
    start_ms: int
    end_ms: int
    text: str
    style: str = "Default"
    layer: int = 0
    style_overrides: dict[str, Any] = field(default_factory=dict)
    name: str = ""


@dataclass
class CaptionConfig:
    """JSON-serialisable style configuration (future templating)."""
    style: str = "bold_pop"
    font_name: str = "Anton"
    font_size: int = 110
    primary_color: str = "FFFFFF"     # RGB hex (no '#')
    outline_color: str = "000000"
    outline_width: int = 6
    shadow: int = 2
    position: int = 2                 # ASS alignment (2 = bottom-center)
    margin_v: int = 300
    margin_l: int = 80
    margin_r: int = 80
    bold: bool = True
    italic: bool = False
    scale_x: int = 100
    scale_y: int = 100
    spacing: float = 0.0
    border_style: int = 1             # 1 = outline+shadow, 3 = opaque box
    back_color: str = "000000"        # only used when border_style == 3
    play_res_x: int = 1080
    play_res_y: int = 1920
    wrap_style: int = 2               # 2 = no word-wrap (manual \N)
    extras: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "CaptionConfig":
        valid = {k: v for k, v in d.items() if k in cls.__dataclass_fields__}
        return cls(**valid)


# ---------------------------------------------------------------------------
# Color helpers — convert "#RRGGBB" / "RRGGBB" → pysubs2.Color + ASS string
# ---------------------------------------------------------------------------
def _parse_hex(h: str) -> tuple[int, int, int]:
    """Parse '#RRGGBB' or 'RRGGBB' → (r, g, b)."""
    h = h.lstrip("#").strip()
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) != 6:
        raise ValueError(f"bad hex colour: {h!r}")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def hex_to_color(h: str, alpha: int = 0) -> Color:
    """Hex string → pysubs2.Color (alpha 0 = opaque, ASS convention)."""
    r, g, b = _parse_hex(h)
    return Color(r, g, b, alpha)


def hex_to_ass_color(h: str) -> str:
    """Return ``&H00BBGGRR`` string for use inside ``\\c`` / ``\\3c`` tags."""
    r, g, b = _parse_hex(h)
    return f"&H00{b:02X}{g:02X}{r:02X}"


def ms_to_ass_time(ms: int) -> str:
    """Convert milliseconds → ``H:MM:SS.cc`` (ASS centi-second precision)."""
    if ms < 0:
        ms = 0
    cs = ms // 10
    s, cs = divmod(cs, 100)
    m, s = divmod(s, 60)
    h, m = divmod(m, 60)
    return f"{h:d}:{m:02d}:{s:02d}.{cs:02d}"


# ---------------------------------------------------------------------------
# ASSBuilder
# ---------------------------------------------------------------------------
class ASSBuilder:
    """Compose a pysubs2 SSAFile from CaptionConfig + ASSLine / word lists."""

    def __init__(self, config: CaptionConfig):
        self.config = config
        self.sub = SSAFile()
        # pysubs2 stores resolution / wrap as plain dict entries
        self.sub.info["PlayResX"] = config.play_res_x
        self.sub.info["PlayResY"] = config.play_res_y
        self.sub.info["ScaledBorderAndShadow"] = "yes"
        self.sub.info["WrapStyle"] = str(config.wrap_style)
        # Seed a default style so callers can `add_line(...)` immediately
        self.set_style(
            "Default",
            fontname=config.font_name,
            fontsize=config.font_size,
            primarycolor=hex_to_color(config.primary_color),
            secondarycolor=hex_to_color("FFFFFF"),
            outlinecolor=hex_to_color(config.outline_color),
            backcolor=hex_to_color(config.back_color, alpha=0x80),
            outline=float(config.outline_width),
            shadow=float(config.shadow),
            alignment=config.position,
            marginl=config.margin_l,
            marginr=config.margin_r,
            marginv=config.margin_v,
            bold=config.bold,
            italic=config.italic,
            scalex=config.scale_x,
            scaley=config.scale_y,
            spacing=config.spacing,
            borderstyle=config.border_style,
        )

    # ------------------------------------------------------------------
    # Styles
    # ------------------------------------------------------------------
    def set_style(self, name: str, **kwargs: Any) -> SSAStyle:
        """Register / replace an SSAStyle and return it."""
        style = SSAStyle()
        for key, val in kwargs.items():
            setattr(style, key, val)
        self.sub.styles[name] = style
        return style

    # ------------------------------------------------------------------
    # Plain dialogue lines
    # ------------------------------------------------------------------
    def add_line(self, line: ASSLine) -> SSAEvent:
        """Append a dialogue line. ``line.text`` should already contain tags."""
        ev = SSAEvent()
        ev.start = int(line.start_ms)
        ev.end = int(line.end_ms)
        ev.style = line.style
        ev.layer = line.layer
        ev.name = line.name
        ev.text = line.text
        # pysubs2 needs margin fields defaulted; -1 → use style
        ev.marginl = line.style_overrides.get("marginl", -1)
        ev.marginr = line.style_overrides.get("marginr", -1)
        ev.marginv = line.style_overrides.get("marginv", -1)
        ev.effect = line.style_overrides.get("effect", "")
        self.sub.events.append(ev)
        return ev

    # ------------------------------------------------------------------
    # Karaoke line — \\kf tags fill words progressively
    # ------------------------------------------------------------------
    def add_karaoke_line(
        self,
        words: list[WordTimestamp],
        fill_color: str = "31E981",
        base_color: str = "FFFFFF",
        style: str = "Default",
        layer: int = 0,
        padding_ms: int = 60,
    ) -> SSAEvent:
        """Emit a single Dialogue line whose words fill (``\\kf``) as spoken.

        Sets *primary* (``\\1c``) to ``fill_color`` and *secondary*
        (``\\2c``) to ``base_color`` once at line start, then issues
        ``\\kf{cs}`` for each syllable.  libass handles the per-word
        white→green transition natively.
        """
        if not words:
            raise ValueError("add_karaoke_line: empty word list")

        start_ms = max(0, int(words[0].start * 1000) - padding_ms)
        end_ms = int(words[-1].end * 1000) + padding_ms

        fill_ass = hex_to_ass_color(fill_color)
        base_ass = hex_to_ass_color(base_color)

        # Set both primary AND secondary ONCE — \kf will animate between them
        # per syllable.  Adding \fad(40,40) for smooth chunk in/out.
        parts: list[str] = [
            f"{{\\fad(40,40)\\1c{fill_ass}\\2c{base_ass}}}"
        ]
        for w in words:
            cs = w.duration_ms                       # centi-seconds
            parts.append(f"{{\\kf{cs}}}{w.word} ")

        text = "".join(parts).rstrip()
        line = ASSLine(
            start_ms=start_ms, end_ms=end_ms,
            text=text, style=style, layer=layer,
        )
        return self.add_line(line)

    # ------------------------------------------------------------------
    # Pop line — chunk-level pop-in + per-word active colour
    # ------------------------------------------------------------------
    def add_pop_line(
        self,
        words: list[WordTimestamp],
        active_color: str = "FFE500",
        scale: float = 1.18,
        style: str = "Default",
        layer: int = 0,
        padding_ms: int = 60,
        pop_duration_ms: int = 180,
    ) -> SSAEvent:
        """Emit a chunk whose words light up (``\\kf``) in ``active_color``
        as they are spoken, plus a chunk-level pop-in ``\\t`` for kinetic feel.

        Parameters
        ----------
        active_color : hex
            Colour the active (currently-spoken) word transitions to.
        scale : float
            Peak overshoot scale (e.g. ``1.18`` → 118%) during the chunk's
            pop-in. The chunk pops from 80% → ``scale*100``% → 100% over
            ``pop_duration_ms`` milliseconds, giving a slight bounce.

        Notes
        -----
        Per-word colour emphasis uses ``\\kf`` (libass native) because raw
        ``\\t`` transitions leak through to downstream words on the same
        Dialogue line — see module docstring.
        """
        if not words:
            raise ValueError("add_pop_line: empty word list")

        chunk_start_ms = max(0, int(words[0].start * 1000) - padding_ms)
        chunk_end_ms = int(words[-1].end * 1000) + padding_ms

        active_ass = hex_to_ass_color(active_color)
        base_ass = hex_to_ass_color("FFFFFF")

        init_pct = 80                                   # start shrunken
        peak_pct = max(100, int(scale * 100))          # peak overshoot
        final_pct = 100                                # settle
        half = max(20, pop_duration_ms // 2)

        # Chunk-level pop-in: shrink → overshoot → settle
        pop_in = (
            f"\\fscx{init_pct}\\fscy{init_pct}"
            f"\\t(0,{half},\\fscx{peak_pct}\\fscy{peak_pct})"
            f"\\t({half},{pop_duration_ms},\\fscx{final_pct}\\fscy{final_pct})"
        )
        header = (
            "{\\fad(40,40)" + pop_in +
            f"\\1c{active_ass}\\2c{base_ass}" + "}"
        )

        parts: list[str] = [header]
        for w in words:
            cs = w.duration_ms
            parts.append(f"{{\\kf{cs}}}{w.word} ")

        text = "".join(parts).rstrip()
        line = ASSLine(
            start_ms=chunk_start_ms, end_ms=chunk_end_ms,
            text=text, style=style, layer=layer,
        )
        return self.add_line(line)

    # ------------------------------------------------------------------
    # Save
    # ------------------------------------------------------------------
    def save(self, path: str) -> str:
        """Write the .ass file (UTF-8 with BOM, libass-friendly)."""
        parent = os.path.dirname(os.path.abspath(path))
        os.makedirs(parent or ".", exist_ok=True)
        # pysubs2 emits UTF-8 with BOM for ass — required by some players.
        self.sub.save(path, encoding="utf-8")
        return path

    # ------------------------------------------------------------------
    # Introspection
    # ------------------------------------------------------------------
    def to_string(self) -> str:
        """Return the entire ASS as a string (debugging / preview)."""
        return self.sub.to_string("ass")

    @property
    def event_count(self) -> int:
        return len(self.sub.events)


__all__ = [
    "ASSBuilder",
    "CaptionConfig",
    "WordTimestamp",
    "ASSLine",
    "hex_to_color",
    "hex_to_ass_color",
    "ms_to_ass_time",
]


# ---------------------------------------------------------------------------
# Standalone smoke test
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    cfg = CaptionConfig(style="bold_pop", font_name="Anton", font_size=110)
    b = ASSBuilder(cfg)

    sample = [
        WordTimestamp("This",    0.0,  0.35),
        WordTimestamp("is",      0.35, 0.55),
        WordTimestamp("kinetic", 0.55, 1.05),
        WordTimestamp("text",    1.05, 1.40),
    ]
    b.add_pop_line(sample, active_color="FFE500", scale=1.18)

    kara = [
        WordTimestamp("Ka", 2.0, 2.20),
        WordTimestamp("ra", 2.20, 2.40),
        WordTimestamp("o",  2.40, 2.60),
        WordTimestamp("ke", 2.60, 2.85),
    ]
    b.add_karaoke_line(kara, fill_color="31E981")

    out = "/tmp/ass_builder_smoke.ass"
    b.save(out)
    print(f"✅ wrote {out} ({b.event_count} events)")
    print(b.to_string())
