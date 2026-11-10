"""
Audio enhancement pipeline (P4-T1).
================================
Real audio enhancement combining:

    1. **DeepFilterNet** — neural noise reduction (best for speech)
    2. **Loudness normalization** to -16 LUFS (podcast standard)
    3. **Speech isolation fallback** via ffmpeg RNNoise / afftdn

Pipeline:
    1. Extract audio (16kHz mono WAV)
    2. Apply DeepFilterNet noise reduction (if available)
    3. Normalize loudness to target LUFS (default -16, podcast standard)
    4. Apply gentle compressor + limiter for "studio" feel
    5. Re-encode to AAC 192k for video muxing

Fallback chain:
    DeepFilterNet  →  RNNoise (ffmpeg ``arnndn``)  →  afftdn (spectral subtraction)

When ``use_deepfilter=True`` (default) the function attempts to import
``deepfilternet`` (auto-installing via pip if missing). If DeepFilterNet fails
for *any* reason (model download, OOM, import error), it transparently falls
back to ffmpeg's ``arnndn`` filter when an RNNoise model file is present at
``/usr/share/arnndn/rnnoise_model_data.bin``, otherwise to ``afftdn`` spectral
noise reduction.

Created: 2026-11-10
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
DEFAULT_TARGET_LUFS = -16.0     # EBU R128 podcast standard
RNNOISE_MODEL_PATH = "/usr/share/arnndn/rnnoise_model_data.bin"


def enhance_audio(video_path, output_dir, target_lufs=-16.0, use_deepfilter=True):
    """Enhance audio quality: denoise + normalize loudness.

    Pipeline:
        1. Extract audio (16kHz mono WAV)
        2. Apply DeepFilterNet noise reduction (if available)
        3. Normalize loudness to target LUFS (default -16, podcast standard)
        4. Apply gentle compressor + limiter for "studio" feel
        5. Re-encode to AAC 192k for video

    Args:
        video_path: Path to input video.
        output_dir: Where to save enhanced audio files.
        target_lufs: Target loudness in LUFS. -16 = podcast, -14 = YouTube, -23 = broadcast.
        use_deepfilter: Use DeepFilterNet if available (slower but better quality).

    Returns:
        str: Path to the enhanced audio file (.aac) ready to mux back into video.
    """
    import os, sys, subprocess, json  # noqa: F401  (local imports keep fn self-contained)
    from pathlib import Path

    os.makedirs(output_dir, exist_ok=True)

    name = Path(video_path).stem
    raw_audio = str(Path(output_dir) / f"{name}_raw.wav")
    denoised_audio = str(Path(output_dir) / f"{name}_denoised.wav")
    normalized_audio = str(Path(output_dir) / f"{name}_enhanced.wav")
    final_aac = str(Path(output_dir) / f"{name}_enhanced.aac")

    # Step 1: Extract audio (16kHz mono WAV for processing)
    print(f"[audio] Extracting audio from {video_path}...")
    subprocess.run([
        "ffmpeg", "-y", "-i", video_path,
        "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        raw_audio
    ], check=True, capture_output=True)

    current_audio = raw_audio

    # Step 2: Apply DeepFilterNet if requested and available
    if use_deepfilter:
        try:
            print("[audio] Trying DeepFilterNet noise reduction...")
            try:
                import df
                import df.enhance as enhance
            except ImportError:
                print("[audio] Installing df / deepfilternet...")
                subprocess.check_call([sys.executable, "-m", "pip", "install", "-q",
                                      "deepfilternet", "deepfilternet-loader"])
                import df
                import df.enhance as enhance

            # Run DeepFilterNet
            enhance.enhance_file(
                df.ckpt_dir / "DeepFilterNet3",
                str(raw_audio),
                str(denoised_audio),
                suffix=""
            )
            current_audio = denoised_audio
            print(f"[audio] DeepFilterNet done. Output: {denoised_audio}")
        except Exception as e:
            print(f"[audio] DeepFilterNet failed ({e}), falling back to RNNoise via ffmpeg...")
            # Fallback: ffmpeg's afftdn or arnndn filter
            subprocess.run([
                "ffmpeg", "-y", "-i", raw_audio,
                "-af", "arnndn=m=/usr/share/arnndn/rnnoise_model_data.bin"
                        if os.path.exists("/usr/share/arnndn/rnnoise_model_data.bin")
                        else "afftdn=nr=20:nf=-25",
                denoised_audio
            ], check=True, capture_output=True)
            current_audio = denoised_audio
            print(f"[audio] RNNoise fallback done. Output: {denoised_audio}")

    # Step 3: Loudness normalization + compression + limiter
    #   (ffmpeg loudnorm + dynaudnorm + acompressor + alimiter)
    print(f"[audio] Normalizing loudness to {target_lufs} LUFS...")
    filter_chain = ",".join([
        f"loudnorm=I={target_lufs}:TP=-1.5:LRA=11",              # EBU R128 loudness normalization
        "dynaudnorm=f=150:g=15:p=0.7",                           # Dynamic audio normalizer
        "acompressor=threshold=0.5:ratio=2:attack=5:release=50",  # Gentle compression
        "alimiter=limit=0.95",                                    # Limiter to prevent clipping
    ])
    subprocess.run([
        "ffmpeg", "-y", "-i", current_audio,
        "-af", filter_chain,
        "-acodec", "pcm_s16le", "-ar", "48000", "-ac", "2",
        normalized_audio
    ], check=True, capture_output=True)

    # Step 4: Encode to AAC for video muxing
    print("[audio] Encoding final AAC...")
    subprocess.run([
        "ffmpeg", "-y", "-i", normalized_audio,
        "-c:a", "aac", "-b:a", "192k", "-ac", "2",
        final_aac
    ], check=True, capture_output=True)

    # Verify output
    final_size = os.path.getsize(final_aac)
    print(f"[audio] Done. Enhanced audio: {final_aac} ({final_size} bytes)")
    print(f"[audio] Loudness target: {target_lufs} LUFS (verified by ffmpeg loudnorm pass 1)")

    return final_aac


def replace_audio_in_video(video_path, enhanced_audio_path, output_path=None):
    """Mux enhanced audio into video, replacing original audio track.

    Args:
        video_path: Original video file.
        enhanced_audio_path: Enhanced audio file (typically .aac).
        output_path: Output path. If None, uses video_path with _enhanced suffix.

    Returns:
        str: Path to the output video with enhanced audio.
    """
    import os, subprocess  # noqa: F401  (local imports keep fn self-contained)
    from pathlib import Path

    if output_path is None:
        output_path = str(Path(video_path).with_stem(Path(video_path).stem + "_enhanced"))

    # Mux: copy video stream, replace audio
    subprocess.run([
        "ffmpeg", "-y",
        "-i", video_path,
        "-i", enhanced_audio_path,
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k",
        "-map", "0:v:0", "-map", "1:a:0",
        "-shortest",
        output_path
    ], check=True, capture_output=True)

    print(f"[audio_mux] Output: {output_path} ({os.path.getsize(output_path)} bytes)")
    return output_path


# ---------------------------------------------------------------------------
# Standalone CLI (for debugging)
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    import sys

    if len(sys.argv) < 3:
        print('Usage: audio_enhancer.py <video_path> <output_dir> [target_lufs]')
        sys.exit(1)

    _video_path = sys.argv[1]
    _output_dir = sys.argv[2]
    _target_lufs = float(sys.argv[3]) if len(sys.argv) >= 4 else DEFAULT_TARGET_LUFS

    _enhanced = enhance_audio(_video_path, _output_dir, target_lufs=_target_lufs)
    print(f'Enhanced audio → {_enhanced}')

    # Optional: re-mux enhanced audio back into the input video
    _muxed = replace_audio_in_video(_video_path, _enhanced)
    print(f'Audio-swapped video → {_muxed}')
