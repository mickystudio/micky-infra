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
def generate_captions(
    transcript: dict,
    style: str = 'hormozi',
    output_dir: str = '.',
) -> dict:
    """
    Generate captions from Whisper transcript.

    Args:
        transcript: Whisper output with `word_timestamps=True`. Each
                    segment must contain a `words` list of
                    {word, start, end} dicts.
        style:      'hormozi' | 'minimal' | 'arabic_bold'
        output_dir: Where to save captions.json.

    Returns:
        {
            'words': [{'word', 'start', 'end', 'emphasis', 'emoji'}],
            'phrases': [{'words', 'start', 'end'}],
            'style': str,
            'language': 'ar',
            'total_duration': float,
        }
    """
    words: list[dict[str, Any]] = []

    # 1. Flatten segment-level words into a single word list
    for segment in transcript.get('segments', []):
        seg_words = segment.get('words', [])
        # Fallback: if word-level missing, synthesize from segment text
        if not seg_words and segment.get('text'):
            seg_start = float(segment.get('start', 0))
            seg_end = float(segment.get('end', seg_start + 1))
            seg_text = segment['text'].strip()
            tokens = seg_text.split()
            if tokens:
                per_word = (seg_end - seg_start) / max(1, len(tokens))
                for i, tok in enumerate(tokens):
                    seg_words.append({
                        'word': tok,
                        'start': seg_start + i * per_word,
                        'end':   seg_start + (i + 1) * per_word,
                    })

        for w in seg_words:
            word_text = (w.get('word') or '').strip()
            if not word_text:
                continue
            start = float(w.get('start', 0))
            end = float(w.get('end', start))

            words.append({
                'word': word_text,
                'start': start,
                'end': max(end, start + 0.05),
                'emphasis': is_emphasis_word(word_text),
                'emoji': emoji_for_word(word_text),
            })

    # 2. Group words into phrases (3–5 words or sentence boundary)
    phrases = group_into_phrases(words, max_words=4)

    # 3. Build the output object
    captions: dict[str, Any] = {
        'words': words,
        'phrases': phrases,
        'style': style,
        'language': 'ar',
        'total_duration': words[-1]['end'] if words else 0.0,
    }

    # 4. Persist
    os.makedirs(output_dir, exist_ok=True)
    captions_path = os.path.join(output_dir, 'captions.json')
    with open(captions_path, 'w', encoding='utf-8') as f:
        json.dump(captions, f, ensure_ascii=False, indent=2)
    print(f"   💬 Saved captions → {captions_path} ({len(words)} words, "
          f"{len(phrases)} phrases)")

    return captions


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
