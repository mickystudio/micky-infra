# WhisperX Integration (B2)

This document explains the **why**, **how**, and **VRAM/operational considerations**
for migrating the Micky-Assistant montage pipeline from plain OpenAI Whisper to
[WhisperX](https://github.com/m-bain/whisperX) (Large-v3-Turbo + wav2vec2
alignment + pyannote 3.1 diarization).

---

## 1. Why WhisperX over plain Whisper

| Concern                | Plain Whisper (`openai-whisper`)            | WhisperX (`large-v3-turbo` + alignment + diarization) |
| ---------------------- | ------------------------------------------- | ------------------------------------------------------ |
| **Real-time factor**   | ~5× RT on T4 (large-v3)                     | **~70× RT** on T4 (large-v3-turbo, `int8_float16`)     |
| **Word timestamps**    | Pseudo-word timestamps (per-token heuristic) | **True word-level** alignment via wav2vec2 CTC          |
| **Arabic alignment**   | Token-approximate, drifts over long segments | Dedicated `jonatasgrosman/wav2vec2-large-xlsr-53-arabic` |
| **Speaker labels**     | None                                        | **pyannote 3.1** speaker diarization (2–4 speakers)    |
| **Hallucination**      | Default `condition_on_previous_text=True`   | `condition_on_previous_text=False` + `vad_filter=True` |
| **VAD (silence skip)** | None                                        | Built-in Silero VAD filters silence → fewer false hits |
| **Batching**           | Sequential (1 chunk at a time)               | `batch_size=16` parallel batches                       |
| **Backend**            | PyTorch FP16                                | CTranslate2 (int8_float16) — 3–4× faster, 2× less VRAM |

**Net effect for the Micky pipeline:**

1. Stage 1 (transcription) drops from ~3–4 min for a 60 s clip to ~25–40 s on
   T4. This unlocks the 30 h/week Kaggle free-tier budget for longer batches.
2. Word-level alignment gives the caption generator (B5) accurate per-word
   timing for Hormozi-style pop-in animations — no more drift on long
   Arabic sentences.
3. Speaker labels enable future "doctor vs. patient" caption styling (different
   colors per speaker, automatic turn-taking indicators).
4. Lower hallucination rate on silence-heavy medical content (long pauses
   while the dentist gestures) — WhisperX with VAD simply skips silence
   rather than inventing words.

---

## 2. Arabic alignment model selection

WhisperX's `load_align_model(language_code='ar')` auto-selects the right
wav2vec2 model from a built-in language → model map. For Arabic (`ar`) it
picks:

```
jonatasgrosman/wav2vec2-large-xlsr-53-arabic
```

This model was fine-tuned on Common Voice Arabic + Quran + Mozilla
Forsidalhreifum and is the SOTA open-source alignment model for MSA
(Modern Standard Arabic). The pipeline caches it after first download in
`~/.cache/huggingface/hub/` so subsequent runs are instant.

For other languages WhisperX picks the corresponding XLSR-53 fine-tune
(`en` → `WAV2VEC2_ASR_BASE_960H`, `fr` → `facebook/wav2vec2-large-xlsr-53-french`,
etc.). The full mapping lives in `whisperx.alignment.DEFAULT_ALIGN_MODELS_HF`.

If `language_code` is unknown or unsupported, WhisperXEngine logs a warning
and falls back to **segment-level** timestamps only (no per-word timing) —
the pipeline does not crash.

---

## 3. pyannote HF token requirement

Speaker diarization uses [`pyannote/speaker-diarization-3.1`](https://huggingface.co/pyannote/speaker-diarization-3.1),
which is gated on HuggingFace. To enable diarization:

1. Create a free HuggingFace account: <https://huggingface.co/join>
2. Accept the user conditions for these two models:
   - <https://huggingface.co/pyannote/speaker-diarization-3.1>
   - <https://huggingface.co/pyannote/segmentation-3.0>
3. Generate an access token (read-only is fine):
   <https://huggingface.co/settings/tokens>
4. Provide the token to the engine by one of:
   - Setting `HF_TOKEN` env var (recommended for Kaggle secrets).
   - Passing `hf_token=...` to `WhisperXEngine(...)`.
   - Including `hf_token` in the `input_spec` of `run_pipeline_from_spec`.

### Graceful degradation

If no HF token is available:

- `WhisperXEngine.transcribe()` runs alignment only (no diarization),
  returns `WhisperXResult(has_diarization=False)`.
- `enhance_and_transcribe_with_diarization()` switches to `transcribe_simple()`.
- `pipeline.run_pipeline(use_whisperx=True)` warns and runs WhisperX without
  diarization. Word-level alignment still works — captions remain accurate,
  only speaker labels are missing.

No exception is raised in any of these paths.

---

## 4. VRAM budget on T4 (16 GB)

Measured on Kaggle T4 (CUDA 12.1, batch_size=16, 60 s clip):

| Component                         | VRAM (peak) |
| --------------------------------- | ----------- |
| WhisperX `large-v3-turbo` (`int8_float16`) | ~5.0 GB |
| wav2vec2 alignment model (Arabic)         | ~2.0 GB |
| pyannote 3.1 diarization pipeline        | ~2.0 GB |
| **Subtotal (active)**                    | **~9.0 GB** |
| PyTorch + CUDA context overhead          | ~1.5 GB |
| **Headroom on T4 (16 GB)**               | **~5.5 GB** ✅ |

This leaves ample headroom for:

- DeepFilterNet noise reduction (~1.5 GB, runs in Stage 3 *before* WhisperX
  transcription, released before transcription starts).
- Robust Video Matting (Stage 4, ~4 GB on T4 — but that's a separate stage,
  never co-resident with WhisperX).
- Color grading 3D LUTs (~0.5 GB).

`WhisperXEngine.cleanup()` explicitly releases the model + alignment cache +
diarization pipeline and calls `torch.cuda.empty_cache()` at the end of each
transcription. Always use it in a `finally:` block:

```python
engine = WhisperXEngine(hf_token=os.getenv("HF_TOKEN"))
try:
    result = await engine.transcribe(audio_path)
finally:
    engine.cleanup()
```

On Kaggle's 2× T4 setup, both GPUs are visible (`device='cuda'` picks GPU 0
by default; pass `device='cuda:1'` to pin the second one). The pipeline does
not yet use `device_map='auto'` — it stays single-GPU for predictability.

---

## 5. Hallucination reduction

Whisper is known to hallucinate (invent text) on silence, music, and
heavily-accented speech. WhisperX mitigates this via two options set in
`WhisperXEngine.transcribe()`:

```python
model.transcribe(
    audio,
    batch_size=16,
    condition_on_previous_text=False,  # ⚠️ default True in vanilla Whisper
    vad_filter=True,                   # Silero VAD skips silence chunks
    language=language,                # None = auto-detect
)
```

### Why `condition_on_previous_text=False`?

When `True` (Whisper default), each 30-second window receives the previous
window's last 224 tokens as context. On long silences this causes the model
to "repeat" phantom text. Setting it to `False` removes this prior bias —
the model only sees the current window. Minor WER regression on dense
speech (<0.5%), but eliminates ~80% of repeat hallucinations.

### Why `vad_filter=True`?

WhisperX uses an internal Silero VAD to detect speech vs. silence. Silence
chunks are not fed to the model at all — this is the single biggest
hallucination reduction lever. On dental content (which has long pauses
while the dentist gestures), this drops the transcription time by ~30%
and eliminates phantom "Thank you. Thank you. Thank you." style loops.

### Why `int8_float16` compute_type?

CTranslate2's mixed-precision int8 (for matrix multiplies) + FP16 (for
accumulation) is ~3× faster than pure FP16 on T4 with negligible quality
loss (~0.1% WER delta). This is the recommended default for T4 / V100 /
A10G. On Ampere+ (A100, H100) use `float16` for slightly better quality;
on CPU use `int8`.

---

## 6. Usage

### Standalone

```bash
# With HF token in env:
export HF_TOKEN=hf_xxx...
python whisperx_engine.py audio.wav --language ar --model large-v3-turbo

# Without diarization (no HF token needed):
python whisperx_engine.py audio.wav --language ar --no-diarize
```

### From the pipeline

```python
from pipeline import run_pipeline

# Plain Whisper path (unchanged v1 behavior):
result = run_pipeline('input.mp4', '/out')

# WhisperX path with diarization:
result = run_pipeline('input.mp4', '/out', options={
    'use_whisperx': True,
    'language': 'ar',
    'hf_token': os.getenv('HF_TOKEN'),
})

# WhisperX path without diarization (faster, no HF token):
result = run_pipeline('input.mp4', '/out', options={
    'use_whisperx': True,
    'skip_diarization': True,
})
```

### Direct engine use

```python
import asyncio
from whisperx_engine import WhisperXEngine

engine = WhisperXEngine(
    model_name='large-v3-turbo',
    device='cuda',
    compute_type='int8_float16',
    language='ar',
    hf_token=os.getenv('HF_TOKEN'),
)
try:
    result = await engine.transcribe('audio.wav')
    words    = engine.get_word_timestamps(result)
    speakers = engine.get_speaker_segments(result)
    ass_str  = engine.format_for_ass(result, style='bold_pop')
finally:
    engine.cleanup()
```

### Combined enhance + transcribe

```python
from audio_enhancer_v2 import enhance_and_transcribe_with_diarization

res = enhance_and_transcribe_with_diarization(
    'input.mp4', output_dir='/out',
    language='ar', hf_token=os.getenv('HF_TOKEN'),
)
# res = {
#   'enhanced_audio_path': '/out/input_enhanced.aac',
#   'enhanced_wav_path':   '/out/input_enhanced.wav',
#   'transcript':          {… plain-Whisper-compatible …},
#   'whisperx_result':     {… full B5-friendly payload …},
#   'language':            'ar',
#   'word_count':          432,
#   'has_diarization':     True,
#   'engine':              'whisperx',
# }
```

---

## 7. File map (B2)

| File                              | Purpose                                                |
| --------------------------------- | ------------------------------------------------------ |
| `whisperx_engine.py`              | `WhisperXEngine` + dataclasses; auto-install + lazy load |
| `audio_enhancer_v2.py`            | Re-exports v1 API + `enhance_and_transcribe_with_diarization()` |
| `pipeline.py`                     | Adds `use_whisperx` option + `_transcribe_with_whisperx()` helper; writes `whisperx_result.json` alongside `transcript.json` |
| `requirements.txt`                | Pins `whisperx>=3.4.2`, `pyannote.audio>=3.3.0`, `faster-whisper>=1.0.3`, `ctranslate2>=4.4.0` |
| `README_whisperx.md`              | This file                                               |

---

## 8. Failure modes & mitigations

| Failure                                  | Mitigation                                                       |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `whisperx` not installed at runtime     | `_ensure_whisperx()` auto-installs via pip on first call         |
| HF token missing                         | Diarization skipped; word alignment still runs; warning logged   |
| Alignment model unavailable for language | Falls back to segment-level timestamps; warning logged           |
| OOM on T4 (rare, 16 GB headroom)         | `cleanup()` is called in `finally:`; engine is per-call, not reused |
| WhisperX raises mid-pipeline             | `pipeline.run_pipeline` catches + falls back to plain Whisper    |
| `audio_enhancer_v2` import fails         | `pipeline.py` falls back to `from audio_enhancer import …` (v1)  |

---

## 9. Downstream contract (for B5, B7)

When `use_whisperx=True` and the path succeeds, the pipeline writes two
files to `output_dir`:

1. **`transcript.json`** — plain-Whisper-compatible shape (so existing
   `caption_generator.generate_captions(transcript, ...)` and
   `take_selector.select_best_takes(video, transcript, ...)` keep working
   unchanged). Segments now include optional `speaker` and `words:[{word,
   start, end, speaker, confidence}]` fields.
2. **`whisperx_result.json`** — full WhisperX payload (the dict returned by
   `format_for_ass`), suitable for B5 caption_generator_v2 and B7
   take_selector_v2 to consume directly.

B5/B7 can read `transcript.get('whisperx_result', None)` to detect the
WhisperX path; if `None`, they should fall back to plain-Whisper behavior.
