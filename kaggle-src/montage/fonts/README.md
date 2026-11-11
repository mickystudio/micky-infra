# Fonts — Kinetic subtitles (B5)

This directory holds the font files used by the kinetic subtitle pipeline
(`kinetic_captions.py` + `ass_builder.py`).

## Required fonts

### Latin (English / European)

| Font | File | Use |
|---|---|---|
| **Anton** | `Anton-Regular.ttf` | Default for `bold_pop`, `karaoke_fill`, `boxed`, `clean_lower`, `hormozi`, `tiktok_default`. Bold condensed sans, ideal for short punchy captions. |
| **Impact** | `impact.ttf` | Windows-built-in alternative to Anton. Slightly heavier; use when Anton is unavailable. |

### Arabic (RTL)

| Font | File | Use |
|---|---|---|
| **Cairo** | `Cairo-Regular.ttf`, `Cairo-Bold.ttf` | Default Arabic font (auto-selected by `is_arabic_text()` when transcript is >30% Arabic). Modern Arabic sans-serif with full ligature support. |
| **Tajawal** | `Tajawal-Regular.ttf`, `Tajawal-Bold.ttf` | Alternative Arabic font (geometric, more "techy" feel). Use via `font_name='Tajawal'` override. |

## How to upload to Kaggle

1. **Download** the fonts (free, OFL-licensed):
   - Anton: <https://fonts.google.com/specimen/Anton>
   - Impact: bundled with Windows, or download `impact.ttf` from any
     Google Fonts mirror.
   - Cairo: <https://fonts.google.com/specimen/Cairo>
   - Tajawal: <https://fonts.google.com/specimen/Tajawal>

2. **Bundle** into a Kaggle dataset:
   ```bash
   kaggle datasets init -p /path/to/fonts
   # Edit dataset-metadata.json: title="micky-fonts", id="<your-username>/micky-fonts"
   kaggle datasets create -p /path/to/fonts
   ```

3. **Attach** the dataset to your notebook (Add Input → Your Datasets →
   `micky-fonts`).  It will be available at
   `/kaggle/input/micky-fonts/`.

4. **Point** the kinetic pipeline at it via the `fontsdir` argument
   (auto-detected if you place the `.ttf` files in this `fonts/` directory
   beside `kinetic_captions.py`):

   ```python
   # KineticCaptionGenerator.burn_into_video auto-looks for a sibling
   # fonts/ directory — but you can also pass an explicit path:
   gen = KineticCaptionGenerator(style='bold_pop', font_name='Anton')
   gen.generate_ass(whisperx_result, '/tmp/out.ass')
   gen.burn_into_video('/input.mp4', '/tmp/out.ass', '/tmp/out.mp4')
   # ↑ ffmpeg invocation will include:  -vf "ass='...':fontsdir='/kaggle/input/micky-fonts'"
   ```

   Or set the `MONTAGE_FONTS_DIR` environment variable.

## Font fallback chain

If `Anton` is missing, the renderer (libass + fontconfig) will substitute.
The fallback chain (configured by fontconfig) is:

```
Anton  →  Impact  →  DejaVu Sans Bold  →  Liberation Sans Bold
```

For Arabic:

```
Cairo  →  Tajawal  →  Noto Naskh Arabic  →  DejaVu Sans
```

> ⚠️  **DejaVu Sans Bold** is the typical fallback on Kaggle / Linux. It
> renders Arabic correctly (with harfbuzz shaping) but lacks the punchy
> condensed look of Anton — captions will look "thinner" than intended.
> Always ship the real fonts.

## Verifying fonts are picked up

After burn-in, check the FFmpeg log for `fontselect` lines:

```
[Parsed_ass_0 @ ...] fontselect: (Anton, 700, 0) -> Anton-Regular, 0, Anton-Regular
[Parsed_ass_0 @ ...] fontselect: (Cairo, 400, 0) -> Cairo-Regular, 0, Cairo-Regular
```

If you see `-> DejaVuSans-Bold` (or any non-requested font), the requested
font is missing and fontconfig fell back.  Add `:fontsdir=/path/to/fonts`
to the `ass` filter (handled automatically by `burn_into_video`).

## Quick test (no Kaggle needed)

```bash
# List available fonts on the host:
fc-list | grep -iE 'anton|impact|cairo|tajawal'

# Smoke-test the kinetic pipeline:
python kinetic_captions.py /path/to/whisperx.json \
    --style bold_pop --font Anton --size 110 --out /tmp/test.ass

# Verify the .ass file references the right font:
head -20 /tmp/test.ass | grep Style:
# Expected:  Style: Default,Anton,110,...
```

## License notes

- Anton, Cairo, Tajawal: SIL Open Font License 1.1 (free for commercial
  use, including burned-in video).
- Impact: bundled with Windows; redistribute `impact.ttf` per Microsoft's
  font redistribution terms (or use Anton instead).
