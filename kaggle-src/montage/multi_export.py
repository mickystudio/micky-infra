"""
Multi-platform export (P4-T6).
==========================
Produces 5 versions of the final video, each tuned to its target
platform's specifications. Also generates captions + hashtags per platform.

Platforms (default 5):
    - Instagram   1080x1920 30fps 4.5 Mbps, <100 MB, 30 hashtags max
    - TikTok      1080x1920 30fps 5.0 Mbps, <287 MB, 30 hashtags max
    - YouTube     1080x1920 30fps 8.0 Mbps, <256 MB, 15 hashtags max
    - Facebook    1080x1920 30fps 4.0 Mbps, <100 MB, 20 hashtags max
    - WhatsApp     720x1280 30fps 1.5 Mbps, <30 MB,   0 hashtags

If a rendered file exceeds the platform's max size, the bitrate is
automatically reduced and the export is retried with `-preset slow`
for better compression efficiency.

Created: 2026-11-10
"""
from __future__ import annotations

import os
import subprocess
import traceback
from pathlib import Path

# ---------------------------------------------------------------------------
# Per-platform specs
# ---------------------------------------------------------------------------
PLATFORM_CONFIGS: dict[str, dict] = {
    'instagram': {
        'resolution':     (1080, 1920),
        'fps':            30,
        'bitrate_kbps':   4500,
        'max_size_mb':    100,
        'format':         'mp4',
        'caption_max':    2200,
        'hashtags_count': 30,
    },
    'tiktok': {
        'resolution':     (1080, 1920),
        'fps':            30,
        'bitrate_kbps':   5000,
        'max_size_mb':    287,
        'format':         'mp4',
        'caption_max':    2200,
        'hashtags_count': 30,
    },
    'youtube': {
        'resolution':     (1080, 1920),
        'fps':            30,
        'bitrate_kbps':   8000,
        'max_size_mb':    256,
        'format':         'mp4',
        'caption_max':    5000,
        'hashtags_count': 15,
    },
    'facebook': {
        'resolution':     (1080, 1920),
        'fps':            30,
        'bitrate_kbps':   4000,
        'max_size_mb':    100,
        'format':         'mp4',
        'caption_max':    5000,
        'hashtags_count': 20,
    },
    'whatsapp': {
        'resolution':     (720, 1280),
        'fps':            30,
        'bitrate_kbps':   1500,
        'max_size_mb':    30,        # WhatsApp Status hard limit
        'format':         'mp4',
        'caption_max':    500,
        'hashtags_count': 0,
    },
}

# ---------------------------------------------------------------------------
# Hashtags (bilingual AR/EN dental)
# ---------------------------------------------------------------------------
DENTAL_HASHTAGS_AR: list[str] = [
    'طب_أسنان', 'تبييض_الأسنان', 'زراعة_الأسنان', 'تقويم_الأسنان',
    'صحة_الفم', 'ابتسامة', 'تنظيف_الأسنان', 'تسوس', 'علاج_العصب',
    'لثة', 'طب_الأسنان_التجميلي', 'ابتسامة_هوليود', 'دكتور_أسنان',
    'عيادة_أسنان', 'زراعة_أسنان', 'حشوة', 'ركيزة', 'خدر_موضعي',
    'أشعة_أسنان', 'طب_الأسنان_الوقائي', 'تجميل_الأسنان', 'إسنان',
    'أسنان_الطفل', 'طب_فم_ووجه_وفكان', 'تركيب_أسنان',
    'dentist', 'dentalcare', 'teethwhitening', 'dentallife',
    'oralhealth', 'smilemakeover', 'dentalimplants',
]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def export_multi_platform(video_path, platforms=None, options=None, output_dir=None):
    """Export a video to multiple platform-optimized versions.
    
    Args:
        video_path: Path to the source video (edited, color-graded, captioned).
        platforms: List of platform names. Default: all 5 platforms.
                   Options: 'tiktok', 'reels', 'shorts', 'feed', 'twitter'.
        options: Dict of optional overrides:
            - max_duration: int seconds (truncate longer videos)
            - bitrate_mult: float (multiplier for video bitrate)
            - keep_audio: bool (default True)
        output_dir: Where to save exported files. If None, uses video_path's parent.
    
    Returns:
        dict: {
            "tiktok": {"path": str, "size_bytes": int, "duration_sec": float},
            "reels": {...},
            "shorts": {...},
            "feed": {...},
            "twitter": {...},
            "all_files": [list of paths],
        }
    """
    import os, json, subprocess
    from pathlib import Path

    if platforms is None:
        platforms = ["tiktok", "reels", "shorts", "feed", "twitter"]
    if options is None:
        options = {}
    if output_dir is None:
        output_dir = str(Path(video_path).parent / "exports")

    os.makedirs(output_dir, exist_ok=True)

    # Platform specs
    PLATFORM_SPECS = {
        "tiktok": {
            "name": "TikTok",
            "aspect": "9:16",
            "width": 1080,
            "height": 1920,
            "max_duration": 60,
            "video_bitrate": "4M",  # 4 Mbps
            "audio_bitrate": "128k",
            "audio_channels": 2,
            "audio_sample_rate": 48000,
            "max_size_mb": 50,
            "fps": 30,
            "extra_args": ["-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.0"],
            "suffix": "_tiktok_9x16.mp4",
        },
        "reels": {
            "name": "Instagram Reels",
            "aspect": "9:16",
            "width": 1080,
            "height": 1920,
            "max_duration": 90,
            "video_bitrate": "4M",
            "audio_bitrate": "128k",
            "audio_channels": 2,
            "audio_sample_rate": 48000,
            "max_size_mb": 100,
            "fps": 30,
            "extra_args": ["-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.0"],
            "suffix": "_reels_9x16.mp4",
        },
        "shorts": {
            "name": "YouTube Shorts",
            "aspect": "9:16",
            "width": 1080,
            "height": 1920,
            "max_duration": 60,
            "video_bitrate": "6M",  # YouTube allows higher quality
            "audio_bitrate": "192k",
            "audio_channels": 2,
            "audio_sample_rate": 48000,
            "max_size_mb": 256,
            "fps": 60,  # YouTube Shorts supports 60fps
            "extra_args": ["-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.0",
                          "-movflags", "+faststart"],
            "suffix": "_shorts_9x16.mp4",
        },
        "feed": {
            "name": "Instagram Feed",
            "aspect": "1:1",
            "width": 1080,
            "height": 1080,
            "max_duration": 60,
            "video_bitrate": "3.5M",
            "audio_bitrate": "128k",
            "audio_channels": 2,
            "audio_sample_rate": 48000,
            "max_size_mb": 100,
            "fps": 30,
            "extra_args": ["-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.0"],
            "suffix": "_feed_1x1.mp4",
        },
        "twitter": {
            "name": "Twitter/X",
            "aspect": "16:9",
            "width": 1280,
            "height": 720,
            "max_duration": 140,
            "video_bitrate": "5M",
            "audio_bitrate": "128k",
            "audio_channels": 2,
            "audio_sample_rate": 48000,
            "max_size_mb": 25,  # Strict Twitter limit
            "fps": 30,
            "extra_args": ["-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.0",
                          "-movflags", "+faststart"],
            "suffix": "_twitter_16x9.mp4",
        },
    }

    # Get source video info
    probe = subprocess.run([
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration:stream=width,height,r_frame_rate",
        "-of", "json", video_path
    ], capture_output=True, text=True, check=True)
    src_info = json.loads(probe.stdout)
    src_duration = float(src_info["format"]["duration"])
    print(f"[export] Source: {video_path} ({src_duration:.1f}s)")

    # Apply overrides
    max_duration_override = options.get("max_duration")
    bitrate_mult = options.get("bitrate_mult", 1.0)
    keep_audio = options.get("keep_audio", True)

    results = {}
    all_files = []

    for platform in platforms:
        if platform not in PLATFORM_SPECS:
            print(f"[export] Skipping unknown platform: {platform}")
            continue

        spec = PLATFORM_SPECS[platform]
        output_path = os.path.join(output_dir, Path(video_path).stem + spec["suffix"])

        # Determine final duration
        max_dur = max_duration_override or spec["max_duration"]
        final_duration = min(src_duration, max_dur)
        if src_duration > max_dur:
            print(f"[export] {platform}: truncating to {max_dur}s")

        # Compute target bitrate (apply multiplier)
        target_bitrate = spec["video_bitrate"]
        if bitrate_mult != 1.0:
            # Parse "4M" -> 4_000_000
            num = float(target_bitrate[:-1])
            unit = target_bitrate[-1]
            mult = {"M": 1_000_000, "K": 1_000, "G": 1_000_000_000}[unit]
            new_bitrate = int(num * mult * bitrate_mult)
            target_bitrate = f"{new_bitrate // mult}{unit}"

        # Build ffmpeg filter chain for aspect ratio conversion
        # Strategy: scale to fit target width, then crop/pad to exact aspect ratio
        # For 9:16 from 16:9 source: scale to 1080x1920, crop center
        # For 1:1 from 16:9: scale to fit 1080 width, then crop to 1080 height
        # For 16:9 from 9:16 source: scale to 1280x720
        target_w = spec["width"]
        target_h = spec["height"]
        target_aspect = target_w / target_h

        # ffmpeg filter: scale + crop + pad
        filter_chain = (
            f"scale={target_w}:{target_h}:force_original_aspect_ratio=increase,"
            f"crop={target_w}:{target_h}"
        )

        # Build ffmpeg command
        cmd = [
            "ffmpeg", "-y",
            "-i", video_path,
            "-t", str(final_duration),
            "-vf", filter_chain,
            "-r", str(spec["fps"]),
            "-c:v", "libx264",
            "-preset", "medium",
            "-b:v", target_bitrate,
            "-maxrate", target_bitrate,
            "-bufsize", str(int(target_bitrate[:-1]) * 2) + target_bitrate[-1] if target_bitrate[-1] in "MK" else target_bitrate,
        ]

        # Audio
        if keep_audio:
            cmd.extend([
                "-c:a", "aac",
                "-b:a", spec["audio_bitrate"],
                "-ac", str(spec["audio_channels"]),
                "-ar", str(spec["audio_sample_rate"]),
            ])
        else:
            cmd.extend(["-an"])

        # Extra platform-specific args
        cmd.extend(spec["extra_args"])

        # Output path
        cmd.append(output_path)

        # Run
        print(f"[export] {platform}: {target_w}x{target_h}, {spec['fps']}fps, {target_bitrate}")
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"[export] {platform} FAILED: {result.stderr[-500:]}")
            continue

        # Verify output
        out_size = os.path.getsize(output_path)
        out_size_mb = out_size / (1024 * 1024)
        size_warning = ""
        if out_size_mb > spec["max_size_mb"]:
            size_warning = f" ⚠️ EXCEEDS LIMIT ({out_size_mb:.1f}MB > {spec['max_size_mb']}MB)"
            # Auto-reduce bitrate and re-encode
            print(f"[export] {platform}: reducing bitrate to fit size limit...")
            reduced_bitrate = int(float(target_bitrate[:-1]) * (spec["max_size_mb"] / out_size_mb) * 0.9)
            cmd[cmd.index("-b:v") + 1] = f"{reduced_bitrate}{target_bitrate[-1]}"
            cmd[cmd.index("-maxrate") + 1] = f"{reduced_bitrate}{target_bitrate[-1]}"
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode == 0:
                out_size = os.path.getsize(output_path)
                out_size_mb = out_size / (1024 * 1024)
                size_warning = f" (re-encoded at {reduced_bitrate}{target_bitrate[-1]} → {out_size_mb:.1f}MB)"

        # Get output duration
        out_probe = subprocess.run([
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", output_path
        ], capture_output=True, text=True)
        out_duration = float(out_probe.stdout.strip()) if out_probe.stdout.strip() else 0

        results[platform] = {
            "path": output_path,
            "size_bytes": out_size,
            "size_mb": round(out_size_mb, 2),
            "duration_sec": round(out_duration, 2),
            "dimensions": f"{target_w}x{target_h}",
            "fps": spec["fps"],
            "bitrate": target_bitrate,
            "size_warning": size_warning,
        }
        all_files.append(output_path)
        print(f"[export] {platform} ✓ {out_size_mb:.1f}MB, {out_duration:.1f}s{size_warning}")

    print(f"[export] Done. {len(all_files)}/{len(platforms)} platforms exported.")
    return {
        **{p: results[p] for p in platforms if p in results},
        "all_files": all_files,
        "total_size_mb": round(sum(r["size_bytes"] for r in results.values()) / (1024 * 1024), 2),
    }


def export_for_platform(
    input_path: str,
    output_path: str,
    config: dict,
) -> None:
    """
    Export video with platform-specific settings. If the file ends up larger
    than the platform's max size, re-encode at 70% bitrate with -preset slow.
    """
    w, h = config['resolution']
    fps = config['fps']
    bitrate = f"{config['bitrate_kbps']}k"

    _render_with_bitrate(input_path, output_path, w, h, fps, bitrate,
                         preset='medium', audio_bitrate='128k')

    # Size check — auto-reduce if over the platform limit
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    if size_mb > config['max_size_mb']:
        reduced = int(config['bitrate_kbps'] * 0.7)
        print(f"      ⚠️  Over limit ({size_mb:.1f} MB > "
              f"{config['max_size_mb']} MB) → retry at {reduced}k, preset slow")
        _render_with_bitrate(
            input_path, output_path, w, h, fps,
            f'{reduced}k', preset='slow', audio_bitrate='96k',
        )


# ---------------------------------------------------------------------------
# Caption + hashtag generation
# ---------------------------------------------------------------------------
def generate_caption(platform: str, options: dict, config: dict) -> str:
    """Generate a platform-appropriate caption (Arabic)."""
    audience = options.get('audience', 'patients')

    if audience == 'colleagues':
        caption = (
            "🎬 معلومات سريرية لحالة طبية — د. مايكل | طبيب أسنان\n"
            "للنقاش العلمي فقط.\n"
            "#طب_الأسنان #حالة_سريرية"
        )
    else:
        # Patient-facing
        caption = (
            "💡 معلومة طبية مفيدة من د. مايكل — طبيب الأسنان\n\n"
            "هل لديك سؤال عن صحة أسنانك؟ شاركنا في التعليقات! 👇\n\n"
            "📍 احجز موعدك الآن"
        )
        if platform == 'whatsapp':
            caption = (
                "💡 معلومة طبية من د. مايكل — طبيب الأسنان\n"
                "احجز موعدك الآن 📞"
            )
        elif platform == 'youtube':
            caption += (
                "\n🔔 لا تنسَ الاشتراك ليصلك كل جديد!\n"
                "⏱️ الفصول في الوصف."
            )

    return caption[: config['caption_max']]


def generate_hashtags(platform: str, options: dict, config: dict) -> list[str]:
    """Return up to `hashtags_count` dental hashtags for the platform."""
    count = config['hashtags_count']
    if count <= 0:
        return []
    return DENTAL_HASHTAGS_AR[:count]


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------
def _render_with_bitrate(
    input_path: str,
    output_path: str,
    w: int, h: int,
    fps: int,
    video_bitrate: str,
    preset: str = 'medium',
    audio_bitrate: str = '128k',
) -> None:
    """Render with ffmpeg using libx264 + AAC + faststart."""
    # Use lanczos for downscale quality; pad to exact dimensions if aspect off
    vf = (
        f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
        f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,"
        f"fps={fps}"
    )
    cmd = [
        'ffmpeg', '-y',
        '-i', input_path,
        '-vf', vf,
        '-c:v', 'libx264',
        '-preset', preset,
        '-b:v', video_bitrate,
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', audio_bitrate,
        '-movflags', '+faststart',
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg export failed for {output_path} (exit {result.returncode}):\n"
            f"stderr: {result.stderr[-1500:]}"
        )


# ===========================================================================
# B12: multi-platform export WITH variant generation
# ===========================================================================
# Pro editors don't deliver one master; they deliver 2-3 variants + a
# platform-adapted master per destination. The ``MultiExporter`` class
# below adds a new ``export_with_variants(video_path, platforms, variant_count)``
# method that runs the B12 PlatformAdapter + ABVariantGenerator on top of
# the legacy ``export_multi_platform`` path.
#
# The class is opt-in: existing callers that use ``export_multi_platform``
# directly keep working unchanged.
class MultiExporter:
    """B12 multi-platform exporter with optional A/B variant generation.

    Combines the legacy ``export_multi_platform`` (5-platform size/bitrate
    optimisation) with the new B12 PlatformAdapter (aspect/pacing smart
    reframe) and ABVariantGenerator (2-3 A/B variants for client review).

    Usage::

        exporter = MultiExporter()
        result = exporter.export_with_variants(
            video_path='/tmp/master.mp4',
            platforms=['tiktok', 'youtube'],
            variant_count=2,
            output_dir='/tmp/out',
        )
        # result = {
        #   'platforms': {'tiktok': {...}, 'youtube': {...}},
        #   'variants': [{'id','video_path','description','score'}, ...],
        #   'comparison_image': '/tmp/.../comparison_<hash>.jpg',
        #   'all_files': [...],
        # }

    Args:
        legacy_export: When True (default), also runs the legacy
            ``export_multi_platform`` for size/bitrate optimisation
            alongside the new B12 platform-adapted output. Set False to
            skip the legacy path (faster, but no per-platform size cap).
        variant_criteria: 'virality' (default) | 'composition' | 'lighting'
            — used by ABVariantGenerator.pick_best_variant.
    """

    def __init__(
        self,
        legacy_export: bool = True,
        variant_criteria: str = 'virality',
    ) -> None:
        self.legacy_export = bool(legacy_export)
        self.variant_criteria = str(variant_criteria)
        # Lazy-import so missing modules never break construction.
        self._adapter_cls = None
        self._variant_cls = None
        try:
            from platform_adapter import PlatformAdapter  # type: ignore
            self._adapter_cls = PlatformAdapter
        except Exception as e:  # pragma: no cover
            print(f"[multi_export] PlatformAdapter unavailable ({e}).")
        try:
            from ab_variant_generator import ABVariantGenerator  # type: ignore
            self._variant_cls = ABVariantGenerator
        except Exception as e:  # pragma: no cover
            print(f"[multi_export] ABVariantGenerator unavailable ({e}).")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def export_with_variants(
        self,
        video_path: str,
        platforms: list[str] | None = None,
        variant_count: int = 1,
        output_dir: str | None = None,
        takes: list | None = None,
        beat_times: list[float] | None = None,
        options: dict | None = None,
    ) -> dict:
        """Multi-platform export + optional A/B variant generation.

        Pipeline:
            1. (optional) Legacy ``export_multi_platform`` per-platform
               size/bitrate optimisation (5-platform path).
            2. For each platform in ``platforms``, run PlatformAdapter
               to smart-reframe, trim, re-pace, and re-encode the video.
            3. If ``variant_count > 1``, generate N variants of the
               PRIMARY platform's adapted video via ABVariantGenerator.

        Args:
            video_path: Source master MP4 (post-Stage-9).
            platforms: B12 platform names. Default ['tiktok']. Choose from
                'tiktok','youtube','reels','shorts','square','landscape'.
            variant_count: 1 (default, off) | 2 | 3 (max).
            output_dir: Where to drop outputs (default: <video dir>/exports).
            takes: Optional list of B1 ``Take`` objects — used by
                PlatformAdapter to pick the highest-scored segments when
                the master exceeds the platform's max_duration.
            beat_times: Optional music beat times (seconds) for pacing.
            options: Optional dict (audience, language, caption_style…).

        Returns:
            dict with keys: ``platforms``, ``variants``, ``comparison_image``,
            ``all_files``, ``total_size_mb``.
        """
        import os
        from pathlib import Path

        if not os.path.exists(video_path):
            raise FileNotFoundError(video_path)

        platforms = platforms or ['tiktok']
        # Clamp variant_count to [1, 3] — 1 = off.
        variant_count = max(1, min(3, int(variant_count)))
        if output_dir is None:
            output_dir = str(Path(video_path).parent / 'exports')
        os.makedirs(output_dir, exist_ok=True)
        options = options or {}

        all_files: list[str] = []
        platform_results: dict[str, dict] = {}
        variant_results: list[dict] = []
        comparison_image: str = ''

        # ---- Step 1: legacy multi_export (size/bitrate optimisation) -----
        legacy_results: dict = {}
        if self.legacy_export:
            try:
                # Map B12 platform names → legacy names where possible.
                legacy_plats = self._map_to_legacy_platforms(platforms)
                if legacy_plats:
                    legacy_results = export_multi_platform(
                        video_path, legacy_plats, options, output_dir,
                    ) or {}
                    for p, r in legacy_results.items():
                        if isinstance(r, dict) and r.get('path'):
                            all_files.append(r['path'])
            except Exception as e:
                print(f"[multi_export] legacy export_multi_platform failed ({e}).")

        # ---- Step 2: B12 PlatformAdapter per-platform adaptation -------
        if self._adapter_cls is not None:
            for plat in platforms:
                try:
                    adapter = self._adapter_cls(plat)
                    plat_out = os.path.join(
                        output_dir,
                        f"{Path(video_path).stem}_{plat}_b12.mp4",
                    )
                    adapted_path = adapter.adapt_video(
                        video_path,
                        takes=takes,
                        beat_times=beat_times,
                        output_path=plat_out,
                    )
                    meta = adapter.get_platform_metadata()
                    # Generate platform-tuned caption via micky gateway.
                    caption = ''
                    try:
                        transcript = options.get('transcript_text', '') \
                            or options.get('transcript', '')
                        if transcript:
                            caption = adapter.generate_caption_for_platform(
                                transcript, plat)
                    except Exception as cap_err:
                        print(f"[multi_export] caption gen for {plat} "
                              f"failed ({cap_err}).")
                    platform_results[plat] = {
                        'video_path': adapted_path,
                        'caption': caption,
                        'metadata': meta,
                        'size_mb': round(
                            os.path.getsize(adapted_path) / (1024 * 1024), 2
                        ) if os.path.exists(adapted_path) else 0.0,
                    }
                    if os.path.exists(adapted_path):
                        all_files.append(adapted_path)
                    print(f"[multi_export] B12 {plat}: → {adapted_path}")
                except Exception as e:
                    print(f"[multi_export] B12 platform {plat} failed ({e}).")
                    traceback.print_exc()
        else:
            print("[multi_export] PlatformAdapter unavailable; skipping B12 stage.")

        # ---- Step 3: A/B variants for primary platform -----------------
        primary_platform = platforms[0] if platforms else 'tiktok'
        if variant_count > 1 and self._variant_cls is not None:
            try:
                # Variant base = the B12-adapted primary platform video
                # (or the master if B12 was unavailable).
                base = (platform_results.get(primary_platform, {}).get('video_path')
                        or video_path)
                if not os.path.exists(base):
                    base = video_path
                variants_dir = os.path.join(output_dir, 'variants')
                gen = self._variant_cls(
                    base_video=base,
                    scene_boundaries=options.get('scene_boundaries') or [],
                    whisperx_result=options.get('whisperx_result') or {},
                    beat_times=beat_times,
                    output_dir=variants_dir,
                )
                variants = gen.generate_variants(count=variant_count)
                best = None
                try:
                    best = gen.pick_best_variant(
                        variants, criteria=self.variant_criteria,
                    )
                except Exception as e:
                    print(f"[multi_export] pick_best_variant failed ({e}).")
                try:
                    cmp_meta = gen.compare_variants(variants)
                    comparison_image = cmp_meta.get('path', '')
                    if comparison_image and os.path.exists(comparison_image):
                        all_files.append(comparison_image)
                except Exception as e:
                    print(f"[multi_export] compare_variants failed ({e}).")
                for v in variants:
                    variant_results.append({
                        'id': v.id,
                        'description': v.description,
                        'video_path': v.video_path,
                        'parameters_used': v.parameters_used,
                        'score': v.score,
                        'is_best': (best is not None and v.id == best.id),
                    })
                    if os.path.exists(v.video_path):
                        all_files.append(v.video_path)
                print(f"[multi_export] {len(variant_results)} variants generated; "
                      f"best={best.id if best else 'n/a'}")
            except Exception as e:
                print(f"[multi_export] variant generation failed ({e}).")
                traceback.print_exc()
        elif variant_count > 1 and self._variant_cls is None:
            print("[multi_export] variant_count>1 but ABVariantGenerator "
                  "unavailable; skipping variants.")

        total_size_mb = round(
            sum(os.path.getsize(f) / (1024 * 1024) for f in all_files
                if os.path.exists(f)), 2)
        return {
            'platforms': platform_results,
            'legacy': legacy_results,
            'variants': variant_results,
            'comparison_image': comparison_image,
            'best_variant_id': (
                next((v['id'] for v in variant_results if v.get('is_best')), None)
                if variant_results else None
            ),
            'all_files': all_files,
            'total_size_mb': total_size_mb,
        }

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------
    @staticmethod
    def _map_to_legacy_platforms(platforms: list[str]) -> list[str]:
        """Map B12 platform names → legacy multi_export platform names.

        Legacy multi_export.py supports: tiktok, reels, shorts, feed,
        twitter, instagram, youtube, facebook, whatsapp. We forward any
        platform name that already matches a legacy key, and map a few
        B12 names that don't (square → feed, landscape → feed).
        """
        legacy_keys = {
            'tiktok', 'reels', 'shorts', 'feed', 'twitter',
            'instagram', 'youtube', 'facebook', 'whatsapp',
        }
        out: list[str] = []
        for p in platforms:
            if p in legacy_keys:
                if p not in out:
                    out.append(p)
            elif p == 'square':
                if 'feed' not in out:
                    out.append('feed')
            elif p == 'landscape':
                # No legacy 16:9 target — use youtube (also 1080p+).
                if 'youtube' not in out:
                    out.append('youtube')
        return out


if __name__ == '__main__':
    # Quick smoke test: export a video to all 5 platforms
    import sys
    if len(sys.argv) < 3:
        print('Usage: multi_export.py <input_video> <output_dir> [platform1,platform2,...]')
        sys.exit(1)
    plats = (sys.argv[3].split(',') if len(sys.argv) > 3
             else ["tiktok", "reels", "shorts", "feed", "twitter"])
    results = export_multi_platform(
        sys.argv[1], plats, {'audience': 'patients'}, sys.argv[2]
    )
    # New return is a dict: {platform -> spec_dict, 'all_files': [...], 'total_size_mb': float}
    for platform in [p for p in plats if p in results]:
        r = results[platform]
        print(f"{platform:10s} → {r['path']} ({r['size_mb']} MB, "
              f"{r['dimensions']}, {r['duration_sec']}s){r.get('size_warning', '')}")
    print(f"Total size: {results.get('total_size_mb', 0)} MB across "
          f"{len(results.get('all_files', []))} files")
