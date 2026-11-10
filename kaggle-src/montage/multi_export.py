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
def export_multi_platform(
    video_path: str,
    platforms: list[str],
    options: dict,
    output_dir: str,
) -> list[dict]:
    """
    Export the final video for each requested platform + generate captions
    and hashtags.

    Returns:
        List of dicts:
            [{'platform', 'video_path', 'caption', 'hashtags', 'size_mb',
              'spec': {'resolution', 'fps', 'bitrate_kbps'}}]
    """
    outputs: list[dict] = []

    for platform in platforms:
        config = PLATFORM_CONFIGS.get(platform)
        if not config:
            print(f"   ⚠️  Unknown platform '{platform}' — skipping")
            continue

        platform_dir = os.path.join(output_dir, platform)
        os.makedirs(platform_dir, exist_ok=True)

        print(f"   📤 Exporting for {platform} "
              f"({config['resolution'][0]}x{config['resolution'][1]} "
              f"@ {config['bitrate_kbps']} kbps)")

        video_output = os.path.join(platform_dir, 'reel.mp4')
        export_for_platform(video_path, video_output, config)

        caption = generate_caption(platform, options, config)
        hashtags = generate_hashtags(platform, options, config)

        size_mb = os.path.getsize(video_output) / (1024 * 1024)
        outputs.append({
            'platform': platform,
            'video_path': video_output,
            'caption': caption,
            'hashtags': hashtags,
            'size_mb': round(size_mb, 2),
            'within_size_limit': size_mb <= config['max_size_mb'],
            'spec': {
                'resolution': f"{config['resolution'][0]}x{config['resolution'][1]}",
                'fps': config['fps'],
                'bitrate_kbps': config['bitrate_kbps'],
                'max_size_mb': config['max_size_mb'],
            },
        })

        # Persist caption + hashtags next to the video for easy upload
        caption_path = os.path.join(platform_dir, 'caption.txt')
        with open(caption_path, 'w', encoding='utf-8') as f:
            f.write(caption)
            if hashtags:
                f.write('\n\n' + ' '.join('#' + h for h in hashtags))
        print(f"      ✅ {platform}: {size_mb:.1f} MB "
              f"({'OK' if size_mb <= config['max_size_mb'] else 'OVER LIMIT'})")

    return outputs


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
    plats = sys.argv[3].split(',') if len(sys.argv) > 3 else list(PLATFORM_CONFIGS.keys())
    results = export_multi_platform(
        sys.argv[1], plats, {'audience': 'patients'}, sys.argv[2]
    )
    for r in results:
        print(f"{r['platform']:10s} → {r['video_path']} ({r['size_mb']} MB)")
