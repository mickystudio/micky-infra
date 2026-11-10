"""
Micky Assistant Montage Pipeline
================================
Takes raw 1080p 30fps 9:16 vertical video (from Redmi Note 13 + Boya BY-V30 mic)
and produces 5 platform-ready cinematic reels + captions + hashtags.

Runs on Kaggle GPU (2x T4, 32GB VRAM, 30h/week free tier).

Stages:
    1. Whisper transcription (word-level timestamps, large-v3)
    2. Take selection (cluster duplicate takes, pick best by SNR + fluency)
    3. Audio enhancement (DeepFilterNet2 + ffmpeg studio chain, -16 LUFS EBU R128)
    4. Background removal (Robust Video Matting + 5 dental backgrounds)
    5. Color grading (3D LUTs — teal_orange, medical_clean, warm_clinical)
    6. Caption generation (Hormozi word-by-word, Arabic RTL)
    7. Remotion animation (React-based overlays)
    8. Multi-platform export (Instagram, TikTok, YouTube, Facebook, WhatsApp)

Created: 2026-11-10  |  Phase P4 (T1..T8)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any

# Local imports — same package directory
sys.path.insert(0, str(Path(__file__).resolve().parent))

from audio_enhancer import enhance_audio, replace_audio_in_video  # noqa: E402
from background_remover import remove_background  # noqa: E402
from take_selector import select_best_takes  # noqa: E402
from color_grader import apply_color_grading  # noqa: E402
from caption_generator import generate_captions  # noqa: E402
from remotion_renderer import render_animations  # noqa: E402
from multi_export import export_multi_platform  # noqa: E402


# ---------------------------------------------------------------------------
# Defaults / options
# ---------------------------------------------------------------------------
DEFAULT_PLATFORMS: list[str] = ['instagram', 'tiktok', 'youtube', 'facebook', 'whatsapp']
DEFAULT_BACKGROUND = 'dental_office'
DEFAULT_LUT = 'medical_clean'
DEFAULT_CAPTION_STYLE = 'hormozi'
DEFAULT_LANGUAGE = 'ar'
DEFAULT_AUDIENCE = 'patients'


def run_pipeline(
    input_video_path: str,
    output_dir: str,
    options: dict | None = None,
) -> dict:
    """
    Full montage pipeline.

    Args:
        input_video_path: Path to raw 1080p 30fps 9:16 video.
        output_dir: Where to save all outputs (created if missing).
        options: dict with keys:
            platforms        list[str]   default all 5
            background       str         one of: dental_office, blue_gradient,
                                              white_studio, infographic_bg, dreamy_soft
            lut              str         one of: teal_orange, medical_clean, warm_clinical
            caption_style    str         hormozi | minimal | arabic_bold
            language         str         ar | en
            audience         str         patients | colleagues
            skip_stages      set[str]    optional stage ids to skip (for debugging)
                                          e.g. {'background', 'color'}

    Returns:
        {
            'outputs': [{'platform', 'video_path', 'caption', 'hashtags', 'size_mb'}],
            'stats': {'duration_seconds', 'whisper_words', 'processing_time',
                      'stages_ran', 'stages_skipped'},
            'transcript_path': str,
            'captions_path': str,
        }
    """
    options = options or {}
    platforms = options.get('platforms', DEFAULT_PLATFORMS)
    skip = set(options.get('skip_stages', []))

    os.makedirs(output_dir, exist_ok=True)
    t0 = time.time()
    stats: dict[str, Any] = {
        'stages_ran': [],
        'stages_skipped': list(skip),
    }

    try:
        # ------------------------------------------------------------------
        # Stage 1: Transcribe
        # ------------------------------------------------------------------
        print("\n" + "=" * 70)
        print("🎬 Stage 1: Transcribing audio (Whisper large-v3)...")
        print("=" * 70)
        if 'transcribe' in skip:
            print("   ⏭️  Skipped (no transcript will be available)")
            transcript = {'segments': [], 'text': ''}
        else:
            language = options.get('language', DEFAULT_LANGUAGE)
            transcript = transcribe_video(input_video_path, language=language)
            transcript_path = os.path.join(output_dir, 'transcript.json')
            with open(transcript_path, 'w', encoding='utf-8') as f:
                json.dump(transcript, f, ensure_ascii=False, indent=2)
            word_count = sum(len(s.get('words', [])) for s in transcript.get('segments', []))
            print(f"   ✅ {word_count} words, {len(transcript.get('segments', []))} segments")
            print(f"   📁 Saved: {transcript_path}")
            stats['whisper_words'] = word_count
            stats['transcript_path'] = transcript_path

        # ------------------------------------------------------------------
        # Stage 2: Select best takes (if multiple)
        # ------------------------------------------------------------------
        print("\n" + "=" * 70)
        print("🎬 Stage 2: Selecting best takes...")
        print("=" * 70)
        if 'takes' in skip:
            print("   ⏭️  Skipped")
            selected_video = input_video_path
        else:
            try:
                selected_video = select_best_takes(input_video_path, transcript, output_dir)
                if selected_video == input_video_path:
                    print("   ℹ️  Single take detected — no selection needed")
                else:
                    print(f"   ✅ Best takes concatenated: {selected_video}")
            except Exception as e:
                print(f"   ⚠️  Take selection failed ({e}); using original video")
                selected_video = input_video_path

        # ------------------------------------------------------------------
        # Stage 3: Enhance audio
        # ------------------------------------------------------------------
        print("\n" + "=" * 70)
        print("🎬 Stage 3: Enhancing audio (studio quality, -16 LUFS)...")
        print("=" * 70)
        if 'audio' in skip:
            print("   ⏭️  Skipped")
            audio_swapped_video = selected_video
        else:
            try:
                enhanced_audio = enhance_audio(selected_video, output_dir)
                print(f"   ✅ Enhanced audio: {enhanced_audio}")
                # Replace original audio with enhanced audio
                audio_swapped_video = os.path.join(output_dir, 'audio_swapped.mp4')
                replace_audio_in_video(selected_video, enhanced_audio, audio_swapped_video)
                print(f"   ✅ Audio replaced in video: {audio_swapped_video}")
            except Exception as e:
                print(f"   ⚠️  Audio enhancement failed ({e}); using original audio")
                traceback.print_exc()
                audio_swapped_video = selected_video

        # ------------------------------------------------------------------
        # Stage 4: Remove background
        # ------------------------------------------------------------------
        print("\n" + "=" * 70)
        print("🎬 Stage 4: Removing background (Robust Video Matting)...")
        print("=" * 70)
        background_choice = options.get('background', DEFAULT_BACKGROUND)
        if 'background' in skip:
            print("   ⏭️  Skipped")
            matted_video = audio_swapped_video
        else:
            try:
                matted_video = remove_background(
                    audio_swapped_video, background_choice, output_dir
                )
                print(f"   ✅ Background replaced → '{background_choice}': {matted_video}")
            except Exception as e:
                print(f"   ⚠️  Background removal failed ({e}); using audio-swapped video")
                traceback.print_exc()
                matted_video = audio_swapped_video

        # ------------------------------------------------------------------
        # Stage 5: Color grading
        # ------------------------------------------------------------------
        print("\n" + "=" * 70)
        print("🎬 Stage 5: Applying color grading...")
        print("=" * 70)
        lut_choice = options.get('lut', DEFAULT_LUT)
        if 'color' in skip:
            print("   ⏭️  Skipped")
            graded_video = matted_video
        else:
            try:
                graded_video = apply_color_grading(matted_video, lut_choice, output_dir)
                print(f"   ✅ Color graded with LUT '{lut_choice}': {graded_video}")
            except Exception as e:
                print(f"   ⚠️  Color grading failed ({e}); using matted video")
                traceback.print_exc()
                graded_video = matted_video

        # ------------------------------------------------------------------
        # Stage 6: Generate captions
        # ------------------------------------------------------------------
        print("\n" + "=" * 70)
        print("🎬 Stage 6: Generating captions...")
        print("=" * 70)
        caption_style = options.get('caption_style', DEFAULT_CAPTION_STYLE)
        if 'captions' in skip:
            print("   ⏭️  Skipped")
            captions = {'words': [], 'phrases': [], 'style': caption_style,
                        'language': options.get('language', DEFAULT_LANGUAGE)}
        else:
            try:
                captions = generate_captions(transcript, caption_style, output_dir)
                print(f"   ✅ {len(captions.get('words', []))} caption words "
                      f"(style={caption_style})")
            except Exception as e:
                print(f"   ⚠️  Caption generation failed ({e})")
                traceback.print_exc()
                captions = {'words': [], 'phrases': [], 'style': caption_style,
                            'language': options.get('language', DEFAULT_LANGUAGE)}

        # ------------------------------------------------------------------
        # Stage 7: Render animations (Remotion)
        # ------------------------------------------------------------------
        print("\n" + "=" * 70)
        print("🎬 Stage 7: Rendering animations (Remotion)...")
        print("=" * 70)
        if 'animation' in skip:
            print("   ⏭️  Skipped")
            animated_video = graded_video
        else:
            try:
                animated_video = render_animations(
                    graded_video, captions, options, output_dir
                )
                print(f"   ✅ Animated video: {animated_video}")
            except Exception as e:
                print(f"   ⚠️  Remotion rendering failed ({e}); using graded video")
                traceback.print_exc()
                animated_video = graded_video

        # ------------------------------------------------------------------
        # Stage 8: Multi-platform export
        # ------------------------------------------------------------------
        print("\n" + "=" * 70)
        print("🎬 Stage 8: Exporting to multiple platforms...")
        print("=" * 70)
        if 'export' in skip:
            print("   ⏭️  Skipped")
            outputs = []
        else:
            try:
                outputs = export_multi_platform(
                    animated_video, platforms, options, output_dir
                )
                print(f"   ✅ Exported to {len(outputs)} platforms")
                for o in outputs:
                    print(f"      - {o['platform']:10s} | {o.get('size_mb', 0):6.1f}MB | "
                          f"{o['video_path']}")
            except Exception as e:
                print(f"   ❌ Multi-platform export failed: {e}")
                traceback.print_exc()
                outputs = []

        # ------------------------------------------------------------------
        # Stats & wrap-up
        # ------------------------------------------------------------------
        duration_seconds = _probe_video_duration(input_video_path)
        stats['duration_seconds'] = duration_seconds
        stats['processing_time'] = round(time.time() - t0, 2)

        print("\n" + "=" * 70)
        print(f"🏁 Pipeline complete in {stats['processing_time']}s")
        print(f"   Source:   {input_video_path}  ({duration_seconds:.1f}s)")
        print(f"   Outputs:  {len(outputs)} platforms")
        print("=" * 70 + "\n")

        return {
            'outputs': outputs,
            'stats': stats,
            'transcript_path': stats.get('transcript_path'),
            'captions_path': os.path.join(output_dir, 'captions.json'),
        }

    except Exception as e:
        # Top-level guard — never let a single stage crash the whole kernel
        print(f"\n❌ FATAL pipeline error: {e}")
        traceback.print_exc()
        return {
            'outputs': [],
            'stats': {
                'processing_time': round(time.time() - t0, 2),
                'error': str(e),
            },
            'error': str(e),
        }


# ---------------------------------------------------------------------------
# Whisper transcription (Stage 1)
# ---------------------------------------------------------------------------
def transcribe_video(video_path: str, language: str = 'ar') -> dict:
    """
    Transcribe video using Whisper large-v3 with word-level timestamps.

    Args:
        video_path: Path to source video file.
        language: ISO code ('ar', 'en'). Whisper will be hinted this language.

    Returns:
        Whisper result dict with keys: 'text', 'segments' (each containing
        'words' list of {word, start, end}).
    """
    import torch
    import whisper

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    print(f"   🔧 Loading Whisper large-v3 on {device}...")
    model = whisper.load_model('large-v3', device=device)

    print(f"   🔧 Transcribing {video_path} (language={language})...")
    result = model.transcribe(
        video_path,
        word_timestamps=True,
        language=language,
        verbose=False,
        # Improve Arabic accuracy
        initial_prompt='مرحباً، أنا طبيب أسنان وأتحدث عن صحة الفم والأسنان.',
    )
    return result


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _probe_video_duration(video_path: str) -> float:
    """Return video duration in seconds using ffprobe (0.0 on failure)."""
    import subprocess
    try:
        result = subprocess.run(
            [
                'ffprobe', '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                video_path,
            ],
            capture_output=True, text=True, check=True,
        )
        return float(result.stdout.strip() or 0.0)
    except Exception:
        return 0.0


# ---------------------------------------------------------------------------
# CLI entrypoint
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Micky Assistant Montage Pipeline')
    parser.add_argument('--input', required=True, help='Path to raw 1080p 30fps video')
    parser.add_argument('--output', required=True, help='Output directory')
    parser.add_argument(
        '--options', type=str, default='{}',
        help='JSON string with pipeline options',
    )
    parser.add_argument(
        '--skip', type=str, default='',
        help='Comma-separated stage ids to skip '
             '(transcribe,takes,audio,background,color,captions,animation,export)',
    )
    args = parser.parse_args()

    options: dict = json.loads(args.options)
    if args.skip:
        options['skip_stages'] = {s.strip() for s in args.skip.split(',') if s.strip()}

    result = run_pipeline(args.input, args.output, options)
    print("\n=== PIPELINE RESULT ===")
    print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
