# Sound Designer (B8)

End-to-end **music + SFX + ducking + LUFS-normalized mix** for the micky-assistant
montage pipeline. Wraps the Jamendo (CC-BY music) and Freesound (CC0 SFX) APIs,
synthesizes a sidechain-compression ducking envelope from WhisperX speech
segments, and mixes all layers into a final track normalized to **-14 LUFS**
(YouTube/TikTok broadcast standard).

## Stage in the pipeline

`Stage 4.5: Sound Design` runs between **Stage 6 (captions)** and
**Stage 7 (Remotion render)** in `pipeline.py`:

```
Stage 6  Captions (kinetic ASS + brand restyle)
   ↓
Stage 4.5  Sound Design (B8)  ← THIS MODULE
   ↓  graded_video is rebound to the sound-designed MP4
Stage 7  Remotion animations (operates on the sound-designed video)
```

The stage is **opt-in via presence of credentials** — if `JAMENDO_CLIENT_ID`
and `FREESOUND_TOKEN` are both unset AND the local `MusicLibrary` (B4) is empty,
`SoundDesigner.auto_design_track` will simply loudness-normalize the existing
speech audio to -14 LUFS and pass it through to Stage 7. Add `'sound_design'`
to `options['skip_stages']` to skip it entirely.

---

## 1. Jamendo API setup (CC-BY music)

Jamendo is a music platform that exposes a free CC-BY-licensed catalog via a
simple REST API. Tracks are returned as MP3 (32/64/128 kbps streams) with full
metadata (BPM, mood tags, artist, license URL).

### Get a client_id

1. Go to <https://developer.jamendo.com/> and create a free developer account.
2. Click **"My Apps" → "Add a new app"**.
3. Fill in any name + description; the redirect URI is irrelevant for server-
   side use (we only hit the public `/v3.0/tracks/` endpoint).
4. Copy the **Client ID** (a 32-char hex string).

### Set the env var

```bash
export JAMENDO_CLIENT_ID="your_client_id_here"
```

Or pass it explicitly via the constructor:

```python
from sound_designer import SoundDesigner
designer = SoundDesigner(jamendo_client_id="your_client_id_here")
```

The pipeline forwards both paths via `options['jamendo_client_id']`.

### Rate limits

- 50 requests / second per client_id (burst), 60 000 / day.
- Track downloads count as a single request each.
- A 20-track BPM+ mood query is one request → can serve ~3 000 videos/day.

### License

All Jamendo tracks are **CC-BY** (Creative Commons Attribution). You MUST
display attribution for every track used. `SoundDesigner._fetch_from_jamendo`
writes a `.json` sidecar next to each downloaded MP3:

```json
{
  "source": "jamendo",
  "track_id": 12345,
  "title": "Sunny Day",
  "artist": "Acoustic Garden",
  "url": "https://www.jamendo.com/track/12345",
  "license": "https://creativecommons.org/licenses/by/4.0/",
  "downloaded_at": "2026-11-10T14:32:11"
}
```

The pipeline copies these JSONs into `<output_dir>/sound_attribution/` after
Stage 4.5 completes. **You must paste the artist + track + URL into the video
description of every published reel that uses a Jamendo track.**

---

## 2. Freesound API setup (CC0 SFX)

Freesound is the largest collaborative database of CC-licensed sound effects.
We filter to **Creative Commons 0** (public domain) only — no attribution
required, no commercial restrictions, no derivative-work limitations.

### Get a token

1. Create a free account at <https://freesound.org/docs/api/> (or log in with
   an existing one).
2. Go to **"My API keys"** under your profile.
3. Click **"Request a new API key"** — fill in any project description.
4. Copy the **API token** (32-char hex).

### Set the env var

```bash
export FREESOUND_TOKEN="your_api_token_here"
```

Or pass via constructor / pipeline options:

```python
designer = SoundDesigner(freesound_token="your_token")
# or
options['freesound_token'] = "your_token"
```

### Rate limits

- 60 requests / minute, 2 000 / day (free tier).
- Premium plans exist but are not required for typical usage.
- Each SFX download is one preview-URL fetch → roughly 30 SFX / minute cap.

### License

All sounds filtered by `license:"Creative Commons 0"` are public domain —
**no attribution required**, no restrictions. `SoundDesigner._fetch_from_freesound`
still writes a `.json` sidecar for transparency / dataset provenance, but it
is not legally required.

### SFX types

The `select_sfx(sfx_type, count)` method accepts these values:

| `sfx_type`   | Use case                                  | Query sent to Freesound        |
|--------------|-------------------------------------------|--------------------------------|
| `whoosh`     | generic scene-cut transition              | `whoosh`                       |
| `whoosh_in`  | rising whoosh (zoom-in)                   | `whoosh rising`                |
| `whoosh_out` | falling whoosh (zoom-out)                 | `whoosh falling`               |
| `impact`     | hard cut, punch emphasis                  | `impact`                       |
| `riser`      | tension-build before reveal               | `riser`                        |
| `transition` | generic between-shot transition           | `transition`                   |

`auto_design_track` currently uses `whoosh` for every scene cut. Pass
explicit types via per-cut SFX selection (future enhancement).

---

## 3. Ducking algorithm (sidechain compression)

When speech is active, the music track must "duck" (drop in level) so the
speaker is intelligible. This is the classic broadcast-radio ducking effect.

### Primary strategy: `sidechaincompress`

`SoundDesigner.duck_music_under_speech` first builds a **sidechain trigger**
audio file — a mono 44.1 kHz sine tone (80 Hz) whose amplitude is 0.5 during
each speech segment `[start, end]` and 0 elsewhere, generated via the
`volume='<expr>':eval=frame` FFmpeg filter:

```
expr = min(0.5, 0.5 * (between(t,0.5,1.2) + between(t,3.0,4.1) + ...))
```

(The `min(0.5, ...)` cap prevents the trigger from clipping above 0.5 even
when speech segments overlap.)

The trigger is then fed as the **sidechain input** to FFmpeg's
`sidechaincompress` filter, which compresses the music whenever the trigger
rises above the threshold:

```bash
ffmpeg -i music.mp3 -i trigger.wav \
  -filter_complex "[0:a][1:a]sidechaincompress=\
    threshold=0.05:ratio=10:attack=5:release=200[mixed]" \
  -map "[mixed]" -ar 44100 -ac 2 -c:a pcm_s16le ducked.wav
```

| Parameter    | Value | Meaning                                              |
|--------------|-------|------------------------------------------------------|
| `threshold`  | 0.05  | Trigger amplitude above which compression kicks in.  |
| `ratio`      | 10    | 10:1 compression — ~20 dB reduction.                |
| `attack`     | 5 ms  | Fast — speech onsets are sharp.                      |
| `release`    | 200 ms| Slower — avoids abrupt music volume jumps.           |

This produces smooth, broadcast-style ducking without the hard volume
"stomping" of naive gain automation.

### Fallback: per-segment `volume` automation

If `sidechaincompress` is unavailable (older FFmpeg builds, missing
`--enable-libavfilter`) or fails for any reason, we fall back to a
`volume='<expr>':eval=frame` filter that switches between 1.0 (no speech)
and the linear factor of `reduction_db` (default -12 dB → 0.251):

```
expr = if(gt(between(t,a,b) + between(t,c,d), 0), 0.251, 1.0)
```

This is faster but produces harder, less natural-sounding ducking edges.
Tune the reduction via the `reduction_db` kwarg.

---

## 4. LUFS normalization (-14 for YouTube/TikTok)

Loudness normalization is the last step of `mix_final_audio` and uses
FFmpeg's `loudnorm` filter (EBU R128 implementation).

### Mix gains (before loudnorm)

| Layer  | Gain  | Linear factor | Reason                                  |
|--------|-------|---------------|-----------------------------------------|
| Speech | 0 dB  | 1.000         | Reference level — must be intelligible. |
| Music  | -18 dB| 0.126         | Background — sits well below speech.    |
| SFX    | -6 dB | 0.501         | Above music, below speech — punches.    |

These are applied via per-layer `volume=` filters before `amix`. The `amix`
filter uses `normalize=0` (no auto-attenuation by 1/sqrt(N)) so the
hand-tuned levels survive into the final mix.

### Target loudness

- **-14 LUFS** integrated (YouTube + TikTok recommendation).
- True-peak max **-1.0 dBTP** (avoidance of inter-sample peaks).
- Loudness range (LRA) **11 LU** (broadcast-typical, allows some dynamics).

```bash
ffmpeg -i video.mp4 -i music.wav -i sfx.wav -i speech.wav \
  -filter_complex "
    [1:a]volume=0.126[m];
    [2:a]volume=0.501[s];
    [3:a]volume=1.000[sp];
    [sp][m][s]amix=inputs=3:duration=first:normalize=0[mixed];
    [mixed]loudnorm=I=-14:TP=-1.0:LRA=11:linear=true[final]
  " \
  -map 0:v -map "[final]" -c:v copy -c:a aac -b:a 192k -shortest out.mp4
```

### Why -14 LUFS?

YouTube's normalization target is **-14 LUFS** (since 2015). Videos uploaded
below this are normalized UP (loss of dynamic range); above are normalized
DOWN (peak limit). Targeting exactly -14 means YouTube applies **no
normalization** — the mix as delivered is the mix the viewer hears.

TikTok follows the same convention (it normalizes to -14 LUFS internally).
Instagram Reels is slightly louder (~-13 LUFS) but -14 is safe across
platforms.

### Two-pass mode (opt-in)

Single-pass `loudnorm` is fast but can under-shoot the target by 1-2 LU on
highly dynamic material. For tighter compliance (broadcast-grade), set the
env var:

```bash
export MICKY_LOUDNORM_TWOPASS=1
```

This switches to EBU R128 two-pass mode with `print_format=summary`. Slower
(~2× per video) but lands within ±0.5 LU of -14 in our tests.

---

## 5. License attribution requirements

### Jamendo (CC-BY 4.0)

**Required.** Every Jamendo track used in a published video MUST be
attributed in the video description with:

1. Track title
2. Artist name
3. Jamendo track URL (or `shareurl`)
4. License URL (`https://creativecommons.org/licenses/by/4.0/`)
5. Any modifications (e.g. "ducked under speech")

`SoundDesigner._fetch_from_jamendo` writes this metadata as
`/tmp/micky_audio/music_<id>.mp3.json` next to each downloaded MP3. The
pipeline copies all `*.json` attribution files into
`<output_dir>/sound_attribution/` after Stage 4.5 completes.

Suggested description template:

```
---
Music:
  Title: Sunny Day
  Artist: Acoustic Garden
  URL: https://www.jamendo.com/track/12345
  License: CC-BY 4.0 (https://creativecommons.org/licenses/by/4.0/)
  Modified: ducked under speech, level adjusted to -18 dB.
---
```

### Freesound (CC0 / Public Domain)

**Not required.** All Freesound sounds used by this pipeline are filtered to
`license:"Creative Commons 0"` (public domain dedication). You may use them
commercially without attribution, but Freesound asks that you mention the
sound IDs / contributor names where possible (best practice, not legal req).

The `*.json` sidecar metadata is still written for transparency and dataset
provenance, but you are not legally obligated to include it in published
videos.

### Local `MusicLibrary` (B4)

The B4 MusicLibrary stores per-track license info in its `index.json`. Most
of the seeded tracks are CC0 (Pixabay Content License, FreePD public domain,
Mixkit Free License) — none require attribution, but we still surface their
license URLs in the JSON sidecars.

---

## 6. File layout

All intermediate audio is written under `/tmp/micky_audio/` (NOT under
`/kaggle/working/`) so the Kaggle output dir stays clean. Files are
intentionally left in place between runs to act as a download cache:

```
/tmp/micky_audio/
├── music_<jamendo_id>.mp3         # Downloaded Jamendo track
├── music_<jamendo_id>.mp3.json    # Attribution metadata
├── sfx_<type>_<sound_id>.wav      # Downloaded + transcoded SFX
├── sfx_<type>_<sound_id>.wav.json # Provenance metadata (CC0)
├── speech_trigger.wav             # Sidechain trigger (transient)
├── speech_extracted.wav           # Speech audio extracted from video
├── music_ducked_<hash>.wav       # Ducking result (transient)
├── sfx_track_<hash>.wav           # SFX layer placed at cuts (transient)
└── <video>_sounddesigned.mp4     # Final output (passed to Stage 7)
```

To force a clean re-download (e.g. for testing), delete the directory:

```bash
rm -rf /tmp/micky_audio/
```

---

## 7. API call to `auto_design_track`

End-to-end usage from `pipeline.py`:

```python
from sound_designer import SoundDesigner

designer = SoundDesigner(
    jamendo_client_id=options.get('jamendo_client_id'),
    freesound_token=options.get('freesound_token'),
    music_library_path=options.get('music_library_path'),
)

sound_designed_video = designer.auto_design_track(
    video_path=graded_video,
    scene_boundaries=stats['scene_boundaries'],  # list[dict|SceneBoundary]
    whisperx_result=whisperx_result,            # dict with 'segments'
    mood='calm',                                 # optional override
)
```

`auto_design_track` does, in order:

1. **Extract speech** from the input video → `speech_extracted.wav` (mono).
2. **Detect BPM** from speech/music — `BeatSync` (beat-this model) first,
   librosa fallback, default 120 BPM if both unavailable.
3. **Resolve mood** — caller override > first scene's `metadata.mood` >
   `'neutral'`.
4. **Select music** — local `MusicLibrary.get_track_by_bpm` first; Jamendo API
   as fallback. Returns `""` if both fail.
5. **Duck music** under WhisperX speech segments via sidechain compression
   (or volume-automation fallback).
6. **Place SFX** at every cut point (skip scene 0 — it's the opening, not a
   cut). `whoosh` SFX by default, cycled if fewer fetched than cuts.
7. **Mix** speech (0 dB) + ducked music (-18 dB) + SFX track (-6 dB) into
   the final video, loudness-normalized to -14 LUFS. Video stream is copied
   (no re-encode) to preserve grading quality.

Returns the path to the final MP4. On any error, falls back to the original
`video_path` (graceful degradation — never crashes the pipeline).
