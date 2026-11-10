"""
Caption generator (P4-T2 + P4-T6).
================================
Produces Alex-Hormozi-style word-by-word captions from Whisper's
word-level timestamps.

Features:
    - Word-level emphasis for dental keywords (تبييض، زراعة، تسوس، …)
    - Emoji injection for high-impact dental terms
    - Phrase grouping (3–5 words or sentence boundary) for Remotion rendering
    - Arabic-aware: punctuation list includes '،' and '؟'
    - Three styles supported:
        hormozi      → bold yellow text with black stroke, RTL Cairo font
        minimal      → small white text bottom-center
        arabic_bold  → large white text with subtle gradient

Output: captions.json (consumed by remotion_renderer.py)

Created: 2026-11-10
"""
from __future__ import annotations

import json
import os
import re
from typing import Any

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
    """Generate Hormozi-style captions from a transcript.

    Args:
        transcript: Either:
            - dict: result from whisper.transcribe() (with "segments" + "text")
            - str: plain text transcript (segmentation will be automatic)
            - list: list of segment dicts [{start, end, text}, ...]
        style: Caption style. 'hormozi' (default), 'arabic_hormozi', 'podcast', 'minimal'.
        output_dir: Where to save caption files.
        language: Language code ('en', 'ar', 'auto'). If 'auto', detect from transcript.

    Returns:
        dict: {
            "segments": [...],  # list of {start, end, words: [...]}
            "ass_path": str,   # path to .ass subtitle file (for ffmpeg burn-in)
            "json_path": str,  # path to .json (for Remotion/animations)
            "word_count": int,
        }
    """
    import os, json, re
    from pathlib import Path

    os.makedirs(output_dir, exist_ok=True)

    # Normalize transcript input to list of segments
    segments = _normalize_transcript(transcript)

    # Detect language
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

        # Split text into words (preserve Arabic + English)
        words = re.findall(r'[\w\u0600-\u06FF]+|[^\s\w\u0600-\u06FF]', seg_text, re.UNICODE)
        words = [w for w in words if w.strip()]

        # Distribute timing across words (roughly proportional to word length)
        total_chars = sum(len(w) for w in words)
        if total_chars == 0:
            continue

        current_time = seg_start
        seg_duration = seg_end - seg_start

        for word in words:
            word_duration = (len(word) / total_chars) * seg_duration
            word_end = current_time + word_duration
            word_segments.append({
                "word": word,
                "start": current_time,
                "end": word_end,
                "duration": word_duration,
            })
            current_time = word_end

    print(f"[caption] Total words: {len(word_segments)}")

    # Apply style-specific coloring
    styled_words = _apply_style(word_segments, style, language)

    # Generate .ass subtitle file (for ffmpeg burn-in)
    ass_path = os.path.join(output_dir, "captions.ass")
    _write_ass_file(styled_words, ass_path, style, language)
    print(f"[caption] .ass file: {ass_path}")

    # Generate JSON file (for Remotion / Canvas animations)
    json_path = os.path.join(output_dir, "captions.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({
            "style": style,
            "language": language,
            "word_count": len(styled_words),
            "words": styled_words,
        }, f, ensure_ascii=False, indent=2)
    print(f"[caption] .json file: {json_path}")

    return {
        "segments": segments,
        "words": styled_words,
        "ass_path": ass_path,
        "json_path": json_path,
        "word_count": len(styled_words),
    }


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
    """Detect if transcript is Arabic or English based on character usage."""
    arabic_chars = 0
    total_chars = 0
    for seg in segments:
        text = seg.get("text", "")
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
    """Write a .ass (Advanced SubStation Alpha) subtitle file with Hormozi styling.

    The .ass format supports per-word coloring, positioning, and basic animations
    via \\fad and \\t (transform) tags.
    """

    # Choose font
    if language == "ar":
        font_name = "Cairo"
        font_size = 80
    else:
        font_name = "Anton"
        font_size = 90

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
    """
    Group word dicts into phrases. A phrase breaks at:
        - max_words reached
        - a phrase-ending punctuation char
        - a silence gap > 0.6s between consecutive words
    """
    phrases: list[dict[str, Any]] = []
    current: list[dict[str, Any]] = []

    for w in words:
        current.append(w)
        ends_sentence = any(ch in w['word'] for ch in PHRASE_END_CHARS)
        is_long_pause = False
        if len(current) >= 2:
            gap = w['start'] - current[-2]['end']
            is_long_pause = gap > 0.6

        if len(current) >= max_words or ends_sentence or is_long_pause:
            phrases.append({
                'words': current,
                'start': current[0]['start'],
                'end': current[-1]['end'],
            })
            current = []

    if current:
        phrases.append({
            'words': current,
            'start': current[0]['start'],
            'end': current[-1]['end'],
        })

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
# Standalone CLI (for debugging)
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    import sys
    if len(sys.argv) < 2:
        print('Usage: caption_generator.py <transcript.json> [style] [out_dir]')
        sys.exit(1)
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        t = json.load(f)
    style = sys.argv[2] if len(sys.argv) > 2 else 'hormozi'
    out_dir = sys.argv[3] if len(sys.argv) > 3 else '.'
    result = generate_captions(t, style, out_dir)
    print(f'✅ {len(result["words"])} words → captions.json')
