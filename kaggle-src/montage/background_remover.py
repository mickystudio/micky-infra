"""
Background removal using Robust Video Matting (RVM) — P4-T3.

Replaces the original background with one of 5 professional dental backgrounds:
    - dental_office   (warm clinical room)
    - blue_gradient   (calm medical fade)
    - white_studio    (clean minimal)
    - infographic_bg  (educational overlay)
    - dreamy_soft     (soft bokeh)

Pipeline:
    1. Extract frames with ffmpeg (30 fps, scaled to 1080x1920).
    2. Run RVM recurrent inference over each frame (GPU on T4).
    3. Composite foreground × alpha with chosen background.
    4. Reassemble MP4 with original (already-enhanced) audio.

Created: 2026-11-10
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    import numpy as np  # for type hints only
    import torch

# Heavy deps loaded lazily so this module imports cleanly on machines
# without torch (e.g. for testing or stage-skipping).
# Actual functions re-import inside their bodies.
np = None  # type: ignore[assignment]
torch = None  # type: ignore[assignment]
Image = None  # type: ignore[assignment]


def _ensure_torch_deps() -> None:
    """Lazy-load numpy, torch, PIL. Raises ImportError if unavailable."""
    global np, torch, Image
    if np is not None:
        return
    import numpy as _np
    import torch as _torch
    from PIL import Image as _Image
    np = _np
    torch = _torch
    Image = _Image

# ---------------------------------------------------------------------------
# Background catalog
# ---------------------------------------------------------------------------
ASSETS_BASE = os.environ.get(
    'MICKY_ASSETS_DIR', '/kaggle/input/micky-assets'
)

BACKGROUNDS: dict[str, str] = {
    'dental_office':   os.path.join(ASSETS_BASE, 'backgrounds/dental_office.png'),
    'blue_gradient':   os.path.join(ASSETS_BASE, 'backgrounds/blue_gradient.png'),
    'white_studio':    os.path.join(ASSETS_BASE, 'backgrounds/white_studio.png'),
    'infographic_bg':  os.path.join(ASSETS_BASE, 'backgrounds/infographic_bg.png'),
    'dreamy_soft':     os.path.join(ASSETS_BASE, 'backgrounds/dreamy_soft.png'),
}

# Output canvas — fixed at 1080x1920 (9:16 vertical Reels/Shorts standard)
FRAME_W = 1080
FRAME_H = 1920
FPS = 30


def remove_background(video_path: str, bg_choice: str, output_dir: str) -> str:
    """
    Remove background using RVM and composite with a new background.

    Args:
        video_path: Input video (audio already enhanced).
        bg_choice:  Key into BACKGROUNDS (falls back to 'dental_office').
        output_dir: Scratch + output directory.

    Returns:
        Path to the matted MP4 (with original audio stream preserved).
    """
    _ensure_torch_deps()
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    print(f"   🖼️  RVM on {device} | background='{bg_choice}'")
    # --- Load model + background ---------------------------------------------
    model = load_rvm_model(device=device)
    background = load_background(
        BACKGROUNDS.get(bg_choice, BACKGROUNDS['dental_office']),
        device=device,
    )

    # --- Extract frames ------------------------------------------------------
    frames_dir = os.path.join(output_dir, 'frames')
    matted_dir = os.path.join(output_dir, 'matted')
    os.makedirs(frames_dir, exist_ok=True)
    os.makedirs(matted_dir, exist_ok=True)

    # Clean previous frames (in case of retry)
    for f in Path(frames_dir).glob('*.png'):
        f.unlink()
    for f in Path(matted_dir).glob('*.png'):
        f.unlink()

    print(f"   🖼️  Extracting frames @ {FPS}fps, {FRAME_W}x{FRAME_H} → {frames_dir}")
    _run_ffmpeg([
        'ffmpeg', '-y',
        '-i', video_path,
        '-vf', f'fps={FPS},scale={FRAME_W}:{FRAME_H}:flags=lanczos',
        '-q:v', '2',
        f'{frames_dir}/%06d.png',
    ])

    frame_files = sorted(Path(frames_dir).glob('*.png'))
    if not frame_files:
        raise RuntimeError(f'ffmpeg produced no frames in {frames_dir}')
    print(f"   🖼️  {len(frame_files)} frames to process")

    # --- RVM inference loop --------------------------------------------------
    # RVM recurrent state: 4 tensors (r1, r2, r3, r4) — initially None
    rec: list[Any] = [None, None, None, None]
    downsample_ratio = 1.0   # full-resolution (1080x1920 fits comfortably in 16GB)

    with torch.no_grad():
        for i, frame_file in enumerate(frame_files):
            frame = load_image_as_tensor(frame_file, device=device)
            # RVM forward pass; recurrent state updated in-place
            fgr, pha, *rec = model(frame, *rec, downsample_ratio=downsample_ratio)
            composite = composite_frame(fgr, pha, background)
            save_image(composite, os.path.join(matted_dir, f'{i:06d}.png'))
            if i % 150 == 0:
                print(f"      …processed {i + 1}/{len(frame_files)} frames")

    print(f"   🖼️  Composited {len(frame_files)} frames → {matted_dir}")

    # --- Reassemble video with audio -----------------------------------------
    output_path = os.path.join(output_dir, 'matted_video.mp4')
    print(f"   🖼️  Reassembling video → {output_path}")
    _run_ffmpeg([
        'ffmpeg', '-y',
        '-framerate', str(FPS),
        '-i', f'{matted_dir}/%06d.png',
        '-i', video_path,                       # audio source
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '18',                            # visually-lossless
        '-pix_fmt', 'yuv420p',
        '-r', str(FPS),
        '-c:a', 'aac', '-b:a', '192k',
        '-shortest',
        '-movflags', '+faststart',
        output_path,
    ])

    return output_path


# ---------------------------------------------------------------------------
# Model + tensor helpers
# ---------------------------------------------------------------------------
_RVM_MODEL_CACHE: Any = None


def load_rvm_model(device: str = 'cuda') -> Any:
    """
    Load the Robust Video Matting (resnet50 backbone) model.

    Uses torch.hub. The model is cached after first load.
    """
    _ensure_torch_deps()
    global _RVM_MODEL_CACHE
    if _RVM_MODEL_CACHE is not None:
        return _RVM_MODEL_CACHE

    print(f"   🖼️  Loading RVM resnet50 model (torch.hub)...")
    model = torch.hub.load(
        'PeterL1n/RobustVideoMatting',
        'resnet50',
        trust_repo=True,
    )
    model = model.to(device).eval()
    _RVM_MODEL_CACHE = model
    return model


def load_background(bg_path: str, device: str = 'cuda') -> 'torch.Tensor':
    """Load background PNG as (1, 3, H, W) tensor in [0,1]."""
    _ensure_torch_deps()
    if not os.path.exists(bg_path):
        # Fallback: synthesize a soft blue gradient so the pipeline never crashes
        print(f"   ⚠️  Background '{bg_path}' missing — synthesizing blue gradient")
        return _synth_blue_gradient(device=device)

    img = Image.open(bg_path).convert('RGB').resize((FRAME_W, FRAME_H))
    arr = np.array(img).transpose(2, 0, 1) / 255.0          # (3, H, W)
    tensor = torch.from_numpy(arr).unsqueeze(0).float()     # (1, 3, H, W)
    return tensor.to(device)


def load_image_as_tensor(path: str | Path, device: str = 'cuda') -> 'torch.Tensor':
    """Load image as (1, 3, H, W) tensor normalized to [0, 1]."""
    _ensure_torch_deps()
    img = Image.open(path).convert('RGB')
    arr = np.array(img).transpose(2, 0, 1) / 255.0
    tensor = torch.from_numpy(arr).unsqueeze(0).float()
    return tensor.to(device)


def composite_frame(
    fgr: 'torch.Tensor',
    pha: 'torch.Tensor',
    background: 'torch.Tensor',
) -> 'np.ndarray':
    """
    Composite foreground × alpha + background × (1 − alpha).

    Args:
        fgr:        (1, 3, H, W) foreground RGBA from RVM
        pha:        (1, 1, H, W) alpha matte
        background: (1, 3, H, W) background

    Returns:
        (H, W, 3) uint8 numpy array.
    """
    _ensure_torch_deps()
    composite = fgr * pha + background * (1.0 - pha)
    composite = composite.squeeze(0).cpu().numpy().transpose(1, 2, 0)
    composite = np.clip(composite * 255.0, 0, 255).astype(np.uint8)
    return composite


def save_image(arr: 'np.ndarray', path: str) -> None:
    """Save (H, W, 3) uint8 array as PNG."""
    _ensure_torch_deps()
    Image.fromarray(arr).save(path)


def _synth_blue_gradient(device: str = 'cuda') -> 'torch.Tensor':
    """Generate a soft vertical blue gradient (fallback background)."""
    _ensure_torch_deps()
    # Top: dark navy → Bottom: bright medical blue
    top = np.array([10, 32, 80], dtype=np.float32)
    bottom = np.array([90, 180, 230], dtype=np.float32)
    grad = np.linspace(0, 1, FRAME_H)[:, None] * (bottom - top) + top
    grad = np.tile(grad[:, None, :], (1, FRAME_W, 1))            # (H, W, 3)
    arr = grad.transpose(2, 0, 1)[None, ...]                     # (1, 3, H, W)
    return torch.from_numpy(arr).float().to(device)


# ---------------------------------------------------------------------------
# Internal: ffmpeg wrapper
# ---------------------------------------------------------------------------
def _run_ffmpeg(cmd: list[str]) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg failed (exit {result.returncode}):\n"
            f"command: {' '.join(cmd)}\n"
            f"stderr: {result.stderr[-2000:]}"
        )
