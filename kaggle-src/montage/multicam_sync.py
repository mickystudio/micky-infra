"""
Micky Assistant — Multi-Camera Synchronisation (Agent B15)
==========================================================

Aligns multiple videos that recorded the *same* event from different
camera angles. Auto-detects per-camera audio offset by either:

    1. **Cross-correlation** (FFT-based) — general purpose, handles up to
       60 s offset (festival / concert scenarios).
    2. **Clap detection** (spectral flux) — fast & deterministic when a
       slate was used. Often more accurate than cross-correlation for
       music-heavy or noisy environments.
    3. **Auto** — tries clap detection first, falls back to cross-correlation.

`pre_roll_align()` prepends black frames so every video starts at the
same wall-clock t=0. `sync_preview()` renders a side-by-side low-res
preview. Output `AlignmentResult` is consumed by `multicam_switcher.py`.

Constraints: Python 3.10+, full type hints, files < 500 lines, pure CPU.
Auto-installs numpy/scipy/librosa on first use.

Created: 2026-11-15 (Agent B15)
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Tuple

# ---------------------------------------------------------------------------
# Auto-install heavy numerics deps. Lazy-imported so module load never
# crashes the pipeline — Kaggle first run pip-installs on demand.
# ---------------------------------------------------------------------------
_NUMPY_OK: Optional[bool] = None
_SCIPY_OK: Optional[bool] = None
_LIBROSA_OK: Optional[bool] = None


def _ensure(modname: str, min_ver: str, flag_attr: str) -> Optional[object]:
    """Lazy-importer with pip auto-install. Caches result in module globals."""
    g = globals()
    if g.get(flag_attr) is True:
        return __import__(modname)
    if g.get(flag_attr) is False:
        return None
    try:
        mod = __import__(modname)
        g[flag_attr] = True
        return mod
    except ImportError:
        try:
            print(f"[multicam_sync] Installing {modname}>={min_ver}...")
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "-q",
                 f"{modname}>={min_ver}"]
            )
            mod = __import__(modname)
            g[flag_attr] = True
            return mod
        except Exception as e:
            print(f"[multicam_sync] {modname} unavailable ({e}).")
            g[flag_attr] = False
            return None


def _np() -> object:
    return _ensure('numpy', '1.24', '_NUMPY_OK')


def _sp() -> Optional[object]:
    return _ensure('scipy', '1.11', '_SCIPY_OK')


def _lib() -> Optional[object]:
    """librosa is optional (only used for clap spectral flux)."""
    return _ensure('librosa', '0.10', '_LIBROSA_OK')


# ---------------------------------------------------------------------------
# Result dataclass
# ---------------------------------------------------------------------------
@dataclass
class AlignmentResult:
    """Outcome of `MultiCamSync.align_videos()`.

    offsets_sec[i] = how many seconds after the reference camera video `i`
    starts (always >= 0; the reference camera is 0.0).
    """
    video_paths: List[str]
    offsets_sec: List[float] = field(default_factory=list)
    reference_idx: int = 0
    confidence: float = 0.0
    method_used: str = 'fallback_zero'

    def __post_init__(self) -> None:
        if not self.offsets_sec:
            self.offsets_sec = [0.0] * len(self.video_paths)

    def to_dict(self) -> dict:
        return {
            'video_paths': self.video_paths,
            'offsets_sec': self.offsets_sec,
            'reference_idx': self.reference_idx,
            'confidence': self.confidence,
            'method_used': self.method_used,
        }


# ---------------------------------------------------------------------------
# MultiCamSync
# ---------------------------------------------------------------------------
class MultiCamSync:
    """Synchronise multi-camera recordings by audio.

    Parameters
    ----------
    sample_rate : int
        Audio sample rate used internally. 16 kHz is sufficient for
        cross-correlation & clap detection.
    alignment_method : str
        'cross_correlation' | 'clap_detection' | 'auto' (default).
    max_offset_sec : float
        Maximum search range for cross-correlation (default 60s).
    work_dir : str | None
        Directory to drop intermediate WAV files. Defaults to temp dir.
    """

    VALID_METHODS = ('cross_correlation', 'clap_detection', 'auto')

    def __init__(
        self,
        sample_rate: int = 16000,
        alignment_method: str = 'auto',
        max_offset_sec: float = 60.0,
        work_dir: Optional[str] = None,
    ) -> None:
        if alignment_method not in self.VALID_METHODS:
            raise ValueError(
                f"alignment_method must be one of {self.VALID_METHODS}, "
                f"got {alignment_method!r}"
            )
        self.sample_rate = int(sample_rate)
        self.alignment_method = alignment_method
        self.max_offset_sec = float(max_offset_sec)
        self.work_dir = work_dir or tempfile.mkdtemp(prefix='multicam_')
        os.makedirs(self.work_dir, exist_ok=True)
        self._audio_cache: dict[str, str] = {}

    # ------------------------------------------------------------------
    # Audio extraction
    # ------------------------------------------------------------------
    def extract_audio(self, video_path: str) -> str:
        """Extract mono audio at `sample_rate` from `video_path` via ffmpeg.

        Output: 16-bit PCM WAV. Cached per video path.
        """
        if video_path in self._audio_cache:
            cached = self._audio_cache[video_path]
            if os.path.exists(cached):
                return cached
        if not os.path.exists(video_path):
            raise FileNotFoundError(f"Video not found: {video_path}")
        out_path = os.path.join(
            self.work_dir,
            Path(video_path).stem + f'_{self.sample_rate}hz.wav',
        )
        cmd = [
            'ffmpeg', '-y', '-i', video_path,
            '-vn', '-ac', '1', '-ar', str(self.sample_rate),
            '-acodec', 'pcm_s16le', '-f', 'wav', out_path,
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True)
        except subprocess.CalledProcessError as e:
            raise RuntimeError(
                f"ffmpeg audio extraction failed for {video_path}: "
                f"{e.stderr.decode('utf-8', errors='ignore')[:400]}"
            ) from e
        if not os.path.exists(out_path):
            raise RuntimeError(f"ffmpeg produced no output for {video_path}")
        self._audio_cache[video_path] = out_path
        return out_path

    # ------------------------------------------------------------------
    # Cross-correlation
    # ------------------------------------------------------------------
    def compute_cross_correlation(self, audio_a: str, audio_b: str) -> float:
        """FFT cross-correlation: find the lag (seconds) that best aligns
        `audio_b` with `audio_a`.

        Returns offset_sec. Positive = B starts AFTER A (prepend that many
        seconds of silence to B to align). Negative = B starts before A.
        """
        np_mod = _np()
        a = _read_wav_mono(audio_a, self.sample_rate)
        b = _read_wav_mono(audio_b, self.sample_rate)
        max_lag_samples = int(self.max_offset_sec * self.sample_rate)

        try:
            _sp()  # ensure installed
            from scipy.signal import correlate  # type: ignore[import-not-found]
            corr = correlate(b, a, mode='full', method='fft')
        except Exception:
            # Pure-numpy fallback (slower but dependency-free)
            n = len(a) + len(b) - 1
            fft_size = 1 << (n - 1).bit_length()
            fa = np_mod.fft.rfft(a, fft_size)
            fb = np_mod.fft.rfft(b, fft_size)
            corr = np_mod.fft.irfft(fb * np_mod.conj(fa), fft_size)[:n]

        peak_idx = int(np_mod.asarray(corr).argmax())
        lag_samples = peak_idx - (len(a) - 1)
        lag_samples = max(-max_lag_samples, min(max_lag_samples, lag_samples))
        return float(lag_samples / self.sample_rate)

    # ------------------------------------------------------------------
    # Clap detection
    # ------------------------------------------------------------------
    def detect_clap(self, audio_path: str) -> Optional[float]:
        """Detect the first sharp transient (clap / slate) via spectral flux.

        Returns the timestamp in seconds, or None if no sharp transient
        is found above the noise floor (median × 6 by default).
        """
        prominence_ratio = 6.0
        max_search_sec = 30.0  # Claps are at the start.

        y = _read_wav_mono(audio_path, self.sample_rate)
        max_samples = int(max_search_sec * self.sample_rate)
        if len(y) > max_samples:
            y = y[:max_samples]
        if len(y) < self.sample_rate // 2:  # <0.5s — can't detect
            return None

        librosa = _lib()
        np_mod = _np()
        if librosa is not None:
            try:
                hop = self.sample_rate // 100  # 10ms hop
                # librosa 0.10+ removed `spectral_flux`; compute it manually.
                S = librosa.stft(y, n_fft=1024, hop_length=hop)  # type: ignore[attr-defined]
                mag = np_mod.abs(S)
                # Half-wave rectified difference between consecutive frames.
                diff = np_mod.diff(mag, axis=1)
                diff[diff < 0] = 0
                flux = diff.sum(axis=0)
                # `times` should align with the diff frames (one less than mag frames).
                times = librosa.frames_to_time(  # type: ignore[attr-defined]
                    range(len(flux)), sr=self.sample_rate, hop_length=hop
                )
            except Exception as e:  # pragma: no cover
                print(f"[multicam_sync] librosa clap failed ({e}); "
                      "scipy energy onsets fallback.")
                librosa = None

        if librosa is None:
            scipy = _sp()
            if scipy is None:
                return None
            from scipy.signal import spectrogram  # type: ignore[import-not-found]
            f, t, Zxx = spectrogram(y, fs=self.sample_rate, nperseg=512, noverlap=384)
            mag = abs(Zxx)
            flux = (mag[:, 1:] - mag[:, :-1]).clip(min=0).sum(axis=0)
            times = t[1:]

        if len(flux) == 0:
            return None
        median_flux = float(np_mod.median(flux)) or 1e-9
        threshold = median_flux * prominence_ratio
        peak_idx = int(np_mod.argmax(flux))
        if flux[peak_idx] < threshold:
            return None
        return float(times[peak_idx])

    # ------------------------------------------------------------------
    # align_videos — main entry point
    # ------------------------------------------------------------------
    def align_videos(self, video_paths: List[str]) -> AlignmentResult:
        """Compute per-video start-time offsets relative to the earliest camera.

        For 2+ videos: extract audio from each, compute pairwise offsets vs
        the first camera, pick the earliest-starting camera as reference,
        rebase all offsets to be >= 0 relative to it.

        Args:
            video_paths: List of 2+ video file paths to align.

        Returns:
            AlignmentResult with offsets_sec[i] = how many seconds after
            the reference camera video `i` starts (always >= 0).
        """
        if len(video_paths) < 2:
            return AlignmentResult(
                video_paths=list(video_paths),
                offsets_sec=[0.0] * len(video_paths),
                reference_idx=0,
                confidence=1.0,
                method_used='single_camera',
            )

        # Step 1: extract audio for all videos.
        audio_paths: List[str] = []
        for vp in video_paths:
            try:
                audio_paths.append(self.extract_audio(vp))
            except Exception as e:
                print(f"[multicam_sync] WARNING: audio extraction failed for "
                      f"{vp}: {e}. Zero offset for this camera.")
                audio_paths.append('')

        # Step 2: pairwise offsets relative to video_paths[0].
        # offsets_raw[i] = how much later video[i] starts vs video[0].
        offsets_raw: List[float] = [0.0]
        confidences: List[float] = [1.0]
        method_used = 'fallback_zero'
        ref_audio = audio_paths[0]
        if not ref_audio:
            return AlignmentResult(
                video_paths=list(video_paths),
                offsets_sec=[0.0] * len(video_paths),
                reference_idx=0,
                confidence=0.0,
                method_used='fallback_zero',
            )
        for i in range(1, len(video_paths)):
            other_audio = audio_paths[i]
            if not other_audio:
                offsets_raw.append(0.0)
                confidences.append(0.0)
                continue
            offset, conf, method = self._compute_pair_offset(ref_audio, other_audio)
            offsets_raw.append(offset)
            confidences.append(conf)
            if i == 1:
                method_used = method

        # Step 3: reference = earliest-starting camera (most negative offset).
        min_offset = min(offsets_raw)
        reference_idx = offsets_raw.index(min_offset)
        if min_offset < 0:
            offsets_sec = [o - min_offset for o in offsets_raw]
        else:
            offsets_sec = list(offsets_raw)
        offsets_sec = [round(o, 3) for o in offsets_sec]

        non_trivial = confidences[1:] if len(confidences) > 1 else [1.0]
        overall_conf = sum(non_trivial) / max(1, len(non_trivial))
        return AlignmentResult(
            video_paths=list(video_paths),
            offsets_sec=offsets_sec,
            reference_idx=reference_idx,
            confidence=round(overall_conf, 3),
            method_used=method_used,
        )

    def _compute_pair_offset(
        self, audio_a: str, audio_b: str
    ) -> Tuple[float, float, str]:
        """Compute the offset of B relative to A using the configured method."""
        if self.alignment_method == 'clap_detection':
            o, c = self._align_by_clap(audio_a, audio_b)
            return o, c, 'clap_detection'
        if self.alignment_method == 'cross_correlation':
            o, c = self._align_by_xcorr(audio_a, audio_b)
            return o, c, 'cross_correlation'
        # 'auto': try clap first (precise when applicable), then xcorr.
        clap_off, clap_conf = self._align_by_clap(audio_a, audio_b)
        if clap_conf >= 0.7:
            return clap_off, clap_conf, 'clap_detection'
        xc_off, xc_conf = self._align_by_xcorr(audio_a, audio_b)
        if xc_conf >= clap_conf:
            return xc_off, xc_conf, 'cross_correlation'
        return clap_off, clap_conf, 'clap_detection'

    def _align_by_clap(self, audio_a: str, audio_b: str) -> Tuple[float, float]:
        """Clap-based alignment. Returns (offset_sec, confidence).

        Confidence = 0.9 if both videos have a detectable clap, else 0.0.
        """
        clap_a = self.detect_clap(audio_a) if audio_a else None
        clap_b = self.detect_clap(audio_b) if audio_b else None
        if clap_a is None or clap_b is None:
            return 0.0, 0.0
        # If clap is the same wall-clock instant, and B's clap appears at
        # t=2s in B's timeline while A's clap is at t=5s in A's timeline,
        # then B started 3s before A. offset = clap_A - clap_B.
        return float(clap_a - clap_b), 0.9

    def _align_by_xcorr(self, audio_a: str, audio_b: str) -> Tuple[float, float]:
        """Cross-correlation alignment with confidence estimate."""
        if not audio_a or not audio_b:
            return 0.0, 0.0
        try:
            offset = self.compute_cross_correlation(audio_a, audio_b)
        except Exception as e:
            print(f"[multicam_sync] cross-correlation failed ({e}); zero offset.")
            return 0.0, 0.0
        conf = 0.7 if abs(offset) <= self.max_offset_sec else 0.3
        return float(offset), conf

    # ------------------------------------------------------------------
    # pre_roll_align
    # ------------------------------------------------------------------
    def pre_roll_align(
        self,
        video_paths: List[str],
        offsets: List[float],
    ) -> List[str]:
        """Prepend black / silent frames so all videos start at the same t=0.

        For each video, `offset` seconds of black frames (at the video's own
        framerate) is prepended. The reference (offset=0) video is copied
        to the work dir unchanged for path consistency.
        """
        if len(video_paths) != len(offsets):
            raise ValueError("video_paths and offsets length mismatch")

        aligned: List[str] = []
        for vp, off in zip(video_paths, offsets):
            if not os.path.exists(vp):
                print(f"[multicam_sync] WARNING: missing {vp}; skipping.")
                aligned.append(vp)
                continue
            off = max(0.0, float(off))
            if off < 0.01:
                dest = os.path.join(self.work_dir, Path(vp).name)
                if not os.path.exists(dest) or os.path.getmtime(vp) > os.path.getmtime(dest):
                    shutil.copy2(vp, dest)
                aligned.append(dest)
                continue

            probe = _probe_video_stream(vp)
            fps = probe.get('fps', 30.0)
            w = probe.get('width', 1080)
            h = probe.get('height', 1920)
            out_path = os.path.join(
                self.work_dir,
                f"{Path(vp).stem}_preroll{int(off*1000)}ms.mp4",
            )
            black_seg = os.path.join(self.work_dir, f"black_{int(off*1000)}ms_{Path(vp).stem}.mp4")
            # Probe source audio params so the black segment matches them.
            src_audio = _probe_audio_stream(vp)
            src_sr = src_audio.get('sample_rate', 44100)
            src_ch = src_audio.get('channels', 1)
            black_cmd = [
                'ffmpeg', '-y',
                '-f', 'lavfi', '-i',
                f'color=c=black:s={w}x{h}:r={fps}:d={off:.3f}',
                '-f', 'lavfi', '-i',
                f'anullsrc=channel_layout={"mono" if src_ch == 1 else "stereo"}:sample_rate={src_sr}',
                '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-b:a', '128k', '-ar', str(src_sr),
                '-ac', str(src_ch), '-shortest', black_seg,
            ]
            try:
                subprocess.run(black_cmd, check=True, capture_output=True)
            except subprocess.CalledProcessError as e:
                print(f"[multicam_sync] black-segment failed ({e}); original used.")
                aligned.append(vp)
                continue

            concat_list = os.path.join(self.work_dir, f"concat_{Path(vp).stem}.txt")
            # Use absolute paths — ffmpeg concat demuxer resolves relative
            # paths against the list file's directory, not the cwd.
            abs_black = os.path.abspath(black_seg)
            abs_vp = os.path.abspath(vp)
            with open(concat_list, 'w', encoding='utf-8') as f:
                f.write(f"file '{abs_black}'\nfile '{abs_vp}'\n")
            # Re-encode by default (instead of `-c copy`) for codec robustness.
            concat_cmd = [
                'ffmpeg', '-y', '-f', 'concat', '-safe', '0',
                '-i', concat_list,
                '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-b:a', '128k',
                '-ar', str(src_sr), '-ac', str(src_ch),
                out_path,
            ]
            try:
                subprocess.run(concat_cmd, check=True, capture_output=True)
                aligned.append(out_path)
            except subprocess.CalledProcessError as e:
                print(f"[multicam_sync] concat re-encode failed ({e}); "
                      "using original video without pre-roll.")
                aligned.append(vp)
        return aligned

    # ------------------------------------------------------------------
    # sync_preview
    # ------------------------------------------------------------------
    def sync_preview(
        self,
        video_paths: List[str],
        offsets: List[float],
        max_duration_sec: float = 30.0,
        height: int = 320,
    ) -> str:
        """Render a low-res side-by-side preview showing all cameras in sync.

        Each video is trimmed to start at its offset, scaled to the same
        height, then hstack'd. Output capped at `max_duration_sec`.
        """
        if len(video_paths) != len(offsets):
            raise ValueError("video_paths and offsets length mismatch")
        if not video_paths:
            raise ValueError("video_paths is empty")

        clip_paths: List[str] = []
        for i, (vp, off) in enumerate(zip(video_paths, offsets)):
            w = int(height * 9 / 16)
            if not os.path.exists(vp):
                ph = os.path.join(self.work_dir, f"placeholder_{i}.mp4")
                subprocess.run(
                    ['ffmpeg', '-y', '-f', 'lavfi', '-i',
                     f'color=c=black:s={w}x{height}:r=30:d={max_duration_sec}',
                     '-c:v', 'libx264', '-preset', 'ultrafast',
                     '-pix_fmt', 'yuv420p', ph],
                    check=True, capture_output=True,
                )
                clip_paths.append(ph)
                continue
            start = max(0.0, float(off))
            clip_path = os.path.join(
                self.work_dir,
                f"preview_cam{i}_start{int(start*1000)}ms.mp4",
            )
            cmd = [
                'ffmpeg', '-y',
                '-ss', f'{start:.3f}', '-i', vp,
                '-t', f'{max_duration_sec:.3f}',
                '-vf', f'scale={w}:{height}:force_original_aspect_ratio=decrease,'
                       f'pad={w}:{height}:(ow-iw)/2:(oh-ih)/2:color=black',
                '-an', '-c:v', 'libx264', '-preset', 'ultrafast',
                '-pix_fmt', 'yuv420p', '-r', '30', clip_path,
            ]
            try:
                subprocess.run(cmd, check=True, capture_output=True)
                clip_paths.append(clip_path)
            except subprocess.CalledProcessError as e:
                print(f"[multicam_sync] preview clip {i} failed ({e}); placeholder.")
                ph = os.path.join(self.work_dir, f"placeholder_{i}.mp4")
                subprocess.run(
                    ['ffmpeg', '-y', '-f', 'lavfi', '-i',
                     f'color=c=black:s={w}x{height}:r=30:d={max_duration_sec}',
                     '-c:v', 'libx264', '-preset', 'ultrafast',
                     '-pix_fmt', 'yuv420p', ph],
                    check=True, capture_output=True,
                )
                clip_paths.append(ph)

        out_path = os.path.join(self.work_dir, 'multicam_sync_preview.mp4')
        parts = ''.join(f'[{i}:v]' for i in range(len(clip_paths)))
        hstack_filter = parts + f'hstack=inputs={len(clip_paths)}[v]'
        cmd = ['ffmpeg', '-y']
        for cp in clip_paths:
            cmd.extend(['-i', cp])
        cmd.extend([
            '-filter_complex', hstack_filter, '-map', '[v]',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
            '-t', f'{max_duration_sec:.3f}', out_path,
        ])
        try:
            subprocess.run(cmd, check=True, capture_output=True)
        except subprocess.CalledProcessError as e:
            raise RuntimeError(
                f"preview hstack failed: "
                f"{e.stderr.decode('utf-8', errors='ignore')[:400]}"
            ) from e
        return out_path


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------
def _read_wav_mono(wav_path: str, expected_sr: int) -> "object":
    """Read a 16-bit PCM WAV as a 1-D float32 numpy array."""
    np_mod = _np()
    if not wav_path or not os.path.exists(wav_path):
        return np_mod.zeros(0, dtype='float32')
    try:
        with wave.open(wav_path, 'rb') as wf:
            n_ch = wf.getnchannels()
            sampwidth = wf.getsampwidth()
            sr = wf.getframerate()
            n_frames = wf.getnframes()
            raw = wf.readframes(n_frames)
        if sampwidth == 2:
            arr = np_mod.frombuffer(raw, dtype='<i2').astype('float32') / 32768.0
        elif sampwidth == 1:
            arr = (np_mod.frombuffer(raw, dtype=np_mod.uint8).astype('float32') - 128) / 128.0
        elif sampwidth == 4:
            arr = np_mod.frombuffer(raw, dtype='<i4').astype('float32') / 2147483648.0
        else:
            arr = np_mod.zeros(0, dtype='float32')
        if n_ch > 1:
            arr = arr.reshape(-1, n_ch).mean(axis=1)
        if sr != expected_sr and sr > 0 and len(arr) > 0:
            new_len = int(len(arr) * expected_sr / sr)
            idx = np_mod.linspace(0, len(arr) - 1, new_len)
            arr = np_mod.interp(idx, np_mod.arange(len(arr)), arr).astype('float32')
        return arr
    except Exception as e:
        print(f"[multicam_sync] _read_wav_mono({wav_path}) failed ({e}); empty.")
        return np_mod.zeros(0, dtype='float32')


def _probe_video_stream(video_path: str) -> dict:
    """Probe video for width/height/fps via ffprobe. Defaults to 1080x1920@30."""
    try:
        import json
        out = subprocess.run(
            ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
             '-show_entries', 'stream=width,height,r_frame_rate',
             '-of', 'json', video_path],
            capture_output=True, text=True, check=True,
        )
        meta = json.loads(out.stdout)
        st = meta.get('streams', [{}])[0]
        w = int(st.get('width', 1080))
        h = int(st.get('height', 1920))
        fps_str = st.get('r_frame_rate', '30/1')
        num, _, den = fps_str.partition('/')
        fps = float(num) / float(den) if den and float(den) > 0 else 30.0
        return {'width': w, 'height': h, 'fps': fps}
    except Exception:
        return {'width': 1080, 'height': 1920, 'fps': 30.0}


def _probe_audio_stream(video_path: str) -> dict:
    """Probe audio stream for sample_rate / channels via ffprobe."""
    try:
        import json
        out = subprocess.run(
            ['ffprobe', '-v', 'error', '-select_streams', 'a:0',
             '-show_entries', 'stream=sample_rate,channels',
             '-of', 'json', video_path],
            capture_output=True, text=True, check=True,
        )
        meta = json.loads(out.stdout)
        st = (meta.get('streams') or [{}])[0]
        return {
            'sample_rate': int(st.get('sample_rate', 44100) or 44100),
            'channels': int(st.get('channels', 1) or 1),
        }
    except Exception:
        return {'sample_rate': 44100, 'channels': 1}
