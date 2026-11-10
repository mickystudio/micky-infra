"""
Remotion React renderer (P4-T5).
=============================
Dynamically generates a Remotion React composition based on the
captions produced by caption_generator.py, then renders the video
with animations on top of the color-graded input video.

Pipeline:
    1. Generate DynamicComposition.tsx (string) with the captions baked in.
    2. Ensure the Remotion project skeleton exists (init template).
    3. Run `npm install` (cached on Kaggle).
    4. Render with `npx remotion render DynamicComposition <output.mp4>
       --props '{...}'`.

The skeleton Remotion project is expected to live at:
    /kaggle/working/micky-assistant/kaggle-src/remotion/
with src/components/AnimatedText.tsx, src/components/InfoCard.tsx, etc.
If missing, we create a minimal one.

Created: 2026-11-10
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
REMOTION_PROJECT = os.environ.get(
    'MICKY_REMOTION_DIR',
    '/kaggle/working/micky-assistant/kaggle-src/remotion',
)


def render_animations(video_path, captions, options=None, output_dir=None):
    """Render Remotion animations overlay on top of the video.

    Animations include:
    - Animated lower-thirds (intro card with name/title)
    - Progress bars (showing video progress at top)
    - Brand logo animation (top-right corner)
    - Hormozi-style caption animations (synchronized with the captions.json)
    - B-roll info cards

    Args:
        video_path: Source video to overlay animations on.
        captions: Captions dict from caption_generator (or path to captions.json).
        options: Dict with optional keys:
            - brand_name: str (default "MICKY")
            - brand_color: str hex (default "#6366f1")
            - show_progress_bar: bool (default True)
            - show_lower_third: bool (default True, only first 5s)
            - show_brand_logo: bool (default True)
        output_dir: Where to save the rendered overlay video.

    Returns:
        str: Path to the final video with animations burned in.
    """
    import os, json, subprocess, sys, shutil
    from pathlib import Path

    if options is None:
        options = {}
    if output_dir is None:
        output_dir = str(Path(video_path).parent / "remotion_out")
    os.makedirs(output_dir, exist_ok=True)

    name = Path(video_path).stem
    final_output = str(Path(output_dir) / f"{name}_animated.mp4")

    # Step 1: Check Node.js + npm + Remotion are available
    print("[remotion] Checking Node.js + Remotion availability...")

    def run(cmd, **kwargs):
        return subprocess.run(cmd, capture_output=True, text=True, **kwargs)

    # Check node
    if not shutil.which("node"):
        print("[remotion] Node.js not found. Installing...")
        # On Kaggle, install via apt or conda
        subprocess.check_call(["apt-get", "install", "-y", "nodejs", "npm"],
                            env={**os.environ, "DEBIAN_FRONTEND": "noninteractive"})

    # Check Remotion
    remotion_check = run(["npx", "--yes", "@remotion/cli@4", "--version"])
    if remotion_check.returncode != 0:
        print("[remotion] Installing Remotion globally...")
        subprocess.check_call(["npm", "install", "-g", "@remotion/cli@4", "remotion@4"])

    # Step 2: Fetch Remotion compositions from GitHub
    REMOTION_REPO = "mickystudio/micky-infra"
    REMOTION_PATH = "kaggle-src/remotion"
    REMOTION_DIR = "/tmp/remotion_compositions"

    if not os.path.exists(REMOTION_DIR):
        print(f"[remotion] Fetching compositions from GitHub ({REMOTION_REPO})...")
        os.makedirs(REMOTION_DIR, exist_ok=True)
        # Clone just the remotion directory using sparse-checkout
        subprocess.run([
            "git", "clone", "--depth", "1", "--filter=blob:none",
            "--sparse", f"https://github.com/{REMOTION_REPO}.git", REMOTION_DIR
        ], check=True)
        subprocess.run(["git", "-C", REMOTION_DIR, "sparse-checkout", "set", REMOTION_PATH], check=True)
        # Move the remotion dir to root of REMOTION_DIR
        remotion_src = os.path.join(REMOTION_DIR, REMOTION_PATH)
        for item in os.listdir(remotion_src):
            shutil.move(os.path.join(remotion_src, item), REMOTION_DIR)

    # Install Remotion deps
    print("[remotion] Installing Remotion deps...")
    subprocess.run(["npm", "install"], cwd=REMOTION_DIR, check=True, capture_output=True)

    # Step 3: Get video duration
    probe = subprocess.run([
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration:stream=width,height,r_frame_rate",
        "-of", "json", video_path
    ], capture_output=True, text=True, check=True)
    info = json.loads(probe.stdout)
    duration = float(info["format"]["duration"])
    width = int(info["streams"][0]["width"])
    height = int(info["streams"][0]["height"])
    fps_num, fps_den = info["streams"][0]["r_frame_rate"].split("/")
    fps = float(fps_num) / float(fps_den) if float(fps_den) > 0 else 30.0

    # Step 4: Load captions
    if isinstance(captions, str):
        with open(captions, "r", encoding="utf-8") as f:
            captions_data = json.load(f)
    elif isinstance(captions, dict):
        captions_data = captions
    else:
        captions_data = {"words": [], "style": "hormozi"}

    # Step 5: Build props JSON for Remotion
    props = {
        "videoDurationInFrames": int(duration * fps),
        "fps": int(fps),
        "width": width,
        "height": height,
        "captions": captions_data,
        "brand": {
            "name": options.get("brand_name", "MICKY"),
            "color": options.get("brand_color", "#6366f1"),
        },
        "showProgressBar": options.get("show_progress_bar", True),
        "showLowerThird": options.get("show_lower_third", True),
        "showBrandLogo": options.get("show_brand_logo", True),
    }

    props_path = os.path.join(output_dir, "props.json")
    with open(props_path, "w", encoding="utf-8") as f:
        json.dump(props, f, ensure_ascii=False, indent=2)

    # Step 6: Render Remotion composition (transparent overlay)
    overlay_path = os.path.join(output_dir, "overlay.webm")
    print(f"[remotion] Rendering overlay ({width}x{height}@{fps}fps, {duration:.1f}s)...")

    render_cmd = [
        "npx", "--yes", "@remotion/cli@4", "render",
        "DynamicComposition",  # composition id from Root.tsx
        overlay_path,
        f"--props={props_path}",
        f"--width={width}",
        f"--height={height}",
        f"--fps={int(fps)}",
        "--codec=h264",
        "--pixel-format=yuva420p",  # transparent overlay
        "--log=warn",
    ]

    result = subprocess.run(render_cmd, cwd=REMOTION_DIR, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"[remotion] Render failed: {result.stderr[-500:]}")
        # Fallback: skip Remotion, return original video
        print("[remotion] Using original video without animations.")
        shutil.copy(video_path, final_output)
        return final_output

    print(f"[remotion] Overlay rendered: {overlay_path}")

    # Step 7: Mux overlay onto original video using ffmpeg
    print("[remotion] Compositing overlay onto source video...")
    subprocess.run([
        "ffmpeg", "-y",
        "-i", video_path,
        "-i", overlay_path,
        "-filter_complex", "[0:v][1:v]overlay=0:0",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-c:a", "copy",
        final_output
    ], check=True, capture_output=True)

    final_size = os.path.getsize(final_output)
    print(f"[remotion] Done. Final video: {final_output} ({final_size} bytes)")
    return final_output


# ---------------------------------------------------------------------------
# Composition code generation
# ---------------------------------------------------------------------------
def generate_remotion_composition(captions, options):
    """Generate a Remotion composition spec (for use with the JS-side rendering)."""
    # This is a thin wrapper for the Remotion-side composition definitions.
    # The actual React components live in kaggle-src/remotion/src/compositions/
    return {
        "compositionId": "DynamicComposition",
        "durationInFrames": int(sum(w.get("duration", 0) for w in captions.get("words", [])) * 30),
        "fps": 30,
        "width": 1080,
        "height": 1920,
        "props": {
            "captions": captions,
            "options": options or {},
        },
    }


# ---------------------------------------------------------------------------
# Remotion project skeleton
# ---------------------------------------------------------------------------
def ensure_remotion_project(project_dir: str) -> None:
    """
    Ensure a minimal Remotion project exists at `project_dir`.
    Creates package.json, tsconfig, Root.tsx, and basic components
    if they don't exist. Idempotent.
    """
    src_dir = os.path.join(project_dir, 'src')
    comp_dir = os.path.join(src_dir, 'components')
    os.makedirs(comp_dir, exist_ok=True)

    # package.json
    pkg_json_path = os.path.join(project_dir, 'package.json')
    if not os.path.exists(pkg_json_path):
        print(f"   🎞️  Initializing Remotion project at {project_dir}")
        _write(pkg_json_path, _PKG_JSON)
        _write(os.path.join(project_dir, 'tsconfig.json'), _TSCONFIG)
        _write(os.path.join(src_dir, 'Root.tsx'), _ROOT_TSX)
        _write(os.path.join(src_dir, 'index.ts'), _INDEX_TS)
        _write(os.path.join(comp_dir, 'AnimatedText.tsx'), _ANIMATED_TEXT_TSX)
        _write(os.path.join(comp_dir, 'ProgressBar.tsx'), _PROGRESS_BAR_TSX)


# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------
_PKG_JSON = """{
  "name": "micky-remotion",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "remotion studio",
    "render": "remotion render"
  },
  "dependencies": {
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "remotion": "4.0.0",
    "@remotion/cli": "4.0.0",
    "@remotion/player": "4.0.0"
  },
  "devDependencies": {
    "@types/react": "18.3.0",
    "typescript": "5.4.0"
  }
}
"""

_TSCONFIG = """{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "./dist"
  },
  "include": ["src/**/*"]
}
"""

_ROOT_TSX = """import React from 'react';
import { Composition } from 'remotion';
import { DynamicComposition } from './DynamicComposition';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="DynamicComposition"
      component={DynamicComposition}
      durationInFrames={900}   // 30s @ 30fps (overridden by --props)
      fps={30}
      width={1080}
      height={1920}
      defaultProps={{ videoPath: '', captions: {}, options: {} }}
    />
  );
};
"""

_INDEX_TS = """import { registerRoot } from 'remotion';
import { RemotionRoot } from './Root';
registerRoot(RemotionRoot);
"""

_ANIMATED_TEXT_TSX = """import React from 'react';
import { useCurrentFrame, useVideoConfig, interpolate } from 'remotion';

interface Word { word: string; start: number; end: number; emphasis: boolean; emoji?: string | null; }

export const AnimatedText: React.FC<{ words: Word[]; style: React.CSSProperties }> = ({ words, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 8, maxWidth: 900, ...style }}>
      {words.map((w, i) => {
        const localStart = Math.floor(w.start * fps);
        const opacity = interpolate(frame - localStart, [0, 3], [0, 1], { extrapolateRight: 'clamp' });
        const scale = w.emphasis ? 1.15 : 1;
        return (
          <span key={i} style={{ opacity, transform: `scale(${scale})` }}>
            {w.word}
            {w.emoji ? <span style={{ marginLeft: 4 }}>{w.emoji}</span> : null}
          </span>
        );
      })}
    </div>
  );
};
"""

_PROGRESS_BAR_TSX = """import React from 'react';
export const ProgressBar: React.FC<{ progress: number }> = ({ progress }) => {
  return (
    <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 8, backgroundColor: 'rgba(255,255,255,0.15)' }}>
      <div style={{ width: `${Math.min(100, progress * 100)}%`, height: '100%', backgroundColor: '#FFD700' }} />
    </div>
  );
};
"""


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------
def _write(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)


def _probe_duration(video_path: str) -> float:
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


# B14: parallel rendering via ParallelRenderer
# ---------------------------------------------------------------------------
def _render_segment_with_remotion(segment, source_video: str, output_path: str) -> str:
    """Per-segment render: trim → Remotion overlay → mux. Idempotent."""
    import os as _os
    import shutil as _sh
    import tempfile as _tf

    _os.makedirs(_os.path.dirname(output_path) or '.', exist_ok=True)
    tmp_dir = _tf.mkdtemp(prefix='remotion_seg_')
    trimmed = _os.path.join(tmp_dir, f'trim_{segment.segment_idx:03d}.mp4')
    try:
        subprocess.run(
            ['ffmpeg', '-y', '-ss', f'{segment.start_sec:.3f}',
             '-to', f'{segment.end_sec:.3f}', '-i', source_video,
             '-c', 'copy', '-avoid_negative_ts', 'make_zero', trimmed],
            check=True, capture_output=True,
        )
    except Exception:
        # If stream copy fails (e.g. B-frames), re-encode.
        subprocess.run(
            ['ffmpeg', '-y', '-ss', f'{segment.start_sec:.3f}',
             '-to', f'{segment.end_sec:.3f}', '-i', source_video,
             '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
             '-c:a', 'copy', trimmed],
            check=True, capture_output=True,
        )
    # Render Remotion overlay on the trimmed clip (captions/options from segment.metadata).
    seg_captions = segment.metadata.get('captions', {'words': [], 'phrases': []})
    seg_options = segment.metadata.get('options', {})
    try:
        rendered = render_animations(trimmed, seg_captions, seg_options, tmp_dir)
        _sh.copy2(rendered, output_path)
    except Exception:
        _sh.copy2(trimmed, output_path)  # Remotion failed → use trimmed clip.
    finally:
        _sh.rmtree(tmp_dir, ignore_errors=True)
    return output_path


def render_parallel(
    video_path: str,
    captions: dict | str,
    options: dict | None = None,
    output_dir: str | None = None,
    scene_boundaries: list | None = None,
    segment_count: int = 4,
) -> str:
    """B14: parallel-render the Remotion overlay. Falls back to single-thread."""
    import os as _os
    from parallel_renderer import ParallelRenderer, Segment, SceneBoundary  # type: ignore

    if options is None:
        options = {}
    if output_dir is None:
        output_dir = str(Path(video_path).parent / 'remotion_parallel_out')
    _os.makedirs(output_dir, exist_ok=True)
    final_output = str(Path(output_dir) / f'{Path(video_path).stem}_animated.mp4')

    # Convert SceneBoundary dicts → dataclass instances if needed.
    boundaries: list = []
    for b in (scene_boundaries or []):
        if isinstance(b, SceneBoundary):
            boundaries.append(b)
        elif isinstance(b, dict):
            boundaries.append(SceneBoundary(
                index=b.get('index', 0), start_time=b.get('start_time', 0.0),
                end_time=b.get('end_time', 0.0),
                start_frame=b.get('start_frame', 0),
                end_frame=b.get('end_frame', 0),
            ))

    # Inject captions/options into each Segment's metadata before rendering.
    def _seg_fn(seg: Segment, src: str, out: str) -> str:
        seg.metadata.setdefault('captions', captions if isinstance(captions, dict)
                                else {'words': [], 'phrases': []})
        seg.metadata.setdefault('options', options)
        return _render_segment_with_remotion(seg, src, out)

    try:
        renderer = ParallelRenderer(segment_count=segment_count, output_dir=output_dir)
        return renderer.parallel_render_video(
            video_path, boundaries, _seg_fn, final_output,
        )
    except Exception as e:
        print(f'[remotion/parallel] failed ({e}); falling back to single-thread.')
        return render_animations(video_path, captions, options, output_dir)


if __name__ == '__main__':
    import argparse, sys

    p = argparse.ArgumentParser(description='Remotion renderer (single or parallel)')
    p.add_argument('video_path', help='Path to source video')
    p.add_argument('output_dir', help='Output directory')
    p.add_argument('--caption-style', default='hormozi')
    p.add_argument('--parallel', action='store_true', help='Use B14 parallel rendering')
    p.add_argument('--segments', type=int, default=4, help='Parallel segment count (default 4)')
    p.add_argument('--benchmark', action='store_true', help='Run N=1,2,4,8 benchmark')
    args = p.parse_args()

    _captions = {'words': [], 'phrases': [], 'style': args.caption_style,
                 'language': 'ar', 'total_duration': 0.0}
    _options = {'caption_style': args.caption_style}

    try:
        if args.benchmark:
            from parallel_renderer import ParallelRenderer  # type: ignore
            import json as _json
            r = ParallelRenderer(segment_count=4, output_dir=args.output_dir)
            print(_json.dumps(r.benchmark_parallelism(args.video_path), indent=2))
        elif args.parallel:
            out = render_parallel(args.video_path, _captions, _options,
                                  args.output_dir, segment_count=args.segments)
            print(f'Animated video (parallel) → {out}')
        else:
            out = render_animations(args.video_path, _captions, _options, args.output_dir)
            print(f'Animated video → {out}')
    except RuntimeError as _e:
        print(f'[ERROR] {_e}')
        print('Hint: Remotion requires Node.js + npm. '
              'Install with `apt-get install -y nodejs npm` on Kaggle.')
        sys.exit(2)
