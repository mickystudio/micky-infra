"""
Platform adapter (B12) — multi-platform re-framing, pacing & captions.
=====================================================================
Pro editors deliver 2-3 variants and a platform-adapted master per
destination. TikTok wants 9:16 ≤ 60s fast pacing; YouTube wants 16:9
≤ 15min medium pacing; Reels wants 9:16 ≤ 90s.

Re-uses B4's RVM model for smart reframing (alpha matte → subject
centroid) and B3's micky gateway for caption generation. Defensive:
falls back to center-crop / template caption when optional deps are
unavailable.

Created: 2026-11-25  |  Agent B12  |  Phase P4 (T8 + variants)
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from take_selector_v2 import Take  # type: ignore  # noqa: F401
except Exception:  # pragma: no cover

    class Take:  # type: ignore[no-redef]
        path: str
        start: float
        end: float
        scene_idx: int

        def __init__(self, path: str = '', start: float = 0.0,
                     end: float = 0.0, scene_idx: int = 0,
                     score: Any = None, frame_path: Optional[str] = None) -> None:
            self.path, self.start, self.end = path, start, end
            self.scene_idx, self.score, self.frame_path = scene_idx, score, frame_path


# Platform specs (aspect, resolution, max_duration, pacing, fps, v_bitrate, a_bitrate, hashtags, caption_max)
PLATFORM_SPECS: dict[str, dict[str, Any]] = {
    'tiktok':    {'aspect': '9:16', 'resolution': (1080, 1920), 'max_duration': 60,
                  'target_pacing': 'fast', 'fps': 30, 'video_bitrate': '5M',
                  'audio_bitrate': '128k', 'caption_max': 2200,
                  'hashtags': ['#fyp', '#foryou', '#viral', '#dentist', '#dental']},
    'youtube':   {'aspect': '16:9', 'resolution': (1920, 1080), 'max_duration': 900,
                  'target_pacing': 'medium', 'fps': 30, 'video_bitrate': '8M',
                  'audio_bitrate': '192k', 'caption_max': 5000,
                  'hashtags': ['#shorts', '#youtube', '#dentist', '#dentalcare']},
    'reels':     {'aspect': '9:16', 'resolution': (1080, 1920), 'max_duration': 90,
                  'target_pacing': 'fast', 'fps': 30, 'video_bitrate': '4M',
                  'audio_bitrate': '128k', 'caption_max': 2200,
                  'hashtags': ['#reels', '#instagram', '#dentist', '#dentalcare', '#oralhealth']},
    'shorts':    {'aspect': '9:16', 'resolution': (1080, 1920), 'max_duration': 60,
                  'target_pacing': 'fast', 'fps': 60, 'video_bitrate': '6M',
                  'audio_bitrate': '192k', 'caption_max': 1000,
                  'hashtags': ['#shorts', '#youtube', '#dentist', '#dental']},
    'square':    {'aspect': '1:1', 'resolution': (1080, 1080), 'max_duration': 120,
                  'target_pacing': 'medium', 'fps': 30, 'video_bitrate': '4M',
                  'audio_bitrate': '128k', 'caption_max': 2200,
                  'hashtags': ['#instagram', '#dentist', '#dentalcare']},
    'landscape': {'aspect': '16:9', 'resolution': (1920, 1080), 'max_duration': 600,
                  'target_pacing': 'medium', 'fps': 30, 'video_bitrate': '6M',
                  'audio_bitrate': '160k', 'caption_max': 5000,
                  'hashtags': ['#youtube', '#dentist', '#dental']},
}
PACING_INTERVALS: dict[str, Tuple[float, float]] = {
    'fast': (1.0, 2.0), 'medium': (3.0, 5.0), 'slow': (6.0, 10.0),
}

# Micky gateway (same endpoint as B3, OpenAI-compatible, 24h disk cache)
MICKY_GATEWAY_URL = os.environ.get(
    'MICKY_GATEWAY_URL',
    'https://micky-assistant.cources01.workers.dev/v1/chat/completions')
MICKY_GATEWAY_KEY = os.environ.get(
    'MICKY_GATEWAY_KEY',
    'micky_demo_byok_key_1234567890abcdefghijklmnop')
MICKY_GATEWAY_MODEL = os.environ.get('MICKY_GATEWAY_MODEL', 'qwen3-32b')
_LLM_CACHE_DIR = Path('/tmp/micky_llm_cache')
_LLM_CACHE_DIR.mkdir(parents=True, exist_ok=True)
_LLM_CACHE_TTL_SEC = 24 * 3600


class PlatformAdapter:
    """Adapt a master video to a target platform's resolution/aspect/pacing."""

    def __init__(self, platform: str = 'tiktok') -> None:
        if platform not in PLATFORM_SPECS:
            raise ValueError(
                f"Unknown platform '{platform}'. Choose from: {sorted(PLATFORM_SPECS)}")
        self.platform = platform
        self.spec = PLATFORM_SPECS[platform]

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def adapt_video(
        self,
        video_path: str,
        takes: Optional[List[Take]] = None,
        beat_times: Optional[List[float]] = None,
        output_path: Optional[str] = None,
    ) -> str:
        """Re-encode ``video_path`` to this adapter's platform spec.

        Steps: smart reframe → trim (highest-scored takes first) →
        pacing re-cut → final bitrate re-encode.
        """
        if not os.path.exists(video_path):
            raise FileNotFoundError(video_path)
        stem, parent = Path(video_path).stem, Path(video_path).parent
        if output_path is None:
            output_path = str(parent / f'{stem}_{self.platform}.mp4')
        reframed = self.reframe_smart(video_path, self.spec['aspect'])
        src_duration = _probe_duration(reframed)
        max_dur = float(self.spec['max_duration'])
        trimmed = (self._trim_to_duration(reframed, takes, max_dur, src_duration)
                   if src_duration > max_dur else reframed)
        paced = self.adjust_pacing(
            trimmed, self.spec['target_pacing'], beat_times=beat_times)
        w, h = self.spec['resolution']
        fps, vbit, abit = (self.spec['fps'], self.spec['video_bitrate'],
                           self.spec['audio_bitrate'])
        _run_ffmpeg([
            'ffmpeg', '-y', '-i', paced,
            '-vf', (f'scale={w}:{h}:force_original_aspect_ratio=decrease,'
                    f'pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,fps={fps}'),
            '-c:v', 'libx264', '-preset', 'medium',
            '-b:v', vbit, '-maxrate', vbit, '-bufsize', _double_bitrate(vbit),
            '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.0',
            '-c:a', 'aac', '-b:a', abit, '-ar', '48000', '-ac', '2',
            '-movflags', '+faststart', output_path])
        print(f'[platform_adapter] {self.platform}: adapted → {output_path}')
        return output_path

    def reframe_smart(
        self,
        video_path: str,
        target_aspect: str,
        output_path: Optional[str] = None,
    ) -> str:
        """Crop ``video_path`` to ``target_aspect`` ('9:16', '16:9', '1:1').

        Uses RVM alpha matte (preferred) or YuNet face detection; falls
        back to center crop when neither is available.
        """
        if ':' not in target_aspect:
            raise ValueError(f"target_aspect must be 'W:H', got {target_aspect!r}")
        stem, parent = Path(video_path).stem, Path(video_path).parent
        if output_path is None:
            output_path = str(
                parent / f'{stem}_reframed_{target_aspect.replace(":", "x")}.mp4')
        src_w, src_h = _probe_dimensions(video_path)
        cx, cy = _detect_primary_subject_center(video_path)
        crop_w, crop_h, x_off, y_off = _compute_crop_rect(
            src_w, src_h, target_aspect, cx, cy)
        try:
            _run_ffmpeg([
                'ffmpeg', '-y', '-i', video_path,
                '-vf', f'crop={crop_w}:{crop_h}:{x_off}:{y_off}',
                '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
                '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
                '-movflags', '+faststart', output_path])
        except RuntimeError as e:
            print(f'[platform_adapter] reframe_smart failed ({e}); center crop.')
            _run_ffmpeg([
                'ffmpeg', '-y', '-i', video_path,
                '-vf', f'crop={crop_w}:{crop_h}',
                '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
                '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
                output_path])
        print(f'[platform_adapter] reframe_smart({target_aspect}) → {output_path}')
        return output_path

    def adjust_pacing(
        self,
        video_path: str,
        target_pacing: str,
        beat_times: Optional[List[float]] = None,
        output_path: Optional[str] = None,
    ) -> str:
        """Re-cut so average shot length matches pacing (fast/medium/slow).

        fast=1–2s, medium=3–5s, slow=6–10s. With ``beat_times``, cuts
        snap to the nearest beat within ±0.5s.
        """
        if target_pacing not in PACING_INTERVALS:
            raise ValueError(
                f"Unknown pacing '{target_pacing}'. Choose from: {sorted(PACING_INTERVALS)}")
        stem, parent = Path(video_path).stem, Path(video_path).parent
        if output_path is None:
            output_path = str(parent / f'{stem}_paced_{target_pacing}.mp4')
        src_duration = _probe_duration(video_path)
        lo, hi = PACING_INTERVALS[target_pacing]
        avg = (lo + hi) / 2.0
        if src_duration <= avg + 0.5:
            _run_ffmpeg(['ffmpeg', '-y', '-i', video_path, '-c', 'copy',
                         '-movflags', '+faststart', output_path])
            return output_path
        cut_times = self._build_cut_times(src_duration, target_pacing, beat_times)
        if len(cut_times) < 2:
            _run_ffmpeg(['ffmpeg', '-y', '-i', video_path, '-c', 'copy',
                         '-movflags', '+faststart', output_path])
            return output_path
        boundaries = sorted({0.0, *cut_times, src_duration})
        segments = [(boundaries[i], boundaries[i + 1])
                    for i in range(len(boundaries) - 1)
                    if boundaries[i + 1] - boundaries[i] >= 0.2]
        _segment_and_concat(
            video_path, segments, parent / f'{stem}_segments_{target_pacing}',
            output_path, label=f'paced_{target_pacing}')
        print(f'[platform_adapter] adjust_pacing({target_pacing}) → {output_path}')
        return output_path

    def get_platform_metadata(self) -> dict:
        """Return platform spec dict + recommended hashtags."""
        return {
            'platform': self.platform,
            'aspect': self.spec['aspect'],
            'resolution': list(self.spec['resolution']),
            'max_duration': self.spec['max_duration'],
            'target_pacing': self.spec['target_pacing'],
            'fps': self.spec['fps'],
            'video_bitrate': self.spec['video_bitrate'],
            'recommended_hashtags': list(self.spec['hashtags']),
        }

    def generate_caption_for_platform(
        self, transcript: str, platform: Optional[str] = None,
    ) -> str:
        """Generate a platform-tuned caption via the micky LLM gateway.

        Falls back to a deterministic template if the gateway is down.
        """
        plat = platform or self.platform
        if plat not in PLATFORM_SPECS:
            raise ValueError(f"Unknown platform '{plat}'")
        spec = PLATFORM_SPECS[plat]
        transcript_short = (transcript or '').strip()[:1500]
        prompt = self._build_caption_prompt(transcript_short, plat)
        try:
            raw = _call_micky_llm(prompt)
            caption = _extract_caption(raw)
        except Exception as e:
            print(f'[platform_adapter] LLM caption failed ({e}); using template.')
            caption = self._template_caption(transcript_short, plat)
        max_len = int(spec['caption_max'])
        if len(caption) > max_len:
            caption = caption[: max_len - 1] + '…'
        return caption

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------
    def _trim_to_duration(
        self, video_path: str, takes: Optional[List[Take]],
        max_duration: float, src_duration: float,
        output_path: Optional[str] = None,
    ) -> str:
        """Trim to ≤ ``max_duration``; keep top-scored takes when provided."""
        stem, parent = Path(video_path).stem, Path(video_path).parent
        if output_path is None:
            output_path = str(parent / f'{stem}_trimmed.mp4')
        if not takes:
            _run_ffmpeg(['ffmpeg', '-y', '-t', f'{max_duration:.3f}',
                         '-i', video_path, '-c', 'copy',
                         '-movflags', '+faststart', output_path])
            return output_path

        def _score(t: Take) -> float:
            s = getattr(t, 'score', None)
            ov = getattr(s, 'overall', None) if s is not None else None
            if ov is None and isinstance(s, dict):
                ov = s.get('overall', 0.0)
            try:
                return float(ov or 0.0)
            except (TypeError, ValueError):
                return 0.0

        kept: list[Take] = []
        total = 0.0
        for t in sorted(takes, key=_score, reverse=True):
            seg_dur = float(t.end) - float(t.start)
            if seg_dur <= 0:
                continue
            if total + seg_dur > max_duration:
                remaining = max_duration - total
                if remaining > 0.5:
                    kept.append(Take(
                        path=t.path, start=t.start,
                        end=t.start + remaining, scene_idx=t.scene_idx,
                        score=t.score, frame_path=t.frame_path))
                    total += remaining
                break
            kept.append(t)
            total += seg_dur
            if total >= max_duration - 0.1:
                break
        if not kept:
            _run_ffmpeg(['ffmpeg', '-y', '-t', f'{max_duration:.3f}',
                         '-i', video_path, '-c', 'copy',
                         '-movflags', '+faststart', output_path])
            return output_path
        kept.sort(key=lambda t: t.start)
        segments = [(float(t.start), float(t.end)) for t in kept]
        _segment_and_concat(
            video_path, segments, parent / f'{stem}_trim_segs',
            output_path, label=f'trimmed_{total:.1f}s')
        print(f'[platform_adapter] trimmed to {total:.1f}s '
              f'({len(kept)} takes) → {output_path}')
        return output_path

    def _build_cut_times(
        self, duration: float, pacing: str,
        beat_times: Optional[List[float]] = None,
    ) -> List[float]:
        lo, hi = PACING_INTERVALS[pacing]
        avg = (lo + hi) / 2.0
        n_cuts = max(1, int(duration // avg))
        if n_cuts < 2:
            return []
        step = duration / n_cuts
        even_cuts = [round(step * i, 3) for i in range(1, n_cuts)]
        if not beat_times:
            return even_cuts
        beats = sorted(b for b in beat_times if 0.0 < b < duration)
        if not beats:
            return even_cuts
        snapped: list[float] = []
        for c in even_cuts:
            nearest = min(beats, key=lambda b: abs(b - c))
            snapped.append(round(nearest, 3) if abs(nearest - c) <= 0.5 else c)
        return sorted(set(snapped))

    @staticmethod
    def _build_caption_prompt(transcript: str, platform: str) -> str:
        spec = PLATFORM_SPECS[platform]
        n_tags = min(5, len(spec['hashtags']))
        templates = {
            'tiktok': ('You are a TikTok growth strategist. Write a short, '
                       f'punchy caption (≤ 150 chars) with 2-3 emojis and up '
                       f'to {n_tags} hashtags. Reply with ONLY the caption.'),
            'youtube': ('You are a YouTube SEO specialist. Write a description '
                        '(≤ 800 chars) with a hook line, 2-3 short timestamps '
                        'in MM:SS format, and 3-5 SEO keywords as hashtags. '
                        'Reply with ONLY the description text.'),
            'reels': ('You are an Instagram Reels strategist. Write a medium-'
                      f'length caption (≤ 300 chars) with one emoji and up to '
                      f'{n_tags} hashtags. Reply with ONLY the caption text.'),
            'shorts': ('You are a YouTube Shorts strategist. Write a short, '
                       f'punchy caption (≤ 200 chars) with one emoji and up to '
                       f'{n_tags} hashtags. Reply with ONLY the caption text.'),
        }
        system = templates.get(platform, (
            f'Write a {platform} caption (≤ 300 chars) with one emoji and '
            f'up to {n_tags} hashtags. Reply with ONLY the caption.'))
        return json.dumps({
            'system': system,
            'user': (f'Transcript:\n"""\n{transcript}\n"""\n\n'
                     f'Write the {platform} caption now.'),
        }, ensure_ascii=False)

    @staticmethod
    def _template_caption(transcript: str, platform: str) -> str:
        spec = PLATFORM_SPECS[platform]
        tags = ' '.join(spec['hashtags'][:5])
        first_line = (transcript.splitlines() or [''])[0][:80]
        if platform == 'youtube':
            return f'{first_line}\n\n⏱️ Chapters:\n00:00 Intro\n\n{tags}'
        if platform == 'tiktok':
            return f'{first_line} 💫✨\n{tags}'
        return f'{first_line} ✨\n{tags}'


# ---------------------------------------------------------------------------
# Module-level helpers (ffprobe / ffmpeg / face detection / LLM gateway)
# ---------------------------------------------------------------------------
def _probe_duration(video_path: str) -> float:
    try:
        r = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1', video_path],
            capture_output=True, text=True, check=False)
        return float(r.stdout.strip() or 0.0)
    except Exception:
        return 0.0


def _probe_dimensions(video_path: str) -> Tuple[int, int]:
    try:
        r = subprocess.run(
            ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
             '-show_entries', 'stream=width,height',
             '-of', 'json', video_path],
            capture_output=True, text=True, check=False)
        streams = json.loads(r.stdout or '{}').get('streams', [])
        if streams:
            return int(streams[0].get('width', 0)), int(streams[0].get('height', 0))
    except Exception:
        pass
    return 0, 0


def _detect_primary_subject_center(video_path: str) -> Tuple[float, float]:
    """Return (x, y) in [0, 1] for the primary subject / face."""
    for fn in (_detect_subject_via_rvm, _detect_face_yunet):
        try:
            center = fn(video_path)
            if center is not None:
                return center
        except Exception as e:
            print(f'[platform_adapter] {fn.__name__} failed ({e}).')
    return 0.5, 0.5


def _detect_subject_via_rvm(video_path: str) -> Optional[Tuple[float, float]]:
    """Run RVM on the mid frame, return centroid of the alpha matte."""
    try:
        import numpy as np  # type: ignore
        import torch  # type: ignore
        from PIL import Image  # type: ignore
        import torchvision.transforms as T  # type: ignore
        from background_remover import load_rvm_model  # type: ignore
    except ImportError:
        return None
    duration = _probe_duration(video_path)
    tmp_frame = '/tmp/_platform_adapter_mid_frame.png'
    try:
        subprocess.run(
            ['ffmpeg', '-y', '-ss', f'{duration / 2.0:.3f}', '-i', video_path,
             '-frames:v', '1', '-update', '1', tmp_frame],
            capture_output=True, check=True)
    except subprocess.CalledProcessError:
        return None
    if not os.path.exists(tmp_frame):
        return None
    try:
        device = 'cuda' if torch.cuda.is_available() else 'cpu'
        model = load_rvm_model(device=device)
        img = Image.open(tmp_frame).convert('RGB').resize((512, 512))
        src = T.ToTensor()(img).unsqueeze(0).to(device) * 2 - 1
        with torch.inference_mode():
            _, pha, *_ = model(src)
        alpha = pha[0, 0].cpu().numpy()
        mask = alpha > 0.5
        if mask.sum() < 50:
            return None
        ys, xs = np.where(mask)
        return (float(xs.mean() / alpha.shape[1]),
                float(ys.mean() / alpha.shape[0]))
    except Exception:
        return None
    finally:
        try:
            os.remove(tmp_frame)
        except OSError:
            pass


def _detect_face_yunet(video_path: str) -> Optional[Tuple[float, float]]:
    """Detect the largest face in the mid frame using OpenCV YuNet."""
    try:
        import cv2  # type: ignore
    except ImportError:
        return None
    duration = _probe_duration(video_path)
    tmp_frame = '/tmp/_platform_adapter_mid_frame_yunet.png'
    try:
        subprocess.run(
            ['ffmpeg', '-y', '-ss', f'{duration / 2.0:.3f}', '-i', video_path,
             '-frames:v', '1', '-update', '1', tmp_frame],
            capture_output=True, check=True)
    except subprocess.CalledProcessError:
        return None
    if not os.path.exists(tmp_frame):
        return None
    try:
        img = cv2.imread(tmp_frame)
        if img is None:
            return None
        h, w = img.shape[:2]
        yunet_path = '/tmp/micky_cache/face_detection_yunet_2023mar.onnx'
        if os.path.exists(yunet_path):
            detector = cv2.FaceDetectorYN.create(yunet_path, '', (w, h),
                                                  score_threshold=0.5)
        else:
            detector = cv2.FaceDetectorYN.create(
                cv2.data.haarcascades + 'haarcascade_frontalface_default.xml',
                '', (w, h))
        _, faces = detector.detect(img)
        if faces is None or len(faces) == 0:
            return None
        f = max(faces, key=lambda x: float(x[2]) * float(x[3]))
        cx = (float(f[0]) + float(f[2]) / 2.0) / w
        cy = (float(f[1]) + float(f[3]) / 2.0) / h
        return max(0.05, min(0.95, cx)), max(0.05, min(0.95, cy))
    except Exception:
        return None
    finally:
        try:
            os.remove(tmp_frame)
        except OSError:
            pass


def _compute_crop_rect(
    src_w: int, src_h: int, target_aspect: str,
    center_x: float, center_y: float,
) -> Tuple[int, int, int, int]:
    """Compute (crop_w, crop_h, x_off, y_off) for target aspect."""
    if src_w <= 0 or src_h <= 0:
        src_w, src_h = 1080, 1920
    tw, th = (int(x) for x in target_aspect.split(':'))
    target_ratio = tw / th
    if src_w / src_h > target_ratio:
        crop_h = src_h
        crop_w = int(round(crop_h * target_ratio))
    else:
        crop_w = src_w
        crop_h = int(round(crop_w / target_ratio))
    crop_w = max(2, crop_w - (crop_w % 2))
    crop_h = max(2, crop_h - (crop_h % 2))
    cx_px = int(round(center_x * src_w))
    cy_px = int(round(center_y * src_h))
    x_off = max(0, min(cx_px - crop_w // 2, src_w - crop_w))
    y_off = max(0, min(cy_px - crop_h // 2, src_h - crop_h))
    return crop_w, crop_h, x_off, y_off


def _run_ffmpeg(cmd: list[str]) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg failed (exit {result.returncode}):\n"
            f"command: {' '.join(cmd)}\n"
            f"stderr: {result.stderr[-2000:]}")


def _double_bitrate(b: str) -> str:
    """'5M' → '10M', '4500k' → '9000k' (case-insensitive suffix)."""
    try:
        if b and b[-1] in ('M', 'm', 'K', 'k', 'G', 'g'):
            return f'{int(float(b[:-1]) * 2)}{b[-1]}'
        return b
    except (ValueError, IndexError):
        return b


def _segment_and_concat(
    video_path: str,
    segments: List[Tuple[float, float]],
    seg_dir: Path,
    output_path: str,
    label: str = '',
) -> List[str]:
    """Cut ``segments`` out of ``video_path``, concat into ``output_path``."""
    seg_dir.mkdir(parents=True, exist_ok=True)
    for old in seg_dir.glob('*.mp4'):
        try:
            old.unlink()
        except OSError:
            pass
    seg_paths: list[str] = []
    for i, (s, e) in enumerate(segments):
        if e - s < 0.2:
            continue
        seg = str(seg_dir / f'seg_{i:04d}.mp4')
        _run_ffmpeg([
            'ffmpeg', '-y', '-ss', f'{s:.3f}', '-to', f'{e:.3f}',
            '-i', video_path,
            '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
            '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart', seg])
        seg_paths.append(seg)
    if not seg_paths:
        _run_ffmpeg(['ffmpeg', '-y', '-i', video_path, '-c', 'copy',
                     '-movflags', '+faststart', output_path])
        return seg_paths
    concat_filter = ''.join(
        f'[{i}:v:0][{i}:a:0]' for i in range(len(seg_paths))
    ) + f'concat=n={len(seg_paths)}:v=1:a=1[v][a]'
    _run_ffmpeg([
        'ffmpeg', '-y',
        *[_a for s in seg_paths for _a in ('-i', s)],
        '-filter_complex', concat_filter,
        '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart', output_path])
    for s in seg_paths:
        try:
            Path(s).unlink(missing_ok=True)
        except Exception:
            pass
    try:
        seg_dir.rmdir()
    except OSError:
        pass
    if label:
        print(f'[platform_adapter] concat {label}: {len(seg_paths)} segments')
    return seg_paths


def _call_micky_llm(prompt: str, timeout: int = 30) -> str:
    """POST a chat-completions request to the micky gateway. 24h cache."""
    cache_key = hashlib.sha256(prompt.encode('utf-8')).hexdigest()[:32]
    cache_path = _LLM_CACHE_DIR / f'{cache_key}.json'
    try:
        if cache_path.exists() and (
            time.time() - cache_path.stat().st_mtime < _LLM_CACHE_TTL_SEC
        ):
            return cache_path.read_text(encoding='utf-8')
    except OSError:
        pass
    try:
        import requests  # type: ignore
    except ImportError as exc:
        raise RuntimeError('requests package not installed') from exc
    try:
        prompt_obj = json.loads(prompt)
    except Exception:
        prompt_obj = {'system': '', 'user': prompt}
    body = {
        'model': MICKY_GATEWAY_MODEL,
        'messages': [
            {'role': 'system', 'content': prompt_obj.get('system', '')},
            {'role': 'user', 'content': prompt_obj.get('user', '')},
        ],
        'temperature': 0.4, 'max_tokens': 800,
    }
    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {MICKY_GATEWAY_KEY}',
    }
    resp = requests.post(
        MICKY_GATEWAY_URL, headers=headers,
        data=json.dumps(body).encode('utf-8'), timeout=timeout)
    if resp.status_code != 200:
        raise RuntimeError(
            f'LLM gateway returned HTTP {resp.status_code}: {resp.text[:300]}')
    data = resp.json()
    choices = data.get('choices') or []
    if not choices:
        raise RuntimeError(f'LLM response had no choices: {data}')
    text = choices[0].get('message', {}).get('content', '')
    try:
        cache_path.write_text(text, encoding='utf-8')
    except OSError:
        pass
    return text


def _extract_caption(raw: str) -> str:
    """Strip ``` fences / surrounding quotes from an LLM caption response."""
    if not raw:
        return ''
    text = raw.strip()
    if text.startswith('```'):
        lines = text.splitlines()
        if lines and lines[0].startswith('```'):
            lines = lines[1:]
        if lines and lines[-1].strip() == '```':
            lines = lines[:-1]
        text = '\n'.join(lines).strip()
    if (text.startswith('"') and text.endswith('"')) or (
        text.startswith("'") and text.endswith("'")
    ):
        text = text[1:-1]
    return text


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='PlatformAdapter (B12)')
    parser.add_argument('video', help='Source video path')
    parser.add_argument('--platform', default='tiktok',
                        choices=sorted(PLATFORM_SPECS))
    parser.add_argument('--out', default=None, help='Output path')
    args = parser.parse_args()
    adapter = PlatformAdapter(args.platform)
    out = adapter.adapt_video(args.video, output_path=args.out)
    meta = adapter.get_platform_metadata()
    print(json.dumps({'output': out, 'metadata': meta}, indent=2,
                     ensure_ascii=False))
