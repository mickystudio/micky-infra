"""
VLM scorer (B7) — Qwen2.5-VL-7B visual re-ranking for take selection.
====================================================================
Wraps Alibaba's Qwen2.5-VL-7B-Instruct (Apache-2.0) to provide a true
visual-understanding layer on top of the heuristic TakeSelectorV2 (B1).

Capabilities:
    - score_frame(frame_path)       : per-criterion 1-10 scores
    - score_take(video_path, scene) : weighted aggregate over N frames
    - select_best_takes_vlm(...)    : re-rank heuristic shortlist
    - analyze_narrative_arc(takes)  : opening / rising / climax / resolution

The scorer is **fully optional**.  If CUDA / transformers / model is
unavailable, every public method returns a neutral mid-score (5.0/10)
plus a ``reasoning`` string.  The pipeline never crashes for lack of GPU.

Cache: per-frame scores persist to ``~/.cache/micky/vlm/<sha1>.json``
(24h TTL) — re-running on the same video is free.

Note: ``Take`` / ``SceneBoundary`` are re-exported from B1's
``take_selector_v2`` so that v3 can operate on the same data shape that
the heuristic pass produced.  VLM-only fields (``vlm_score``, ``reason``,
``rank``) are attached dynamically to Take instances; B1's dataclass is
non-frozen so this is safe.

Created: 2026-11-22  |  Phase P4-T2-v3  (B7)
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from take_selector_v2 import SceneBoundary, Take  # noqa: E402  (B1's API)

log = logging.getLogger(__name__)

# Constants ----------------------------------------------------------------
DEFAULT_MODEL = 'Qwen/Qwen2.5-VL-7B-Instruct'
DEFAULT_CRITERIA: list[str] = [
    'composition', 'lighting', 'facial_expression',
    'visual_interest', 'storytelling',
]
CACHE_TTL_SECONDS = 24 * 60 * 60
DEFAULT_CACHE_DIR = Path(
    os.environ.get('MICKY_VLM_CACHE',
                   str(Path.home() / '.cache' / 'micky' / 'vlm'))
)

PROMPT_TEMPLATE = (
    "You are a cinematic video editor rating a single video frame on a "
    "1-10 scale across five criteria. Be concise and honest. "
    "Criteria: composition (framing, rule-of-thirds, balance), "
    "lighting (exposure, contrast, mood), facial_expression (emotion, "
    "engagement, clarity), visual_interest (does the frame hold attention?), "
    "storytelling (does it convey narrative?). "
    "Return ONLY a JSON object, no prose. Example format:\n"
    '{"composition": 7, "lighting": 8, "facial_expression": 6, '
    '"visual_interest": 7, "storytelling": 6, "reasoning": "one short sentence"}'
)


# Data classes -------------------------------------------------------------
@dataclass
class VLMScore:
    """Per-criterion VLM scores (1-10 scale) + overall + free-form reasoning."""
    composition: float = 5.0
    lighting: float = 5.0
    facial_expression: float = 5.0
    visual_interest: float = 5.0
    storytelling: float = 5.0
    overall: float = 5.0
    reasoning: str = ''

    def __post_init__(self) -> None:
        if self.overall <= 0:
            self.overall = round(
                (self.composition + self.lighting + self.facial_expression
                 + self.visual_interest + self.storytelling) / 5.0, 2,
            )

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class NarrativeArc:
    """4-act narrative structure assigned to a chronological take list."""
    opening: Take | None = None
    rising: list[Take] = field(default_factory=list)
    climax: Take | None = None
    resolution: Take | None = None
    arc_confidence: float = 0.0

    def to_dict(self) -> dict:
        """JSON-friendly view (avoids serialising the full Take dataclass)."""
        def _t(t: Take | None) -> dict | None:
            if t is None:
                return None
            d = {
                'start': t.start, 'end': t.end,
                'scene_idx': t.scene_idx,
                'frame_path': t.frame_path,
                'heuristic_score': t.score.overall,
            }
            vlm = getattr(t, 'vlm_score', None)
            if vlm is not None:
                d['vlm_score'] = vlm
            return d
        return {
            'opening': _t(self.opening),
            'rising': [_t(t) for t in self.rising],
            'climax': _t(self.climax),
            'resolution': _t(self.resolution),
            'arc_confidence': self.arc_confidence,
        }


# VLMScorer ----------------------------------------------------------------
class VLMScorer:
    """
    Wrap Qwen2.5-VL-7B-Instruct to score video frames / scenes.

    Construction is lazy & defensive: if torch, transformers, or the
    model itself are unavailable, ``self.available`` becomes ``False``
    and every subsequent call returns a neutral mid-score instead of
    raising.
    """

    def __init__(
        self,
        model_name: str = DEFAULT_MODEL,
        device: str = 'cuda',
        dtype: str = 'bfloat16',
        cache_dir: Path | str | None = None,
        auto_install: bool = True,
    ) -> None:
        self.model_name = model_name
        self.device = device
        self.dtype_str = dtype
        self.cache_dir = Path(cache_dir or DEFAULT_CACHE_DIR)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

        self.model = None
        self.processor = None
        self.available: bool = False
        self._failure_reason: str = ''

        self._try_load(auto_install=auto_install)

    # -- Model loading (defensive) ----------------------------------------
    def _try_load(self, auto_install: bool = True) -> None:
        """Attempt to load the VLM; set self.available=False on failure."""
        try:
            import torch  # type: ignore  # noqa: F401
        except ImportError:
            self._failure_reason = 'torch not installed'
            log.warning('[VLMScorer] torch missing — VLM disabled')
            return

        if self.device == 'cuda' and not self._cuda_available():
            self._failure_reason = 'CUDA not available on this host'
            log.warning('[VLMScorer] %s — VLM disabled', self._failure_reason)
            return

        try:
            from transformers import (  # type: ignore
                Qwen2VLForConditionalGeneration, AutoProcessor,
            )
        except ImportError:
            pkgs = ['transformers>=4.45', 'qwen-vl-utils>=0.0.8', 'accelerate>=0.34']
            if not auto_install or not self._pip_install(pkgs):
                self._failure_reason = 'transformers>=4.45 missing'
                log.warning('[VLMScorer] %s', self._failure_reason)
                return
            try:
                from transformers import (  # type: ignore
                    Qwen2VLForConditionalGeneration, AutoProcessor,
                )
            except ImportError as e:
                self._failure_reason = f'transformers still missing: {e}'
                log.warning('[VLMScorer] %s', self._failure_reason)
                return

        try:
            import torch  # type: ignore
            dtype_map = {'bfloat16': torch.bfloat16, 'float16': torch.float16,
                         'float32': torch.float32}
            torch_dtype = dtype_map.get(self.dtype_str, torch.bfloat16)
            log.info('[VLMScorer] Loading %s (dtype=%s, device_map=auto)…',
                     self.model_name, self.dtype_str)
            self.model = Qwen2VLForConditionalGeneration.from_pretrained(
                self.model_name, torch_dtype=torch_dtype,
                device_map='auto', trust_remote_code=True,
            )
            self.model.eval()
            self.processor = AutoProcessor.from_pretrained(
                self.model_name, trust_remote_code=True,
            )
            self.available = True
            log.info('[VLMScorer] Ready. VRAM ≈ %d MB',
                     int(self.model.get_memory_footprint() / 1024 / 1024))
        except Exception as e:
            self._failure_reason = f'model load failed: {e!r}'
            log.exception('[VLMScorer] %s', self._failure_reason)
            self.model = None
            self.processor = None
            self.available = False

    @staticmethod
    def _cuda_available() -> bool:
        try:
            import torch  # type: ignore
            return bool(torch.cuda.is_available())
        except Exception:
            return False

    @staticmethod
    def _pip_install(packages: list[str]) -> bool:
        try:
            subprocess.check_call(
                [sys.executable, '-m', 'pip', 'install', '-q', *packages])
            return True
        except Exception as e:
            log.warning('[VLMScorer] pip install failed (%s): %s', packages, e)
            return False

    # -- Frame scoring ---------------------------------------------------
    def score_frame(
        self,
        frame_path: str,
        criteria: list[str] | None = None,
    ) -> VLMScore:
        """Score a single still frame on the requested criteria (1-10)."""
        criteria = criteria or DEFAULT_CRITERIA
        cache_key = self._cache_key(frame_path, criteria)
        cached = self._cache_get(cache_key)
        if cached is not None:
            return VLMScore(**cached)

        if not self.available:
            neutral = VLMScore(reasoning=f'vlm-unavailable: {self._failure_reason}')
            self._cache_set(cache_key, neutral.to_dict())
            return neutral

        if not os.path.exists(frame_path):
            raise FileNotFoundError(frame_path)

        try:
            import torch  # type: ignore
            from qwen_vl_utils import process_vision_info  # type: ignore

            messages = [{
                'role': 'user',
                'content': [
                    {'type': 'image',
                     'image': f'file://{os.path.abspath(frame_path)}'},
                    {'type': 'text', 'text': PROMPT_TEMPLATE},
                ],
            }]
            text = self.processor.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True,
            )
            image_inputs, video_inputs = process_vision_info(messages)
            inputs = self.processor(
                text=[text], images=image_inputs, videos=video_inputs,
                padding=True, return_tensors='pt',
            ).to(self.model.device)

            with torch.inference_mode():
                out_ids = self.model.generate(**inputs, max_new_tokens=200)
            trimmed = out_ids[:, inputs.input_ids.shape[1]:]
            raw = self.processor.batch_decode(
                trimmed, skip_special_tokens=True,
                clean_up_tokenization_spaces=True,
            )[0]

            score = self._parse_vlm_response(raw)
            self._cache_set(cache_key, score.to_dict())
            return score
        except Exception as e:
            log.warning('[VLMScorer] score_frame failed (%s) — neutral', e)
            neutral = VLMScore(reasoning=f'vlm-error: {e!r}')
            self._cache_set(cache_key, neutral.to_dict())
            return neutral

    # -- Take (scene) scoring --------------------------------------------
    def score_take(
        self,
        video_path: str,
        scene: SceneBoundary,
        sample_count: int = 3,
        preextracted_frame: str | None = None,
    ) -> VLMScore:
        """Sample N frames across scene; return weighted-aggregate VLMScore.

        Args:
            video_path: Source video (used by ffmpeg when we need to
                extract additional samples).
            scene: B1 ``SceneBoundary`` (uses ``start_sec`` / ``end_sec``).
            sample_count: Total number of frames to sample inside the scene.
            preextracted_frame: If B1 already extracted a middle frame
                (``Take.frame_path``), pass it here — it is reused as
                the middle sample (saves one ffmpeg call) and weighted
                highest.
        """
        duration = getattr(scene, 'duration_sec', None) or 0.0
        if duration <= 0:
            return VLMScore(reasoning='empty-scene')
        if not self.available:
            return VLMScore(reasoning=f'vlm-unavailable: {self._failure_reason}')

        # Reuse B1's pre-extracted middle frame as the most heavily weighted
        # sample (saves an ffmpeg call and guarantees alignment with heuristic).
        middle_frame = preextracted_frame if (preextracted_frame
                                              and os.path.exists(preextracted_frame)) else None
        extra = self._sample_frames(
            video_path,
            start_sec=scene.start_sec,
            end_sec=scene.end_sec,
            sample_count=max(0, sample_count - (1 if middle_frame else 0)),
            skip_middle=bool(middle_frame),
        )
        frame_paths: list[str] = (extra + ([middle_frame] if middle_frame else []))

        if not frame_paths:
            return VLMScore(reasoning='frame-extract-failed')

        n = len(frame_paths)
        # Triangular weight profile centred on the middle sample (so the
        # pre-extracted B1 frame, if present, dominates the aggregate).
        weights = [max(0.1, 1.0 - abs(i - (n - 1) / 2.0) * 0.5) for i in range(n)]
        wsum = sum(weights)

        per: dict[str, float] = {c: 0.0 for c in DEFAULT_CRITERIA}
        reasons: list[str] = []
        for fp, w in zip(frame_paths, weights):
            sc = self.score_frame(fp)
            for c in DEFAULT_CRITERIA:
                per[c] += getattr(sc, c) * w
            if sc.reasoning:
                reasons.append(sc.reasoning)

        agg = VLMScore(
            composition=per['composition'] / wsum,
            lighting=per['lighting'] / wsum,
            facial_expression=per['facial_expression'] / wsum,
            visual_interest=per['visual_interest'] / wsum,
            storytelling=per['storytelling'] / wsum,
            overall=0.0,
            reasoning=' | '.join(reasons[:3]),
        )
        agg.overall = round(
            (agg.composition + agg.lighting + agg.facial_expression
             + agg.visual_interest + agg.storytelling) / 5.0, 2,
        )
        return agg

    # -- Selection --------------------------------------------------------
    def select_best_takes_vlm(
        self,
        video_path: str,
        scenes: list[SceneBoundary],
        target_count: int = 10,
    ) -> list[Take]:
        """Score every scene with the VLM; return the top-N as Take list.

        ``Take`` objects are constructed with a placeholder ``TakeScore``
        (overall = VLM score normalised to 0..1).  ``vlm_score`` and
        ``reason`` are attached dynamically.
        """
        from take_selector_v2 import TakeScore  # local import to avoid cycle
        scored: list[Take] = []
        for idx, sc in enumerate(scenes):
            v = self.score_take(video_path, sc)
            ts = TakeScore(
                overall=round(v.overall / 10.0, 4),   # 0..1 for cross-compat
                audio_rms=0.0, speech_density=0.0, length_score=0.0,
                face_score=0.0, motion_score=0.0, composition_score=0.0,
            )
            take = Take(
                path=video_path,
                start=sc.start_sec,
                end=sc.end_sec,
                score=ts,
                scene_idx=idx,
            )
            # Attach VLM-only attributes dynamically (B1's Take is non-frozen).
            take.vlm_score = v.overall              # type: ignore[attr-defined]
            take.vlm_reasoning = v.reasoning         # type: ignore[attr-defined]
            take.reason = f'vlm={v.overall:.1f}/10'  # type: ignore[attr-defined]
            scored.append(take)

        scored.sort(key=lambda t: getattr(t, 'vlm_score', 0.0), reverse=True)
        top = scored[:target_count]
        top.sort(key=lambda t: t.start)
        for i, t in enumerate(top):
            t.rank = i + 1  # type: ignore[attr-defined]
        return top

    # -- Narrative arc analysis -------------------------------------------
    def analyze_narrative_arc(self, scenes: list[Take]) -> NarrativeArc:
        """
        Identify opening hook / rising action / climax / resolution from a
        chronologically ordered list of Takes.

        Uses ``take.score.overall`` (heuristic, 0..1) and
        ``take.vlm_score`` (1..10, optional, attached by ``select_best_takes_vlm``
        or by ``TakeSelectorV3``).  When ``vlm_score`` is missing the
        heuristic score × 10 is used as a fallback.

        ``arc_confidence`` (0..1) drops if VLM is unavailable or <4 scenes.
        """
        if not scenes:
            return NarrativeArc(arc_confidence=0.0)

        ordered = sorted(scenes, key=lambda t: t.start)

        def s10(t: Take) -> float:
            vlm = getattr(t, 'vlm_score', None)
            if vlm is not None:
                return float(vlm)
            # Fall back to heuristic overall (0..1) × 10.
            try:
                return float(t.score.overall) * 10.0
            except Exception:
                return 5.0

        # storytelling proxy: prefer a VLM reasoning lookup, else s10().
        def storytelling10(t: Take) -> float:
            vlm = getattr(t, 'vlm_breakdown', None)
            if isinstance(vlm, dict) and 'storytelling' in vlm:
                try:
                    return float(vlm['storytelling'])
                except (TypeError, ValueError):
                    pass
            return s10(t)

        first_half = ordered[: max(1, len(ordered) // 2)]
        opening = first_half[0]
        best_first = max(first_half, key=storytelling10)
        if storytelling10(best_first) - storytelling10(opening) >= 1.5:
            opening = best_first

        climax = max(ordered, key=s10)

        last_half = ordered[max(1, len(ordered) // 2):]
        if last_half:
            resolution = max(last_half, key=storytelling10)
            if resolution is climax and len(last_half) > 1:
                # Pick the second-best storytelling take from the last half
                # to avoid duplicating the climax role.
                rest_last = [t for t in last_half if t is not climax]
                if rest_last:
                    resolution = max(rest_last, key=storytelling10)
        else:
            resolution = ordered[-1] if ordered[-1] is not opening else opening

        opening_idx = ordered.index(opening)
        climax_idx = ordered.index(climax)
        if opening_idx < climax_idx:
            rising = ordered[opening_idx + 1: climax_idx]
        else:
            rising = ordered[climax_idx + 1: opening_idx]

        conf = 0.0
        if self.available:
            conf += 0.4
        if len(ordered) >= 4:
            conf += 0.3
        if s10(climax) - s10(opening) >= 1.0:
            conf += 0.3
        return NarrativeArc(
            opening=opening, rising=rising, climax=climax,
            resolution=resolution, arc_confidence=round(min(1.0, conf), 2),
        )

    # -- Frame sampling --------------------------------------------------
    @staticmethod
    def _sample_frames(
        video_path: str,
        start_sec: float,
        end_sec: float,
        sample_count: int,
        skip_middle: bool = False,
    ) -> list[str]:
        """Evenly spaced frames across [start_sec, end_sec] via ffmpeg."""
        duration = end_sec - start_sec
        if sample_count <= 0 or duration <= 0:
            return []
        sample_count = min(sample_count, max(1, int(duration)))
        out_dir = Path(video_path).parent / '_vlm_frames' / Path(video_path).stem
        out_dir.mkdir(parents=True, exist_ok=True)

        if sample_count == 1 and not skip_middle:
            timestamps = [(start_sec + end_sec) / 2.0]
        else:
            step = duration / (sample_count + 1)
            timestamps = [start_sec + step * i for i in range(1, sample_count + 1)]

        paths: list[str] = []
        for i, ts in enumerate(timestamps):
            out_path = str(out_dir / f'frame_{i:02d}_{ts:.2f}.jpg')
            if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
                paths.append(out_path)
                continue
            try:
                subprocess.run(
                    ['ffmpeg', '-y', '-ss', f'{ts:.3f}',
                     '-i', video_path, '-frames:v', '1',
                     '-vf', 'scale=512:-1', '-q:v', '3', out_path],
                    capture_output=True, check=True,
                )
                paths.append(out_path)
            except subprocess.CalledProcessError as e:
                log.warning('[VLMScorer] ffmpeg extract failed @ %ss: %s',
                            ts, (e.stderr or '')[-200:])
        return paths

    # -- VLM output parsing ----------------------------------------------
    @staticmethod
    def _parse_vlm_response(raw: str) -> VLMScore:
        """Tolerant JSON extraction; Qwen2.5-VL usually returns clean JSON."""
        text = raw.strip()
        if text.startswith('```'):
            text = _strip_fence(text)

        try:
            obj = json.loads(text)
        except json.JSONDecodeError:
            obj = _extract_first_json(text)

        if not isinstance(obj, dict):
            return VLMScore(reasoning=f'unparseable: {raw[:120]}')

        def _get(k: str) -> float:
            try:
                return max(1.0, min(10.0, float(obj.get(k, 5.0))))
            except (TypeError, ValueError):
                return 5.0

        return VLMScore(
            composition=_get('composition'),
            lighting=_get('lighting'),
            facial_expression=_get('facial_expression'),
            visual_interest=_get('visual_interest'),
            storytelling=_get('storytelling'),
            overall=0.0,
            reasoning=str(obj.get('reasoning', ''))[:300],
        )

    # -- Disk cache (24h TTL) --------------------------------------------
    def _cache_key(self, frame_path: str, criteria: list[str]) -> str:
        try:
            with open(frame_path, 'rb') as f:
                content_hash = hashlib.sha1(f.read()).hexdigest()[:16]
        except OSError:
            stat = os.stat(frame_path) if os.path.exists(frame_path) else None
            content_hash = f'{(stat.st_size if stat else 0):x}'
        criteria_part = '-'.join(criteria)
        model_part = self.model_name.replace('/', '_').replace('.', '_')
        return f'{model_part}_{content_hash}_{criteria_part}'

    def _cache_get(self, key: str) -> dict | None:
        path = self.cache_dir / f'{key}.json'
        if not path.exists():
            return None
        try:
            if time.time() - path.stat().st_mtime > CACHE_TTL_SECONDS:
                return None
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return None

    def _cache_set(self, key: str, payload: dict) -> None:
        try:
            with open(self.cache_dir / f'{key}.json', 'w', encoding='utf-8') as f:
                json.dump(payload, f, ensure_ascii=False, default=str)
        except Exception as e:
            log.warning('[VLMScorer] cache write failed (%s)', e)

    # -- Cleanup ----------------------------------------------------------
    def cleanup(self) -> None:
        """Release GPU memory. Safe to call multiple times."""
        try:
            if self.model is not None:
                del self.model
                self.model = None
            if self.processor is not None:
                del self.processor
                self.processor = None
            try:
                import torch  # type: ignore
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
            log.info('[VLMScorer] Cleaned up (GPU memory released).')
        except Exception as e:
            log.warning('[VLMScorer] cleanup failed: %s', e)

    def __del__(self) -> None:
        try:
            self.cleanup()
        except Exception:
            pass


# Module-level parsing helpers (kept module-level for testability) ----------
def _strip_fence(text: str) -> str:
    """Remove ```json / ``` fences if present."""
    lines = text.splitlines()
    if lines and lines[0].startswith('```'):
        lines = lines[1:]
    if lines and lines[-1].strip() == '```':
        lines = lines[:-1]
    return '\n'.join(lines).strip()


def _extract_first_json(text: str) -> dict | None:
    """Greedy match for the first {...} block in a free-form string."""
    m = re.search(r'\{.*?\}', text, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


# Helper used by v3 / pipeline.py -----------------------------------------
def attach_vlm_score(take: Take, vlm_score: VLMScore) -> None:
    """Dynamically attach VLM score + breakdown to a B1 ``Take`` instance."""
    take.vlm_score = vlm_score.overall             # type: ignore[attr-defined]
    take.vlm_breakdown = vlm_score.to_dict()        # type: ignore[attr-defined]
    take.vlm_reasoning = vlm_score.reasoning        # type: ignore[attr-defined]
