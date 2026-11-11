"""WhisperX transcription engine (B2).

Drop-in upgrade for plain OpenAI Whisper that adds:
  * Faster inference — 70× real-time on T4 (large-v3-turbo + int8_float16)
  * Word-level alignment — wav2vec2 CTC; auto-picks Arabic XLSR-53 for 'ar'
  * Speaker diarization — pyannote 3.1 (HF token required; see README)
  * Lower hallucination — condition_on_previous_text=False + vad_filter=True

Auto-installs `whisperx>=3.4.2` (and pin-pinned deps) on first call.

Usage:
    from whisperx_engine import WhisperXEngine, WhisperXResult
    engine = WhisperXEngine(model_name='large-v3-turbo', device='cuda',
                           compute_type='int8_float16', language='ar',
                           hf_token=os.getenv('HF_TOKEN'))
    result = await engine.transcribe('audio.wav')
    words    = engine.get_word_timestamps(result)
    speakers = engine.get_speaker_segments(result)
    ass_str  = engine.format_for_ass(result, style='bold_pop')
    engine.cleanup()

Created: 2026-11-10
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class WordTimestamp:
    """A single word with start/end timestamps, confidence, optional speaker."""
    word: str
    start: float
    end: float
    confidence: float = 0.0
    speaker: Optional[str] = None


@dataclass
class WhisperXSegment:
    """A sentence-ish segment carrying word-level timestamps."""
    id: int
    start: float
    end: float
    text: str
    words: list[WordTimestamp] = field(default_factory=list)
    speaker: Optional[str] = None


@dataclass
class SpeakerSegment:
    """A contiguous speaker chunk — built by merging same-speaker words."""
    speaker: str
    start: float
    end: float
    text: str


@dataclass
class WhisperXResult:
    """Full WhisperX transcription result."""
    segments: list[WhisperXSegment] = field(default_factory=list)
    language: str = "unknown"
    duration_sec: float = 0.0
    has_diarization: bool = False

    @property
    def text(self) -> str:
        """Concatenated plain-text transcript."""
        return " ".join(s.text.strip() for s in self.segments if s.text.strip())


# ---------------------------------------------------------------------------
# Lazy whisperx import + auto-install
# ---------------------------------------------------------------------------

_WX_INSTALL_HINT = (
    "whisperx>=3.4.2 faster-whisper>=1.0.3 ctranslate2>=4.4.0 "
    "pyannote.audio>=3.3.0"
)


def _ensure_whisperx() -> Any:
    """Import whisperx, auto-installing on first run if missing."""
    try:
        import whisperx  # type: ignore
        return whisperx
    except ImportError:
        print(f"[whisperx] Not found — installing {_WX_INSTALL_HINT}...")
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "-q"]
            + _WX_INSTALL_HINT.split()
        )
        import whisperx  # type: ignore
        return whisperx


def _load_audio(audio_path: str) -> tuple[Any, float]:
    """Load 16kHz mono audio via whisperx.load_audio → (audio_array, duration_sec)."""
    whisperx = _ensure_whisperx()
    audio = whisperx.load_audio(audio_path)
    # whisperx.load_audio returns float32 ndarray at 16 kHz
    duration = float(len(audio)) / 16000.0
    return audio, duration


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------

class WhisperXEngine:
    """WhisperX engine: transcribe → align → diarize in one pipeline.

    Args:
        model_name:    Whisper model name ('large-v3-turbo', 'large-v3', ...).
        device:        'cuda' or 'cpu'.
        compute_type:  ctranslate2 compute type ('int8_float16' on T4 etc).
        language:      force language code ('ar','en') or None for auto.
        hf_token:      Hugging Face token — required for pyannote diarization.
                       If None, diarization is skipped with a warning
                       (graceful degradation).

    Usage:
        engine = WhisperXEngine(hf_token=os.getenv('HF_TOKEN'))
        result = await engine.transcribe('audio.wav')
    """

    DEFAULT_BATCH_SIZE = 16

    def __init__(
        self,
        model_name: str = "large-v3-turbo",
        device: str = "cuda",
        compute_type: str = "int8_float16",
        language: Optional[str] = None,
        hf_token: Optional[str] = None,
    ) -> None:
        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        self.language = language
        self.hf_token = (
            hf_token
            or os.getenv("HF_TOKEN")
            or os.getenv("HUGGINGFACE_TOKEN")
        )

        self._model = None  # lazily loaded whisperx.WhisperModel
        self._align_cache: dict[str, tuple[Any, dict]] = {}  # lang → (model, meta)
        self._diarize_pipeline = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    async def transcribe(self, audio_path: str) -> WhisperXResult:
        """Full pipeline: transcribe → align → diarize → assign speakers."""
        t0 = time.time()
        audio, duration = _load_audio(audio_path)
        print(f"[whisperx] Loaded {audio_path} ({duration:.1f}s)")

        # Steps 1–2: load model + transcribe
        # Hallucination mitigation: condition_on_previous_text=False
        # (don't hallucinate from prior ctx) + vad_filter=True (skip silence)
        model = self._get_model()
        print(f"[whisperx] Transcribing with {self.model_name} "
              f"(device={self.device}, compute={self.compute_type})...")
        transcribe_kwargs: dict[str, Any] = {
            "batch_size": self.DEFAULT_BATCH_SIZE,
            "condition_on_previous_text": False,
            "vad_filter": True,
        }
        if self.language:
            transcribe_kwargs["language"] = self.language
        result = model.transcribe(audio, **transcribe_kwargs)
        detected_lang = result.get("language", self.language or "unknown")
        print(f"[whisperx] Transcribed: language={detected_lang}, "
              f"{len(result.get('segments', []))} segments")

        # Steps 3–4: alignment (word-level timestamps)
        result = self._align(result, audio, detected_lang)

        # Steps 5–6: diarization (graceful skip if no HF token)
        has_diarization = False
        if self.hf_token:
            try:
                result = self._diarize_and_assign(result, audio)
                has_diarization = True
            except Exception as e:
                print(f"[whisperx] Diarization failed ({e}); continuing w/o speakers.")
        else:
            print("[whisperx] No HF token — skipping diarization "
                  "(set HF_TOKEN env var to enable).")

        wx_result = WhisperXResult(
            segments=[self._segment_from_dict(s) for s in result["segments"]],
            language=detected_lang,
            duration_sec=duration,
            has_diarization=has_diarization,
        )
        elapsed = time.time() - t0
        rtf = elapsed / max(duration, 0.1)
        print(f"[whisperx] Done in {elapsed:.1f}s ({rtf:.2f}x real-time, "
              f"diarization={'on' if has_diarization else 'off'})")
        return wx_result

    def transcribe_simple(self, audio_path: str) -> dict:
        """Faster path: transcribe + align only (no diarization).

        Returns plain-Whisper-compatible dict — useful when caption_generator
        only needs word timestamps (no speaker labels).
        """
        audio, _ = _load_audio(audio_path)
        model = self._get_model()
        transcribe_kwargs: dict[str, Any] = {
            "batch_size": self.DEFAULT_BATCH_SIZE,
            "condition_on_previous_text": False,
            "vad_filter": True,
        }
        if self.language:
            transcribe_kwargs["language"] = self.language
        result = model.transcribe(audio, **transcribe_kwargs)
        detected_lang = result.get("language", self.language or "unknown")
        result = self._align(result, audio, detected_lang)

        return {
            "text": " ".join(
                s.get("text", "").strip() for s in result["segments"]
            ),
            "segments": [
                {
                    "id": s.get("id", i),
                    "start": s.get("start", 0.0),
                    "end": s.get("end", 0.0),
                    "text": s.get("text", "").strip(),
                    "words": [
                        {
                            "word": w.get("word", ""),
                            "start": w.get("start", 0.0),
                            "end": w.get("end", 0.0),
                            "score": w.get("score", 0.0),
                        }
                        for w in (s.get("words", []) or [])
                    ],
                }
                for i, s in enumerate(result["segments"])
            ],
            "language": detected_lang,
        }

    def get_word_timestamps(self, result: WhisperXResult) -> list[WordTimestamp]:
        """Flatten all segments → flat list of WordTimestamp."""
        words: list[WordTimestamp] = []
        for seg in result.segments:
            words.extend(seg.words)
        return words

    def get_speaker_segments(self, result: WhisperXResult) -> list[SpeakerSegment]:
        """Group consecutive words by speaker → SpeakerSegment list.

        If diarization wasn't performed, returns a single segment spanning
        the full audio with ``speaker='SPEAKER_UNKNOWN'``.
        """
        if not result.has_diarization:
            return [SpeakerSegment(
                speaker="SPEAKER_UNKNOWN",
                start=result.segments[0].start if result.segments else 0.0,
                end=result.segments[-1].end if result.segments else 0.0,
                text=result.text,
            )]

        out: list[SpeakerSegment] = []
        cur_spk: Optional[str] = None
        cur_start = cur_end = 0.0
        cur_text: list[str] = []

        def _flush() -> None:
            if cur_spk is not None and cur_text:
                out.append(SpeakerSegment(cur_spk, cur_start, cur_end, " ".join(cur_text)))

        for seg in result.segments:
            if not seg.words:
                spk = seg.speaker or "SPEAKER_UNKNOWN"
                if spk != cur_spk:
                    _flush()
                    cur_spk, cur_start, cur_text = spk, seg.start, [seg.text.strip()]
                else:
                    cur_text.append(seg.text.strip())
                cur_end = seg.end
                continue
            for w in seg.words:
                spk = w.speaker or seg.speaker or "SPEAKER_UNKNOWN"
                if spk != cur_spk:
                    _flush()
                    cur_spk, cur_start, cur_text = spk, w.start, [w.word]
                else:
                    cur_text.append(w.word)
                cur_end = w.end
        _flush()
        return out

    def format_for_ass(self, result: WhisperXResult, style: str = "bold_pop") -> str:
        """Serialize result as JSON string for caption_generator (B5).

        Output shape: {style, language, has_diarization, segments:[{...}],
        speakers:[{speaker,start,end,text}], word_count}.
        """
        import json as _json

        payload = {
            "style": style,
            "language": result.language,
            "has_diarization": result.has_diarization,
            "segments": [
                {
                    "id": s.id, "start": s.start, "end": s.end,
                    "text": s.text, "speaker": s.speaker,
                    "words": [
                        {"word": w.word, "start": w.start, "end": w.end,
                         "speaker": w.speaker, "confidence": w.confidence}
                        for w in s.words
                    ],
                }
                for s in result.segments
            ],
            "speakers": [
                {"speaker": sp.speaker, "start": sp.start,
                 "end": sp.end, "text": sp.text}
                for sp in self.get_speaker_segments(result)
            ],
            "word_count": sum(len(s.words) for s in result.segments),
        }
        return _json.dumps(payload, ensure_ascii=False)

    def cleanup(self) -> None:
        """Release GPU memory (call at end of session, e.g. in finally block)."""
        try:
            if self._model is not None:
                del self._model
                self._model = None
            self._align_cache.clear()
            if self._diarize_pipeline is not None:
                del self._diarize_pipeline
                self._diarize_pipeline = None
            try:
                import torch  # type: ignore
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                    print("[whisperx] GPU memory released.")
            except Exception:
                pass
        except Exception as e:
            print(f"[whisperx] cleanup() warning: {e}")

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _get_model(self):
        """Lazily load the WhisperX model on first use."""
        if self._model is None:
            whisperx = _ensure_whisperx()
            print(f"[whisperx] Loading model '{self.model_name}' "
                  f"(device={self.device}, compute_type={self.compute_type})...")
            self._model = whisperx.load_model(
                self.model_name, self.device,
                compute_type=self.compute_type, language=self.language,
            )
        return self._model

    def _align(self, result: dict, audio: Any, language: str) -> dict:
        """Load alignment model + align segments → word-level timestamps.

        `whisperx.load_align_model(language_code=...)` auto-picks the right
        wav2vec2 model per language; for 'ar' it uses the Arabic XLSR-53.
        """
        whisperx = _ensure_whisperx()
        if not language or language == "unknown":
            print("[whisperx] Skipping alignment (unknown language).")
            return result
        try:
            cached = self._align_cache.get(language)
            if cached is None:
                print(f"[whisperx] Loading alignment model for '{language}'...")
                align_model, align_meta = whisperx.load_align_model(
                    language_code=language, device=self.device
                )
                self._align_cache[language] = (align_model, align_meta)
            else:
                align_model, align_meta = cached
            print("[whisperx] Aligning segments (word-level timestamps)...")
            result = whisperx.align(
                result["segments"], align_model, align_meta, audio,
                self.device, return_char_alignments=False,
            )
            return result
        except Exception as e:
            print(f"[whisperx] Alignment failed for '{language}' ({e}); "
                  "continuing with segment-level timestamps only.")
            return result

    def _diarize_and_assign(self, result: dict, audio: Any) -> dict:
        """Run pyannote diarization + assign speakers to words/segments."""
        whisperx = _ensure_whisperx()
        if self._diarize_pipeline is None:
            print("[whisperx] Loading pyannote diarization pipeline...")
            self._diarize_pipeline = whisperx.DiarizationPipeline(
                use_auth_token=self.hf_token, device=self.device
            )
        print("[whisperx] Diarizing (min_speakers=2, max_speakers=4)...")
        diarize_segments = self._diarize_pipeline(
            audio, min_speakers=2, max_speakers=4
        )
        print(f"[whisperx] Diarized: {len(diarize_segments)} speaker turns.")
        return whisperx.assign_word_speakers(diarize_segments, result)

    @staticmethod
    def _segment_from_dict(s: dict) -> WhisperXSegment:
        """Convert a raw WhisperX segment dict → WhisperXSegment dataclass."""
        words: list[WordTimestamp] = []
        for w in s.get("words", []) or []:
            words.append(WordTimestamp(
                word=str(w.get("word", "")).strip(),
                start=float(w.get("start", 0.0)),
                end=float(w.get("end", 0.0)),
                confidence=float(w.get("score", w.get("probability", 0.0)) or 0.0),
                speaker=w.get("speaker"),
            ))
        return WhisperXSegment(
            id=int(s.get("id", 0)),
            start=float(s.get("start", 0.0)),
            end=float(s.get("end", 0.0)),
            text=str(s.get("text", "")).strip(),
            words=words,
            speaker=s.get("speaker"),
        )


# ---------------------------------------------------------------------------
# CLI (debug)
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import argparse
    import asyncio

    p = argparse.ArgumentParser(description="WhisperX transcription engine")
    p.add_argument("audio_path", help="Path to WAV/MP3/MP4 audio")
    p.add_argument("--model", default="large-v3-turbo")
    p.add_argument("--device", default="cuda")
    p.add_argument("--compute", default="int8_float16")
    p.add_argument("--language", default=None)
    p.add_argument("--no-diarize", action="store_true",
                   help="Skip diarization even if HF token is available.")
    a = p.parse_args()

    token = None if a.no_diarize else (
        os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN")
    )
    engine = WhisperXEngine(
        model_name=a.model, device=a.device, compute_type=a.compute,
        language=a.language, hf_token=token,
    )
    try:
        res = asyncio.run(engine.transcribe(a.audio_path))
        print(f"\n=== Result: {res.language}, {res.duration_sec:.1f}s ===")
        print(f"Segments: {len(res.segments)} | Diarization: {res.has_diarization}")
        print(f"Words: {len(engine.get_word_timestamps(res))}")
        if res.has_diarization:
            print(f"Speaker turns: {len(engine.get_speaker_segments(res))}")
        for s in res.segments[:3]:
            spk = f" [{s.speaker}]" if s.speaker else ""
            print(f"  {s.start:.1f}-{s.end:.1f}{spk}: {s.text[:80]}")
    finally:
        engine.cleanup()
