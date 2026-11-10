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


def render_animations(
    video_path: str,
    captions: dict,
    options: dict,
    output_dir: str,
) -> str:
    """
    Render Remotion animations on top of `video_path`.

    Args:
        video_path: Input color-graded video (1080x1920, 30fps).
        captions:   Output of caption_generator.generate_captions().
        options:    Pipeline options dict.
        output_dir: Where to drop the final animated video.

    Returns:
        Path to the animated MP4.
    """
    print(f"   🎞️  Remotion project: {REMOTION_PROJECT}")

    # 1. Ensure project skeleton (init if missing)
    ensure_remotion_project(REMOTION_PROJECT)

    # 2. Generate DynamicComposition.tsx
    composition_code = generate_remotion_composition(captions, options)
    comp_dir = os.path.join(REMOTION_PROJECT, 'src')
    os.makedirs(comp_dir, exist_ok=True)
    comp_file = os.path.join(comp_dir, 'DynamicComposition.tsx')
    with open(comp_file, 'w', encoding='utf-8') as f:
        f.write(composition_code)
    print(f"   🎞️  Wrote composition: {comp_file}")

    # 3. Save props (passed via --props or stdin)
    props = {
        'videoPath': video_path,
        'captions': captions,
        'options': options,
    }
    props_file = os.path.join(output_dir, 'remotion_props.json')
    with open(props_file, 'w', encoding='utf-8') as f:
        json.dump(props, f, ensure_ascii=False, indent=2)

    # 4. Render
    output_path = os.path.join(output_dir, 'animated_video.mp4')

    # Probe input video duration (so Remotion knows total frames)
    duration_seconds = _probe_duration(video_path)
    total_frames = max(1, int(duration_seconds * 30))

    cmd = [
        'npx',
        '--yes',
        'remotion',
        'render',
        'DynamicComposition',
        output_path,
        '--props', json.dumps(props, ensure_ascii=False),
        '--concurrency', '2',         # 2 T4 GPUs available
        '--gl', 'angle',              # headless GPU
        '--frames', f'0-{total_frames - 1}',
    ]

    print(f"   🎞️  Rendering ({total_frames} frames) → {output_path}")
    result = subprocess.run(
        cmd, cwd=REMOTION_PROJECT,
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Remotion render failed (exit {result.returncode}):\n"
            f"stderr: {result.stderr[-3000:]}"
        )

    print(f"   🎞️  ✅ Rendered: {output_path}")
    return output_path


# ---------------------------------------------------------------------------
# Composition code generation
# ---------------------------------------------------------------------------
def generate_remotion_composition(captions: dict, options: dict) -> str:
    """
    Generate the TypeScript React code for a DynamicComposition.
    The captions (phrases) are embedded as a JSON constant.
    """
    phrases_json = json.dumps(
        captions.get('phrases', []),
        ensure_ascii=False,
    )

    # Style mapping (P4-T5 acceptance: 3+ templates ready)
    style = captions.get('style', 'hormozi')
    if style == 'minimal':
        text_style = (
            "fontSize: 56, fontWeight: 700, color: '#FFFFFF', "
            "fontFamily: 'Tajawal, sans-serif', "
            "textShadow: '2px 2px 4px rgba(0,0,0,0.6)'"
        )
    elif style == 'arabic_bold':
        text_style = (
            "fontSize: 96, fontWeight: 900, color: '#FFFFFF', "
            "fontFamily: 'Cairo, sans-serif', "
            "background: 'rgba(0,0,0,0.55)', padding: '8px 16px', "
            "borderRadius: 12"
        )
    else:  # hormozi (default)
        text_style = (
            "fontSize: 80, fontWeight: 900, color: '#FFD700', "
            "textShadow: '4px 4px 0 #000, -4px -4px 0 #000, "
            "4px -4px 0 #000, -4px 4px 0 #000', "
            "fontFamily: 'Cairo, sans-serif'"
        )

    return f"""// AUTO-GENERATED by remotion_renderer.py — do not edit by hand.
import React from 'react';
import {{
  AbsoluteFill,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  Video,
  interpolate,
  spring,
}} from 'remotion';
import {{ AnimatedText }} from './components/AnimatedText';
import {{ ProgressBar }} from './components/ProgressBar';

interface PhraseWord {{
  word: string;
  start: number;
  end: number;
  emphasis: boolean;
  emoji?: string | null;
}}
interface Phrase {{
  words: PhraseWord[];
  start: number;
  end: number;
}}

const phrases: Phrase[] = {phrases_json};

const TEXT_STYLE: React.CSSProperties = {{ {text_style} }};

export const DynamicComposition: React.FC<{{
  videoPath: string;
  captions?: any;
  options?: any;
}}> = ({{ videoPath }}) => {{
  const frame = useCurrentFrame();
  const {{ fps, durationInFrames }} = useVideoConfig();

  return (
    <AbsoluteFill style={{{{ backgroundColor: '#000' }}}}>
      <Video src={{videoPath}} style={{{{ width: '100%', height: '100%', objectFit: 'cover' }}}} />

      {{/* Captions */}}
      {{phrases.map((phrase, i) => {{
        const startFrame = Math.floor(phrase.start * fps);
        const durationFrames = Math.max(
          1,
          Math.ceil((phrase.end - phrase.start) * fps)
        );

        return (
          <Sequence
            key={{i}}
            from={{startFrame}}
            durationInFrames={{durationFrames}}
          >
            <AbsoluteFill
              style={{{{
                justifyContent: 'center',
                alignItems: 'flex-end',
                paddingBottom: 200,
                direction: 'rtl',
              }}}}
            >
              <AnimatedText words={{phrase.words}} style={{TEXT_STYLE}} />
            </AbsoluteFill>
          </Sequence>
        );
      }})}}

      {{/* Progress bar */}}
      <ProgressBar progress={{frame / Math.max(1, durationInFrames)}} />
    </AbsoluteFill>
  );
}};
"""


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
