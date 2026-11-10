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
