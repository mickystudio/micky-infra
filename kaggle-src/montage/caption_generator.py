"""
Caption generator (P4-T2 + P4-T6 + B5 kinetic upgrade).
=======================================================
Produces Alex-Hormozi-style word-by-word captions from Whisper's
word-level timestamps.

Features:
    - Word-level emphasis for dental keywords (تبييض، زراعة، تسوس، …)
    - Emoji injection for high-impact dental terms
    - Phrase grouping (3–5 words or sentence boundary) for Remotion rendering
    - Arabic-aware: punctuation list includes '،' and '؟'
    - Three legacy styles supported:
        hormozi      → bold yellow text with black stroke, RTL Cairo font
        minimal      → small white text bottom-center
        arabic_bold  → large white text with subtle gradient
    - Six kinetic (B5) styles via the new KineticCaptionGenerator:
        bold_pop, karaoke_fill, boxed, clean_lower, hormozi, tiktok_default
      (see kinetic_captions.py + README_kinetic.md)

Output: captions.json (consumed by remotion_renderer.py)
        + kinetic.ass (consumed by FFmpeg libass for burn-in)

Created: 2026-11-10  |  B5 kinetic upgrade: 2026-11-12
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

# Local imports — same package directory (B5 kinetic pipeline)
sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from kinetic_captions import KineticCaptionGenerator, VALID_STYLES
    _KINETIC_AVAILABLE = True
except ImportError:  # pragma: no cover
    _KINETIC_AVAILABLE = False

# ---------------------------------------------------------------------------
# Dental keyword → emoji map (Arabic + English)
# ---------------------------------------------------------------------------
DENTAL_KEYWORDS: dict[str, str] = {
    # Arabic
    'تبييض':    '🦷',
    'زراعة':    '🦷',
    'تقويم':    '😁',
    'تنظيف':    '🪥',
    'تسوس':     '⚠️',
    'ألم':      '😖',
    'عصب':      '🦷',
    'لثة':      '👄',
    'ابتسامة':  '😊',
    'تجويف':    '🕳️',
    'ضرس':      '🦷',
    'ضروس':     '🦷',
    'سنة':      '🦷',
    'أسنان':    '🦷',
    'طبيب':     '👨‍⚕️',
    'عيادة':    '🏥',
    'خدر':      '💉',
    'حشوة':     '🦷',
    'ركيزة':    '🦷',
    # English (fallback)
    'whitening': '🦷',
    'implant':   '🦷',
    'braces':    '😁',
    'cleaning':  '🪥',
    'cavity':    '⚠️',
    'pain':      '😖',
    'smile':     '😊',
    'dentist':   '👨‍⚕️',
}

# Punctuation that ends a phrase
PHRASE_END_CHARS = ('.', '!', '?', '،', '؟', ':', ';')

# Strip these chars before keyword matching
_STRIP_PUNCT_RE = re.compile(r'[.,!?،؟:";()\[\]{}«»""\']+')


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def generate_captions(transcript, style="hormozi", output_dir=".", language="auto"):
    """Generate Hormozi-style captions from a transcript (legacy SRT path).

    Args:
        transcript: dict (whisper result), str (plain text), or list of
            segment dicts [{start, end, text}, ...].
        style: 'hormozi', 'arabic_hormozi', 'podcast', or 'minimal'.
        output_dir: Where to save caption files.
        language: 'en', 'ar', or 'auto'.

    Returns: {segments, words, ass_path, json_path, word_count}.
    """
    import os, json, re
    from pathlib import Path

    os.makedirs(output_dir, exist_ok=True)
    segments = _normalize_transcript(transcript)
    if language == "auto":
        language = _detect_language(segments)
    print(f"[caption] Language: {language}, Style: {style}, Segments: {len(segments)}")

    # Split each segment into individual words with timing
    word_segments = []
    for seg in segments:
        seg_start = float(seg.get("start", 0))
        seg_end = float(seg.get("end", seg_start + 1))
        seg_text = seg.get("text", "").strip()
        if not seg_text:
            continue
        # Preserve Arabic + English word boundaries
        words = [w for w in re.findall(
            r'[\w\u0600-\u06FF]+|[^\s\w\u0600-\u06FF]', seg_text, re.UNICODE
        ) if w.strip()]
        total_chars = sum(len(w) for w in words)
        if total_chars == 0:
            continue
        current_time = seg_start
        seg_duration = seg_end - seg_start
        for word in words:
            word_duration = (len(word) / total_chars) * seg_duration
            word_end = current_time + word_duration
            word_segments.append({
                "word": word, "start": current_time,
                "end": word_end, "duration": word_duration,
            })
            current_time = word_end

    print(f"[caption] Total words: {len(word_segments)}")
    styled_words = _apply_style(word_segments, style, language)

    ass_path = os.path.join(output_dir, "captions.ass")
    _write_ass_file(styled_words, ass_path, style, language)
    print(f"[caption] .ass file: {ass_path}")

    json_path = os.path.join(output_dir, "captions.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({"style": style, "language": language,
                  "word_count": len(styled_words), "words": styled_words},
                 f, ensure_ascii=False, indent=2)
    print(f"[caption] .json file: {json_path}")

    return {"segments": segments, "words": styled_words, "ass_path": ass_path,
            "json_path": json_path, "word_count": len(styled_words)}


def _normalize_transcript(transcript):
    """Convert various transcript input formats to a list of segment dicts."""
    if isinstance(transcript, str):
        # Plain text: split by sentences/punctuation, fake timing
        import re
        sentences = re.split(r'[.!?؟\n]+', transcript)
        sentences = [s.strip() for s in sentences if s.strip()]
        # Assume ~3 seconds per sentence
        return [{"start": i * 3.0, "end": (i + 1) * 3.0, "text": s} for i, s in enumerate(sentences)]
    elif isinstance(transcript, dict):
        if "segments" in transcript:
            return transcript["segments"]
        elif "text" in transcript:
            return _normalize_transcript(transcript["text"])
    elif isinstance(transcript, list):
        return transcript
    return []


def _detect_language(segments):
    """Detect if transcript is Arabic or English based on character usage.

    Falls back to inspecting ``words[*].word`` when segments lack a ``text``
    field (WhisperX word-only output).
    """
    arabic_chars = 0
    total_chars = 0
    for seg in segments:
        text = seg.get("text", "")
        if not text and seg.get("words"):
            # WhisperX word-only output: reconstruct from word list
            text = " ".join(w.get("word", "") for w in seg["words"])
        for c in text:
            if '\u0600' <= c <= '\u06FF':
                arabic_chars += 1
            if c.isalpha():
                total_chars += 1
    if total_chars > 0 and arabic_chars / total_chars > 0.3:
        return "ar"
    return "en"


def _apply_style(words, style, language):
    """Apply style-specific color cycling + emphasis to word list."""

    # Hormozi color palette (cycle through these)
    HORMOZI_COLORS = ["#FFFFFF", "#FFD700", "#00FF7F", "#FF6347", "#FFFFFF", "#FFA500"]
    ARABIC_COLORS = ["#FFFFFF", "#FFD700", "#00CED1", "#FF6347"]
    PODCAST_COLORS = ["#FFFFFF", "#E0E0E0", "#FFFFFF", "#C0C0C0"]
    MINIMAL_COLORS = ["#FFFFFF"]

    if style == "arabic_hormozi":
        colors = ARABIC_COLORS
    elif style == "podcast":
        colors = PODCAST_COLORS
    elif style == "minimal":
        colors = MINIMAL_COLORS
    else:  # hormozi (default)
        colors = HORMOZI_COLORS

    # Emphasis words (boost scale + color)
    EMPHASIS_WORDS = {"important", "huge", "massive", "never", "always", "best", "worst",
                       "مهم", "كبير", "ضخم", "أبدا", "دائما", "أفضل", "أسوأ"}

    styled = []
    for i, w in enumerate(words):
        word = w["word"]
        color = colors[i % len(colors)]
        is_emphasis = word.lower().strip(".,!?؟") in EMPHASIS_WORDS
        scale = 1.15 if is_emphasis else 1.0

        styled.append({
            "word": word,
            "start": w["start"],
            "end": w["end"],
            "duration": w["duration"],
            "color": color,
            "scale": scale,
            "emphasis": is_emphasis,
            "animation": "pop_in" if style in ("hormozi", "arabic_hormozi") else "fade_in",
        })

    return styled


def _write_ass_file(words, path, style, language):
    """Write a .ass subtitle file with Hormozi styling (legacy SRT path).

    Supports per-word coloring, positioning, and basic animations via
    \\fad and \\t tags.  Superseded by KineticCaptionGenerator in B5.
    """
    # Choose font
    font_name, font_size = ("Cairo", 80) if language == "ar" else ("Anton", 90)

    # .ass header
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hormozi,{font_name},{font_size},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,80,80,300,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    # Format time as H:MM:SS.cc
    def fmt_time(t):
        h = int(t // 3600)
        m = int((t % 3600) // 60)
        s = int(t % 60)
        cs = int((t - int(t)) * 100)
        return f"{h}:{m:02d}:{s:02d}.{cs:02d}"

    lines = [header]

    for w in words:
        start = fmt_time(w["start"])
        end = fmt_time(w["end"])
        # .ass color: BGR format, &H00BBGGRR
        # Convert hex #RRGGBB to &H00BBGGRR
        hex_color = w["color"].lstrip("#")
        r = int(hex_color[0:2], 16)
        g = int(hex_color[2:4], 16)
        b = int(hex_color[4:6], 16)
        ass_color = f"&H00{b:02X}{g:02X}{r:02X}"

        scale_pct = int(w["scale"] * 100)
        # Animation: fade in 50ms + scale transform
        text = (
            f"{{\\fad(50,0)\\fscx{scale_pct}\\fscy{scale_pct}\\c{ass_color}\\bord4\\shad2}}"
            f"{w['word']}"
        )
        lines.append(f"Dialogue: 0,{start},{end},Hormozi,,0,0,0,,{text}")

    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def is_emphasis_word(word: str) -> bool:
    """True if `word` (after punctuation-stripping + lowercasing) is a dental keyword."""
    cleaned = _clean_word(word)
    return any(_clean_word(k) == cleaned for k in DENTAL_KEYWORDS.keys())


def emoji_for_word(word: str) -> str | None:
    """Return an emoji for dental keywords, else None."""
    cleaned = _clean_word(word)
    for keyword, emoji in DENTAL_KEYWORDS.items():
        if _clean_word(keyword) == cleaned:
            return emoji
    # Also handle "contains" — e.g. "الزراعة" should match "زراعة"
    for keyword, emoji in DENTAL_KEYWORDS.items():
        if _clean_word(keyword) in cleaned and len(cleaned) < 12:
            return emoji
    return None


def group_into_phrases(
    words: list[dict[str, Any]],
    max_words: int = 4,
) -> list[dict[str, Any]]:
    """Group word dicts into phrases (max_words / punctuation / >0.6s gap)."""
    phrases: list[dict[str, Any]] = []
    current: list[dict[str, Any]] = []
    for w in words:
        current.append(w)
        ends_sentence = any(ch in w['word'] for ch in PHRASE_END_CHARS)
        is_long_pause = (len(current) >= 2
                         and (w['start'] - current[-2]['end']) > 0.6)
        if len(current) >= max_words or ends_sentence or is_long_pause:
            phrases.append({'words': current,
                            'start': current[0]['start'],
                            'end': current[-1]['end']})
            current = []
    if current:
        phrases.append({'words': current,
                        'start': current[0]['start'],
                        'end': current[-1]['end']})

    return phrases


def format_caption_for_remotion(captions: dict) -> dict:
    """
    Return a Remotion-friendly view of captions:
    {
        'phrases': [{words, start, end}],
        'style', 'language'
    }
    """
    return {
        'phrases': captions.get('phrases', []),
        'style': captions.get('style', 'hormozi'),
        'language': captions.get('language', 'ar'),
    }


def _clean_word(word: str) -> str:
    """Lowercase + strip leading/trailing punctuation + Arabic diacritics."""
    cleaned = _STRIP_PUNCT_RE.sub('', word).strip()
    # Strip Arabic diacritics (tashkeel) for robust matching
    cleaned = re.sub(r'[\u064B-\u0652\u0670\u0640]', '', cleaned)
    return cleaned.lower()


# ---------------------------------------------------------------------------
# B5: Kinetic captions (CapCut-style animated ASS via libass)
# ---------------------------------------------------------------------------
def generate_kinetic_captions(
    whisperx_result: dict,
    video_path: str | None = None,
    output_dir: str = ".",
    style: str = "auto",
    language: str = "auto",
    font_name: str = "Anton",
    font_size: int = 110,
    burn_in: bool = True,
) -> dict:
    """Generate CapCut-style kinetic captions (B5 upgrade).

    Pipeline: WhisperX → KineticCaptionGenerator.generate_ass (.ass) →
    optional FFmpeg libass burn-in (.mp4).

    Six styles: bold_pop, karaoke_fill, boxed, clean_lower, hormozi,
    tiktok_default (see README_kinetic.md).

    Args:
        whisperx_result: WhisperX dict (segments[*].words[*] or word_segments).
        video_path: Source video for burn-in (None = .ass only).
        output_dir: Output directory (created if missing).
        style: Kinetic style, 'auto' (detect), or legacy hint
            ('vlog'→bold_pop, 'podcast'→clean_lower, 'promotional'→hormozi).
        language: 'ar', 'en', or 'auto' (auto switches font to Cairo).
        font_name / font_size: overrides (Anton → Cairo for Arabic).
        burn_in: If True and video_path given, also produce burned video.

    Returns: {ass_path, burned_path, style, language, font_name,
              font_size, word_count, chunk_count}
    """
    if not _KINETIC_AVAILABLE:
        raise RuntimeError(
            "KineticCaptionGenerator not available — install pysubs2 "
            "(pip install pysubs2>=1.7.0) or use legacy generate_captions()"
        )
    os.makedirs(output_dir, exist_ok=True)

    if language == "auto":
        language = _detect_language(_normalize_transcript(whisperx_result))
    print(f"[kinetic] Language: {language}")

    # Style auto-detect + legacy hint mapping
    if style == "auto":
        style = KineticCaptionGenerator.detect_style(whisperx_result)
        print(f"[kinetic] Auto-detected style: {style}")
    elif style in ("vlog", "vlogger", "casual"):
        style = "bold_pop"
    elif style in ("podcast", "interview", "talking_head"):
        style = "clean_lower"
    elif style in ("promo", "promotional", "ad", "advertising"):
        style = "hormozi"
    elif style not in VALID_STYLES:
        legacy = {"arabic_hormozi": "hormozi",
                  "minimal": "clean_lower",
                  "arabic_bold": "bold_pop"}
        if style in legacy:
            print(f"[kinetic] Mapped legacy style {style!r} → {legacy[style]}")
            style = legacy[style]
        else:
            raise ValueError(
                f"unknown style {style!r}; valid: {sorted(VALID_STYLES)}"
            )

    if language == "ar" and font_name in ("Anton", "Impact"):
        font_name = "Cairo"
    elif not font_name:
        font_name = "Anton"

    gen = KineticCaptionGenerator(style=style, font_name=font_name,
                                   font_size=font_size)
    ass_path = os.path.join(output_dir, "kinetic.ass")
    gen.generate_ass(whisperx_result, ass_path)

    words = gen.extract_words(whisperx_result)
    chunks = gen.chunk_words(words)
    # Reflect the actual font used (may differ from input if Arabic was
    # auto-detected → switched Anton → Cairo inside generate_ass).
    from kinetic_captions import is_arabic_text
    if (is_arabic_text(" ".join(w.word for w in words))
            and font_name in ("Anton", "Impact")):
        font_name = "Cairo"
    print(f"[kinetic] {len(words)} words → {len(chunks)} chunks "
          f"(style={style}, font={font_name})")

    burned_path: str | None = None
    if burn_in and video_path:
        burned_path = os.path.join(output_dir, "kinetic_burned.mp4")
        try:
            gen.burn_into_video(video_path, ass_path, burned_path)
        except Exception as e:
            print(f"[kinetic] ⚠️  burn-in failed: {e}")
            burned_path = None

    return {"ass_path": ass_path, "burned_path": burned_path, "style": style,
            "language": language, "font_name": font_name,
            "font_size": font_size, "word_count": len(words),
            "chunk_count": len(chunks)}


# ---------------------------------------------------------------------------
# Standalone CLI (for debugging)
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: caption_generator.py <transcript.json> [style] [out_dir]')
        sys.exit(1)
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        t = json.load(f)
    style = sys.argv[2] if len(sys.argv) > 2 else 'hormozi'
    out_dir = sys.argv[3] if len(sys.argv) > 3 else '.'

    kinetic_styles = VALID_STYLES | {'auto', 'vlog', 'podcast', 'promotional'}
    if _KINETIC_AVAILABLE and style in kinetic_styles:
        print('[main] Using kinetic caption pipeline (B5)')
        result = generate_kinetic_captions(t, None, out_dir, style=style)
        print(f'✅ {result["word_count"]} words → {result["ass_path"]} '
              f'(style={result["style"]})')
    else:
        print('[main] Using legacy SRT caption pipeline')
        result = generate_captions(t, style, out_dir)
        print(f'✅ {len(result["words"])} words → captions.json')
