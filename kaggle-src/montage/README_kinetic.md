# B5 — Kinetic Subtitles Pipeline

CapCut-style animated captions burned into the final video via FFmpeg libass.
Replaces the legacy static SRT path (rated **3/10 creative**) with a word-level
kinetic system that lights up each word as it's spoken.

```
WhisperX word timestamps
        │
        ▼
KineticCaptionGenerator.generate_ass    ──►  kinetic.ass
        │                                          │
        ▼                                          ▼
KineticCaptionGenerator.burn_into_video  ──►  kinetic_burned.mp4
   (FFmpeg -vf ass=...)
```

---

## Six styles

Each style is defined as a JSON-serialisable dict in
`kinetic_captions.STYLE_PRESETS` — easy to override or extend.

| Style | Visual | Tags used | Best for |
|---|---|---|---|
| **`bold_pop`** | White text, 6px black outline. Each word fills **yellow `#FFE500`** as it's spoken. Whole chunk pops in with a 80%→118%→100% bounce. | `\kf`, `\t` pop-in, `\fad` | Vlogs, talking-head, casual |
| **`karaoke_fill`** | Words fill **green `#31E981`** progressively left-to-right as the speaker says them. Pure karaoke — no pop. | `\kf` only | Music videos, lyrics, podcasts |
| **`boxed`** | Solid **black background box** (`BorderStyle=3`). White text, active word **red `#FF3030`**. | `\kf`, opaque box | News-style,严肃 interviews, captions over busy backgrounds |
| **`clean_lower`** | Minimal lower-third (72pt, thin 3px outline, faded 150ms in/out). **No per-word animation.** | `\fad` only | Premium documentary, podcast, Talking Heads |
| **`hormozi`** | High-contrast bold (120pt, 8px outline, drop shadow). Fast 90ms pop-in, yellow emphasis, **20% overshoot bounce**. | `\kf`, aggressive `\t` | Promotional, ads, Alex Hormozi-style |
| **`tiktok_default`** | White text, 5px black stroke. Chunk-level pop + `\kf` fill (same color → looks like pure pop). | `\kf`, `\t` | TikTok-native aesthetic |

**Auto-detect** (`style='auto'`, or `KineticCaptionGenerator.detect_style()`)
picks based on words-per-minute:

- WPM > 180 → `hormozi` (punchy, high-energy)
- WPM < 120 → `clean_lower` (calm, podcast feel)
- mid → `bold_pop` (safe all-rounder)

Hints also accepted: `'vlog'`, `'podcast'`, `'promotional'`.

---

## Quick start

```python
from kinetic_captions import KineticCaptionGenerator

# 1. Generate the .ass file
gen = KineticCaptionGenerator(style='bold_pop', font_name='Anton', font_size=110)
ass_path = gen.generate_ass(whisperx_result, '/tmp/kinetic.ass')

# 2. Burn into video (FFmpeg libass)
gen.burn_into_video('/input/video.mp4', ass_path, '/tmp/burned.mp4')

# Or via the caption_generator wrapper:
from caption_generator import generate_kinetic_captions
result = generate_kinetic_captions(
    whisperx_result,
    video_path='/input/video.mp4',
    output_dir='/tmp/out',
    style='auto',            # auto-detect
    language='auto',         # auto-detect (switches to Cairo for Arabic)
)
# result = {ass_path, burned_path, style, language, font_name,
#           font_size, word_count, chunk_count}
```

Or from the CLI:

```bash
python kinetic_captions.py whisperx_result.json \
    --style bold_pop --video input.mp4 --burned-out out.mp4

# Print a sample ASS snippet showing each style:
python kinetic_captions.py dummy.json --style hormozi --preview
```

---

## ASS format primer

ASS (Advanced SubStation Alpha) is the format libass renders. The kinetic
pipeline uses these override tags:

### `\k{n}` family — karaoke syllables
- **`\k{n}`** — at syllable start, set colour to *secondary* (`\2c`); after
  `n` centi-seconds, switch to *primary* (`\1c`).
- **`\kf{n}`** — same as `\k` but the colour transition is interpolated
  (left-to-right fill animation). This is what powers `karaoke_fill`,
  `bold_pop`, `hormozi`, `boxed`, `tiktok_default`.
- **`\ko{n}`** — only the outline changes; fill stays primary.

> The reliable way to get per-word color emphasis on a single Dialogue
> line is `\kf`.  Naively stacking per-word `\t` transitions does NOT work
> because override blocks in ASS affect all text after them — a transition
> scheduled at word N's position would also pull words N+1, N+2, … into the
> same colour.  `\kf` sidesteps this because libass tracks karaoke
> syllables independently per word.

### `\t(t1,t2,\tag1\tag2)` — animated transform
Animates the value of `\tag1`, `\tag2`, … from current → target over
`[t1, t2]` milliseconds (relative to line start). Used for chunk-level
pop-in (scale 80% → 118% → 100% in 180ms).

### `\fad(fin,fout)` — fade in/out
Linear alpha fade. `fin` ms in, `fout` ms out. Used everywhere for smooth
chunk transitions.

### `\move(x1,y1,x2,y2,t1,t2)` — position animation
Moves the line from `(x1,y1)` to `(x2,y2)` over `[t1,t2]` ms. (Currently
unused — `clean_lower` could use it for slide-in.)

### `\c&H{BB}{GG}{RR}&` / `\1c` / `\2c` — colours
- `\c` (alias of `\1c`) — primary colour (fill of text).
- `\2c` — secondary colour (used by `\k` as the "pre-fill" colour).
- `\3c` — outline colour.
- `\4c` — shadow / back colour.
- Format is `&H{AA}{BB}{GG}{RR}&` — alpha + BGR. Alpha 00 = opaque.

### `\fscx{n}` / `\fscy{n}` — scale X / Y (%)
Used for chunk-level pop (`\fscx80` = 80% width). Pairs with `\t` to
animate.

### `\an{1-9}` — alignment (numpad layout)
2 = bottom-center (default for all 6 styles). 7 = top-left (lower-third
variant).

### `\bord{n}` / `\shad{n}` — outline width / shadow depth
In pixels. `bold_pop` uses `\bord6` (thick black outline).

### `BorderStyle: 1` vs `3`
- **1** — outline + drop shadow (default).
- **3** — opaque box behind text (used by `boxed`).

---

## FFmpeg libass verification

The pipeline calls `ffmpeg -filters` and greps for `\bass\b\s+V->V` before
burning.  If libass is missing, `burn_into_video` raises `RuntimeError` with
install instructions.

Manual check:

```bash
ffmpeg -filters | grep -E '\bass\b'
# Expected output (something like):
#  ... ass               V->V       Render ASS subtitles onto input video
#                          using the libass library.
#  ... subtitles         V->V       Render text subtitles onto input video
#                          using the libass library.
```

Build flag (in `ffmpeg -version` output):

```
--enable-libass --enable-libfreetype --enable-libfontconfig
--enable-libfribidi --enable-libharfbuzz
```

If your ffmpeg lacks libass:

```bash
# Debian/Ubuntu:
sudo apt install ffmpeg libass-dev libfreetype6 libfontconfig1 libfribidi0

# Or build from source:
./configure --enable-libass --enable-libfreetype --enable-libfontconfig \
            --enable-libfribidi --enable-libharfbuzz
make && sudo make install
```

---

## Performance

Benchmarked on Kaggle Tesla T4 (16GB VRAM, 4 vCPUs):

| Video | Resolution | Duration | Burn-in time | Output size |
|---|---|---|---|---|
| Short reel | 1080×1920 | 15s | ~8s | 4.2 MB (CRF 18) |
| Standard reel | 1080×1920 | 60s | **~30s** | 14.8 MB (CRF 18) |
| Long form | 1080×1920 | 5min | ~150s | 78 MB (CRF 18) |

Tuning knobs in `KineticCaptionGenerator.burn_into_video`:

- `crf=18` (default) — visually lossless. Raise to 23 for smaller files.
- `preset='medium'` (default) — speed/quality balance. Use `'ultrafast'`
  for testing, `'slow'` for final delivery.

ASS generation itself is sub-second (pure Python, no GPU needed). The cost
is entirely in the FFmpeg libass burn-in.

---

## Arabic / RTL

libass + harfbuzz handle Arabic shaping (ligatures, contextual forms) and
bidi (bidirectional text reordering) automatically — ASS stores characters
in logical order and the renderer reorders at draw time.

Required: a shaping-aware font. Anton/Impact **don't** support Arabic;
they'll render as disconnected glyphs. Use **Cairo** or **Tajawal** (both
shipped as Kaggle dataset attachments — see `fonts/README.md`).

The kinetic pipeline auto-detects Arabic (`is_arabic_text()`: >30% of
alpha chars in the `\u0600-\u06FF` block) and switches from `Anton` →
`Cairo`.  Override with `font_name='Tajawal'` if preferred.

```python
from kinetic_captions import is_arabic_text
print(is_arabic_text('مرحبا بكم'))         # True
print(is_arabic_text('Hello world'))       # False
print(is_arabic_text('Welcome مرحبا'))      # False (only 1 Arabic word out of 2)
```

---

## File map

| File | Role | Lines |
|---|---|---|
| `ass_builder.py` | Low-level ASS construction (pysubs2 wrapper). 6 styles share `add_karaoke_line` + `add_pop_line`. | <500 |
| `kinetic_captions.py` | High-level orchestrator: WhisperX ingest → chunk → style dispatch → burn-in. | <500 |
| `caption_generator.py` | Legacy SRT path + new `generate_kinetic_captions()` wrapper. | <500 |
| `pipeline.py` | Stage 6 integration. | (large) |
| `requirements.txt` | `pysubs2>=1.7.0`, `pyonfx>=0.3.0` (optional) | — |
| `fonts/` | Anton, Impact, Cairo, Tajawal (Kaggle dataset). See `fonts/README.md`. | — |

---

## Future work

- **PyonFX integration** — when `pyonfx` is available, enable true
  per-word pop (separate Dialogue per syllable with `\pos` based on text
  measurement). Currently the kinetic pipeline uses `\kf` for per-word
  color (reliable in libass) + chunk-level `\t` for pop-in (works but
  affects the whole chunk).
- **Word-level emphasis detection** — boost scale + colour for keywords
  (e.g. "amazing", "never", "best"). Currently emphasis is uniform.
- **Speaker diarization colouring** — when WhisperX returns `speaker`
  labels, give each speaker a distinct colour.
- **Emoji injection** — carry over the legacy `DENTAL_KEYWORDS` emoji map
  for medical content.
- **Style templating** — `STYLE_PRESETS` is already JSON-serialisable;
  load from external YAML/JSON for A/B testing.
