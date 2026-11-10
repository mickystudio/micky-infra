"""
Audio enhancement pipeline (P4-T1).
================================
Steps:
    1. Extract audio from input video (48kHz mono WAV).
    2. DeepFilterNet2 noise reduction (with ffmpeg `afftdn` fallback).
    3. ffmpeg studio chain:
         highpass 80 Hz   → kill rumble (HVAC, handling noise)
         lowpass 12 kHz   → kill hiss
         acompressor       → even out levels (dentist speaks softly/loudly)
         equalizer @4kHz   → presence boost for intelligibility
         deesser           → reduce sibilance (critical for "س"/"ص" sounds
                            in Arabic dental vocabulary)
         loudnorm EBU R128  → -16 LUFS (Instagram Reels / TikTok standard),
                            TP -1.5 dB, LRA 11
    4. Re-mux enhanced audio back into video (replace_audio_in_video).

Created: 2026-11-10
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
TARGET_LUFS = -16            # EBU R128 for Reels / TikTok / YouTube Shorts
TARGET_TRUE_PEAK = -1.5      # dBTP
TARGET_LRA = 11              # Loudness range

SAMPLE_RATE = 48000         # 48 kHz broadcast standard
CHANNELS = 1                 # Mono (Boya BY-V30 is mono)


def enhance_audio(video_path: str, output_dir: str) -> str:
    """
    Enhance audio to studio quality.

    Args:
        video_path: Input video (any container ffmpeg can decode).
        output_dir: Where to drop intermediate + final WAV files.

    Returns:
        Path to the enhanced audio file (`enhanced_audio.wav`, 48kHz mono).
    """
    os.makedirs(output_dir, exist_ok=True)

    # ------------------------------------------------------------------
    # 1. Extract raw audio
    # ------------------------------------------------------------------
    raw_audio = os.path.join(output_dir, 'raw_audio.wav')
    print(f"   🎧 Extracting raw audio → {raw_audio}")
    _run_ffmpeg([
        'ffmpeg', '-y',
        '-i', video_path,
        '-vn',                    # no video
        '-acodec', 'pcm_s16le',
        '-ar', str(SAMPLE_RATE),
        '-ac', str(CHANNELS),
        raw_audio,
    ])

    # ------------------------------------------------------------------
    # 2. DeepFilterNet2 noise reduction
    # ------------------------------------------------------------------
    df_audio = os.path.join(output_dir, 'df_audio.wav')
    if not _run_deepfilternet(raw_audio, df_audio):
        # Fallback: ffmpeg frequency-domain noise reduction
        print("   🎧 DeepFilterNet unavailable — falling back to ffmpeg afftdn")
        _run_ffmpeg([
            'ffmpeg', '-y',
            '-i', raw_audio,
            '-af', 'afftdn=nr=20:nf=-40',
            '-acodec', 'pcm_s16le',
            '-ar', str(SAMPLE_RATE),
            df_audio,
        ])

    # ------------------------------------------------------------------
    # 3. Studio processing chain
    # ------------------------------------------------------------------
    enhanced_audio = os.path.join(output_dir, 'enhanced_audio.wav')
    filter_chain = _build_studio_filter_chain()
    print(f"   🎧 Applying studio chain → {enhanced_audio}")
    _run_ffmpeg([
        'ffmpeg', '-y',
        '-i', df_audio,
        '-af', filter_chain,
        '-acodec', 'pcm_s16le',
        '-ar', str(SAMPLE_RATE),
        '-ac', str(CHANNELS),
        enhanced_audio,
    ])

    return enhanced_audio


def replace_audio_in_video(video_path: str, enhanced_audio: str,
                           output_path: str) -> str:
    """
    Mux enhanced audio into a video, replacing the original audio track.
    Video stream is stream-copied (no re-encode) so quality is preserved.

    Args:
        video_path: Source video.
        enhanced_audio: Enhanced WAV file.
        output_path: Output MP4 path.

    Returns:
        output_path (the same string for convenience).
    """
    print(f"   🎧 Replacing audio: {video_path} + {enhanced_audio} → {output_path}")
    _run_ffmpeg([
        'ffmpeg', '-y',
        '-i', video_path,
        '-i', enhanced_audio,
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '192k',
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-shortest',
        '-movflags', '+faststart',
        output_path,
    ])
    return output_path


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------
def _build_studio_filter_chain() -> str:
    """Build the ffmpeg -af chain for studio-quality voice."""
    return (
        # 1. Remove low-end rumble (HVAC, mic handling)
        f'highpass=f=80,'
        # 2. Remove hiss above 12 kHz (Boya BY-V30 self-noise)
        f'lowpass=f=12000,'
        # 3. Compressor — even out soft/loud speech
        f'acompressor=threshold=-20dB:ratio=3:attack=10:release=200,'
        # 4. Presence boost 4 kHz — improves intelligibility for dental
        #    vocabulary (e.g. distinguishing "تسوس" vs "عصب")
        f'equalizer=f=4000:t=q:w=1:g=3,'
        # 5. De-esser — tame sibilant "س"/"ص"/"ز" sounds critical in Arabic
        f'deesser=i=0.5:s=0.7,'
        # 6. Loudness normalization to EBU R128 standard
        f'loudnorm=I={TARGET_LUFS}:LRA={TARGET_LRA}:TP={TARGET_TRUE_PEAK}'
    )


def _run_deepfilternet(input_wav: str, output_wav: str) -> bool:
    """
    Try to run DeepFilterNet2 noise reduction.

    Returns True on success, False if DeepFilterNet is unavailable.
    """
    try:
        # Preferred: df.enhance Python API
        import torch  # noqa: F401
        from df.enhance import enhance
        from df.models import load_model

        # Default model dir on Kaggle: /kaggle/working/.deepfilternet
        model_dir = os.environ.get(
            'DF_MODEL_DIR',
            '/kaggle/working/.deepfilternet',
        )
        os.makedirs(model_dir, exist_ok=True)
        model = load_model('df2', model_dir)

        print(f"   🎧 Running DeepFilterNet2 → {output_wav}")
        enhance(model, input_wav, output_wav)
        return True
    except ImportError:
        return False
    except Exception as e:
        print(f"   ⚠️  DeepFilterNet failed ({e}); falling back to afftdn")
        return False


def _run_ffmpeg(cmd: list[str]) -> None:
    """Run an ffmpeg command, raising on non-zero exit with stderr captured."""
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        # Surface a readable error
        raise RuntimeError(
            f"ffmpeg failed (exit {result.returncode}):\n"
            f"command: {' '.join(cmd)}\n"
            f"stderr: {result.stderr[-2000:]}"
        )
