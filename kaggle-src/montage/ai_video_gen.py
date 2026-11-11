"""
AI Video Generation (B10) — Wan2.1 / LTX-Video text-to-video + thumbnails.
=========================================================================
Wraps Alibaba's Wan2.1-T2V-1.3B (Apache-2.0, commercial-safe) to generate
short B-roll clips and still thumbnails for the montage pipeline. Falls
back to Lightricks' LTX-Video (also permissive) when Wan2.1 fails to load.

Heavy imports (``diffusers``, ``transformers``, ``torch``, ``accelerate``)
are lazy — only fired on first call to generate_*(). This keeps the module
importable on CPU-only / non-GPU hosts where ``available=False`` and
callers degrade gracefully.

VRAM (T4 16GB):
    Wan2.1-T2V-1.3B FP16 ≈ 8GB; LTX-Video 2B ≈ 10GB;
    FLUX-schnell thumb ≈ 12GB (else Wan2.1 first frame).
Generation: ~30s for a 5s 720p B-roll on T4 (25 steps); ~3-5s thumbnail.

Created: 2026-12-08  |  Phase P4-T8  (B10)
"""
from __future__ import annotations

import hashlib
import logging
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, List, Optional, Tuple

log = logging.getLogger(__name__)

DEFAULT_VIDEO_MODEL = 'Wan-AI/Wan2.1-T2V-1.3B'
FALLBACK_VIDEO_MODEL = 'Lightricks/LTX-Video'
DEFAULT_THUMB_MODEL = 'black-forest-labs/FLUX.1-schnell'

OUTPUT_ROOT = Path('/tmp/micky_generated')
OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)

DEFAULT_NEGATIVE_PROMPT = (
    'low quality, blurry, distorted, watermark, text overlay, '
    'deformed, jpeg artifacts, extra limbs, bad anatomy'
)

_PIP_PACKAGES = {
    'diffusers': 'diffusers>=0.30',
    'transformers': 'transformers>=4.45',
    'accelerate': 'accelerate>=0.34',
    'torch': 'torch>=2.1',
}


def _ensure_pip_packages(packages: List[str]) -> None:
    """Install missing pip packages (no-op if already present)."""
    import importlib
    missing = []
    for pkg in packages:
        try:
            importlib.import_module(pkg)
        except ImportError:
            missing.append(_PIP_PACKAGES.get(pkg, pkg))
    if not missing:
        return
    print(f"[ai_video_gen] Installing: {', '.join(missing)}")
    subprocess.check_call(
        [sys.executable, '-m', 'pip', 'install', '-q', *missing],
    )


def _gpu_collect() -> None:
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:
        pass


def _hash_prompt(prompt: str, salt: str = '') -> str:
    return hashlib.sha1(f"{prompt}|{salt}|{time.time()}".encode()).hexdigest()[:12]


class AIVideoGenerator:
    """Text-to-video B-roll + thumbnail generator.

    Lazy-loads ``diffusers`` + the chosen model on first use. If Wan2.1
    fails to load, falls back to LTX-Video. If both fail, ``available=False``
    and callers must handle the absence.
    """

    def __init__(
        self,
        model_name: str = DEFAULT_VIDEO_MODEL,
        device: str = 'cuda',
        torch_dtype: str = 'float16',
    ) -> None:
        self.model_name = model_name
        self.device = device
        self.torch_dtype_name = torch_dtype
        self._pipe: Any = None
        self._thumb_pipe: Any = None
        self._actual_model_name: Optional[str] = None
        self._actual_thumb_model_name: Optional[str] = None
        self.available: bool = True
        self.thumb_available: bool = True

    # ----- private loaders ------------------------------------------------
    def _resolve_torch_dtype(self) -> Any:
        import torch
        return getattr(torch, self.torch_dtype_name, torch.float16)

    def _load_video_pipe(self) -> Any:
        """Load the video pipeline (Wan2.1 → LTX-Video fallback)."""
        if self._pipe is not None:
            return self._pipe
        _ensure_pip_packages(['diffusers', 'transformers', 'accelerate', 'torch'])
        import torch
        from diffusers import DiffusionPipeline
        dtype = self._resolve_torch_dtype()
        last_err: Optional[Exception] = None
        for model in (self.model_name, FALLBACK_VIDEO_MODEL):
            if not model:
                continue
            try:
                print(f"[ai_video_gen] Loading video model: {model} ({dtype})")
                pipe = DiffusionPipeline.from_pretrained(model, torch_dtype=dtype)
                pipe.to(self.device)
                for opt in ('enable_model_cpu_offload', 'enable_vae_slicing'):
                    try:
                        getattr(pipe, opt)()
                    except Exception:
                        pass
                self._pipe = pipe
                self._actual_model_name = model
                print(f"[ai_video_gen] Loaded video model: {model}")
                return pipe
            except Exception as e:
                last_err = e
                print(f"[ai_video_gen] Failed to load {model}: {e}")
                self._pipe = None
                self._actual_model_name = None
                _gpu_collect()
        self.available = False
        raise RuntimeError(
            f"Could not load any video pipeline "
            f"(tried {self.model_name}, {FALLBACK_VIDEO_MODEL}); last error: {last_err}"
        )

    def _load_thumb_pipe(self) -> Any:
        """Load the thumbnail pipeline (FLUX-schnell preferred; else Wan2.1)."""
        if self._thumb_pipe is not None:
            return self._thumb_pipe
        _ensure_pip_packages(['diffusers', 'transformers', 'accelerate', 'torch'])
        import torch
        from diffusers import DiffusionPipeline
        dtype = self._resolve_torch_dtype()
        try:
            print(f"[ai_video_gen] Loading thumb model: {DEFAULT_THUMB_MODEL}")
            pipe = DiffusionPipeline.from_pretrained(
                DEFAULT_THUMB_MODEL, torch_dtype=dtype,
            )
            pipe.to(self.device)
            try:
                pipe.enable_model_cpu_offload()
            except Exception:
                pass
            self._thumb_pipe = pipe
            self._actual_thumb_model_name = DEFAULT_THUMB_MODEL
            print(f"[ai_video_gen] Loaded thumb model: {DEFAULT_THUMB_MODEL}")
            return pipe
        except Exception as e:
            print(f"[ai_video_gen] FLUX-schnell unavailable ({e}); "
                  "thumbnails will use first frame of Wan2.1 video.")
            self._thumb_pipe = None
            self._actual_thumb_model_name = None
            self.thumb_available = False
            return self._load_video_pipe()

    # ----- public API -----------------------------------------------------
    def generate_b_roll(
        self,
        prompt: str,
        duration_sec: float = 5.0,
        resolution: Tuple[int, int] = (1280, 720),
        num_inference_steps: int = 25,
        negative_prompt: str = DEFAULT_NEGATIVE_PROMPT,
        fps: int = 24,
    ) -> str:
        """Generate a short B-roll clip from a text prompt.

        Returns:
            Path to /tmp/micky_generated/broll_<hash>.mp4.
        """
        pipe = self._load_video_pipe()
        num_frames = max(8, int(duration_sec * fps))
        if num_frames % 4 != 0:
            num_frames = ((num_frames + 3) // 4) * 4
        w, h = resolution
        print(f"[ai_video_gen] T2V: {prompt[:80]!r} "
              f"({w}x{h}, {num_frames}f, {num_inference_steps} steps)")
        t0 = time.time()
        try:
            kwargs: dict[str, Any] = dict(
                prompt=prompt, negative_prompt=negative_prompt,
                num_frames=num_frames,
                num_inference_steps=num_inference_steps,
                height=h, width=w, guidance_scale=5.0,
            )
            try:
                output = pipe(**kwargs)
            except TypeError:
                kwargs.pop('negative_prompt', None)
                kwargs.pop('guidance_scale', None)
                output = pipe(**kwargs)
        except Exception as e:
            _gpu_collect()
            raise RuntimeError(f"Video generation failed: {e}") from e

        frames = getattr(output, 'frames', None)
        if frames is None and isinstance(output, dict):
            frames = output.get('frames')
        if frames is None:
            raise RuntimeError("Pipeline returned no frames — unexpected shape.")

        out_path = str(OUTPUT_ROOT / f"broll_{_hash_prompt(prompt)}.mp4")
        _frames_to_mp4(frames, out_path, fps=fps)
        print(f"[ai_video_gen] B-roll in {time.time() - t0:.1f}s → {out_path}")
        _gpu_collect()
        return out_path

    def generate_thumbnail(
        self,
        prompt: str,
        resolution: Tuple[int, int] = (1280, 720),
        num_inference_steps: int = 4,
    ) -> str:
        """Generate a single thumbnail image (PNG) from a text prompt.

        Uses FLUX-schnell if available (4-step, ~3s); otherwise runs a
        1-frame Wan2.1 T2V pass and exports the first frame.
        """
        w, h = resolution
        out_path = str(OUTPUT_ROOT / f"thumb_{_hash_prompt(prompt)}.png")
        t0 = time.time()
        if self._thumb_pipe is None and self.thumb_available:
            try:
                self._load_thumb_pipe()
            except Exception as e:
                print(f"[ai_video_gen] thumb pipe load failed ({e}); "
                      "will fall back to Wan2.1 first frame.")
                self.thumb_available = False

        if (self._thumb_pipe is not None
                and self._actual_thumb_model_name == DEFAULT_THUMB_MODEL):
            try:
                print(f"[ai_video_gen] FLUX thumb: {prompt[:80]!r} "
                      f"({w}x{h}, {num_inference_steps} steps)")
                image = self._thumb_pipe(
                    prompt=prompt, num_inference_steps=num_inference_steps,
                    height=h, width=w,
                ).images[0]
                image.save(out_path)
                print(f"[ai_video_gen] Thumbnail in {time.time() - t0:.1f}s → {out_path}")
                _gpu_collect()
                return out_path
            except Exception as e:
                print(f"[ai_video_gen] FLUX thumb failed ({e}); "
                      "falling back to Wan2.1 first frame.")
                self._thumb_pipe = None
                self._actual_thumb_model_name = None
                self.thumb_available = False
                _gpu_collect()

        # Fallback: Wan2.1 first frame
        clip_path = self.generate_b_roll(
            prompt, duration_sec=0.5, resolution=resolution,
            num_inference_steps=max(8, num_inference_steps),
        )
        subprocess.run(
            ['ffmpeg', '-y', '-i', clip_path, '-frames:v', '1', out_path],
            check=True, capture_output=True,
        )
        print(f"[ai_video_gen] Thumbnail (Wan2.1 first-frame) "
              f"in {time.time() - t0:.1f}s → {out_path}")
        _gpu_collect()
        return out_path

    def generate_cutaway(
        self,
        prompt: str,
        context_frame: Optional[str] = None,
        duration_sec: float = 3.0,
        resolution: Tuple[int, int] = (1280, 720),
    ) -> str:
        """Generate a cutaway clip — image-to-video if context_frame given.

        When ``context_frame`` is provided, attempts Wan2.1-I2V / LTX-Video
        I2V for visually grounded continuation; otherwise text-to-video.
        """
        if context_frame and os.path.exists(context_frame):
            try:
                return self._generate_image_to_video(
                    prompt, context_frame, duration_sec, resolution,
                )
            except Exception as e:
                print(f"[ai_video_gen] I2V failed ({e}); falling back to T2V.")
        return self.generate_b_roll(
            prompt, duration_sec=duration_sec, resolution=resolution,
        )

    def _generate_image_to_video(
        self, prompt: str, context_frame: str,
        duration_sec: float, resolution: Tuple[int, int],
    ) -> str:
        """Image-to-video generation using Wan2.1-I2V / LTX-Video."""
        _ensure_pip_packages(['diffusers', 'transformers', 'accelerate', 'torch'])
        from PIL import Image
        from diffusers import DiffusionPipeline
        dtype = self._resolve_torch_dtype()
        w, h = resolution
        i2v_candidates = [
            'Wan-AI/Wan2.1-I2V-14B-480P',
            'Lightricks/LTX-Video',
        ]
        last_err: Optional[Exception] = None
        for model in i2v_candidates:
            try:
                print(f"[ai_video_gen] Loading I2V model: {model}")
                pipe = DiffusionPipeline.from_pretrained(model, torch_dtype=dtype)
                pipe.to(self.device)
                try:
                    pipe.enable_model_cpu_offload()
                except Exception:
                    pass
                image = Image.open(context_frame).convert('RGB').resize((w, h))
                fps = 24
                num_frames = max(8, int(duration_sec * fps))
                if num_frames % 4 != 0:
                    num_frames = ((num_frames + 3) // 4) * 4
                output = pipe(
                    image=image, prompt=prompt, num_frames=num_frames,
                    num_inference_steps=20, height=h, width=w,
                )
                frames = getattr(output, 'frames', None) or (
                    output.get('frames') if isinstance(output, dict) else None
                )
                if frames is None:
                    raise RuntimeError("I2V pipeline returned no frames.")
                out_path = str(OUTPUT_ROOT / f"broll_{_hash_prompt(prompt)}.mp4")
                _frames_to_mp4(frames, out_path, fps=fps)
                print(f"[ai_video_gen] I2V cutaway → {out_path}")
                del pipe
                _gpu_collect()
                return out_path
            except Exception as e:
                last_err = e
                print(f"[ai_video_gen] I2V model {model} failed: {e}")
                _gpu_collect()
        raise RuntimeError(f"All I2V models failed; last error: {last_err}")

    def batch_generate_b_rolls(
        self, prompts: List[str],
        duration_sec: float = 5.0,
        resolution: Tuple[int, int] = (1280, 720),
    ) -> List[str]:
        """Generate multiple B-roll clips in sequence (GPU memory constraint).

        The pipeline is loaded once and reused; we free GPU memory between
        generations to keep peak VRAM low. Per-prompt failures are skipped.
        """
        out_paths: List[str] = []
        for i, p in enumerate(prompts):
            try:
                print(f"[ai_video_gen] batch B-roll {i + 1}/{len(prompts)}")
                out_paths.append(self.generate_b_roll(
                    p, duration_sec=duration_sec, resolution=resolution,
                ))
            except Exception as e:
                print(f"[ai_video_gen] batch item {i} failed ({e}); skipping.")
                log.warning("batch B-roll %d failed: %s", i, e)
            finally:
                _gpu_collect()
        return out_paths

    # ----- cleanup --------------------------------------------------------
    def cleanup(self) -> None:
        """Release GPU memory and drop loaded pipelines."""
        for attr in ('_pipe', '_thumb_pipe'):
            pipe = getattr(self, attr, None)
            if pipe is not None:
                try:
                    del pipe
                except Exception:
                    pass
                setattr(self, attr, None)
        self._actual_model_name = None
        self._actual_thumb_model_name = None
        _gpu_collect()


# ---------------------------------------------------------------------------
# Module-level frame writer (used by the class + CLI smoke test)
# ---------------------------------------------------------------------------
def _frames_to_mp4(frames: Any, out_path: str, fps: int = 24) -> None:
    """Write a diffusers frames object to MP4 via imageio / ffmpeg."""
    import numpy as np
    if hasattr(frames, 'cpu'):
        frames = frames.cpu().numpy()
    if isinstance(frames, list):
        arr = np.stack([np.asarray(f) for f in frames])
    else:
        arr = np.asarray(frames)
    if arr.ndim == 4 and arr.shape[1] in (1, 3):
        arr = np.transpose(arr, (0, 2, 3, 1))
    if arr.dtype != np.uint8:
        arr = np.clip(arr * 255, 0, 255).astype(np.uint8)

    try:
        import imageio
        writer = imageio.get_writer(
            out_path, fps=fps, codec='libx264',
            quality=8, macro_block_size=16,
        )
        for frame in arr:
            writer.append_data(frame)
        writer.close()
        return
    except ImportError:
        pass
    except Exception as e:
        print(f"[ai_video_gen] imageio write failed ({e}); "
              "falling back to raw ffmpeg.")

    tmp_dir = OUTPUT_ROOT / f"_frames_{os.path.basename(out_path)}"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    from PIL import Image
    for i, frame in enumerate(arr):
        Image.fromarray(frame).save(tmp_dir / f"frame_{i:05d}.png")
    subprocess.run(
        ['ffmpeg', '-y', '-framerate', str(fps),
         '-i', str(tmp_dir / 'frame_%05d.png'),
         '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
         '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
         out_path],
        check=True, capture_output=True,
    )
    shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == '__main__':
    gen = AIVideoGenerator()
    try:
        path = gen.generate_b_roll(
            'a cinematic close-up of a dental microscope '
            'in soft morning light, shallow depth of field',
            duration_sec=3.0,
        )
        print(f"B-roll OK: {path}")
        thumb = gen.generate_thumbnail(
            'dental clinic hero shot, white and teal, professional',
        )
        print(f"Thumbnail OK: {thumb}")
    finally:
        gen.cleanup()
