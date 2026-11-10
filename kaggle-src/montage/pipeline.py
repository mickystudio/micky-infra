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
    4.5. Sound Design (B8 — Jamendo music + Freesound SFX + sidechain ducking,
         mixed to -14 LUFS YouTube/TikTok standard)
    7. Remotion animation (React-based overlays)
    8. AI Enhancement (B10, optional) — Wan2.1 B-roll + OpenVoice v2 narration
    9. Multi-platform export (Instagram, TikTok, YouTube, Facebook, WhatsApp)

Created: 2026-11-10  |  Phase P4 (T1..T8)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any

# Local imports — same package directory
sys.path.insert(0, str(Path(__file__).resolve().parent))

# B2: prefer audio_enhancer_v2 (re-exports v1's enhance_audio +
# replace_audio_in_video verbatim, plus adds the new WhisperX-aware
# enhance_and_transcribe_with_diarization). Falls back to v1 on import error.
try:
    from audio_enhancer_v2 import (  # noqa: E402
        enhance_audio,
        replace_audio_in_video,
        enhance_and_transcribe_with_diarization,
    )
    _AUDIO_V2_AVAILABLE = True
except Exception as _audio_v2_err:  # pragma: no cover
    from audio_enhancer import enhance_audio, replace_audio_in_video  # noqa: E402
    enhance_and_transcribe_with_diarization = None  # type: ignore[assignment]
    _AUDIO_V2_AVAILABLE = False
    print(f"[pipeline] WARNING: audio_enhancer_v2 unavailable ({_audio_v2_err}); "
          "using v1 (no WhisperX integration).")
from background_remover import remove_background  # noqa: E402
# B7: prefer take_selector_v3 (heuristic + Qwen2.5-VL neural re-rank) when the
# VLM is importable; falls back to B1's v2 (pure heuristic) on ImportError,
# and ultimately to v1 (OpenCV motion only) further down.
try:
    from take_selector_v3 import (
        TakeSelectorV3 as _TakeSelectorV3,
        select_best_takes as _select_best_takes_v3,
    )
    _TAKE_SELECTOR_V3_AVAILABLE = True
except Exception as _ts_v3_err:  # pragma: no cover
    _TAKE_SELECTOR_V3_AVAILABLE = False
    _TakeSelectorV3 = None  # type: ignore[assignment, misc]
    _select_best_takes_v3 = None  # type: ignore[assignment, misc]
    print(f"[pipeline] WARNING: take_selector_v3 unavailable ({_ts_v3_err}); "
          "VLM re-ranking disabled (heuristic-only mode).")
# B1: prefer take_selector_v2 (PySceneDetect + auto-editor + 6-criterion
# scoring). Falls back to v1 (OpenCV motion only) on import error so the
# pipeline never blocks on a missing heavy dep.
try:
    from scene_detector import SceneDetector as _SceneDetector  # noqa: E402
    from silence_trimmer import SilenceTrimmer as _SilenceTrimmer  # noqa: E402
    from take_selector_v2 import TakeSelectorV2 as _TakeSelectorV2  # noqa: E402
    _TAKE_SELECTOR_V2_AVAILABLE = True
except Exception as _ts_v2_err:  # pragma: no cover
    _TAKE_SELECTOR_V2_AVAILABLE = False
    _TakeSelectorV2 = None  # type: ignore[assignment, misc]
    _SceneDetector = None  # type: ignore[assignment, misc]
    _SilenceTrimmer = None  # type: ignore[assignment, misc]
    print(f"[pipeline] WARNING: take_selector_v2 unavailable ({_ts_v2_err}); "
          "falling back to v1 take_selector (OpenCV motion only).")
from take_selector import select_best_takes  # noqa: E402  (kept as fallback)
from color_grader import apply_color_grading  # noqa: E402
# B6: AI color grading v2 (CLIP mood → LUT → shot matching).
# Imported lazily inside `_run_color_grading_v2` so that missing
# transformers/torch/color-matcher never blocks pipeline startup.
from color_matcher import ColorMatcher, SceneBoundary  # noqa: E402
from caption_generator import (  # noqa: E402
    generate_captions,
    generate_kinetic_captions,
    _KINETIC_AVAILABLE,
)
from remotion_renderer import render_animations, render_parallel  # noqa: E402
from multi_export import export_multi_platform  # noqa: E402

# B13: optional brand-overlay (logo watermark + brand-coloured captions +
# intro/outro pre-roll). Lazy import so a missing FFmpeg / ass_builder
# never blocks pipeline startup. Brand profile is OPTIONAL — pipeline
# runs brandless when options['brand_profile'] is None.
try:
    from brand_overlay import brand_overlay_from_dict as _brand_overlay_from_dict  # noqa: E402
    _BRAND_OVERLAY_AVAILABLE = True
except Exception as _brand_err:  # pragma: no cover
    _BRAND_OVERLAY_AVAILABLE = False
    print(f"[pipeline] WARNING: brand_overlay unavailable ({_brand_err}); "
          "brand_profile option will be ignored.")

# B14: optional parallel renderer — lazy import so missing module never blocks
# pipeline startup. When unavailable, pipeline falls back to single-threaded
# render_animations regardless of the parallel_render option.
try:
    from parallel_renderer import ParallelRenderer as _ParallelRenderer  # noqa: E402
    _PARALLEL_RENDERER_AVAILABLE = True
except Exception as _par_err:  # pragma: no cover
    _ParallelRenderer = None  # type: ignore[assignment, misc]
    _PARALLEL_RENDERER_AVAILABLE = False
    print(f"[pipeline] WARNING: parallel_renderer unavailable ({_par_err}); "
          "B14 parallel rendering disabled (single-thread fallback).")

# B11: optional storyboard generator — lazy import so missing PIL/reportlab
# never blocks pipeline startup. The pipeline pauses for user approval
# only when options['generate_storyboard'] is True (default).
try:
    from storyboard import (
        StoryboardGenerator as _StoryboardGenerator,
        Storyboard as _Storyboard,
        StoryboardTake as _StoryboardTake,
    )
    _STORYBOARD_AVAILABLE = True
except Exception as _sb_err:  # pragma: no cover
    _StoryboardGenerator = None  # type: ignore[assignment, misc]
    _Storyboard = None  # type: ignore[assignment, misc]
    _StoryboardTake = None  # type: ignore[assignment, misc]
    _STORYBOARD_AVAILABLE = False
    print(f"[pipeline] WARNING: storyboard unavailable ({_sb_err}); "
          "B11 storyboard pause/resume disabled (final render only).")

# B2: optional WhisperX engine — used when options['use_whisperx'] is True.
try:
    from whisperx_engine import WhisperXEngine, WhisperXResult  # noqa: E402
    _WHISPERX_AVAILABLE = True
except Exception as _wx_err:  # pragma: no cover
    WhisperXEngine = None  # type: ignore[assignment, misc]
    WhisperXResult = None  # type: ignore[assignment, misc]
    _WHISPERX_AVAILABLE = False

# B12: optional platform adapter + A/B variant generator — used when
# options['adapt_platforms'] is non-empty (default ['tiktok']) or when
# options['generate_variants'] > 1 (default 1, max 3). Lazy import so
# missing module / ffmpeg failure never blocks pipeline startup.
try:
    from platform_adapter import PlatformAdapter as _PlatformAdapter  # noqa: E402
    from ab_variant_generator import ABVariantGenerator as _ABVariantGenerator  # noqa: E402
    _B12_AVAILABLE = True
except Exception as _b12_err:  # pragma: no cover
    _PlatformAdapter = None  # type: ignore[assignment, misc]
    _ABVariantGenerator = None  # type: ignore[assignment, misc]
    _B12_AVAILABLE = False
    print(f"[pipeline] WARNING: platform_adapter / ab_variant_generator "
          f"unavailable ({_b12_err}); B12 platform adaptation + A/B "
          "variants disabled.")

# B15: optional multi-cam sync + switcher. Used when
# options['multicam_mode'] is set AND multiple input videos are provided.
# Lazy-imported so missing scipy/librosa/opencv never blocks the pipeline.
try:
    from multicam_sync import (  # noqa: E402
        MultiCamSync as _MultiCamSync,
        AlignmentResult as _AlignmentResult,
    )
    from multicam_switcher import (  # noqa: E402
        MultiCamSwitcher as _MultiCamSwitcher,
        CutDecision as _CutDecision,
        CameraScore as _CameraScore,
    )
    _MULTICAM_AVAILABLE = True
except Exception as _multicam_err:  # pragma: no cover
    _MultiCamSync = None  # type: ignore[assignment, misc]
    _AlignmentResult = None  # type: ignore[assignment, misc]
    _MultiCamSwitcher = None  # type: ignore[assignment, misc]
    _CutDecision = None  # type: ignore[assignment, misc]
    _CameraScore = None  # type: ignore[assignment, misc]
    _MULTICAM_AVAILABLE = False
    print(f"[pipeline] WARNING: multicam modules unavailable ({_multicam_err}); "
          "multi-cam mode disabled (single-cam path used).")

# B10: optional AI video generation (Wan2.1 / LTX-Video) and voice cloning
# (OpenVoice v2 / Coqui XTTS v2 / GPT-SoVITS). Both are heavy, lazy-loaded
# only when options['add_b_roll'] / options['narrate_script'] are True, and
# silently degrade if the underlying modules fail to import.
try:
    from ai_video_gen import AIVideoGenerator as _AIVideoGenerator  # noqa: E402
    _AI_VIDEO_AVAILABLE = True
except Exception as _aiv_err:  # pragma: no cover
    _AIVideoGenerator = None  # type: ignore[assignment, misc]
    _AI_VIDEO_AVAILABLE = False
    print(f"[pipeline] WARNING: ai_video_gen unavailable ({_aiv_err}); "
          "B10 B-roll generation disabled.")
try:
    from voice_clone import VoiceCloner as _VoiceCloner  # noqa: E402
    _VOICE_CLONE_AVAILABLE = True
except Exception as _vc_err:  # pragma: no cover
    _VoiceCloner = None  # type: ignore[assignment, misc]
    _VOICE_CLONE_AVAILABLE = False
    print(f"[pipeline] WARNING: voice_clone unavailable ({_vc_err}); "
          "B10 voice cloning disabled.")

# B8: optional sound designer (music + SFX + ducking + LUFS normalize).
# Lazy-loaded so missing requests/mutagen/ffmpeg never blocks pipeline
# startup. When unavailable, the pipeline simply passes the video through
# to Stage 7 with no sound design applied (graceful degradation).
try:
    from sound_designer import SoundDesigner as _SoundDesigner  # noqa: E402
    _SOUND_DESIGNER_AVAILABLE = True
except Exception as _sd_err:  # pragma: no cover
    _SoundDesigner = None  # type: ignore[assignment, misc]
    _SOUND_DESIGNER_AVAILABLE = False
    print(f"[pipeline] WARNING: sound_designer unavailable ({_sd_err}); "
          "B8 sound design stage will be skipped.")


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
            use_whisperx     bool        (B2) if True, use WhisperX instead of plain
                                          Whisper for Stage 1 transcription —
                                          adds word-level alignment + speaker
                                          diarization. Falls back to plain
                                          Whisper if WhisperX import fails.
            whisperx_model   str         (B2) WhisperX model name (default 'large-v3-turbo')
            hf_token         str         (B2) HuggingFace token for pyannote
                                          diarization. If None, env var HF_TOKEN
                                          is used; if still None, diarization is
                                          skipped but word-level alignment still runs.
            skip_diarization bool        (B2) skip diarization even if HF_TOKEN set
            multicam_mode    str | None  (B15) None = single-cam (default);
                                          one of 'smart' | 'round_robin' |
                                          'beat_sync' | 'speaker' enables
                                          multi-cam mode. Requires
                                          `multicam_videos` to be a list of 2+
                                          video paths (in addition to
                                          `input_video_path` which acts as the
                                          reference camera). When set, the
                                          pipeline runs MultiCamSync.align_videos()
                                          → MultiCamSwitcher.generate_cut_plan()
                                          → MultiCamSwitcher.render_multicam_video()
                                          first; downstream stages then process
                                          the switched output as a single video.
            multicam_videos  list[str]   (B15) list of additional camera video
                                          paths (besides input_video_path).
                                          Required when multicam_mode is set.
            multicam_alignment_method str (B15) 'auto' (default) | 'cross_correlation'
                                          | 'clap_detection'. See multicam_sync.py.
            multicam_sync_preview bool   (B15) if True, also write a side-by-side
                                          sync preview MP4 to output_dir
                                          (default False).
            beat_times       list[float] (B15) beat timestamps (sec) for
                                          beat_sync mode (from beat_sync.py).
            brand_profile    dict | None (B13) brand identity dict from the
                                          Worker's brand_profiles D1 row.
                                          When supplied, the pipeline:
                                            • passes brand_profile.font_primary
                                              to the kinetic caption generator
                                              (font customization)
                                            • after Stage 6 (captions), calls
                                              BrandOverlay.restyle_captions()
                                              on the .ass file (replaces \1c /
                                              \2c colour tags + Style: line
                                              with brand primary/secondary)
                                            • after Stage 7 (animations),
                                              calls BrandOverlay.apply_brand_to_video()
                                              which adds the logo watermark
                                              (FFmpeg overlay + colorchannelmixer
                                              for opacity) and concatenates
                                              intro + main + outro if any.
                                          When None (default), the pipeline
                                          runs brandless — backward compatible
                                          with all existing callers.
            add_b_roll       bool        (B10) optional Stage 8 — when True,
                                          generate Wan2.1/LTX-Video B-roll from
                                          the prompts in b_roll_prompts (list[str]).
                                          Default False. Manifest written to
                                          output_dir/b_roll_manifest.json.
            b_roll_prompts   list[str]   (B10) text prompts for each B-roll clip.
            b_roll_duration_sec float    (B10) per-clip duration (default 5.0).
            b_roll_resolution tuple[int,int] (B10) per-clip (W,H); default
                                          (1280,720).
            narrate_script   bool        (B10) optional Stage 8 — when True,
                                          synthesize AI voiceover via OpenVoice
                                          v2 (with Coqui XTTS / GPT-SoVITS
                                          fallback for Arabic). Default False.
                                          Result WAV path is stored in
                                          options['narration_wav'] for Stage 9.
            narrate_script_text str      (B10) narration text; if absent the
                                          Whisper transcript text is used.
            narration_voice  str         (B10) 'default' (no cloning) or path
                                          to a 3-15s reference audio clip.
            narration_reference_audio str (B10) required when narration_voice
                                          != 'default' (voice cloning path).
            video_model      str         (B10) HF model id for B-roll
                                          (default 'Wan-AI/Wan2.1-T2V-1.3B').
            voice_model      str         (B10) 'OpenVoiceV2' (default) or
                                          'CoquiXTTS'.
            ai_device        str         (B10) device for AI generation
                                          (default 'cuda').
            adapt_platforms  list[str]   (B12) list of platform names to
                                          re-encode the final rendered video
                                          for via PlatformAdapter. Choose from
                                          'tiktok','youtube','reels','shorts',
                                          'square','landscape'. Default
                                          ['tiktok']. Pass [] to disable Stage 10.
            generate_variants int         (B12) number of A/B variants to generate
                                          for the primary platform (first in
                                          adapt_platforms). Default 1 (= off),
                                          max 3. Each variant costs ~60s of
                                          render time on T4 (documented in
                                          README_variants.md).
            variant_criteria  str         (B12) scoring criterion for
                                          pick_best_variant: 'virality'
                                          (default) | 'composition' | 'lighting'.

    Returns:
        {
            'outputs': [{'platform', 'video_path', 'caption', 'hashtags', 'size_mb'}],
            'adapted_outputs': [{'platform','video_path','caption','hashtags',
                                 'metadata','size_mb'}],   # B12
            'variant_outputs': [{'id','description','video_path',
                                  'parameters_used','score','is_best'}],  # B12
            'stats': {'duration_seconds', 'whisper_words', 'processing_time',
                      'stages_ran', 'stages_skipped'},
            'transcript_path': str,
            'captions_path': str,
        }
    """
    options = options or {}
    platforms = options.get('platforms', DEFAULT_PLATFORMS)
    skip = set(options.get('skip_stages', []))

    # B13: optional brand profile.  We resolve the BrandOverlay once
    # here (cheap construction) so subsequent stages can call its methods.
    # When brand_profile is None or brand_overlay is unimportable, `bo`
    # stays None and the pipeline runs brandless.
    brand_profile = options.get('brand_profile')
    bo = None
    if brand_profile and _BRAND_OVERLAY_AVAILABLE:
        bo = _brand_overlay_from_dict(brand_profile)
        if bo is not None:
            print(f"[pipeline] 🎨 Brand profile active: {bo.name!r} "
                  f"(primary={bo.color_primary}, font={bo.font_primary})")
    elif brand_profile and not _BRAND_OVERLAY_AVAILABLE:
        print("[pipeline] ⚠️  brand_profile set but brand_overlay module "
              "unavailable; running brandless.")

    os.makedirs(output_dir, exist_ok=True)
    t0 = time.time()
    stats: dict[str, Any] = {
        'stages_ran': [],
        'stages_skipped': list(skip),
    }
    if bo is not None:
        stats['brand_profile'] = bo.name

    try:
        # ------------------------------------------------------------------
        # B15: Multi-cam sync + switching (optional, before Stage 1)
        # ------------------------------------------------------------------
        # If `multicam_mode` is set AND `multicam_videos` is provided,
        # we run MultiCamSync + MultiCamSwitcher here, producing a single
        # switched MP4. Downstream stages then process `input_video_path`
        # (= the switched output) as if it were a single-camera take.
        multicam_mode = options.get('multicam_mode')
        multicam_videos = list(options.get('multicam_videos') or [])
        if multicam_mode and _MULTICAM_AVAILABLE and multicam_videos:
            print("\n" + "=" * 70)
            print("🎬 B15: Multi-cam sync + switching...")
            print("=" * 70)
            try:
                # The reference camera is always input_video_path; others come
                # from options['multicam_videos'].
                all_videos = [input_video_path] + [
                    v for v in multicam_videos if v and v != input_video_path
                ]
                print(f"   📹 {len(all_videos)} cameras detected")
                for i, v in enumerate(all_videos):
                    print(f"      cam[{i}]: {v}")

                syncer = _MultiCamSync(
                    alignment_method=options.get(
                        'multicam_alignment_method', 'auto'),
                    work_dir=os.path.join(output_dir, 'multicam_sync'),
                )
                alignment = syncer.align_videos(all_videos)
                stats['multicam_alignment'] = alignment.to_dict()
                print(f"   ✅ Aligned: method={alignment.method_used}, "
                      f"confidence={alignment.confidence:.2f}")
                print(f"      offsets: {alignment.offsets_sec}")
                print(f"      reference_idx: {alignment.reference_idx}")

                if options.get('multicam_sync_preview'):
                    preview_path = syncer.sync_preview(
                        alignment.video_paths, alignment.offsets_sec,
                    )
                    stats['multicam_sync_preview'] = preview_path
                    print(f"   📁 Sync preview: {preview_path}")

                # Generate cut plan + render the switched video.
                beat_times = options.get('beat_times')
                switcher = _MultiCamSwitcher(
                    alignment=alignment,
                    scene_boundaries=stats.get('scene_boundaries'),
                    beat_times=beat_times,
                    crossfade_sec=float(options.get(
                        'multicam_crossfade_sec', 0.3)),
                    work_dir=os.path.join(output_dir, 'multicam_sw'),
                )
                cut_plan = switcher.generate_cut_plan(mode=multicam_mode)
                stats['multicam_cut_plan'] = [c.to_dict() for c in cut_plan]
                print(f"   ✅ Cut plan: {len(cut_plan)} cuts ({multicam_mode})")
                for c in cut_plan[:5]:
                    print(f"      [{c.start_sec:.1f}s-{c.end_sec:.1f}s] "
                          f"cam{c.cam_idx} ({c.reason})")
                if len(cut_plan) > 5:
                    print(f"      ... ({len(cut_plan)-5} more)")

                switched_path = os.path.join(
                    output_dir, 'multicam_switched.mp4',
                )
                switcher.render_multicam_video(
                    alignment.video_paths, cut_plan, switched_path,
                    crossfade=bool(options.get(
                        'multicam_crossfade', True)),
                )
                print(f"   ✅ Switched video: {switched_path}")
                # Replace the input_video_path so all downstream stages
                # operate on the switched output. (Note: we rebind the
                # local name — the caller's variable is unaffected.)
                input_video_path = switched_path
                stats['multicam_used'] = True
                stats['multicam_mode'] = multicam_mode
            except Exception as mc_err:
                print(f"   ⚠️  Multi-cam failed ({mc_err}); "
                      "falling back to single-cam path.")
                traceback.print_exc()
                stats['multicam_used'] = False
                stats['multicam_error'] = str(mc_err)
        elif multicam_mode and not _MULTICAM_AVAILABLE:
            print("\n[ pipeline ] WARNING: multicam_mode set but multicam "
                  "modules unavailable — single-cam path used.")
            stats['multicam_used'] = False
            stats['multicam_error'] = 'multicam modules not importable'
        elif multicam_mode and not multicam_videos:
            print("\n[ pipeline ] WARNING: multicam_mode set but "
                  "multicam_videos list is empty — single-cam path used.")
            stats['multicam_used'] = False
            stats['multicam_error'] = 'no multicam_videos provided'
        else:
            stats['multicam_used'] = False

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
            # B2: when use_whisperx option is set (and WhisperX is importable),
            # use WhisperXEngine to produce word-level timestamps + speaker
            # labels. Falls back to plain Whisper on any error so the pipeline
            # never breaks.
            use_whisperx = bool(options.get('use_whisperx', False))
            if use_whisperx and _WHISPERX_AVAILABLE:
                try:
                    print("   🎯 WhisperX mode (B2): word-level alignment + diarization")
                    transcript = _transcribe_with_whisperx(
                        input_video_path, output_dir, language=language,
                        model_name=options.get('whisperx_model', 'large-v3-turbo'),
                        hf_token=options.get('hf_token') or os.getenv('HF_TOKEN'),
                        skip_diarization=bool(options.get('skip_diarization', False)),
                    )
                except Exception as wx_err:
                    print(f"   ⚠️  WhisperX failed ({wx_err}); falling back to plain Whisper.")
                    traceback.print_exc()
                    use_whisperx = False
                    transcript = None
                else:
                    stats['whisperx_used'] = True
                    stats['whisperx_diarized'] = transcript.get('has_diarization', False)
            else:
                transcript = None
                if use_whisperx and not _WHISPERX_AVAILABLE:
                    print("   ⚠️  use_whisperx=True but WhisperX is not installed; "
                          "falling back to plain Whisper.")
            if transcript is None:
                # Plain Whisper fallback (unchanged v1 path)
                # New signature: transcribe_video(video_path, output_dir, model_size="base")
                # Old signature passed `language=` which is no longer supported.
                # Whisper auto-detects language; if user wants to force, they
                # should pass `model_size` instead.
                model_size = options.get('whisper_model', 'base' if language == 'en' else 'small')
                transcript = transcribe_video(input_video_path, output_dir, model_size=model_size)
            # transcribe_video already writes transcript.json internally, but
            # we keep the explicit save for backward compat (it overwrites
            # with the same content). The WhisperX path also writes
            # whisperx_result.json alongside it for downstream consumers.
            transcript_path = transcript.get('transcript_path', os.path.join(output_dir, 'transcript.json'))
            with open(transcript_path, 'w', encoding='utf-8') as f:
                json.dump(transcript, f, ensure_ascii=False, indent=2, default=str)
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
        narrative_arc_dict: dict | None = None
        if 'takes' in skip:
            print("   ⏭️  Skipped")
            selected_video = input_video_path
        else:
            try:
                # B7: try v3 (heuristic + VLM) first; falls back to v2 (B1)
                # heuristic, then to v1 OpenCV motion.
                v3_result = _run_take_selector_v3(
                    input_video_path, transcript, output_dir, options,
                ) if _TAKE_SELECTOR_V3_AVAILABLE else None
                if v3_result is not None:
                    selected_video = v3_result.get('selected_video', input_video_path)
                    stats['scene_boundaries'] = v3_result.get('scene_boundaries', [])
                    stats['selected_takes'] = v3_result.get('selected_takes', [])
                    stats['silence_segments'] = v3_result.get('silence_segments', [])
                    stats['vlm_used'] = v3_result.get('vlm_used', False)
                    narrative_arc_dict = v3_result.get('narrative_arc')
                    if narrative_arc_dict:
                        stats['narrative_arc'] = narrative_arc_dict
                        # Persist narrative_arc.json so remotion_renderer / external
                        # tools can pick it up for ordering.
                        try:
                            arc_path = os.path.join(output_dir, 'narrative_arc.json')
                            with open(arc_path, 'w', encoding='utf-8') as f:
                                json.dump(narrative_arc_dict, f, indent=2,
                                          ensure_ascii=False, default=str)
                            print(f"   📁 Narrative arc JSON: {arc_path}")
                        except Exception as _arc_err:
                            print(f"   ⚠️  Could not write narrative_arc.json: {_arc_err}")
                    scenes_json_path = os.path.join(output_dir, 'scene_detection.json')
                    try:
                        with open(scenes_json_path, 'w', encoding='utf-8') as f:
                            json.dump({
                                'scenes': stats['scene_boundaries'],
                                'selected_takes': stats['selected_takes'],
                                'silence_segments': stats['silence_segments'],
                            }, f, indent=2, ensure_ascii=False, default=str)
                        print(f"   📁 Scene detection JSON: {scenes_json_path}")
                    except Exception as _json_err:
                        print(f"   ⚠️  Could not write scene_detection.json: {_json_err}")
                    vlm_tag = "VLM✅" if stats['vlm_used'] else "VLM⏭️"
                    print(f"   ✅ v3: {len(stats['selected_takes'])} takes, "
                          f"{len(stats['scene_boundaries'])} scenes  [{vlm_tag}]")
                else:
                    # v3 unavailable (or no VLM) → try v2 (B1 heuristic only).
                    v2_result = _run_take_selector_v2(
                        input_video_path, transcript, output_dir, options,
                    )
                    if v2_result is not None:
                        # v2 path — selected_takes + scenes JSON written.
                        selected_video = v2_result.get('selected_video', input_video_path)
                        stats['scene_boundaries'] = v2_result.get('scene_boundaries', [])
                        stats['selected_takes'] = v2_result.get('selected_takes', [])
                        stats['silence_segments'] = v2_result.get('silence_segments', [])
                        stats['vlm_used'] = False
                        scenes_json_path = os.path.join(output_dir, 'scene_detection.json')
                        try:
                            with open(scenes_json_path, 'w', encoding='utf-8') as f:
                                json.dump({
                                    'scenes': stats['scene_boundaries'],
                                    'selected_takes': stats['selected_takes'],
                                    'silence_segments': stats['silence_segments'],
                                }, f, indent=2, ensure_ascii=False, default=str)
                            print(f"   📁 Scene detection JSON: {scenes_json_path}")
                        except Exception as _json_err:
                            print(f"   ⚠️  Could not write scene_detection.json: {_json_err}")
                        print(f"   ✅ v2: {len(stats['selected_takes'])} takes, "
                              f"{len(stats['scene_boundaries'])} scenes")
                    else:
                        # v2 unavailable → v1 fallback
                        selected_video = select_best_takes(input_video_path, transcript, output_dir)
                        if selected_video == input_video_path:
                            print("   ℹ️  Single take detected — no selection needed")
                        else:
                            print(f"   ✅ Best takes concatenated: {selected_video}")
            except Exception as e:
                print(f"   ⚠️  Take selection failed ({e}); using original video")
                traceback.print_exc()
                selected_video = input_video_path

        # ------------------------------------------------------------------
        # B11: Storyboard checkpoint — pause for user approval.
        # ------------------------------------------------------------------
        # If `generate_storyboard` (default True) and the storyboard module
        # is importable, build the storyboard image + JSON, persist the
        # pipeline state to /tmp/micky_pipeline_state_<hash>.json, and
        # RETURN early with status='paused_for_approval'. The Telegram
        # bot sends the storyboard image; when the user clicks ✅ Approve,
        # the bot re-invokes the Kaggle runner which calls
        # `resume_pipeline(state_path)` — picking up from Stage 3 below
        # without re-doing Whisper or take selection.
        generate_storyboard = bool(options.get('generate_storyboard', True))
        if generate_storyboard and _STORYBOARD_AVAILABLE and not skip:
            paused = _maybe_pause_for_storyboard(
                input_video_path=input_video_path,
                output_dir=output_dir,
                options=options,
                transcript=transcript,
                selected_video=selected_video,
                stats=stats,
                narrative_arc_dict=narrative_arc_dict,
            )
            if paused is not None:
                return paused
        elif generate_storyboard and not _STORYBOARD_AVAILABLE:
            print("   ⚠️  Storyboard requested but module unavailable; "
                  "continuing to final render.")

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
        # Stage 5: Color grading (B6: AI v2 with mood detection + shot match)
        # ------------------------------------------------------------------
        print("\n" + "=" * 70)
        print("🎬 Stage 5: Applying color grading (v2: CLIP mood → LUT → match)...")
        print("=" * 70)
        lut_choice = options.get('lut', DEFAULT_LUT)
        use_color_v2 = options.get('color_v2', True)
        custom_mood = options.get('mood', None)  # B6: optional override
        style_preset = options.get('style', None)  # B6: optional preset
        if 'color' in skip:
            print("   ⏭️  Skipped")
            graded_video = matted_video
        else:
            try:
                if use_color_v2:
                    # Build scene boundaries from transcript segments as a
                    # lightweight proxy (true scene detection is a future
                    # task; transcript segments are usually a good shot
                    # boundary estimate for talking-head footage).
                    scenes = _estimate_scene_boundaries(
                        transcript, _probe_video_duration(matted_video)
                    )
                    graded_video = _run_color_grading_v2(
                        video_path=matted_video,
                        output_dir=output_dir,
                        scenes=scenes,
                        custom_mood=custom_mood,
                        style_preset=style_preset,
                        intensity=float(options.get('intensity', 0.85)),
                    )
                    print(f"   ✅ Color graded v2: {graded_video}")
                else:
                    raise RuntimeError('color_v2 disabled by option')
            except Exception as e:
                print(f"   ⚠️  Color grading v2 failed ({e}); "
                      f"falling back to legacy apply_color_grading()")
                traceback.print_exc()
                try:
                    graded_video = apply_color_grading(
                        matted_video, lut_choice, output_dir
                    )
                    print(f"   ✅ Color graded (legacy) with LUT "
                          f"'{lut_choice}': {graded_video}")
                except Exception as e2:
                    print(f"   ⚠️  Legacy color grading also failed ({e2}); "
                          f"using matted video")
                    traceback.print_exc()
                    graded_video = matted_video

        # ------------------------------------------------------------------
        # Stage 6: Generate captions
        # ------------------------------------------------------------------
        print("\n" + "=" * 70)
        print("🎬 Stage 6: Generating captions...")
        print("=" * 70)
        caption_style = options.get('caption_style', DEFAULT_CAPTION_STYLE)
        # B13: if a brand profile is active, prefer its default_style for
        # captions (unless the caller explicitly set caption_style).  Also
        # pass brand_profile.font_primary to the kinetic caption generator
        # so captions use the brand's font (font customization).
        if bo is not None and not options.get('caption_style'):
            caption_style = bo.profile.get('default_style') or caption_style
        # B13: kinetic captions accept a font_name override.  We pass the
        # brand's font_primary if set; otherwise let generate_kinetic_captions
        # pick based on language (Anton → Cairo for Arabic).
        kinetic_font_override = bo.font_primary if (bo and bo.font_primary) else None

        # B5: prefer the kinetic caption pipeline (CapCut-style animated ASS)
        # when pysubs2 is available.  Falls back to legacy SRT-based
        # generate_captions() otherwise.
        kinetic_ass_path: str | None = None
        if 'captions' in skip:
            print("   ⏭️  Skipped")
            captions = {'words': [], 'phrases': [], 'style': caption_style,
                        'language': options.get('language', DEFAULT_LANGUAGE)}
        else:
            try:
                if _KINETIC_AVAILABLE:
                    print("   🎯 Using kinetic caption pipeline (B5)")
                    # Use the latest available video as the burn-in source.
                    burn_source = (graded_video if 'color' not in skip
                                   else audio_swapped_video)
                    kinetic_kwargs: dict = dict(
                        video_path=burn_source,
                        output_dir=output_dir,
                        style=caption_style,
                        language=options.get('language', DEFAULT_LANGUAGE),
                        burn_in=options.get('kinetic_burn_in', True),
                    )
                    if kinetic_font_override:
                        kinetic_kwargs['font_name'] = kinetic_font_override
                    kinetic_result = generate_kinetic_captions(
                        transcript,
                        **kinetic_kwargs,
                    )
                    kinetic_ass_path = kinetic_result.get('ass_path')
                    captions = {
                        'words': [], 'phrases': [],
                        'style': kinetic_result['style'],
                        'language': kinetic_result.get('language', 'en'),
                        'ass_path': kinetic_ass_path,
                        'burned_path': kinetic_result.get('burned_path'),
                        'chunk_count': kinetic_result.get('chunk_count', 0),
                    }
                    print(f"   ✅ Kinetic: {kinetic_result['word_count']} words → "
                          f"{kinetic_result['chunk_count']} chunks "
                          f"(style={kinetic_result['style']}, "
                          f"font={kinetic_result.get('font_name', 'Anton')})")
                    if kinetic_result.get('burned_path'):
                        print(f"   ✅ Burned-in video: "
                              f"{kinetic_result['burned_path']}")
                else:
                    captions = generate_captions(
                        transcript, caption_style, output_dir,
                    )
                    print(f"   ✅ {len(captions.get('words', []))} caption words "
                          f"(style={caption_style}) [legacy SRT]")
            except Exception as e:
                print(f"   ⚠️  Caption generation failed ({e}); "
                      f"falling back to legacy")
                traceback.print_exc()
                try:
                    captions = generate_captions(
                        transcript, caption_style, output_dir,
                    )
                except Exception as e2:
                    print(f"   ❌ Legacy fallback also failed: {e2}")
                    captions = {'words': [], 'phrases': [],
                                'style': caption_style,
                                'language': options.get('language',
                                                         DEFAULT_LANGUAGE)}

        # Surface the .ass path for downstream stages (Agent B
        # remotion_renderer can read options['kinetic_ass_path']).
        if kinetic_ass_path:
            options['kinetic_ass_path'] = kinetic_ass_path
            options['kinetic_style'] = captions.get('style', caption_style)

        # B13: apply brand colours to the .ass file (text-based rewrite of
        # Style: + \1c / \2c inline tags).  This produces a *_brand.ass next
        # to the original; we update options['kinetic_ass_path'] so any
        # downstream consumer picks up the restyled file.  Note: if the
        # captions were already burned into the video, the burned video
        # still has the *original* colours — the restyle only affects the
        # standalone .ass file (useful for FFmpeg re-burn or libass players).
        if bo is not None and kinetic_ass_path:
            try:
                restyled = bo.restyle_captions(kinetic_ass_path)
                if restyled and restyled != kinetic_ass_path:
                    print(f"   🎨 Brand restyled captions → {restyled}")
                    options['kinetic_ass_path'] = restyled
                    kinetic_ass_path = restyled
                    captions['ass_path'] = restyled
                    stats['brand_captions_restyled'] = True
            except Exception as e:
                print(f"   ⚠️  Brand caption restyle failed ({e}); "
                      f"using original .ass")
                traceback.print_exc()

        # ------------------------------------------------------------------
        # Stage 4.5: Sound Design (B8)
        # ------------------------------------------------------------------
        # Fetches background music (Jamendo CC-BY or local MusicLibrary from
        # B4) + SFX (Freesound CC0), auto-ducks music under speech via
        # FFmpeg sidechain compression, places whoosh SFX at scene cut
        # points, and mixes all layers into a final track loudness-
        # normalized to -14 LUFS (YouTube/TikTok broadcast standard).
        # Skipped gracefully if sound_designer module is missing or if
        # 'sound_design' is in skip_stages.
        print("\n" + "=" * 70)
        print("🎬 Stage 4.5: Sound Design (B8 — music + SFX + ducking)...")
        print("=" * 70)
        if 'sound_design' in skip:
            print("   ⏭️  Skipped (in skip_stages)")
        elif not _SOUND_DESIGNER_AVAILABLE:
            print("   ⏭️  Skipped (sound_designer module unavailable; "
                  "graded video passed through to Stage 7)")
        else:
            try:
                designer = _SoundDesigner(
                    jamendo_client_id=options.get('jamendo_client_id'),
                    freesound_token=options.get('freesound_token'),
                    music_library_path=options.get('music_library_path'),
                )
                # Build scene_boundaries list for cut-point detection. We
                # prefer the real scene boundaries from Stage 2 (stats)
                # if available; else fall back to transcript-segment
                # boundaries so SFX still get placed at natural pauses.
                scene_boundaries_for_sound = (
                    stats.get('scene_boundaries') or []
                )
                if not scene_boundaries_for_sound and transcript:
                    # Fall back to transcript segments as scene proxies.
                    segs = transcript.get('segments', []) or []
                    scene_boundaries_for_sound = [
                        {'start_time': float(s.get('start', 0.0)),
                         'end_time': float(s.get('end', s.get('start', 0.0) + 1.0))}
                        for s in segs
                    ]
                # whisperx_result: prefer the full WhisperX dict (saved by
                # Stage 1 when use_whisperx=True); else fall back to the
                # plain `transcript` dict which has the same shape (top-
                # level `segments` list with start/end/words).
                whisperx_result_for_sound = (
                    stats.get('whisperx_result') or transcript or {}
                )
                mood_override = options.get('mood')  # B6 mood override
                # Run the full sound-design pipeline. auto_design_track
                # returns the path to the final video with mixed audio;
                # we rebind `graded_video` so Stage 7 operates on it.
                sound_designed_video = designer.auto_design_track(
                    video_path=graded_video,
                    scene_boundaries=scene_boundaries_for_sound,
                    whisperx_result=whisperx_result_for_sound,
                    mood=mood_override,
                )
                if sound_designed_video and sound_designed_video != graded_video:
                    print(f"   ✅ Sound-designed video: {sound_designed_video}")
                    stats['sound_design_used'] = True
                    # Persist attribution metadata (CC-BY music requires it).
                    try:
                        import shutil as _sh
                        _attr_dir = os.path.join(output_dir, 'sound_attribution')
                        os.makedirs(_attr_dir, exist_ok=True)
                        for _fname in os.listdir('/tmp/micky_audio'):
                            if _fname.endswith('.json'):
                                _src = os.path.join('/tmp/micky_audio', _fname)
                                _sh.copy(_src, os.path.join(_attr_dir, _fname))
                        print(f"   📁 Attribution JSONs: {_attr_dir}")
                    except Exception as _attr_err:
                        print(f"   ⚠️  Could not copy attribution JSONs: "
                              f"{_attr_err}")
                    graded_video = sound_designed_video
                else:
                    print("   ℹ️  Sound design produced no change "
                          "(no music/SFX available); using graded video")
                    stats['sound_design_used'] = False
            except Exception as sd_err:
                print(f"   ⚠️  Sound design failed ({sd_err}); using graded video")
                traceback.print_exc()
                stats['sound_design_used'] = False
                stats['sound_design_error'] = str(sd_err)

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
                # B7: pass the narrative arc into Remotion via options so the
                # renderer can order clips / pick intro & outro cards based on
                # the VLM-derived arc (opening → rising → climax → resolution).
                # remotion_renderer.py reads `options['narrative_arc']` if present.
                if narrative_arc_dict is not None:
                    options['narrative_arc'] = narrative_arc_dict

                # B14: parallel rendering (default on). Splits the graded video
                # into N segments aligned to scene boundaries, renders each in
                # a separate thread via ThreadPoolExecutor, then concatenates.
                # Falls back to single-threaded render_animations on failure.
                parallel_render = bool(options.get('parallel_render', True))
                segment_count = int(options.get('segment_count', 4))
                use_parallel = (
                    parallel_render
                    and _PARALLEL_RENDERER_AVAILABLE
                    and segment_count > 1
                )
                # Scene boundaries for splitting (best-effort — empty list is OK).
                scene_boundaries_for_split = (
                    stats.get('scene_boundaries')
                    or options.get('scene_boundaries')
                    or []
                )

                if use_parallel:
                    print(f"   ⚡ B14 parallel render: {segment_count} segments "
                          f"(ThreadPoolExecutor)")
                    animated_video = render_parallel(
                        graded_video, captions, options, output_dir,
                        scene_boundaries=scene_boundaries_for_split,
                        segment_count=segment_count,
                    )
                    stats['parallel_render_used'] = True
                else:
                    if parallel_render and not _PARALLEL_RENDERER_AVAILABLE:
                        print("   ⚠️  parallel_render=True but parallel_renderer "
                              "module unavailable; using single-thread.")
                    animated_video = render_animations(
                        graded_video, captions, options, output_dir
                    )
                    stats['parallel_render_used'] = False
                print(f"   ✅ Animated video: {animated_video}")
            except Exception as e:
                print(f"   ⚠️  Remotion rendering failed ({e}); using graded video")
                traceback.print_exc()
                animated_video = graded_video

        # ------------------------------------------------------------------
        # Stage 8: AI Enhancement (B10) — OPTIONAL, off by default
        # ------------------------------------------------------------------
        # Two independent sub-features:
        #   (a) options['add_b_roll']     → AIVideoGenerator fills gaps with
        #                                   generated B-roll (Wan2.1 / LTX-Video).
        #   (b) options['narrate_script'] → VoiceCloner adds AI voiceover
        #                                   (OpenVoice v2, Arabic fallback chain).
        # Both are skipped unless their option flag is True. If the underlying
        # module fails to load, the stage logs a warning and the pipeline
        # continues without the AI enhancement (graceful degradation).
        print("\n" + "=" * 70)
        print("🎬 Stage 8: AI Enhancement (B10, optional)...")
        print("=" * 70)
        do_b_roll = bool(options.get('add_b_roll', False))
        do_narrate = bool(options.get('narrate_script', False))
        ai_stats: dict[str, Any] = {'b_roll_used': False, 'narration_used': False}

        if not (do_b_roll or do_narrate) or 'ai_enhancement' in skip:
            if 'ai_enhancement' in skip:
                print("   ⏭️  Skipped (in skip_stages)")
            else:
                print("   ⏭️  Skipped (add_b_roll / narrate_script not set)")
        else:
            # (a) B-roll generation
            if do_b_roll:
                if _AI_VIDEO_AVAILABLE:
                    try:
                        b_roll_prompts = options.get('b_roll_prompts') or []
                        if not b_roll_prompts:
                            print("   ℹ️  add_b_roll=True but no b_roll_prompts "
                                  "list provided; nothing to generate.")
                        else:
                            print(f"   🎯 Generating {len(b_roll_prompts)} B-roll "
                                  f"clip(s) via Wan2.1/LTX-Video...")
                            gen = _AIVideoGenerator(
                                model_name=options.get(
                                    'video_model',
                                    'Wan-AI/Wan2.1-T2V-1.3B',
                                ),
                                device=options.get('ai_device', 'cuda'),
                            )
                            try:
                                clips = gen.batch_generate_b_rolls(
                                    b_roll_prompts,
                                    duration_sec=float(
                                        options.get('b_roll_duration_sec', 5.0)
                                    ),
                                    resolution=tuple(
                                        options.get('b_roll_resolution', (1280, 720))
                                    ),
                                )
                                ai_stats['b_roll_used'] = bool(clips)
                                ai_stats['b_roll_clips'] = clips
                                print(f"   ✅ {len(clips)} B-roll clip(s) generated")
                                if clips:
                                    # Persist a manifest so downstream stages can
                                    # splice them in (Stage 9 / Remotion).
                                    try:
                                        manifest_path = os.path.join(
                                            output_dir, 'b_roll_manifest.json',
                                        )
                                        with open(manifest_path, 'w',
                                                  encoding='utf-8') as f:
                                            json.dump(
                                                {'clips': clips,
                                                 'prompts': b_roll_prompts},
                                                f, ensure_ascii=False, indent=2,
                                            )
                                        print(f"   📁 B-roll manifest: "
                                              f"{manifest_path}")
                                    except Exception as _mf_err:
                                        print(f"   ⚠️  Could not write "
                                              f"b_roll_manifest.json: {_mf_err}")
                            finally:
                                gen.cleanup()
                    except Exception as e:
                        print(f"   ⚠️  B-roll generation failed ({e}); "
                              "continuing without B-roll.")
                        traceback.print_exc()
                else:
                    print("   ⚠️  add_b_roll=True but ai_video_gen module "
                          "unavailable; skipping B-roll.")

            # (b) Voice cloning / narration
            if do_narrate:
                if _VOICE_CLONE_AVAILABLE:
                    try:
                        narrate_script_text = options.get('narrate_script_text') or ''
                        # If narrate_script is True but no text provided, fall
                        # back to the Whisper transcript text (if any).
                        if not narrate_script_text and transcript:
                            narrate_script_text = (
                                transcript.get('text', '') if isinstance(
                                    transcript, dict) else str(transcript)
                            )
                        if not narrate_script_text.strip():
                            print("   ℹ️  narrate_script=True but no script text "
                                  "available; nothing to narrate.")
                        else:
                            voice_choice = options.get('narration_voice', 'default')
                            ref_audio = options.get('narration_reference_audio')
                            language = options.get('language', DEFAULT_LANGUAGE)
                            print(f"   🎯 Narrating {len(narrate_script_text)} "
                                  f"chars via OpenVoice v2 (lang={language})...")
                            cloner = _VoiceCloner(
                                model_name=options.get('voice_model', 'OpenVoiceV2'),
                                device=options.get('ai_device', 'cuda'),
                            )
                            try:
                                narration_wav = cloner.narrate_script(
                                    narrate_script_text,
                                    voice=voice_choice,
                                    language=language,
                                    reference_audio_path=ref_audio,
                                )
                                ai_stats['narration_used'] = True
                                ai_stats['narration_wav'] = narration_wav
                                print(f"   ✅ Narration: {narration_wav}")
                                # Surface for downstream stages / export.
                                options['narration_wav'] = narration_wav
                            finally:
                                cloner.cleanup()
                    except Exception as e:
                        print(f"   ⚠️  Narration failed ({e}); "
                              "continuing without AI voiceover.")
                        traceback.print_exc()
                else:
                    print("   ⚠️  narrate_script=True but voice_clone module "
                          "unavailable; skipping narration.")

        stats['ai_enhancement'] = ai_stats

        # ------------------------------------------------------------------
        # Stage 8.5: Brand overlay (B13) — OPTIONAL, runs when brand_profile set
        # ------------------------------------------------------------------
        # Applies the user's brand identity to the animated video:
        #   • intro/outro concat (if intro_video_url / outro_video_url set)
        #   • logo watermark at configured position with configured opacity
        # Caption colour restyle already happened in Stage 6 (above) on the
        # .ass file.  This stage works on the rendered MP4 directly.
        #
        # All FFmpeg failures are caught and logged — the pipeline never
        # crashes on a brand-application hiccup (graceful degradation).
        if bo is not None and 'brand' not in skip:
            print("\n" + "=" * 70)
            print("🎨 Stage 8.5: Applying brand overlay (B13)...")
            print("=" * 70)
            try:
                branded = bo.apply_brand_to_video(animated_video)
                if branded != animated_video:
                    print(f"   ✅ Branded video: {branded}")
                    animated_video = branded
                    stats['brand_overlay_applied'] = True
                else:
                    print("   ℹ️  Brand overlay had nothing to apply "
                          "(no logo + no intro/outro)")
            except Exception as e:
                print(f"   ⚠️  Brand overlay failed ({e}); using unbranded video")
                traceback.print_exc()
        elif bo is not None and 'brand' in skip:
            print("\n" + "=" * 70)
            print("🎨 Stage 8.5: Brand overlay (B13) — ⏭️  Skipped")
            print("=" * 70)

        # ------------------------------------------------------------------
        # Stage 9: Multi-platform export
        # ------------------------------------------------------------------
        print("\n" + "=" * 70)
        print("🎬 Stage 9: Exporting to multiple platforms...")
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
        # Stage 10: B12 — Platform adaptation + A/B variants (OPTIONAL)
        # ------------------------------------------------------------------
        # Pro editors deliver 2–3 variants + a platform-adapted master per
        # destination (TikTok 9:16 ≤ 60s fast / YouTube 16:9 ≤ 15min medium /
        # Reels 9:16 ≤ 90s). This stage runs PlatformAdapter on the final
        # rendered video for each requested platform, and optionally
        # generates N variants (1–3, default 1 = no variants) for the
        # primary platform via ABVariantGenerator.
        #
        # Defaults:
        #   adapt_platforms   = ['tiktok']   (off = [])
        #   generate_variants  = 1            (max 3, off by default)
        adapt_platforms: list[str] = list(options.get('adapt_platforms', ['tiktok']))
        # If user explicitly passes `platforms` for B12 (not the legacy
        # multi_export list), prefer it. We detect this by checking if
        # any platform name is in PLATFORM_SPECS (the B12 catalogue).
        if _B12_AVAILABLE and _PlatformAdapter is not None:
            try:
                from platform_adapter import PLATFORM_SPECS as _B12_SPECS
                b12_platforms_in_options = [
                    p for p in (options.get('platforms') or [])
                    if p in _B12_SPECS
                ]
                if b12_platforms_in_options and 'adapt_platforms' not in options:
                    adapt_platforms = b12_platforms_in_options
            except Exception:
                pass

        # generate_variants: default 1 (= off), max 3.
        generate_variants = max(1, min(3, int(options.get('generate_variants', 1))))

        adapted_outputs: list[dict] = []
        variant_outputs: list[dict] = []
        if 'adapt' in skip:
            print("\n" + "=" * 70)
            print("🎬 Stage 10: Platform adaptation + A/B variants (B12)...")
            print("=" * 70)
            print("   ⏭️  Skipped")
        elif not _B12_AVAILABLE or not adapt_platforms:
            print("\n" + "=" * 70)
            print("🎬 Stage 10: Platform adaptation + A/B variants (B12)...")
            print("=" * 70)
            if not _B12_AVAILABLE:
                print("   ⏭️  Skipped (platform_adapter module unavailable)")
            elif not adapt_platforms:
                print("   ⏭️  Skipped (adapt_platforms=[] or empty)")
        else:
            print("\n" + "=" * 70)
            print("🎬 Stage 10: Platform adaptation + A/B variants (B12)...")
            print("=" * 70)
            try:
                # Convert selected_takes (dicts from v3) back into Take
                # objects so PlatformAdapter can prioritise highest-scored
                # segments when trimming to max_duration.
                takes_for_adapt = _selected_takes_to_objects(
                    stats.get('selected_takes') or [],
                )
                beat_times_for_adapt = (
                    list(options.get('beat_times') or [])
                    or stats.get('beat_times') or []
                )

                # ---- Per-platform adaptation ------------------------------
                # The primary platform is the first in the list (used
                # later for variant generation).
                primary_platform = adapt_platforms[0]
                for plat in adapt_platforms:
                    try:
                        adapter = _PlatformAdapter(plat)
                        plat_out = os.path.join(
                            output_dir,
                            f"{Path(animated_video).stem}_{plat}_adapted.mp4",
                        )
                        adapted_path = adapter.adapt_video(
                            animated_video,
                            takes=takes_for_adapt or None,
                            beat_times=beat_times_for_adapt or None,
                            output_path=plat_out,
                        )
                        meta = adapter.get_platform_metadata()
                        # Try to generate a platform-tuned caption (LLM call
                        # via micky gateway; falls back to template).
                        transcript_text = get_transcript_text(transcript) \
                            if transcript else ''
                        try:
                            caption = adapter.generate_caption_for_platform(
                                transcript_text, plat,
                            )
                        except Exception as cap_err:
                            print(f"      ⚠️  caption gen failed ({cap_err}); "
                                  "no caption attached.")
                            caption = ''
                        adapted_outputs.append({
                            'platform': plat,
                            'video_path': adapted_path,
                            'caption': caption,
                            'hashtags': meta.get('recommended_hashtags', []),
                            'metadata': meta,
                            'size_mb': round(
                                os.path.getsize(adapted_path) / (1024 * 1024), 2
                            ) if os.path.exists(adapted_path) else 0.0,
                        })
                        print(f"   ✅ {plat:10s} | {adapted_outputs[-1]['size_mb']:6.1f}MB "
                              f"| {adapted_path}")
                    except Exception as plat_err:
                        print(f"   ❌ {plat} adaptation failed: {plat_err}")
                        traceback.print_exc()

                # ---- A/B variants for the primary platform ----------------
                if generate_variants > 1 and _ABVariantGenerator is not None:
                    print(f"\n   🎯 A/B variants: {generate_variants} variants for "
                          f"primary platform '{primary_platform}'...")
                    # Variant generation re-renders from the master video
                    # (not the platform-adapted one) so variants can be
                    # adapted to ANY platform afterwards if desired.
                    variant_base = (
                        adapted_outputs[0]['video_path'] if adapted_outputs
                        else animated_video
                    )
                    variants_dir = os.path.join(output_dir, 'variants')
                    gen = _ABVariantGenerator(
                        base_video=variant_base,
                        scene_boundaries=stats.get('scene_boundaries') or [],
                        whisperx_result=transcript or {},
                        beat_times=beat_times_for_adapt or None,
                        output_dir=variants_dir,
                    )
                    variants = gen.generate_variants(count=generate_variants)
                    # Score + pick the best (VLM if available, else neutral).
                    try:
                        best = gen.pick_best_variant(
                            variants, criteria=str(options.get(
                                'variant_criteria', 'virality')),
                        )
                        stats['best_variant_id'] = best.id
                        stats['best_variant_score'] = best.score
                    except Exception as vp_err:
                        print(f"      ⚠️  pick_best_variant failed ({vp_err}); "
                              "no best-variant selection.")
                        best = variants[0] if variants else None
                    # Build side-by-side comparison image.
                    try:
                        compare_meta = gen.compare_variants(variants)
                        stats['variants_comparison'] = compare_meta
                    except Exception as vc_err:
                        print(f"      ⚠️  compare_variants failed ({vc_err}).")

                    for v in variants:
                        variant_outputs.append({
                            'id': v.id,
                            'description': v.description,
                            'video_path': v.video_path,
                            'parameters_used': v.parameters_used,
                            'score': v.score,
                            'is_best': (best is not None and v.id == best.id),
                        })
                    print(f"   ✅ {len(variant_outputs)} variants generated; best="
                          f"{best.id if best else 'n/a'}")
                elif generate_variants > 1 and _ABVariantGenerator is None:
                    print("   ⚠️  generate_variants>1 but ABVariantGenerator "
                          "unavailable; skipping variant generation.")

                stats['adapt_platforms'] = adapt_platforms
                stats['adapted_outputs'] = adapted_outputs
                stats['variant_outputs'] = variant_outputs
                stats['generate_variants'] = generate_variants
            except Exception as b12_err:
                print(f"   ❌ B12 stage failed: {b12_err}")
                traceback.print_exc()

        # ------------------------------------------------------------------
        # Stats & wrap-up
        # ------------------------------------------------------------------
        duration_seconds = _probe_video_duration(input_video_path)
        stats['duration_seconds'] = duration_seconds
        stats['processing_time'] = round(time.time() - t0, 2)

        n_outputs = len(outputs) + len(adapted_outputs)
        print("\n" + "=" * 70)
        print(f"🏁 Pipeline complete in {stats['processing_time']}s")
        print(f"   Source:   {input_video_path}  ({duration_seconds:.1f}s)")
        print(f"   Outputs:  {len(outputs)} platforms (legacy) + "
              f"{len(adapted_outputs)} adapted + {len(variant_outputs)} variants")
        print("=" * 70 + "\n")

        return {
            'outputs': outputs,
            'adapted_outputs': adapted_outputs,
            'variant_outputs': variant_outputs,
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
# Spec-based entry point (for API / orchestration callers)
# ---------------------------------------------------------------------------
def run_pipeline_from_spec(input_spec: dict) -> dict:
    """
    Run the full montage pipeline from a JSON-serializable spec dict.

    This is the orchestration-friendly entry point — it accepts a single
    `input_spec` and returns `{output_url, output_meta}`, suitable for
    use from a backend task queue or REST handler.

    Args:
        input_spec: dict with the following keys (all optional unless noted):
            - file_url        str   (required) path/URL to the raw 1080p
                                     30fps 9:16 video. If it's a URL, the
                                     caller is expected to have already
                                     downloaded it to a local path that
                                     ffmpeg can read.
            - output_dir      str   (required) where to drop outputs.
            - caption         str   optional override caption text.
            - caption_style   str   hormozi | minimal | arabic_bold
            - language        str   ar | en
            - audience        str   patients | colleagues
            - background      str   one of: dental_office, blue_gradient,
                                       white_studio, infographic_bg, dreamy_soft
            - lut             str   one of: teal_orange, medical_clean,
                                              warm_clinical
            - platforms       list[str]  subset of the 5 supported platforms.
            - skip_stages     set[str]   stage ids to skip.

    Returns:
        {
            'output_url':   str,           # primary MP4 path (first platform)
            'output_meta': {
                'outputs':     [...],     # per-platform export list
                'stats':       {...},
                'transcript_path': str,
                'captions_path':   str,
            }
        }
    """
    if not isinstance(input_spec, dict):
        raise TypeError(f'input_spec must be a dict, got {type(input_spec)}')

    file_url = input_spec.get('file_url') or input_spec.get('input_video_path')
    if not file_url:
        raise ValueError(
            "input_spec must include 'file_url' "
            "(or 'input_video_path') pointing to the source video."
        )

    # The output_dir is where outputs will be written. The downstream
    # 'output_url' (returned to the caller) is the path of the final MP4,
    # NOT a directory — so we accept only 'output_dir' here.
    output_dir = input_spec.get('output_dir')
    if not output_dir:
        raise ValueError(
            "input_spec must include 'output_dir' where outputs should be "
            "written."
        )

    # Map spec keys → pipeline options dict
    options: dict[str, Any] = {}
    for spec_key, opt_key in (
        ('caption_style', 'caption_style'),
        ('language', 'language'),
        ('audience', 'audience'),
        ('background', 'background'),
        ('lut', 'lut'),
        ('platforms', 'platforms'),
        ('skip_stages', 'skip_stages'),
        # B6: AI color grading v2 keys
        ('color_v2', 'color_v2'),
        ('mood', 'mood'),
        ('style', 'style'),
        ('intensity', 'intensity'),
        # B2: WhisperX integration keys
        ('use_whisperx', 'use_whisperx'),
        ('whisperx_model', 'whisperx_model'),
        ('hf_token', 'hf_token'),
        ('skip_diarization', 'skip_diarization'),
        # B14: parallel render keys
        ('parallel_render', 'parallel_render'),
        ('segment_count', 'segment_count'),
        # B15: multi-cam sync + switcher keys
        ('multicam_mode', 'multicam_mode'),
        ('multicam_videos', 'multicam_videos'),
        ('multicam_alignment_method', 'multicam_alignment_method'),
        ('multicam_sync_preview', 'multicam_sync_preview'),
        ('multicam_crossfade_sec', 'multicam_crossfade_sec'),
        ('multicam_crossfade', 'multicam_crossfade'),
        ('beat_times', 'beat_times'),
        # B10: AI enhancement (Wan2.1 B-roll + OpenVoice v2 narration) keys
        ('add_b_roll', 'add_b_roll'),
        ('b_roll_prompts', 'b_roll_prompts'),
        ('b_roll_duration_sec', 'b_roll_duration_sec'),
        ('b_roll_resolution', 'b_roll_resolution'),
        ('narrate_script', 'narrate_script'),
        ('narrate_script_text', 'narrate_script_text'),
        ('narration_voice', 'narration_voice'),
        ('narration_reference_audio', 'narration_reference_audio'),
        ('video_model', 'video_model'),
        ('voice_model', 'voice_model'),
        ('ai_device', 'ai_device'),
        # B13: brand profile (logo watermark + brand-coloured captions +
        # intro/outro pre-roll). The Worker (kaggle_runner.ts) will fetch
        # the brand_profiles row from D1 by user_id and pass it through
        # input_spec['brand_profile'] as a dict.
        ('brand_profile', 'brand_profile'),
        # B12: platform adaptation + A/B variant generation. Drives Stage 10.
        # 'adapt_platforms' defaults to ['tiktok'] inside run_pipeline; passing
        # it through input_spec lets orchestration callers override (e.g. to
        # deliver both TikTok + YouTube masters). 'generate_variants' clamps to
        # [1, 3] (1 = off by default).
        ('adapt_platforms', 'adapt_platforms'),
        ('generate_variants', 'generate_variants'),
        ('variant_criteria', 'variant_criteria'),
        # B11: storyboard checkpoint — when True (default), the pipeline
        # pauses after Stage 2 to wait for the user to approve / edit /
        # regenerate the storyboard. The Worker's kaggle_runner.ts re-
        # invokes the pipeline via `resume_pipeline(state_path)` once
        # the user clicks ✅ Approve in the Telegram chat.
        ('generate_storyboard', 'generate_storyboard'),
    ):
        if spec_key in input_spec:
            options[opt_key] = input_spec[spec_key]

    # Optional: store caller-supplied caption text in options for downstream
    # consumers (caption_generator currently synthesizes from Whisper, but
    # the override text is preserved here for future use).
    if input_spec.get('caption'):
        options['caption_override'] = input_spec['caption']

    result = run_pipeline(file_url, output_dir, options)

    # Pick the first platform output as the primary `output_url`.
    outputs = result.get('outputs', []) or []
    primary_url = outputs[0]['video_path'] if outputs else (
        os.path.join(output_dir, 'animated_video.mp4')
    )

    return {
        'output_url': primary_url,
        'output_meta': {
            'outputs': outputs,
            'stats': result.get('stats', {}),
            'transcript_path': result.get('transcript_path'),
            'captions_path': result.get('captions_path'),
            'error': result.get('error'),
        },
    }


# ---------------------------------------------------------------------------
# Whisper transcription (Stage 1)
# ---------------------------------------------------------------------------

def _transcribe_with_whisperx(
    video_path: str,
    output_dir: str,
    language: str | None = None,
    model_name: str = "large-v3-turbo",
    hf_token: str | None = None,
    skip_diarization: bool = False,
    device: str = "cuda",
    compute_type: str = "int8_float16",
) -> dict:
    """B2 helper: WhisperX transcription with word-level alignment + diarization.

    Produces a transcript dict in the SAME shape as ``transcribe_video()``
    so downstream stages (take_selector, caption_generator) consume it
    unchanged. Additionally attaches a ``whisperx_result`` key with the
    full WhisperX result (speakers, words) and writes
    ``whisperx_result.json`` alongside ``transcript.json`` for B5/B7 use.

    Args:
        video_path:    Input video / audio path (ffmpeg-readable).
        output_dir:    Where to write outputs.
        language:      Force language code ('ar','en') or None for auto.
        model_name:    WhisperX model name (default 'large-v3-turbo').
        hf_token:      HuggingFace token (needed for pyannote diarization).
                       If None and not in env, diarization is skipped.
        skip_diarization: If True, use transcribe_simple() (no diarization).
        device:        'cuda' or 'cpu'.
        compute_type:  ctranslate2 compute type.

    Returns:
        dict: {text, segments:[{id,start,end,text,speaker,words:[...]}],
               language, has_diarization, duration_sec,
               whisperx_result: dict,
               transcript_path: str}
    """
    import asyncio
    import json
    import os
    import subprocess
    from pathlib import Path

    os.makedirs(output_dir, exist_ok=True)
    audio_path = str(Path(output_dir) / "audio.wav")
    transcript_path = str(Path(output_dir) / "transcript.json")
    whisperx_path = str(Path(output_dir) / "whisperx_result.json")

    # Step 1: Extract audio with ffmpeg (16kHz mono PCM, required by WhisperX)
    print(f"[whisperx_stage] Extracting audio from {video_path}...")
    subprocess.run(
        ["ffmpeg", "-y", "-i", video_path,
         "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
         audio_path],
        check=True, capture_output=True,
    )

    hf_token = hf_token or os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN")
    # Respect skip_diarization but also auto-skip if no token
    effective_token = None if skip_diarization else hf_token
    if skip_diarization:
        print("[whisperx_stage] skip_diarization=True — using transcribe_simple().")
    elif not hf_token:
        print("[whisperx_stage] No HF_TOKEN — word alignment only "
              "(set HF_TOKEN to enable speaker diarization).")

    engine = WhisperXEngine(
        model_name=model_name, device=device,
        compute_type=compute_type, language=language,
        hf_token=effective_token,
    )
    try:
        if effective_token is None:
            # Simple path: word timestamps only (no diarization)
            simple = engine.transcribe_simple(audio_path)
            transcript = {
                "text": simple["text"],
                "segments": simple["segments"],
                "language": simple["language"],
                "has_diarization": False,
                "transcript_path": transcript_path,
                "whisperx_result": None,
            }
            # Persist whisperx_result.json even in simple mode (for symmetry)
            try:
                with open(whisperx_path, "w", encoding="utf-8") as f:
                    json.dump({"simple": True, **simple}, f,
                              ensure_ascii=False, indent=2, default=str)
            except Exception:
                pass
            return transcript

        # Full path: alignment + diarization
        wx_result: WhisperXResult = asyncio.run(engine.transcribe(audio_path))
        # Plain-Whisper-compatible transcript dict for downstream stages
        transcript = {
            "text": wx_result.text,
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
                for s in wx_result.segments
            ],
            "language": wx_result.language,
            "has_diarization": wx_result.has_diarization,
            "duration_sec": wx_result.duration_sec,
            "transcript_path": transcript_path,
            # Full WhisperXResult as a dict (consumed by B5 caption_generator
            # and B7 take_selector_v2 when present).
            "whisperx_result": json.loads(
                engine.format_for_ass(wx_result, style="bold_pop")
            ),
        }
        # Persist whisperx_result.json
        try:
            with open(whisperx_path, "w", encoding="utf-8") as f:
                json.dump(transcript["whisperx_result"], f,
                          ensure_ascii=False, indent=2, default=str)
            print(f"[whisperx_stage] WhisperX result → {whisperx_path}")
        except Exception as e:
            print(f"[whisperx_stage] WARN: could not write whisperx_result.json ({e})")
        return transcript
    finally:
        engine.cleanup()


def transcribe_video(video_path, output_dir, model_size="base"):
    """Transcribe audio from video using OpenAI Whisper.

    Args:
        video_path: Path to input video file.
        output_dir: Directory to save transcript.json.
        model_size: Whisper model size ('tiny', 'base', 'small', 'medium',
                    'large'). Default 'base' for balance of speed/accuracy.

    Returns:
        dict: {"text": str, "segments": [...], "language": str,
               "transcript_path": str}
    """
    import json
    import os
    import subprocess
    import sys
    from pathlib import Path

    os.makedirs(output_dir, exist_ok=True)
    audio_path = str(Path(output_dir) / "audio.wav")
    transcript_path = str(Path(output_dir) / "transcript.json")

    # Step 1: Extract audio with ffmpeg (16kHz mono PCM, required by Whisper)
    print(f"[transcribe] Extracting audio from {video_path}...")
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", video_path,
            "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
            audio_path,
        ],
        check=True,
        capture_output=True,
    )

    # Step 2: Install openai-whisper if missing (Kaggle: first-run only)
    try:
        import whisper
    except ImportError:
        print("[transcribe] Installing openai-whisper...")
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "-q", "openai-whisper"]
        )
        import whisper

    # Step 3: Load model (cached at /root/.cache/whisper after first download)
    print(f"[transcribe] Loading Whisper '{model_size}' model...")
    model = whisper.load_model(model_size)

    # Step 4: Transcribe
    print(f"[transcribe] Transcribing {audio_path}...")
    result = model.transcribe(audio_path, verbose=False)

    # Step 5: Save transcript (normalized, JSON-serializable)
    with open(transcript_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "text": result["text"],
                "segments": [
                    {
                        "id": s["id"],
                        "start": s["start"],
                        "end": s["end"],
                        "text": s["text"].strip(),
                    }
                    for s in result["segments"]
                ],
                "language": result.get("language", "unknown"),
            },
            f,
            ensure_ascii=False,
            indent=2,
        )

    print(f"[transcribe] Done. Transcript saved to {transcript_path}")
    print(f"[transcribe] Language: {result.get('language', '?')}")
    preview = (result.get("text") or "")[:200]
    print(f"[transcribe] Text preview: {preview}...")

    return {
        "text": result["text"],
        "segments": result["segments"],
        "language": result.get("language", "unknown"),
        "transcript_path": transcript_path,
    }


def get_transcript_text(transcript_result):
    """Extract plain text from transcribe_video() result.

    Args:
        transcript_result: dict returned by transcribe_video(), or any
                           object that can be coerced to a string.

    Returns:
        str: the transcribed text, or empty string if unavailable.
    """
    if isinstance(transcript_result, dict):
        return transcript_result.get("text", "") or ""
    return str(transcript_result)


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


def _selected_takes_to_objects(selected_takes: list) -> list:
    """Convert ``selected_takes`` dicts (from B1/B7 stats) into B1 ``Take`` objects.

    B12's PlatformAdapter takes optional ``List[Take]`` so it can prioritise
    the highest-scored segments when trimming to ``max_duration``. The
    pipeline stats store these as JSON-serialisable dicts; this helper
    converts them back into the dataclass shape ``Take`` expects.

    Defensive: returns an empty list on any conversion failure (the
    adapter then falls back to a head-trim).
    """
    if not selected_takes:
        return []
    try:
        from take_selector_v2 import Take, TakeScore  # type: ignore
    except Exception:
        return []
    takes: list[Take] = []
    for t in selected_takes:
        if not isinstance(t, dict):
            continue
        score_dict = t.get('score') or {}
        try:
            ts = TakeScore(
                overall=float(score_dict.get('overall', 0.0)),
                audio_rms=float(score_dict.get('audio_rms', 0.0)),
                speech_density=float(score_dict.get('speech_density', 0.0)),
                length_score=float(score_dict.get('length_score', 0.0)),
                face_score=float(score_dict.get('face_score', 0.0)),
                motion_score=float(score_dict.get('motion_score', 0.0)),
                composition_score=float(score_dict.get('composition_score', 0.0)),
            )
            takes.append(Take(
                path=str(t.get('path', '')),
                start=float(t.get('start', 0.0)),
                end=float(t.get('end', 0.0)),
                score=ts,
                scene_idx=int(t.get('scene_idx', 0)),
                frame_path=t.get('frame_path'),
            ))
        except (TypeError, ValueError):
            continue
    return takes


def _estimate_scene_boundaries(
    transcript: dict, video_duration: float,
) -> list[SceneBoundary]:
    """Build lightweight `SceneBoundary` list from transcript segments.

    This is a proxy for true scene detection (which is a future task).
    Talking-head footage usually has one "shot" per Whisper segment, so we
    use the segment start/end timestamps as scene boundaries. If there are
    no segments, we fall back to a single scene covering the whole video.

    B1 note: when the v2 take selector (`take_selector_v2`) is available,
    real scene boundaries are detected by `SceneDetector` and stored in
    `stats['scene_boundaries']` — those are JSON-serializable dicts.
    This helper still feeds B6's `color_matcher.SceneBoundary`-typed
    `_run_color_grading_v2()` path.
    """
    FPS = 30  # Pipeline assumes 1080p 30fps vertical source
    segments = transcript.get('segments', []) if transcript else []
    if not segments or video_duration <= 0:
        return [SceneBoundary(
            index=0, start_time=0.0, end_time=video_duration,
            start_frame=0, end_frame=int(video_duration * FPS),
            mid_frame=int(video_duration * FPS / 2),
        )]
    scenes: list[SceneBoundary] = []
    for i, seg in enumerate(segments):
        s = float(seg.get('start', 0.0))
        e = float(seg.get('end', s + 1.0))
        sf = int(s * FPS)
        ef = int(e * FPS)
        scenes.append(SceneBoundary(
            index=i,
            start_time=s,
            end_time=e,
            start_frame=sf,
            end_frame=ef,
            mid_frame=(sf + ef) // 2,
        ))
    return scenes


def _run_color_grading_v2(
    video_path: str,
    output_dir: str,
    scenes: list[SceneBoundary],
    custom_mood: str | None = None,
    style_preset: str | None = None,
    intensity: float = 0.85,
) -> str:
    """Run the B6 v2 color grader (CLIP mood → LUT → shot matching).

    Imports MoodDetector / ColorGraderV2 lazily so missing optional deps
    (transformers/torch) only fail at this stage and the rest of the
    pipeline continues (with a graceful v1 fallback in the caller).
    """
    from mood_detector import MoodDetector
    from color_grader_v2 import ColorGraderV2

    device = os.environ.get('MICKY_CLIP_DEVICE', 'cuda')
    detector = MoodDetector(device=device)
    matcher = ColorMatcher(method='mkl')
    grader = ColorGraderV2(detector, matcher)

    output_path = os.path.join(
        output_dir,
        Path(video_path).stem + '_graded_v2.mp4',
    )

    if style_preset:
        return grader.grade_with_style(
            video_path, style_preset, intensity,
            scene_boundaries=scenes or None,
            output_path=output_path,
        )
    return grader.grade_video(
        video_path,
        scene_boundaries=scenes or None,
        custom_mood=custom_mood,
        output_path=output_path,
    )


# ---------------------------------------------------------------------------
# B1: take_selector_v2 wrapper (PySceneDetect + auto-editor + scoring).
# Returns None when v2 is unavailable so the caller can fall back to v1.
# ---------------------------------------------------------------------------
def _run_take_selector_v2(
    input_video_path: str,
    transcript: dict | None,
    output_dir: str,
    options: dict,
) -> dict | None:
    """Run the v2 3-layer take selector.

    Returns a dict with the following keys (or None when v2 is not
    importable):
        selected_video     str   – same as input (v2 doesn't concatenate;
                                       downstream stages still process the
                                       full source; selected takes are
                                       returned for downstream VLM scoring).
        scene_boundaries   list  – all detected scenes (dicts).
        selected_takes     list  – top-N Take dicts with per-criterion scores.
        silence_segments   list  – silence regions detected by auto-editor
                                       (Layer 2; dicts).
    """
    if not _TAKE_SELECTOR_V2_AVAILABLE:
        return None
    scene_det = _SceneDetector(
        threshold=float(options.get('scene_threshold', 27.0)),
        min_scene_len_sec=float(options.get('min_scene_len_sec', 1.0)),
    )
    silence_tr = _SilenceTrimmer(
        threshold_db=float(options.get('silence_threshold_db', -12.0)),
        margin_sec=float(options.get('silence_margin_sec', 0.2)),
    )
    selector = _TakeSelectorV2(
        scene_detector=scene_det,
        silence_trimmer=silence_tr,
        whisper_result=transcript or {},
    )
    target_count = int(options.get('take_target_count', 10))
    min_duration = float(options.get('take_min_duration', 3.0))
    max_duration = float(options.get('take_max_duration', 30.0))
    takes = selector.select_best_takes(
        input_video_path,
        target_count=target_count,
        min_duration=min_duration,
        max_duration=max_duration,
    )
    boundaries = selector.scene_detector.detect_scenes(input_video_path)
    silence_segs = selector.silence_trimmer.analyze_silence(input_video_path)
    return {
        'selected_video': input_video_path,
        'scene_boundaries': [b.to_dict() for b in boundaries],
        'selected_takes': [t.to_dict() for t in takes],
        'silence_segments': [s.to_dict() for s in silence_segs],
    }


# ---------------------------------------------------------------------------
# B7: take_selector_v3 wrapper (heuristic + Qwen2.5-VL neural re-rank).
# Returns None when v3 is unavailable so the caller can fall back to v2 / v1.
# ---------------------------------------------------------------------------
def _run_take_selector_v3(
    input_video_path: str,
    transcript: dict | None,
    output_dir: str,
    options: dict,
) -> dict | None:
    """Run the v3 hybrid take selector (heuristic + VLM).

    Returns a dict with the following keys (or None when v3 is not
    importable, or when both the heuristic and VLM layers fail to
    initialise — in which case the caller falls back to v2):

        selected_video     str     – path to the concatenated best-takes MP4
                                       (or input_video_path when only one take
                                       is selected).
        scene_boundaries   list    – all detected scenes (dicts).
        selected_takes     list    – top-N Take dicts with per-criterion scores.
        silence_segments   list    – silence regions (dicts).
        vlm_used           bool    – True iff VLM re-ranking actually ran.
        narrative_arc      dict?  – NarrativeArc.to_dict() (None when <2 takes
                                       or VLM unavailable).

    Notes
    -----
    * When the VLM fails to load (no GPU / transformers missing / model
      download error), v3 silently degrades to heuristic-only —
      ``vlm_used`` will be False and ``narrative_arc`` will be None,
      but the take list is still produced.
    * ``options['use_vlm']`` (default True) lets the caller explicitly
      disable VLM and force heuristic-only operation (useful for tests
      on CPU-only machines).
    """
    if not _TAKE_SELECTOR_V3_AVAILABLE:
        return None

    use_vlm = bool(options.get('use_vlm', True))
    vlm_model_name = options.get('vlm_model_name') or 'Qwen/Qwen2.5-VL-7B-Instruct'
    vlm_device = options.get('vlm_device', 'cuda')
    vlm_dtype = options.get('vlm_dtype', 'bfloat16')
    hybrid_weight_vlm = float(options.get('hybrid_weight_vlm', 0.5))
    target_count = int(options.get('take_target_count', 10))
    min_duration = float(options.get('take_min_duration', 3.0))
    max_duration = float(options.get('take_max_duration', 30.0))

    # Construct v3 — this also auto-loads the VLM (which may fail gracefully).
    selector = _TakeSelectorV3(
        whisper_result=transcript or {},
        vlm_model_name=vlm_model_name,
        vlm_device=vlm_device,
        vlm_dtype=vlm_dtype,
        hybrid_weight_vlm=hybrid_weight_vlm,
    )
    if not use_vlm:
        selector.vlm_scorer = None  # force heuristic-only
    vlm_used = selector.vlm_available

    try:
        takes = selector.select_best_takes(
            input_video_path,
            target_count=target_count,
            min_duration=min_duration,
            max_duration=max_duration,
        )

        # Produce scene / silence metadata (reuse B1's layers internally).
        boundaries: list = []
        try:
            boundaries = selector.scene_detector.detect_scenes(input_video_path) \
                if selector.scene_detector is not None else []
        except Exception as _b_err:
            print(f"[pipeline] WARNING: scene_detector.detect_scenes failed ({_b_err})")
        silence_segs: list = []
        try:
            silence_segs = selector.silence_trimmer.analyze_silence(input_video_path) \
                if selector.silence_trimmer is not None else []
        except Exception as _s_err:
            print(f"[pipeline] WARNING: silence_trimmer.analyze_silence failed ({_s_err})")

        # Optionally compute the narrative arc.
        narrative_arc: dict | None = None
        if takes and use_vlm and vlm_used:
            try:
                arc = selector.select_with_narrative(
                    input_video_path, target_count=target_count,
                )
                narrative_arc = arc.to_dict()
            except Exception as _arc_err:
                print(f"[pipeline] WARNING: narrative arc failed ({_arc_err})")

        # Build the concatenated MP4 (or fall back to the input video path).
        selected_video = input_video_path
        try:
            from take_selector_v3 import _concat_takes as _v3_concat
            if takes:
                concat_path = os.path.join(
                    output_dir,
                    f"{Path(input_video_path).stem}_best_takes.mp4",
                )
                if len(takes) == 1:
                    selected_video = input_video_path
                else:
                    p = _v3_concat(takes, concat_path)
                    selected_video = p if (p and os.path.exists(p)) else input_video_path
        except Exception as _concat_err:
            print(f"[pipeline] WARNING: v3 concat failed ({_concat_err}); "
                  "using input video as selected_video.")
            selected_video = input_video_path

        return {
            'selected_video': selected_video,
            'scene_boundaries': [b.to_dict() for b in boundaries],
            'selected_takes': [t.to_dict() for t in takes],
            'silence_segments': [s.to_dict() for s in silence_segs],
            'vlm_used': vlm_used,
            'narrative_arc': narrative_arc,
        }
    finally:
        try:
            selector.cleanup()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# B11: Storyboard pause / resume helpers
# ---------------------------------------------------------------------------
PIPELINE_STATE_DIR = '/tmp'
PIPELINE_STATE_TTL_SEC = 24 * 60 * 60   # 24h (cleanup cron on Kaggle side)


def _pipeline_state_path(input_video_path: str, output_dir: str) -> str:
    """Stable path /tmp/micky_pipeline_state_<hash>.json keyed by the
    input video + output_dir. Idempotent: same inputs → same path."""
    fingerprint = f'{input_video_path}|{output_dir}'
    h = hashlib.sha1(fingerprint.encode('utf-8')).hexdigest()[:16]
    return os.path.join(PIPELINE_STATE_DIR, f'micky_pipeline_state_{h}.json')


def _maybe_pause_for_storyboard(
    input_video_path: str,
    output_dir: str,
    options: dict,
    transcript: dict | None,
    selected_video: str,
    stats: dict,
    narrative_arc_dict: dict | None,
) -> dict | None:
    """Build the storyboard, persist pipeline state, and return a
    `paused_for_approval` result dict.

    Returns None when storyboard generation should be skipped (no takes,
    or storyboard module unavailable — caller already checked the latter).

    Idempotent: if the state file already exists for this (input, output)
    pair AND the approval_token is still valid, returns the existing
    paused result without re-generating the storyboard. This makes the
    pipeline safe to re-invoke while waiting for user approval.
    """
    if not _STORYBOARD_AVAILABLE:
        return None

    state_path = _pipeline_state_path(input_video_path, output_dir)

    # Idempotency check: if state file exists and hasn't been approved yet,
    # re-use the existing storyboard.
    if os.path.exists(state_path):
        try:
            with open(state_path, 'r', encoding='utf-8') as f:
                existing = json.load(f)
            if existing.get('status') == 'paused_for_approval':
                print(f"[pipeline] ⏸️  Storyboard already pending approval "
                      f"(token={existing.get('approval_token', '?')[:8]}…). "
                      f"Re-using state at {state_path}.")
                return existing.get('paused_result')
        except (json.JSONDecodeError, OSError):
            pass  # corrupt or unreadable → regenerate

    # Materialise the Take list from stats (v2/v3 already wrote dicts
    # there; we wrap them in a light shim so StoryboardGenerator's
    # duck-typed accessors work).
    takes_list = stats.get('selected_takes', []) or []
    if not takes_list:
        print("[pipeline] ℹ️  No takes selected — skipping storyboard.")
        return None

    class _TakeShim:
        """Minimal adapter so dict-based takes look like v2 Take objects
        for StoryboardGenerator's duck-typed accessors."""
        def __init__(self, d: dict) -> None:
            self.start = float(d.get('start', 0.0))
            self.end = float(d.get('end', 0.0))
            self.path = d.get('path') or input_video_path
            self.scene_idx = int(d.get('scene_idx', 0))
            sc = d.get('score', {})
            if isinstance(sc, dict):
                overall = float(sc.get('overall', 0.0))
            else:
                overall = float(sc or 0.0)
            class _ScoreShim:
                pass
            self.score = _ScoreShim()
            self.score.overall = overall   # type: ignore[attr-defined]
    takes_shim = [_TakeShim(t) for t in takes_list]

    print("[pipeline] 🎬 Generating storyboard for user approval…")
    try:
        gen = _StoryboardGenerator(output_dir=os.path.join(output_dir, 'storyboard'))
        sb = gen.generate_storyboard(
            takes_shim,
            scene_boundaries=stats.get('scene_boundaries', []),
            narrative_arc=narrative_arc_dict,
        )
        approval = gen.prepare_for_user_approval(sb)
    except Exception as e:
        print(f"[pipeline] ⚠️  Storyboard generation failed ({e}); "
              "continuing to final render.")
        traceback.print_exc()
        return None

    # Persist storyboard.json in the output dir for traceability.
    sb_json_path = os.path.join(output_dir, 'storyboard.json')
    try:
        with open(sb_json_path, 'w', encoding='utf-8') as f:
            json.dump(gen.export_storyboard_json(sb), f, indent=2,
                      ensure_ascii=False, default=str)
        print(f"   📁 Storyboard JSON: {sb_json_path}")
    except Exception as e:
        print(f"   ⚠️  Could not write storyboard.json: {e}")

    # Build the paused result that the caller (run_pipeline) returns.
    paused_result: dict[str, Any] = {
        'outputs': [],
        'adapted_outputs': [],
        'variant_outputs': [],
        'stats': {
            **stats,
            'processing_time': round(time.time() - stats.get('t0', time.time()), 2),
            'stages_ran': stats.get('stages_ran', []) + ['storyboard'],
            'storyboard_path': sb.image_path,
            'storyboard_json_path': sb_json_path,
            'approval_token': approval['approval_token'],
            'approval_expires_at': approval['expires_at'],
        },
        'transcript_path': stats.get('transcript_path'),
        'captions_path': None,
        'status': 'paused_for_approval',
        'storyboard': approval,
        'pipeline_state_path': state_path,
    }

    # Persist the full pipeline state for resume_pipeline() to pick up.
    state: dict[str, Any] = {
        'state_version': 1,
        'status': 'paused_for_approval',
        'input_video_path': input_video_path,
        'output_dir': output_dir,
        'options': options,
        'transcript_path': stats.get('transcript_path'),
        'selected_video': selected_video,
        'selected_takes': takes_list,
        'scene_boundaries': stats.get('scene_boundaries', []),
        'silence_segments': stats.get('silence_segments', []),
        'narrative_arc': narrative_arc_dict,
        'storyboard_path': sb.image_path,
        'storyboard_json_path': sb_json_path,
        'approval_token': approval['approval_token'],
        'approval_expires_at': approval['expires_at'],
        'paused_at': time.time(),
        'paused_result': paused_result,
    }
    try:
        with open(state_path, 'w', encoding='utf-8') as f:
            json.dump(state, f, indent=2, ensure_ascii=False, default=str)
        print(f"[pipeline] ⏸️  Paused for storyboard approval.\n"
              f"   State file: {state_path}\n"
              f"   Approval token: {approval['approval_token']}\n"
              f"   Expires in: {approval['expires_in_sec']}s")
    except Exception as e:
        print(f"[pipeline] ⚠️  Could not persist pipeline state ({e}); "
              "continuing to final render.")
        traceback.print_exc()
        return None

    return paused_result


def resume_pipeline(state_path: str, approved_takes: list | None = None) -> dict:
    """Resume a pipeline that was paused for storyboard approval.

    Loads the saved state from `state_path`, optionally overrides the
    selected takes (when the user edited/regenerated one), and re-runs
    `run_pipeline` with `skip_stages={'transcribe', 'takes',
    'storyboard'}` so it picks up at Stage 3 (audio enhancement).

    Idempotent: if the state file is missing or already approved, returns
    the existing result without re-running anything.

    Args:
        state_path:   Path returned in `pipeline_state_path` from the
                      paused result (typically /tmp/micky_pipeline_state_<hash>.json).
        approved_takes: Optional list of Take dicts to substitute for
                      the originally-selected takes (used when the user
                      edited/regenerated a take via the storyboard UI).

    Returns:
        The full run_pipeline result dict (outputs, stats, etc.).
    """
    if not os.path.exists(state_path):
        raise FileNotFoundError(f'Pipeline state file not found: {state_path}')

    with open(state_path, 'r', encoding='utf-8') as f:
        state = json.load(f)

    if state.get('status') != 'paused_for_approval':
        # Already approved / cancelled / completed → return cached result
        # (prefer the final `result` over the original `paused_result`).
        existing = state.get('result') or state.get('paused_result')
        if existing:
            print(f"[pipeline] State at {state_path} already processed "
                  f"(status={state.get('status')}); returning cached result.")
            return existing

    # Mark as approved so a second resume call is a no-op.
    state['status'] = 'approved'
    state['approved_at'] = time.time()
    if approved_takes is not None:
        state['selected_takes'] = approved_takes
    try:
        with open(state_path, 'w', encoding='utf-8') as f:
            json.dump(state, f, indent=2, ensure_ascii=False, default=str)
    except Exception as e:
        print(f"[pipeline] ⚠️  Could not update state file ({e}); "
              "continuing anyway.")

    # Re-run pipeline with skip for the already-done stages. We pass
    # the previously-built selected_video so Stage 3 onward uses it.
    options = dict(state.get('options', {}) or {})
    options['skip_stages'] = set(options.get('skip_stages', [])) | {
        'transcribe', 'takes', 'storyboard',
    }
    options['generate_storyboard'] = False   # never pause on resume
    # Carry the narrative arc + transcript paths so downstream stages
    # (color grading, Remotion) can still find them.
    if state.get('narrative_arc'):
        options['narrative_arc'] = state['narrative_arc']

    print(f"[pipeline] ▶️  Resuming pipeline from {state_path} "
          f"(skipping Stages 1+2; starting at Stage 3).")
    result = run_pipeline(
        state['input_video_path'],
        state['output_dir'],
        options,
    )

    # Update state file with the final result for idempotency.
    state['status'] = 'completed'
    state['result'] = result
    try:
        with open(state_path, 'w', encoding='utf-8') as f:
            json.dump(state, f, indent=2, ensure_ascii=False, default=str)
    except Exception:
        pass
    return result


# ---------------------------------------------------------------------------
# CLI entrypoint
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Micky Assistant Montage Pipeline')
    parser.add_argument('--input', help='Path to raw 1080p 30fps video')
    parser.add_argument('--output', help='Output directory')
    parser.add_argument(
        '--options', type=str, default='{}',
        help='JSON string with pipeline options',
    )
    parser.add_argument(
        '--skip', type=str, default='',
        help='Comma-separated stage ids to skip '
             '(transcribe,takes,audio,background,color,captions,animation,'
             'ai_enhancement,export,adapt)',
    )
    parser.add_argument(
        '--spec', type=str, default=None,
        help='Path to a JSON spec file (alternative to --input/--output). '
             'Uses the run_pipeline_from_spec(input_spec) entry point.',
    )
    parser.add_argument(
        '--parallel', dest='parallel_render', action='store_true',
        default=None,
        help='B14: enable parallel Remotion rendering (default: on). '
             'Use --no-parallel to disable.',
    )
    parser.add_argument(
        '--no-parallel', dest='parallel_render', action='store_false',
        help='B14: disable parallel rendering, force single-thread.',
    )
    parser.add_argument(
        '--segments', type=int, default=None,
        help='B14: number of parallel render segments (default 4).',
    )
    # B12: platform adaptation + A/B variant generation.
    parser.add_argument(
        '--adapt-platforms', type=str, default=None,
        help='B12: comma-separated list of platforms to adapt the final '
             'video to (tiktok,youtube,reels,shorts,square,landscape). '
             "Default 'tiktok'. Pass '' to disable Stage 10.",
    )
    parser.add_argument(
        '--variants', type=int, default=None,
        help='B12: number of A/B variants to generate for the primary '
             'platform (1=off, max 3). Each variant costs ~60s on T4.',
    )
    parser.add_argument(
        '--no-storyboard', dest='generate_storyboard', action='store_false',
        default=None,
        help='B11: disable storyboard pause (skip user approval; render '
             'straight to final output).',
    )
    parser.add_argument(
        '--resume', type=str, default=None,
        help='B11: resume a paused pipeline from the given state file '
             '(typically /tmp/micky_pipeline_state_<hash>.json).',
    )
    args = parser.parse_args()

    # B11: resume mode — short-circuits everything else.
    if args.resume:
        result = resume_pipeline(args.resume)
        print("\n=== PIPELINE RESUMED RESULT ===")
        print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
        sys.exit(0)

    # Mode A: spec-based entry point (preferred for orchestration callers)
    if args.spec:
        with open(args.spec, 'r', encoding='utf-8') as f:
            spec = json.load(f)
        # Apply CLI overrides on top of spec.
        if args.parallel_render is not None:
            spec['parallel_render'] = args.parallel_render
        if args.segments is not None:
            spec['segment_count'] = args.segments
        if args.adapt_platforms is not None:
            spec['adapt_platforms'] = [
                p.strip() for p in args.adapt_platforms.split(',') if p.strip()
            ]
        if args.variants is not None:
            spec['generate_variants'] = args.variants
        result = run_pipeline_from_spec(spec)
        print("\n=== PIPELINE RESULT (from spec) ===")
        print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
        sys.exit(0)

    # Mode B: classic positional CLI
    if not args.input or not args.output:
        parser.error('either --spec <spec.json> or both --input and --output are required')

    options: dict = json.loads(args.options)
    if args.skip:
        options['skip_stages'] = {s.strip() for s in args.skip.split(',') if s.strip()}
    if args.parallel_render is not None:
        options['parallel_render'] = args.parallel_render
    if args.segments is not None:
        options['segment_count'] = args.segments
    if args.adapt_platforms is not None:
        options['adapt_platforms'] = [
            p.strip() for p in args.adapt_platforms.split(',') if p.strip()
        ]
    if args.variants is not None:
        options['generate_variants'] = args.variants

    result = run_pipeline(args.input, args.output, options)
    print("\n=== PIPELINE RESULT ===")
    print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
