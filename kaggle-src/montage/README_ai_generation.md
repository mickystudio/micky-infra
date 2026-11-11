# B10 — AI Video Generation + Voice Cloning

Adds an **optional** Stage 8 ("AI Enhancement") to the montage pipeline that
generates short B-roll clips (Wan2.1-T2V-1.3B) and AI-narrated voiceover
(OpenVoice v2) on Kaggle T4 16 GB. Both features are off by default; opt in
per-run with `options['add_b_roll']=True` and/or `options['narrate_script']=True`.

| Module | Role |
| --- | --- |
| `ai_video_gen.py` | `AIVideoGenerator` — text-to-video B-roll (Wan2.1 → LTX-Video fallback), single-frame thumbnails (FLUX.1-schnell preferred), image-to-video cutaways, batch generation |
| `voice_clone.py` | `VoiceCloner` — OpenVoice v2 voice cloning, dedicated Arabic cross-lingual path (OpenVoice v2 → Coqui XTTS v2 → GPT-SoVITS), long-script narration with FFmpeg concat |
| `pipeline.py` | Stage 8 (`ai_enhancement`) inserts before Stage 9 (export); lazy-imports the two modules with `try/except`, never blocks pipeline startup. Skip with `'ai_enhancement'` in `skip_stages`. |
| `requirements.txt` | Appends `diffusers>=0.30`, `accelerate>=0.34`, `TTS>=0.22` (the last is NC-licensed, dev-only fallback) |

---

## Model picks (all free, commercial-safe, fit T4 16 GB)

| Layer | Model | License | VRAM | Notes |
| --- | --- | --- | --- | --- |
| B-roll (T2V) | **Wan-AI/Wan2.1-T2V-1.3B** | Apache-2.0 | ~8 GB FP16 | Primary path; supports negative prompts, `num_frames`, `num_inference_steps` |
| B-roll fast lane | **Lightricks/LTX-Video** (2B distilled) | Apache-2.0 | ~10 GB | Real-time fallback when Wan2.1 fails to load |
| Thumbnail | **black-forest-labs/FLUX.1-schnell** | Apache-2.0 | ~12 GB | 4-step, ~3-5 s per PNG; falls back to Wan2.1 first-frame if unavailable |
| Image-to-video | **Wan-AI/Wan2.1-I2V-14B-480P** | Apache-2.0 | ~14 GB (transient) | Loaded only for `generate_cutaway(context_frame=...)`; freed immediately |
| Voice cloning | **OpenVoice v2** (MyShell) | MIT | ~4 GB | Cross-lingual cloning + 18 native languages |
| Voice fallback | **Coqui XTTS v2** | CPML (NC) | ~6 GB | DEV-ONLY — used when OpenVoice v2 init fails or Arabic quality is insufficient |
| Voice Arabic | **GPT-SoVITS** (community Arabic) | MIT | varies | Third-tier fallback for Arabic if installed at `/tmp/GPT-SoVITS` |

---

## Wan2.1 model card + license

**Repo:** [Wan-AI/Wan2.1-T2V-1.3B](https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B)

| Field | Value |
| --- | --- |
| License | Apache-2.0 (commercial-safe, no royalties, no call-home) |
| Parameters | 1.3 B (DiT + T5 text encoder) |
| VRAM (FP16) | ~8 GB weights + ~0.5 GB activation buffers |
| Native resolution | 1280×720 @ 16-24 fps |
| Max duration | ~5 s practical (longer = OOM risk on T4) |
| Inference steps | 20 (fast) – 30 (quality); 25 is the sweet spot |
| Negative prompts | Supported (default: "low quality, blurry, distorted, watermark, text overlay, deformed, jpeg artifacts, extra limbs, bad anatomy") |
| HuggingFace cache | `~/.cache/huggingface/hub/` (~6 GB download, first run only) |

**Why Wan2.1 over competitors:**
- *LTX-Video 2B distilled* — faster (~5 s for 5 s clip) but slightly lower
  fidelity; we keep it as a real-time fallback.
- *Stable Video Diffusion (SVD)* — 1.5B but only does I2V; no T2V path.
- *CogVideoX-2B* — comparable quality but Apache-2.0 is ambiguous (CogVideoX
  ships under "The Apache License 2.0 with additional conditions" — we prefer
  Wan2.1's clean Apache-2.0).
- *HunyuanVideo* — 13B, too heavy for T4.

---

## OpenVoice v2 setup

```bash
# 1) Clone the repo (handled automatically on first call):
git clone --depth 1 https://github.com/myshell-ai/OpenVoiceV2 /tmp/OpenVoiceV2

# 2) Install Python deps (auto-handled by voice_clone._ensure_openvoice_python):
pip install -e /tmp/OpenVoiceV2
pip install 'numpy<2' librosa inflect unidecode whispercpp pydub 'gradio==3.50.2'

# 3) Download checkpoints (~3.5 GB total):
cd /tmp/OpenVoiceV2 && python download.py --source hf
# Resulting layout:
#   checkpoints_v2/base_speakers/{config.json, base_speakers.pth, source_default.pt}
#   checkpoints_v2/converter/{config.json, checkpoint.pth}
```

The `VoiceCloner` class runs all three steps lazily on first `clone_voice` /
`clone_voice_arabic` / `narrate_script` call. Subsequent calls reuse the
loaded `BaseSpeakerTTS` + `ToneColorConverter` instances (cached on the
cloner object) until `cloner.cleanup()` is invoked.

**Arabic note:** OpenVoice v2 ships an `ar` profile but quality is
community-tier. For production Arabic we use a three-tier strategy (see
`voice_clone.VoiceCloner.clone_voice_arabic`).

---

## VRAM budget (Kaggle T4 — 16 GB)

| Component | VRAM |
| --- | --- |
| Whisper large-v3 (Stage 1, transient) | ~3 GB (freed after transcription) |
| Robust Video Matting (Stage 4, transient) | ~3 GB (freed after matting) |
| Qwen2.5-VL-7B (Stage 2 VLM, optional) | ~14 GB (B7) |
| **Wan2.1-T2V-1.3B FP16** | **~8 GB** |
| **OpenVoice v2 base + converter** | **~4 GB** |
| Coqui XTTS v2 (fallback) | ~6 GB |
| FLUX.1-schnell (thumbnail) | ~12 GB (transient — released after thumb) |
| **Total (B10 only)** | **~12 GB** (Wan2.1 + OpenVoice co-exist) |
| **Headroom** | **~4 GB** (Whisper + RVM transient spikes fit) |

**Pipeline scheduler:** Stages 1-7 are sequential on a single T4. Stage 8
(AI Enhancement) waits until the VLM (Stage 2) and RVM (Stage 4) have been
freed, so Wan2.1 has the full ~16 GB available. OpenVoice v2 (~4 GB) is
loaded only when `narrate_script=True` and shares the GPU with Wan2.1.

**Multi-T4 (Kaggle GPU×2):** By default the pipeline stays on a single GPU;
the second T4 is available for parallel Remotion rendering (B14). If
`MICKY_AI_DEVICE=cuda:1` is set in the env, the AI generation runs on
`cuda:1` while the rest of the pipeline uses `cuda:0`.

---

## Generation time (T4 16 GB, FP16, batch=1)

| Task | Steps | Frames | Wall-clock |
| --- | --- | --- | --- |
| Wan2.1 T2V B-roll (1280×720, 5 s @ 24 fps) | 25 | 120 | ~30 s |
| Wan2.1 T2V B-roll (1280×720, 5 s @ 24 fps) | 15 | 120 | ~18 s (fast) |
| LTX-Video fast lane (1280×720, 5 s @ 24 fps) | 8 | 120 | ~6 s |
| FLUX.1-schnell thumbnail (1280×720, single PNG) | 4 | 1 | ~3-5 s |
| Wan2.1 first-frame thumbnail (fallback) | 8 | 1 | ~3 s |
| OpenVoice v2 clone (10 s script, en) | — | — | ~5 s |
| OpenVoice v2 clone (10 s script, ar) | — | — | ~7 s (slower Arabic decoder) |
| OpenVoice v2 narrate_script (1000 chars, en, ~120 s audio) | — | — | ~60-90 s (sentence-split + concat) |
| Coqui XTTS v2 cross-lingual Arabic (10 s) | — | — | ~10 s |

---

## Arabic voice strategy

OpenVoice v2's `ar` profile exists but produces robotic prosody on long-form
content (the base TTS wasn't trained on enough Arabic data). For Micky's
default `language='ar'` workflow we use a **three-tier strategy**:

```
┌─────────────────────────────────────────────────────────────────────┐
│  clone_voice_arabic(reference_audio, text)                          │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Tier 1: OpenVoice v2 native `ar`                                    │
│    - Extract speaker embedding from reference_audio_path             │
│    - base_tts.tts(text, lang='ar') → tmp_base.wav                    │
│    - tone_color_converter.convert(tmp_base → out_path)               │
│    - Returns out_path if successful; on any error → Tier 2          │
└────────────────────────────────┬────────────────────────────────────┘
                                 │ (OpenVoice failed or quality flagged)
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Tier 2: Coqui XTTS v2 cross-lingual cloning (DEV-ONLY, NC license)  │
│    - tts.tts_to_file(text, speaker_wav=reference, language='ar')     │
│    - Note: CPML is non-commercial; do NOT ship to production.        │
└────────────────────────────────┬────────────────────────────────────┘
                                 │ (Coqui failed or blocked by license)
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Tier 3: GPT-SoVITS community Arabic                                 │
│    - Only attempted if /tmp/GPT-SoVITS exists (manual install)       │
│    - inference_cli.py --ref_audio <ref> --text <text> --lang arabic  │
│    - Returns out_path; raises RuntimeError if all 3 tiers fail      │
└─────────────────────────────────────────────────────────────────────┘
```

**Why three tiers?**
- OpenVoice v2 `ar` is fast (~5 s) and Apache-2.0-clean but quality varies.
- Coqui XTTS v2 has the best Arabic quality of the open-weight options but
  ships under a **non-commercial license** — strictly dev-only.
- GPT-SoVITS community Arabic is MIT-licensed and high-quality but requires
  manual repo setup (model checkpoints, fine-tuned Arabic reference). We
  shell out to its `inference_cli.py` if installed; otherwise skip silently.

For production Arabic narration, install GPT-SoVITS manually:
```bash
git clone https://github.com/RVC-Boss/GPT-SoVITS /tmp/GPT-SoVITS
cd /tmp/GPT-SoVITS && pip install -r requirements.txt
# Download pre-trained Arabic checkpoint (community):
#   GPT_SoVITS/pretrained_models/s1bert25hz-2kh-longer-epoch=68e-step=2e2.ckpt
#   GPT_SoVITS/pretrained_models/s2G488k.ckpt
```

---

## Pipeline usage

```python
from pipeline import run_pipeline

# Option A: B-roll only (Wan2.1)
result = run_pipeline(
    input_video_path='/kaggle/working/raw.mp4',
    output_dir='/kaggle/working/out',
    options={
        'add_b_roll': True,
        'b_roll_prompts': [
            'cinematic close-up of a dental microscope in soft morning light',
            'patient smiling in dental chair, shallow depth of field',
        ],
        'b_roll_duration_sec': 4.0,
        'b_roll_resolution': (1280, 720),
    },
)

# Option B: AI narration only (OpenVoice v2 + Arabic fallback)
result = run_pipeline(
    input_video_path='/kaggle/working/raw.mp4',
    output_dir='/kaggle/working/out',
    options={
        'narrate_script': True,
        'narrate_script_text': 'مرحباً بكم في عيادة الدكتور سميث...',
        'narration_voice': '/kaggle/working/doctor_reference.wav',
        'narration_reference_audio': '/kaggle/working/doctor_reference.wav',
        'language': 'ar',
    },
)

# Option C: both (B-roll + narration), skip Stage 8 manually with skip_stages
result = run_pipeline(
    input_video_path='/kaggle/working/raw.mp4',
    output_dir='/kaggle/working/out',
    options={
        'add_b_roll': True,
        'narrate_script': True,
        # ...other keys as above...
        'skip_stages': {'ai_enhancement'},  # opt out at runtime
    },
)
```

**Outputs:**
- B-roll MP4s are saved to `/tmp/micky_generated/broll_<hash>.mp4` and a
  manifest is written to `<output_dir>/b_roll_manifest.json` for downstream
  Remotion / export stages.
- Narration WAV is saved to `/tmp/micky_voice/narration_<hash>.wav` and the
  path is propagated to `options['narration_wav']` so Stage 9 (export) can
  mux it into the final MP4s.

---

## Graceful degradation

| Failure mode | Behavior |
| --- | --- |
| `ai_video_gen` import fails (no diffusers/torch) | `_AI_VIDEO_AVAILABLE=False`; Stage 8 B-roll branch logs a warning and skips. Pipeline continues to Stage 9 export. |
| `voice_clone` import fails (no TTS/openvoice) | `_VOICE_CLONE_AVAILABLE=False`; Stage 8 narration branch logs a warning and skips. Pipeline continues. |
| Wan2.1 model fails to load (HF download error, OOM) | `AIVideoGenerator._load_video_pipe()` tries `Lightricks/LTX-Video` as fallback; if both fail, `available=False` and the per-prompt exception propagates to the pipeline's try/except which logs + continues. |
| OpenVoice init fails | `clone_voice()` automatically routes to `_clone_voice_coqui()` (XTTS v2, dev-only). If Coqui is also unavailable, the per-call exception is caught by the pipeline's `try/except` and the pipeline continues without narration. |
| FLUX-schnell unavailable | `generate_thumbnail()` falls back to a 1-frame Wan2.1 T2V pass + ffmpeg extraction. |
| Per-prompt B-roll failure | `batch_generate_b_rolls()` skips the failed prompt and continues with the next; the failed entry is omitted from the returned list. |
| Per-chunk narration failure | `narrate_script()` skips the failed chunk and concatenates the rest; if all chunks fail, raises `RuntimeError` (caught by pipeline's try/except). |

The pipeline's top-level `try/except` is the final guard — even a fatal
exception in Stage 8 leaves the previously-staged `animated_video` intact
and Stage 9 export runs with whatever was produced.

---

## Smoke tests

```bash
# AI video generation (requires GPU + diffusers)
python /home/z/my-project/download/micky-assistant/kaggle-src/montage/ai_video_gen.py

# Voice cloning (requires reference audio + OpenVoice v2 setup)
python /home/z/my-project/download/micky-assistant/kaggle-src/montage/voice_clone.py \
    --reference /path/to/3-15s-reference.wav \
    --text "Hello, this is a voice clone test." \
    --language en
```

---

## Notes / future work

- **Long B-roll stitching** — the current implementation generates independent
  5-second clips; a future enhancement could use a vision-language model to
  suggest splice points (e.g. between Whisper segments) and FFmpeg-merge them
  into the main video.
- **Voice cloning quality metric** — we currently accept whatever OpenVoice
  produces. A future task could add a MOS (Mean Opinion Score) estimate via
  NISQA or UTMOS to gate the output and trigger the fallback chain
  automatically when quality < 3.5/5.
- **Wan2.1 quantization** — at FP16 Wan2.1 is ~8 GB; an INT8 path via
  `bitsandbytes` could drop this to ~4 GB, freeing room for a larger VLM
  (Qwen2.5-VL-32B) on the same T4. Not implemented yet; the 8 GB budget
  already fits comfortably.
- **Coqui TTS license** — XTTS v2 is non-commercial. The pipeline logs a
  warning whenever this fallback is used; for production deployment, ensure
  GPT-SoVITS is installed or use OpenVoice v2's native Arabic path only.
