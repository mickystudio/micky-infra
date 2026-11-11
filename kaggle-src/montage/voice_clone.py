"""
Voice Cloning (B10) — OpenVoice v2 + Arabic cross-lingual fallback.
====================================================================
Wraps MyShell's OpenVoice v2 (MIT, commercial-safe, ~4GB VRAM) to clone a
speaker's voice from a short reference clip and re-synthesize arbitrary
text in that timbre. OpenVoice v2 native langs include Arabic (community-
tier); for production Arabic we also try Coqui XTTS v2 cross-lingual or
GPT-SoVITS. VRAM (T4 16GB): OpenVoice ~4GB, Coqui XTTS ~6GB.

Setup: first call git-clones https://github.com/myshell-ai/OpenVoiceV2
into /tmp/OpenVoiceV2, pip-installs deps, and downloads checkpoints via
the repo's download.py script.

Created: 2026-12-08  |  Phase P4-T8  (B10)
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, List, Optional

log = logging.getLogger(__name__)
DEFAULT_OPENVOICE_REPO = 'https://github.com/myshell-ai/OpenVoiceV2'
DEFAULT_OPENVOICE_DIR = Path('/tmp/OpenVoiceV2')
OUTPUT_ROOT = Path('/tmp/micky_voice')
OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
# OpenVoice v2 base TTS native languages (Arabic in v2 is community-tier;
# clone_voice_arabic has a dedicated cross-lingual fallback chain).
_OV_NATIVE_LANGS = {
    'en', 'es', 'fr', 'de', 'it', 'pt', 'pl', 'tr', 'ru',
    'nl', 'cs', 'zh-cn', 'ja', 'hu', 'ko', 'hi', 'vi', 'ar',
}
XTTS_MODEL = 'tts_models/multilingual/multi-dataset/xtts_v2'


def _pip_install(pkgs: List[str]) -> None:
    print(f"[voice_clone] pip install: {', '.join(pkgs)}")
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', '-q', *pkgs])


def _ensure_openvoice_repo(repo_dir: Path = DEFAULT_OPENVOICE_DIR) -> Path:
    """Clone OpenVoice v2 repo + ensure checkpoints exist."""
    if not repo_dir.exists():
        print(f"[voice_clone] git clone OpenVoiceV2 → {repo_dir}")
        subprocess.check_call(
            ['git', 'clone', '--depth', '1', DEFAULT_OPENVOICE_REPO, str(repo_dir)]
        )
    ckpt_dir = repo_dir / 'checkpoints_v2'
    if not ckpt_dir.exists():
        print(f"[voice_clone] Downloading OpenVoice v2 checkpoints → {ckpt_dir}")
        script = repo_dir / 'download.py'
        if script.exists():
            subprocess.check_call(
                [sys.executable, str(script), '--source', 'hf'], cwd=str(repo_dir)
            )
        else:
            sh = repo_dir / 'download_checkpoints.sh'
            if sh.exists():
                subprocess.check_call(['bash', str(sh)], cwd=str(repo_dir))
            else:
                print(f"[voice_clone] WARNING: no checkpoint download script "
                      f"in {repo_dir}; OpenVoice v2 will fail to load.")
    return repo_dir


def _ensure_openvoice_python() -> None:
    """Install OpenVoice v2 Python deps (and importable package shim)."""
    try:
        import openvoice  # noqa
    except ImportError:
        repo = _ensure_openvoice_repo()
        _pip_install(['numpy<2', 'librosa', 'inflect', 'unidecode',
                       'whispercpp', 'pydub', 'gradio==3.50.2'])
        subprocess.check_call(
            [sys.executable, '-m', 'pip', 'install', '-q', '-e', str(repo)]
        )


def _ensure_coqui_tts() -> bool:
    """Install Coqui TTS for cross-lingual fallback. Returns True on success."""
    try:
        from TTS.api import TTS  # noqa
        return True
    except ImportError:
        try:
            _pip_install(['TTS>=0.22'])
            return True
        except Exception as e:
            print(f"[voice_clone] Coqui TTS install failed ({e}).")
            return False


def _gpu_collect() -> None:
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:
        pass


def _hash_text(text: str) -> str:
    return hashlib.sha1(f"{text}|{time.time()}".encode()).hexdigest()[:12]


class VoiceCloner:
    """OpenVoice v2 voice cloning + Arabic cross-lingual fallback.

    Lazy-loads OpenVoice on first ``clone_voice`` call. If OpenVoice fails
    to initialize, falls back to Coqui TTS XTTS v2 (NC-licensed — dev only).
    """

    def __init__(
        self, model_name: str = 'OpenVoiceV2', device: str = 'cuda',
        repo_dir: Path = DEFAULT_OPENVOICE_DIR,
    ) -> None:
        self.model_name = model_name
        self.device = device
        self.repo_dir = Path(repo_dir)
        self._base_tts: Any = None
        self._converter: Any = None
        self._source_se: Any = None
        self._coqui_tts: Any = None
        self._coqui_loaded: bool = False
        self.available: bool = True
        self.fallback_to_coqui: bool = False

    # ----- private loaders ------------------------------------------------
    def _ensure_openvoice(self) -> None:
        """Initialize OpenVoice v2 base TTS + tone color converter."""
        if self._converter is not None and self._base_tts is not None:
            return
        _ensure_openvoice_python()
        repo = _ensure_openvoice_repo(self.repo_dir)
        ckpt = repo / 'checkpoints_v2'
        if not (ckpt / 'converter').exists():
            raise RuntimeError(
                f"OpenVoice v2 checkpoints missing in {ckpt}/converter "
                "— run the repo's download script first."
            )
        if str(repo) not in sys.path:
            sys.path.insert(0, str(repo))
        from openvoice import BaseSpeakerTTS, ToneColorConverter
        import torch
        bs = ckpt / 'base_speakers'
        cv = ckpt / 'converter'
        self._base_tts = BaseSpeakerTTS(str(bs / 'config.json'), device=self.device)
        self._base_tts.load_ckpt(str(bs / 'base_speakers.pth'))
        self._converter = ToneColorConverter(str(cv / 'config.json'), device=self.device)
        self._converter.load_ckpt(str(cv / 'checkpoint.pth'))
        self._source_se = torch.load(str(bs / 'source_default.pt'),
                                     map_location=self.device)
        print(f"[voice_clone] OpenVoice v2 ready on {self.device}")

    def _ensure_coqui(self) -> Any:
        """Initialize Coqui XTTS v2 for cross-lingual fallback."""
        if self._coqui_tts is not None:
            return self._coqui_tts
        if not _ensure_coqui_tts():
            return None
        try:
            from TTS.api import TTS
            tts = TTS(XTTS_MODEL, gpu=self.device.startswith('cuda'))
            self._coqui_tts = tts
            self._coqui_loaded = True
            print(f"[voice_clone] Coqui XTTS v2 ready on {self.device}")
            return tts
        except Exception as e:
            print(f"[voice_clone] Coqui XTTS load failed ({e}).")
            return None

    def _extract_se(self, reference_audio_path: str) -> Any:
        """Extract speaker embedding from reference audio via OpenVoice."""
        from openvoice import se_g2p
        import torch
        target_dir = OUTPUT_ROOT / '_se_cache'
        target_dir.mkdir(parents=True, exist_ok=True)
        se_path, _ = se_g2p.get_se(
            reference_audio_path, self._converter, target_dir=str(target_dir),
        )
        return torch.load(se_path, map_location=self.device)

    # ----- public API -----------------------------------------------------
    def clone_voice(
        self, reference_audio_path: str, text: str,
        language: str = 'en', speed: float = 1.0,
    ) -> str:
        """Clone voice from reference and synthesize speech for ``text``.
        Returns: path to /tmp/micky_voice/cloned_<hash>.wav.
        """
        if language == 'ar':
            return self.clone_voice_arabic(reference_audio_path, text)
        try:
            self._ensure_openvoice()
        except Exception as e:
            print(f"[voice_clone] OpenVoice init failed ({e}); "
                  "falling back to Coqui XTTS.")
            return self._clone_voice_coqui(reference_audio_path, text, language)
        if language not in _OV_NATIVE_LANGS:
            print(f"[voice_clone] WARNING: '{language}' not in OpenVoice "
                  f"native list; quality may vary.")
        out_path = str(OUTPUT_ROOT / f"cloned_{_hash_text(text)}.wav")
        self._openvoice_synthesize(text, reference_audio_path, language,
                                    speed, out_path, '[micky_voice_clone]')
        print(f"[voice_clone] cloned → {out_path}")
        return out_path

    def _openvoice_synthesize(
        self, text: str, reference_audio_path: str,
        language: str, speed: float, out_path: str, message: str,
    ) -> None:
        """Internal: OpenVoice v2 base TTS + tone color conversion."""
        tmp_base = str(OUTPUT_ROOT / f"_base_{_hash_text(text)}.wav")
        self._base_tts.tts(text, tmp_base, language=language, speed=speed)
        target_se = self._extract_se(reference_audio_path)
        self._converter.convert(
            audio_path=tmp_base, src_se=self._source_se, tgt_se=target_se,
            output_path=out_path, message=message,
        )
        try:
            os.remove(tmp_base)
        except OSError:
            pass
        _gpu_collect()

    def clone_voice_arabic(
        self, reference_audio_path: str, text: str,
    ) -> str:
        """Cross-lingual voice cloning for Arabic.

        Strategy chain:
            1. OpenVoice v2 native `ar` (community-tier; works for short
               narration but prosody may sound robotic).
            2. Coqui XTTS v2 cross-lingual cloning (speaker_wav=reference)
               — NC-licensed (CPML), DEV-ONLY.
            3. GPT-SoVITS community Arabic (if installed at /tmp/GPT-SoVITS).
        Returns: path to /tmp/micky_voice/cloned_<hash>.wav.
        """
        out_path = str(OUTPUT_ROOT / f"cloned_{_hash_text(text)}.wav")
        ov_err: Optional[Exception] = None
        # Strategy 1: OpenVoice v2 native `ar`
        try:
            self._ensure_openvoice()
            self._openvoice_synthesize(text, reference_audio_path, 'ar',
                                        1.0, out_path, '[micky_voice_clone_ar]')
            print(f"[voice_clone] Arabic via OpenVoice v2 → {out_path}")
            return out_path
        except Exception as e:
            ov_err = e
            print(f"[voice_clone] OpenVoice Arabic failed ({e}); "
                  "trying Coqui XTTS v2 cross-lingual.")
        # Strategy 2: Coqui XTTS v2 cross-lingual
        coqui = self._ensure_coqui()
        if coqui is not None:
            try:
                coqui.tts_to_file(text=text, file_path=out_path,
                                  speaker_wav=reference_audio_path, language='ar')
                print(f"[voice_clone] Arabic via Coqui XTTS → {out_path}")
                return out_path
            except Exception as cx_err:
                print(f"[voice_clone] Coqui Arabic failed ({cx_err}); "
                      "trying GPT-SoVITS.")
        # Strategy 3: GPT-SoVITS (community Arabic, if installed)
        sovits = self._try_gpt_sovits(reference_audio_path, text, out_path)
        if sovits:
            return sovits
        raise RuntimeError(
            f"All Arabic voice cloning strategies failed: "
            f"OpenVoice ({ov_err}), Coqui (failed), "
            "GPT-SoVITS (not installed)."
        )

    def _try_gpt_sovits(
        self, reference_audio_path: str, text: str, out_path: str,
    ) -> Optional[str]:
        """Try GPT-SoVITS at /tmp/GPT-SoVITS. Returns path or None."""
        sovits_dir = Path('/tmp/GPT-SoVITS')
        if not sovits_dir.exists():
            print("[voice_clone] GPT-SoVITS not installed at /tmp/GPT-SoVITS; skipping.")
            return None
        try:
            if str(sovits_dir) not in sys.path:
                sys.path.insert(0, str(sovits_dir))
            cli = sovits_dir / 'inference_cli.py'
            if not cli.exists():
                print("[voice_clone] GPT-SoVITS inference_cli.py not found.")
                return None
            subprocess.run(
                [sys.executable, str(cli), '--ref_audio', reference_audio_path,
                 '--text', text, '--language', 'arabic', '--out', out_path],
                check=True, capture_output=True, cwd=str(sovits_dir),
            )
            if os.path.exists(out_path):
                print(f"[voice_clone] Arabic via GPT-SoVITS → {out_path}")
                return out_path
        except Exception as e:
            print(f"[voice_clone] GPT-SoVITS failed ({e}).")
        return None

    def _clone_voice_coqui(
        self, reference_audio_path: str, text: str, language: str,
    ) -> str:
        """Pure Coqui XTTS v2 path — DEV-ONLY (CPML non-commercial license)."""
        coqui = self._ensure_coqui()
        if coqui is None:
            raise RuntimeError(
                "Neither OpenVoice v2 nor Coqui TTS is available for voice cloning."
            )
        out_path = str(OUTPUT_ROOT / f"cloned_{_hash_text(text)}.wav")
        coqui.tts_to_file(text=text, file_path=out_path,
                          speaker_wav=reference_audio_path,
                          language=language or 'en')
        print(f"[voice_clone] cloned (Coqui XTTS, NC-license dev-only) → {out_path}")
        return out_path

    def narrate_script(
        self, script: str, voice: str = 'default',
        language: str = 'en', reference_audio_path: Optional[str] = None,
        max_chars_per_chunk: int = 800,
    ) -> str:
        """Narrate a long script — split into sentences and concatenate.

        For scripts > ``max_chars_per_chunk`` (default 800), split on sentence
        boundaries, generate each with ``clone_voice`` (or ``clone_voice_arabic``
        for language='ar'), and stitch the WAVs together with FFmpeg's concat.

        ``voice='default'`` uses OpenVoice default speaker; otherwise pass a
        reference-audio path via ``reference_audio_path`` (required when
        ``voice != 'default'``).
        Returns: path to /tmp/micky_voice/narration_<hash>.wav.
        """
        if voice != 'default' and not reference_audio_path:
            raise ValueError(
                "reference_audio_path is required when voice != 'default'."
            )
        if not script.strip():
            raise ValueError("Cannot narrate an empty script.")
        # Short script: single shot
        if len(script) <= max_chars_per_chunk:
            if voice == 'default':
                return self._narrate_default_voice(script, language)
            assert reference_audio_path is not None
            if language == 'ar':
                return self.clone_voice_arabic(reference_audio_path, script)
            return self.clone_voice(reference_audio_path, script, language=language)
        # Long script: split into sentences
        chunks = self._split_into_sentences(script, max_chars_per_chunk)
        print(f"[voice_clone] narrate_script: {len(chunks)} chunks "
              f"(avg {sum(len(c) for c in chunks) // max(len(chunks), 1)} chars)")
        chunk_paths: List[str] = []
        for i, chunk in enumerate(chunks):
            try:
                if voice == 'default':
                    p = self._narrate_default_voice(chunk, language)
                elif language == 'ar':
                    assert reference_audio_path is not None
                    p = self.clone_voice_arabic(reference_audio_path, chunk)
                else:
                    assert reference_audio_path is not None
                    p = self.clone_voice(reference_audio_path, chunk, language=language)
                chunk_paths.append(p)
            except Exception as e:
                print(f"[voice_clone] chunk {i} failed ({e}); skipping.")
        if not chunk_paths:
            raise RuntimeError("All narration chunks failed.")
        if len(chunk_paths) == 1:
            return chunk_paths[0]
        out_path = str(OUTPUT_ROOT / f"narration_{_hash_text(script)}.wav")
        self._ffmpeg_concat_wavs(chunk_paths, out_path)
        print(f"[voice_clone] narration → {out_path}")
        return out_path

    def _narrate_default_voice(self, text: str, language: str) -> str:
        """Narrate using OpenVoice's default base speaker (no cloning)."""
        try:
            self._ensure_openvoice()
        except Exception as e:
            print(f"[voice_clone] OpenVoice init failed ({e}); "
                  "trying Coqui for default voice.")
            coqui = self._ensure_coqui()
            if coqui is None:
                raise RuntimeError(
                    "No TTS backend available for default-voice narration."
                )
            out_path = str(OUTPUT_ROOT / f"cloned_{_hash_text(text)}.wav")
            coqui.tts_to_file(text=text, file_path=out_path,
                              language=language or 'en')
            return out_path
        out_path = str(OUTPUT_ROOT / f"cloned_{_hash_text(text)}.wav")
        self._base_tts.tts(text, out_path, language=language, speed=1.0)
        return out_path

    # ----- text utilities -------------------------------------------------
    @staticmethod
    def _split_into_sentences(text: str, max_chars: int) -> List[str]:
        """Split text into chunks ≤ max_chars on sentence boundaries.

        Handles ASCII (. ! ?) and Arabic (؟) terminators. Over-long sentences
        are hard-split on word boundaries.
        """
        raw = re.split(r'(?<=[.!?؟])\s+', text.strip())
        chunks: List[str] = []
        current = ''
        for sentence in raw:
            if not sentence:
                continue
            if len(current) + len(sentence) + 1 <= max_chars:
                current = (current + ' ' + sentence).strip()
                continue
            if current:
                chunks.append(current)
            if len(sentence) > max_chars:
                buf = ''
                for w in sentence.split():
                    if len(buf) + len(w) + 1 <= max_chars:
                        buf = (buf + ' ' + w).strip()
                    else:
                        if buf:
                            chunks.append(buf)
                        buf = w
                current = buf
            else:
                current = sentence
        if current:
            chunks.append(current)
        return chunks

    @staticmethod
    def _ffmpeg_concat_wavs(wav_paths: List[str], out_path: str) -> None:
        """Concatenate WAVs via ffmpeg concat demuxer; fall back to re-encode.

        The copy-mode concat fails when codecs/sample rates differ across
        chunks; in that case we re-encode with the ``concat`` filter.
        """
        if not wav_paths:
            raise ValueError("No WAVs to concatenate.")
        if len(wav_paths) == 1:
            shutil.copyfile(wav_paths[0], out_path)
            return
        list_path = OUTPUT_ROOT / f"_concat_{_hash_text(out_path)}.txt"
        with open(list_path, 'w', encoding='utf-8') as f:
            for p in wav_paths:
                f.write(f"file '{os.path.abspath(p)}'\n")
        try:
            subprocess.run(
                ['ffmpeg', '-y', '-f', 'concat', '-safe', '0',
                 '-i', str(list_path), '-c', 'copy', out_path],
                check=True, capture_output=True,
            )
        except subprocess.CalledProcessError:
            print("[voice_clone] concat copy failed; re-encoding.")
            cmd = ['ffmpeg', '-y']
            for p in wav_paths:
                cmd += ['-i', p]
            filt = ''.join(f'[{i}:a]' for i in range(len(wav_paths)))
            filt += f'concat=n={len(wav_paths)}:v=0:a=1[out]'
            cmd += ['-filter_complex', filt, '-map', '[out]',
                    '-acodec', 'pcm_s16le', out_path]
            subprocess.run(cmd, check=True, capture_output=True)
        finally:
            try:
                os.remove(list_path)
            except OSError:
                pass

    # ----- cleanup --------------------------------------------------------
    def cleanup(self) -> None:
        """Release GPU memory and drop loaded models."""
        for attr in ('_base_tts', '_converter', '_source_se', '_coqui_tts'):
            obj = getattr(self, attr, None)
            if obj is not None:
                try:
                    del obj
                except Exception:
                    pass
                setattr(self, attr, None)
        _gpu_collect()


if __name__ == '__main__':
    import argparse
    p = argparse.ArgumentParser(description='Voice clone smoke test')
    p.add_argument('--reference', required=True, help='Reference audio (3-15s)')
    p.add_argument('--text', default='Hello, this is a voice clone test.')
    p.add_argument('--language', default='en')
    args = p.parse_args()
    cloner = VoiceCloner()
    try:
        print('OK:', cloner.clone_voice(args.reference, args.text,
                                          language=args.language))
    finally:
        cloner.cleanup()
