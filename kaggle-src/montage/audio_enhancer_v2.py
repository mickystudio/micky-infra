"""Audio enhancement v2 (B2).

Drop-in upgrade for ``audio_enhancer.py`` that adds an optional WhisperX
path with word-level alignment + speaker diarization, while keeping the
original public API 100 % backward compatible.

Public API (unchanged from v1):
    enhance_audio(video_path, output_dir, target_lufs=-16.0,
                  use_deepfilter=True) -> str
    replace_audio_in_video(video_path, enhanced_audio_path,
                           output_path=None) -> str

New API (B2):
    enhance_and_transcribe_with_diarization(audio_or_video_path, ...) -> dict
        Runs v1 enhance_audio() AND a WhisperX transcription with diarization,
        returning both the enhanced .aac path and a rich transcript dict.

Behavior:
  * v1 functions are re-exported verbatim — callers that import
    ``enhance_audio`` / ``replace_audio_in_video`` from v2 keep working
    exactly as before.
  * The new method gracefully falls back to plain OpenAI Whisper via
    ``pipeline.transcribe_video()`` when whisperx cannot be imported
    (e.g. on a CPU-only box without the new deps installed).

Created: 2026-11-10
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Optional

# Make sibling modules importable regardless of CWD
sys.path.insert(0, str(Path(__file__).resolve().parent))

# ---------------------------------------------------------------------------
# Re-export v1 public API verbatim (callers must not break)
# ---------------------------------------------------------------------------
from audio_enhancer import (  # noqa: E402, F401
    DEFAULT_TARGET_LUFS,
    RNNOISE_MODEL_PATH,
    enhance_audio,
    replace_audio_in_video,
)

# ---------------------------------------------------------------------------
# Optional WhisperX import — failure is OK, we fall back at call time
# ---------------------------------------------------------------------------
try:
    from whisperx_engine import WhisperXEngine, WhisperXResult  # noqa: E402
    _WHISPERX_AVAILABLE = True
    _WHISPERX_IMPORT_ERROR: Optional[Exception] = None
except Exception as _e:  # pragma: no cover — only when deps missing
    _WHISPERX_AVAILABLE = False
    _WHISPERX_IMPORT_ERROR = _e
    WhisperXEngine = None  # type: ignore[assignment, misc]
    WhisperXResult = None  # type: ignore[assignment, misc]


# ---------------------------------------------------------------------------
# New API: enhance + transcribe with diarization in one shot
# ---------------------------------------------------------------------------

def enhance_and_transcribe_with_diarization(
    audio_or_video_path: str,
    output_dir: Optional[str] = None,
    target_lufs: float = DEFAULT_TARGET_LUFS,
    use_deepfilter: bool = True,
    model_name: str = "large-v3-turbo",
    device: str = "cuda",
    compute_type: str = "int8_float16",
    language: Optional[str] = None,
    hf_token: Optional[str] = None,
    skip_diarization: bool = False,
) -> dict:
    """Enhance audio AND run WhisperX transcription with diarization.

    Steps:
      1. Run v1 ``enhance_audio()`` on the input → produces
         ``<name>_enhanced.wav`` (16 kHz mono intermediate) and
         ``<name>_enhanced.aac`` (final studio-quality output).
      2. Run WhisperX (``transcribe()`` or ``transcribe_simple()``) on the
         enhanced WAV → word-level timestamps + speaker labels.

    Args:
        audio_or_video_path: Input .mp4/.mov/.wav/.mp3.
        output_dir: Where to write outputs. Default: same dir as input.
        target_lufs: EBU R128 loudness target (default -16).
        use_deepfilter: Use DeepFilterNet for denoise (default True).
        model_name: WhisperX model name (default 'large-v3-turbo').
        device: 'cuda' or 'cpu'.
        compute_type: ctranslate2 compute type.
        language: force language code ('ar','en') or None for auto.
        hf_token: Hugging Face token (needed for pyannote diarization).
                  If None and not in env, diarization is skipped with a
                  warning but word-level alignment still runs.
        skip_diarization: if True, use ``transcribe_simple()`` (no diarization).

    Returns:
        {
            "enhanced_audio_path": str,   # .aac (for video mux)
            "enhanced_wav_path":   str,   # .wav (fed to WhisperX)
            "transcript":          dict,  # plain-Whisper-compatible shape
            "whisperx_result":     dict | None,  # full WhisperX result as dict
            "language":            str,
            "word_count":          int,
            "has_diarization":     bool,
            "engine":              "whisperx" | "whisper_fallback" | "none",
        }
    """
    src = Path(audio_or_video_path)
    if not src.exists():
        raise FileNotFoundError(f"Input not found: {audio_or_video_path}")

    output_dir = output_dir or str(src.parent)
    os.makedirs(output_dir, exist_ok=True)
    name = src.stem

    # Step 1+2: v1 enhancement — produces enhanced .aac + .wav
    enhanced_aac = enhance_audio(
        str(src), output_dir,
        target_lufs=target_lufs, use_deepfilter=use_deepfilter,
    )
    enhanced_wav = str(Path(output_dir) / f"{name}_enhanced.wav")
    if not os.path.exists(enhanced_wav):
        # enhance_audio writes <name>_enhanced.wav — but if the input stem
        # differs (e.g. user passed audio.wav not video.mp4), fall back to
        # the .aac by re-decoding to 16kHz mono WAV for WhisperX.
        import subprocess
        enhanced_wav = str(Path(output_dir) / f"{name}_wx_input.wav")
        subprocess.run(
            ["ffmpeg", "-y", "-i", enhanced_aac,
             "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
             enhanced_wav],
            check=True, capture_output=True,
        )

    # Step 3: Transcribe (WhisperX with graceful fallback)
    if not _WHISPERX_AVAILABLE:
        print(f"[audio_v2] WhisperX unavailable ({_WHISPERX_IMPORT_ERROR}); "
              "falling back to plain Whisper (no diarization).")
        return _fallback_whisper(enhanced_aac, enhanced_wav, output_dir, language)

    hf_token = hf_token or os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN")

    if skip_diarization or not hf_token:
        if skip_diarization:
            print("[audio_v2] skip_diarization=True → using transcribe_simple().")
        else:
            print("[audio_v2] No HF token — using transcribe_simple() "
                  "(word timestamps without speaker labels).")
        engine = WhisperXEngine(
            model_name=model_name, device=device,
            compute_type=compute_type, language=language, hf_token=None,
        )
        try:
            transcript = engine.transcribe_simple(enhanced_wav)
            word_count = sum(len(s.get("words", []))
                             for s in transcript.get("segments", []))
            return {
                "enhanced_audio_path": enhanced_aac,
                "enhanced_wav_path": enhanced_wav,
                "transcript": transcript,
                "whisperx_result": None,
                "language": transcript.get("language", language or "unknown"),
                "word_count": word_count,
                "has_diarization": False,
                "engine": "whisperx",
            }
        finally:
            engine.cleanup()

    # Full path: transcription + alignment + diarization
    import asyncio
    engine = WhisperXEngine(
        model_name=model_name, device=device,
        compute_type=compute_type, language=language,
        hf_token=hf_token,
    )
    try:
        wx_result: WhisperXResult = asyncio.run(engine.transcribe(enhanced_wav))

        # Build plain-Whisper-compatible transcript (for downstream
        # take_selector / caption_generator that already understand the
        # plain Whisper shape).
        transcript = {
            "text": wx_result.text,
            "segments": [
                {
                    "id": s.id,
                    "start": s.start,
                    "end": s.end,
                    "text": s.text,
                    "speaker": s.speaker,
                    "words": [
                        {
                            "word": w.word,
                            "start": w.start,
                            "end": w.end,
                            "speaker": w.speaker,
                            "confidence": w.confidence,
                        }
                        for w in s.words
                    ],
                }
                for s in wx_result.segments
            ],
            "language": wx_result.language,
            "has_diarization": wx_result.has_diarization,
            "duration_sec": wx_result.duration_sec,
        }

        # Full WhisperXResult serialized as dict for downstream agents
        # (B5 caption_generator / take_selector_v2 will consume this).
        wx_result_dict = json.loads(
            engine.format_for_ass(wx_result, style="bold_pop")
        )

        return {
            "enhanced_audio_path": enhanced_aac,
            "enhanced_wav_path": enhanced_wav,
            "transcript": transcript,
            "whisperx_result": wx_result_dict,
            "language": wx_result.language,
            "word_count": sum(len(s.words) for s in wx_result.segments),
            "has_diarization": wx_result.has_diarization,
            "engine": "whisperx",
        }
    finally:
        engine.cleanup()


def _fallback_whisper(
    enhanced_aac: str,
    enhanced_wav: str,
    output_dir: str,
    language: Optional[str],
) -> dict:
    """Plain-Whisper fallback when WhisperX is unavailable.

    Uses ``pipeline.transcribe_video()`` (already defined in pipeline.py).
    """
    try:
        from pipeline import transcribe_video  # type: ignore
    except Exception as e:
        print(f"[audio_v2] Plain Whisper fallback also failed: {e}")
        return {
            "enhanced_audio_path": enhanced_aac,
            "enhanced_wav_path": enhanced_wav,
            "transcript": {
                "text": "",
                "segments": [],
                "language": language or "unknown",
            },
            "whisperx_result": None,
            "language": language or "unknown",
            "word_count": 0,
            "has_diarization": False,
            "engine": "none",
            "error": str(e),
        }

    # transcribe_video accepts any ffmpeg-readable path; pass the enhanced WAV.
    # Match the model-size heuristic used in pipeline.run_pipeline:
    #   'small' for Arabic, 'base' for English.
    model_size = "small" if language == "ar" else "base"
    transcript = transcribe_video(enhanced_wav, output_dir, model_size=model_size)
    return {
        "enhanced_audio_path": enhanced_aac,
        "enhanced_wav_path": enhanced_wav,
        "transcript": transcript,
        "whisperx_result": None,
        "language": transcript.get("language", language or "unknown"),
        "word_count": sum(
            len(s.get("words", [])) for s in transcript.get("segments", [])
        ),
        "has_diarization": False,
        "engine": "whisper_fallback",
    }


# ---------------------------------------------------------------------------
# Standalone CLI (for debugging)
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(
        description="Audio enhancement v2 — WhisperX-powered transcription + diarization"
    )
    p.add_argument("input", help="Audio/video input path")
    p.add_argument("--output-dir", default=".")
    p.add_argument("--target-lufs", type=float, default=DEFAULT_TARGET_LUFS)
    p.add_argument("--no-deepfilter", action="store_true",
                   help="Skip DeepFilterNet (use ffmpeg fallback).")
    p.add_argument("--model", default="large-v3-turbo")
    p.add_argument("--device", default="cuda")
    p.add_argument("--compute", default="int8_float16")
    p.add_argument("--language", default=None,
                   help="Force language code ('ar','en') or omit for auto.")
    p.add_argument("--no-diarize", action="store_true",
                   help="Skip diarization even if HF token is available.")
    args = p.parse_args()

    res = enhance_and_transcribe_with_diarization(
        args.input,
        output_dir=args.output_dir,
        target_lufs=args.target_lufs,
        use_deepfilter=not args.no_deepfilter,
        model_name=args.model,
        device=args.device,
        compute_type=args.compute,
        language=args.language,
        skip_diarization=args.no_diarize,
    )
    print("\n=== Result ===")
    print(json.dumps(res, ensure_ascii=False, indent=2, default=str))
