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


def remove_background(video_path, bg_choice="transparent", output_dir=None):
    """Remove video background using Robust Video Matting (RVM).

    Args:
        video_path: Path to input video.
        bg_choice: One of 'transparent', 'white', 'black', 'green', 'blur', or a path to a background image.
        output_dir: Where to save the output. If None, uses video_path's parent.

    Returns:
        str: Path to the output video with background removed/replaced.
    """
    import os, sys, subprocess
    from pathlib import Path
    import shutil

    video_path = str(video_path)
    if output_dir is None:
        output_dir = str(Path(video_path).parent / "output")
    os.makedirs(output_dir, exist_ok=True)

    name = Path(video_path).stem
    output_path = str(Path(output_dir) / f"{name}_nobg.mp4")

    print(f"[bg_remove] Processing {video_path} with bg='{bg_choice}'...")

    # Step 1: Install dependencies if missing
    try:
        import torch
        print(f"[bg_remove] torch version: {torch.__version__}, CUDA: {torch.cuda.is_available()}")
    except ImportError:
        print("[bg_remove] Installing torch...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "-q",
                              "torch", "torchvision", "--index-url",
                              "https://download.pytorch.org/whl/cu121"])
        import torch

    # Step 2: Load RVM model from torch hub
    print("[bg_remove] Loading RobustVideoMatting model...")
    try:
        model = torch.hub.load("PeterL1n/RobustVideoMatting", "mobilenetv3", trust_repo=True)
    except Exception as e:
        print(f"[bg_remove] torch.hub.load failed: {e}, trying direct download...")
        # Fallback: clone repo and load manually
        repo_dir = "/tmp/RobustVideoMatting"
        if not os.path.exists(repo_dir):
            subprocess.check_call(["git", "clone", "--depth", "1",
                                   "https://github.com/PeterL1n/RobustVideoMatting.git", repo_dir])
        sys.path.insert(0, repo_dir)
        from model.rvm import MobileNetV3Matting
        model = MobileNetV3Matting()

    if torch.cuda.is_available():
        model = model.cuda()
        print("[bg_remove] Using GPU (CUDA)")
    else:
        print("[bg_remove] WARNING: No GPU available, will be very slow on CPU")
    model.eval()

    # Step 3: Process video with RVM inference
    # Use the official inference.py script's API
    import numpy as np
    from PIL import Image
    import torchvision.transforms as T

    # Extract frames first using ffmpeg
    frames_dir = str(Path(output_dir) / "frames_input")
    os.makedirs(frames_dir, exist_ok=True)
    print(f"[bg_remove] Extracting frames to {frames_dir}...")
    subprocess.run([
        "ffmpeg", "-y", "-i", video_path,
        "-q:v", "1", os.path.join(frames_dir, "%08d.png")
    ], check=True, capture_output=True)

    # Get video metadata
    probe = subprocess.run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,nb_frames",
        "-of", "json", video_path
    ], capture_output=True, text=True)
    import json
    meta = json.loads(probe.stdout)["streams"][0]
    width, height = int(meta["width"]), int(meta["height"])
    fps_num, fps_den = meta["r_frame_rate"].split("/")
    fps = float(fps_num) / float(fps_den) if float(fps_den) > 0 else 30.0

    # Load background image if specified
    bg_image = None
    if bg_choice not in ("transparent", "white", "black", "green", "blur"):
        if os.path.exists(bg_choice):
            bg_image = Image.open(bg_choice).convert("RGB").resize((width, height))
            bg_image = T.ToTensor()(bg_image).unsqueeze(0)
            if torch.cuda.is_available():
                bg_image = bg_image.cuda()

    # Process frames in batches
    frame_files = sorted(os.listdir(frames_dir))
    batch_size = 4 if torch.cuda.is_available() else 1
    output_frames_dir = str(Path(output_dir) / "frames_output")
    os.makedirs(output_frames_dir, exist_ok=True)

    rec = [None] * 4  # recurrent states

    print(f"[bg_remove] Processing {len(frame_files)} frames in batches of {batch_size}...")

    for batch_start in range(0, len(frame_files), batch_size):
        batch_files = frame_files[batch_start:batch_start + batch_size]
        batch_tensors = []
        for f in batch_files:
            img = Image.open(os.path.join(frames_dir, f)).convert("RGB")
            batch_tensors.append(T.ToTensor()(img))
        src = torch.stack(batch_tensors)
        if torch.cuda.is_available():
            src = src.cuda()

        # Normalize to [-1, 1] (RVM convention)
        src = src * 2 - 1
        src = src.unsqueeze(0)  # [1, T, C, H, W]

        with torch.no_grad():
            fgr, pha, *rec = model(src, *rec, downsample_ratio=0.25)

        # Compose with chosen background
        fgr = fgr[0]  # [T, C, H, W]
        pha = pha[0]  # [T, 1, H, W]

        for i, f in enumerate(batch_files):
            fg = fgr[i].cpu()
            a = pha[i].cpu()

            if bg_choice == "transparent":
                # Save as RGBA PNG
                rgba = torch.cat([fg, a], dim=0)
                img = T.ToPILImage()(rgba)
                img.save(os.path.join(output_frames_dir, f.replace(".png", ".png")))
            elif bg_choice == "white":
                bg = torch.ones_like(fg)
                composite = fg * a + bg * (1 - a)
                T.ToPILImage()(composite).save(os.path.join(output_frames_dir, f))
            elif bg_choice == "black":
                bg = torch.zeros_like(fg)
                composite = fg * a + bg * (1 - a)
                T.ToPILImage()(composite).save(os.path.join(output_frames_dir, f))
            elif bg_choice == "green":
                bg = torch.tensor([0.0, 1.0, 0.0]).view(3, 1, 1).expand_as(fg)
                composite = fg * a + bg * (1 - a)
                T.ToPILImage()(composite).save(os.path.join(output_frames_dir, f))
            elif bg_choice == "blur":
                # Apply blur to original frame, composite with foreground
                img = Image.open(os.path.join(frames_dir, f)).convert("RGB").filter(Image.GaussianBlur(radius=20))
                bg = T.ToTensor()(img)
                composite = fg * a + bg * (1 - a)
                T.ToPILImage()(composite).save(os.path.join(output_frames_dir, f))
            elif bg_image is not None:
                composite = fg * a + bg_image[0] * (1 - a)
                T.ToPILImage()(composite).save(os.path.join(output_frames_dir, f))
            else:
                # Default to original (passthrough)
                T.ToPILImage()(fg).save(os.path.join(output_frames_dir, f))

    print(f"[bg_remove] Frames processed. Re-encoding video...")

    # Re-encode frames to video using ffmpeg
    subprocess.run([
        "ffmpeg", "-y", "-r", str(fps),
        "-i", os.path.join(output_frames_dir, "%08d.png"),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
        output_path
    ], check=True, capture_output=True)

    # Cleanup intermediate frames
    shutil.rmtree(frames_dir, ignore_errors=True)
    shutil.rmtree(output_frames_dir, ignore_errors=True)

    print(f"[bg_remove] Done. Output: {output_path} ({os.path.getsize(output_path)} bytes)")
    return output_path


# ---------------------------------------------------------------------------
# Model + tensor helpers
# ---------------------------------------------------------------------------
_RVM_MODEL_CACHE: Any = None


def load_rvm_model(device: str = 'cuda') -> Any:
    """
    Load the Robust Video Matting (resnet50 backbone) model.

    Uses torch.hub. The model is cached after first load.
    Raises RuntimeError if the model cannot be fetched
    (e.g. no internet on a sandboxed Kaggle kernel).
    """
    _ensure_torch_deps()
    global _RVM_MODEL_CACHE
    if _RVM_MODEL_CACHE is not None:
        return _RVM_MODEL_CACHE

    print(f"   🖼️  Loading RVM resnet50 model (torch.hub)...")
    try:
        model = torch.hub.load(
            'PeterL1n/RobustVideoMatting',
            'resnet50',
            trust_repo=True,
        )
    except Exception as e:
        raise RuntimeError(
            "Failed to load Robust Video Matting model from torch.hub. "
            "This typically requires internet access on first run "
            "(Kaggle: enable 'Internet' in the kernel settings). "
            f"Original error: {e}"
        ) from e
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


# ---------------------------------------------------------------------------
# Standalone CLI (for debugging)
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    import sys

    if len(sys.argv) < 4:
        print('Usage: background_remover.py <video_path> <bg_choice> <output_dir>')
        print("bg_choice options: " + ', '.join(BACKGROUNDS.keys()))
        sys.exit(1)

    _video = sys.argv[1]
    _bg = sys.argv[2]
    _out_dir = sys.argv[3]
    _result = remove_background(_video, _bg, _out_dir)
    print(f'Matted video → {_result}')
