"""
Take selector v3 (B7) — heuristic + VLM hybrid.
================================================
Composes :class:`TakeSelectorV2` (B1's heuristic, multi-criteria:
audio/speech/length/face/motion/composition) with :class:`VLMScorer`
(Qwen2.5-VL-7B neural re-ranking) for a true two-stage selection:

    1. Heuristic pass over all candidate scenes (CPU, ~6-criteria).
       Over-sample ×3 to leave a wide shortlist for the VLM.
    2. VLM pass that re-ranks the shortlist using 5 visual criteria
       (composition, lighting, facial_expression, visual_interest,
       storytelling).  Output is the final cut + an optional
       :class:`NarrativeArc` (opening / rising / climax / resolution).

If the VLM is unavailable (no GPU, transformers missing, model fails
to download), step 2 silently degrades to a no-op and v3 returns the
heuristic shortlist unchanged.  No caller ever needs to handle an
exception for lack of a GPU.

Created: 2026-11-22  |  Phase P4-T2-v3  (B7)
"""
from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from take_selector_v2 import (  # noqa: E402
    SceneBoundary, Take, TakeSelectorV2, TakeScore,
)
from vlm_scorer import (  # noqa: E402
    VLMScorer, VLMScore, NarrativeArc, attach_vlm_score,
)

log = logging.getLogger(__name__)


class TakeSelectorV3:
    """
    Hybrid take selector: heuristic (B1) + VLM (B7).

    Parameters
    ----------
    scene_detector, silence_trimmer
        B1's Layer-1 / Layer-2 instances.  If ``None``, v3 auto-constructs
        default :class:`SceneDetector` + :class:`SilenceTrimmer` instances
        (imported lazily so missing PySceneDetect / auto-editor never
        blocks v3 startup — the heuristic stage will fail gracefully).
    vlm_scorer
        Optional pre-constructed :class:`VLMScorer`.  If ``None``, v3
        tries to construct one with defaults; if that also fails, v3
        falls back to heuristic-only operation.
    whisper_result
        Whisper transcript dict (with ``segments``).
    vlm_model_name, vlm_device, vlm_dtype
        Forwarded to ``VLMScorer`` if v3 needs to auto-construct one.
    hybrid_weight_vlm
        Weight (0..1) of the VLM score in the final combined score;
        ``(1-hybrid_weight_vlm)`` is the heuristic weight.  Default 0.5.
    """

    def __init__(
        self,
        scene_detector: Any = None,
        silence_trimmer: Any = None,
        vlm_scorer: VLMScorer | None = None,
        whisper_result: dict | None = None,
        vlm_model_name: str | None = None,
        vlm_device: str = 'cuda',
        vlm_dtype: str = 'bfloat16',
        hybrid_weight_vlm: float = 0.5,
    ) -> None:
        self.whisper_result = whisper_result or {}

        # Auto-construct B1's Layer 1 + Layer 2 if the caller didn't pass them.
        if scene_detector is None or silence_trimmer is None:
            scene_detector, silence_trimmer = self._build_default_layers()

        self.scene_detector = scene_detector
        self.silence_trimmer = silence_trimmer

        # Heuristic layer (always available — pure CPU + numpy/OpenCV).
        self.heuristic = TakeSelectorV2(
            scene_detector=scene_detector,
            silence_trimmer=silence_trimmer,
            whisper_result=self.whisper_result,
        )

        # VLM layer (optional).  Either take the passed instance or try
        # to construct one with defaults; either way we never raise.
        self.vlm_scorer: VLMScorer | None
        if vlm_scorer is not None:
            self.vlm_scorer = vlm_scorer
        else:
            try:
                self.vlm_scorer = VLMScorer(
                    model_name=vlm_model_name or 'Qwen/Qwen2.5-VL-7B-Instruct',
                    device=vlm_device,
                    dtype=vlm_dtype,
                )
            except Exception as e:
                log.warning('[TakeSelectorV3] VLMScorer construction failed: %s', e)
                self.vlm_scorer = None

        if self.vlm_scorer is None or not self.vlm_scorer.available:
            log.warning('[TakeSelectorV3] VLM unavailable — heuristic-only mode.')

        self.hybrid_weight_vlm = float(hybrid_weight_vlm)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    @property
    def vlm_available(self) -> bool:
        return bool(self.vlm_scorer and self.vlm_scorer.available)

    def select_best_takes(
        self,
        video_path: str,
        target_count: int = 10,
        over_sample: int = 3,
        min_duration: float = 3.0,
        max_duration: float = 30.0,
    ) -> list[Take]:
        """
        Two-stage selection.

        Stage 1: heuristic returns ``target_count × over_sample`` candidate
        takes (sorted by overall heuristic score, descending).

        Stage 2: VLM re-scores each candidate using up to N sampled frames
        (re-using B1's pre-extracted middle frame when available).  The
        top ``target_count`` by combined score are returned,
        chronologically ordered.  If VLM is unavailable, the heuristic
        shortlist is returned as-is (trimmed to ``target_count``).
        """
        if not os.path.exists(video_path):
            raise FileNotFoundError(video_path)

        # ---- Stage 1: heuristic shortlist ------------------------------
        pool_size = max(target_count, target_count * over_sample)
        log.info('[TakeSelectorV3] Stage 1: heuristic selection '
                 '(pool=%d, over_sample=%d)', pool_size, over_sample)
        try:
            shortlist = self.heuristic.select_best_takes(
                video_path,
                target_count=pool_size,
                min_duration=min_duration,
                max_duration=max_duration,
            )
        except Exception as e:
            log.exception('[TakeSelectorV3] heuristic failed (%s) — '
                          'falling back to single-take', e)
            from vlm_scorer import _  # noqa: F401  (ensures import side-effect)
            # Return a single fake Take covering the whole video.
            try:
                total = _probe_video_duration(video_path)
            except Exception:
                total = 0.0
            ts = TakeScore(overall=0.5, audio_rms=0.0, speech_density=0.0,
                           length_score=0.0, face_score=0.0, motion_score=0.0,
                           composition_score=0.0)
            return [Take(path=video_path, start=0.0, end=total,
                        score=ts, scene_idx=0)]

        log.info('[TakeSelectorV3] Heuristic returned %d candidates',
                 len(shortlist))

        # ---- Stage 2: VLM re-rank --------------------------------------
        if not self.vlm_available:
            log.info('[TakeSelectorV3] Stage 2 skipped (VLM unavailable)')
            return self._trim(shortlist, target_count)

        log.info('[TakeSelectorV3] Stage 2: VLM re-rank of %d candidates',
                 len(shortlist))
        try:
            reranked = self._vlm_rerank(shortlist, video_path)
        except Exception as e:
            log.warning('[TakeSelectorV3] VLM re-rank failed (%s) — using '
                        'heuristic order', e)
            reranked = shortlist

        return self._trim(reranked, target_count)

    def select_with_narrative(
        self,
        video_path: str,
        target_count: int = 10,
    ) -> NarrativeArc:
        """
        Run :meth:`select_best_takes` then attach narrative roles.

        Returns a :class:`NarrativeArc` whose ``opening`` / ``rising`` /
        ``climax`` / ``resolution`` fields reference the actual Take
        objects.  ``arc_confidence`` is 0 if the VLM was unavailable.
        """
        takes = self.select_best_takes(video_path, target_count=target_count)
        if self.vlm_scorer is None:
            arc = NarrativeArc(arc_confidence=0.0)
            if takes:
                arc.opening = takes[0]
                arc.climax = max(takes, key=lambda t: t.score.overall)
                arc.resolution = takes[-1]
                arc.rising = [t for t in takes
                              if t is not arc.opening and t is not arc.climax]
            return arc
        return self.vlm_scorer.analyze_narrative_arc(takes)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------
    @staticmethod
    def _build_default_layers() -> tuple[Any, Any]:
        """Construct default SceneDetector + SilenceTrimmer if missing.

        Lazy imports so v3 stays importable even when scenedetect or
        auto-editor is not installed.
        """
        try:
            from scene_detector import SceneDetector
        except Exception as e:
            log.warning('[TakeSelectorV3] SceneDetector import failed: %s', e)
            SceneDetector = None  # type: ignore[assignment]
        try:
            from silence_trimmer import SilenceTrimmer
        except Exception as e:
            log.warning('[TakeSelectorV3] SilenceTrimmer import failed: %s', e)
            SilenceTrimmer = None  # type: ignore[assignment]

        sd = SceneDetector() if SceneDetector else None
        st = SilenceTrimmer() if SilenceTrimmer else None
        return sd, st

    def _vlm_rerank(self, takes: list[Take], video_path: str) -> list[Take]:
        """Score each Take with the VLM and return a new sorted list.

        The combined score replaces ``take.score.overall`` so that the
        downstream trim/sort logic operates on the hybrid number.  The
        original heuristic scores are preserved on ``take.score``'s
        per-criterion fields.
        """
        assert self.vlm_scorer is not None
        w_vlm = self.hybrid_weight_vlm
        w_heur = 1.0 - w_vlm

        for t in takes:
            try:
                # Build a SceneBoundary that the VLM scorer understands.
                # B1's Take has .start / .end (floats, seconds).
                scene = SceneBoundary(
                    start_sec=t.start, end_sec=t.end,
                    frame_count=max(1, int((t.end - t.start) * 30.0)),
                )
                v: VLMScore = self.vlm_scorer.score_take(
                    video_path, scene,
                    sample_count=3,
                    preextracted_frame=t.frame_path,  # reuse B1's PNG if present
                )
                attach_vlm_score(t, v)
                # Hybrid overall: 50% heuristic + 50% (vlm/10).
                hybrid = w_heur * t.score.overall + w_vlm * (v.overall / 10.0)
                t.score.overall = round(hybrid, 4)   # mutate in place
                t.reason = (  # type: ignore[attr-defined]
                    f'heur={t.score.overall:.2f} vlm={v.overall:.1f}/10 '
                    f'({v.reasoning[:40]})'
                )
            except Exception as e:
                log.warning('[TakeSelectorV3] VLM score failed for scene '
                            '%.1f-%.1fs (%s) — keeping heuristic score',
                            t.start, t.end, e)
        # Sort by combined score descending; final caller re-orders by time.
        return sorted(takes, key=lambda t: t.score.overall, reverse=True)

    @staticmethod
    def _trim(takes: list[Take], target_count: int) -> list[Take]:
        """Take top-N by score, then re-order chronologically + re-rank."""
        top = sorted(takes, key=lambda t: t.score.overall, reverse=True)
        top = top[:target_count]
        top.sort(key=lambda t: t.start)
        for i, t in enumerate(top):
            t.rank = i + 1  # type: ignore[attr-defined]
        return top

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------
    def cleanup(self) -> None:
        """Release the VLM (and GPU memory) if it was loaded."""
        if self.vlm_scorer is not None:
            try:
                self.vlm_scorer.cleanup()
            except Exception as e:
                log.warning('[TakeSelectorV3] VLM cleanup failed: %s', e)

    def __del__(self) -> None:
        try:
            self.cleanup()
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Serialisation helpers (used by pipeline.py + tests)
    # ------------------------------------------------------------------
    @staticmethod
    def takes_to_json(takes: list[Take], path: str) -> None:
        """Write the take list to ``path`` as JSON."""
        out = []
        for t in takes:
            d = t.to_dict()
            vlm = getattr(t, 'vlm_score', None)
            if vlm is not None:
                d['vlm_score'] = vlm
            out.append(d)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(out, f, indent=2, ensure_ascii=False, default=str)

    @staticmethod
    def narrative_to_json(arc: NarrativeArc, path: str) -> None:
        """Write a :class:`NarrativeArc` to ``path`` as JSON."""
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(arc.to_dict(), f, indent=2,
                      ensure_ascii=False, default=str)


# ---------------------------------------------------------------------------
# Helper for pipeline.py — returns the path of the selected "best takes" video
# ---------------------------------------------------------------------------
def _probe_video_duration(video_path: str) -> float:
    """ffprobe-based duration lookup (seconds; 0.0 on failure)."""
    import subprocess
    try:
        r = subprocess.run(
            ['ffprobe', '-v', 'error',
             '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1',
             video_path],
            capture_output=True, text=True, check=True,
        )
        return float(r.stdout.strip() or 0.0)
    except Exception:
        return 0.0


def _concat_takes(takes: list[Take], output_path: str) -> str:
    """ffmpeg concat the [start,end] ranges of ``takes`` into one MP4."""
    import subprocess
    if not takes:
        return ''
    if len(takes) == 1:
        # Single take — just trim it.
        t = takes[0]
        cmd = ['ffmpeg', '-y', '-ss', f'{t.start:.3f}', '-to', f'{t.end:.3f}',
               '-i', t.path, '-c', 'copy', output_path]
        subprocess.run(cmd, capture_output=True, check=True)
        return output_path

    # Multi-take — write a concat list of trimmed segments.
    list_path = str(Path(output_path).with_suffix('.txt'))
    part_paths: list[str] = []
    with open(list_path, 'w', encoding='utf-8') as f:
        for i, t in enumerate(takes):
            part = str(Path(output_path).with_suffix(f'.part{i:02d}.mp4'))
            cmd = ['ffmpeg', '-y', '-ss', f'{t.start:.3f}',
                   '-to', f'{t.end:.3f}',
                   '-i', t.path, '-c', 'copy', part]
            try:
                subprocess.run(cmd, capture_output=True, check=True)
            except subprocess.CalledProcessError as e:
                log.warning('[take_selector_v3] trim failed for part %d (%s)',
                            i, (e.stderr or '')[-200:])
                continue
            f.write(f"file '{os.path.basename(part)}'\n")
            part_paths.append(part)

    # Concat the parts.
    cmd = ['ffmpeg', '-y', '-f', 'concat', '-safe', '0',
           '-i', list_path, '-c', 'copy', output_path]
    subprocess.run(cmd, capture_output=True, check=True)

    # Cleanup parts.
    for p in part_paths:
        try:
            os.remove(p)
        except OSError:
            pass
    try:
        os.remove(list_path)
    except OSError:
        pass
    return output_path


def select_best_takes(
    video_path: str,
    whisper_result: dict | None = None,
    output_dir: str | None = None,
    target_count: int = 10,
    use_vlm: bool = True,
    return_takes: bool = False,
    **vlm_kwargs: Any,
) -> Any:
    """
    Drop-in replacement for ``take_selector.select_best_takes`` that uses
    the v3 hybrid pipeline.

    Pipeline.py uses the **string-path** contract: this function returns
    the path to the concatenated best-takes MP4 (or the input video path
    when only one take is selected).  Pass ``return_takes=True`` to also
    get the underlying list of :class:`Take` objects (used by tests and
    by the narrative-arc API).

    Args:
        video_path: Path to the source video.
        whisper_result: Optional Whisper transcript dict.
        output_dir: Where to write ``takes_v3.json`` and the concatenated
            output. Defaults to ``<video_dir>/takes``.
        target_count: Number of takes to return (default 10).
        use_vlm: If True (default), try to use the VLM.  If the VLM
            fails to load, falls back to heuristic only.
        return_takes: If True, returns ``(video_path, list[Take])``.
        **vlm_kwargs: Optional VLMScorer kwargs (``vlm_model_name``,
            ``vlm_device``, ``vlm_dtype``, ``hybrid_weight_vlm``).

    Returns:
        By default: ``str`` — path to the selected-takes MP4.
        If ``return_takes=True``: ``tuple[str, list[Take]]``.
    """
    if output_dir is None:
        output_dir = str(Path(video_path).parent / 'takes')
    os.makedirs(output_dir, exist_ok=True)

    sel = TakeSelectorV3(
        whisper_result=whisper_result or {},
        vlm_model_name=vlm_kwargs.pop('vlm_model_name', None),
        vlm_device=vlm_kwargs.pop('vlm_device', 'cuda'),
        vlm_dtype=vlm_kwargs.pop('vlm_dtype', 'bfloat16'),
        hybrid_weight_vlm=vlm_kwargs.pop('hybrid_weight_vlm', 0.5),
    )
    if not use_vlm:
        sel.vlm_scorer = None

    try:
        takes = sel.select_best_takes(video_path, target_count=target_count)
        # Persist takes_v3.json side-by-side with the output.
        out_json = os.path.join(output_dir, 'takes_v3.json')
        TakeSelectorV3.takes_to_json(takes, out_json)
        log.info('[take_selector_v3] Wrote %d takes → %s', len(takes), out_json)

        # Concatenate (or copy) the selected takes into a single MP4.
        stem = Path(video_path).stem
        concat_path = os.path.join(output_dir, f'{stem}_best_takes.mp4')
        if not takes:
            log.warning('[take_selector_v3] no takes selected — using input')
            result_path = video_path
        else:
            try:
                result_path = _concat_takes(takes, concat_path)
                if not result_path or not os.path.exists(result_path):
                    result_path = video_path
            except Exception as e:
                log.warning('[take_selector_v3] concat failed (%s) — using input', e)
                result_path = video_path

        if return_takes:
            return result_path, takes
        return result_path
    finally:
        sel.cleanup()


# ---------------------------------------------------------------------------
# CLI smoke test
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    import argparse

    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s [%(levelname)s] %(name)s — %(message)s',
    )

    p = argparse.ArgumentParser(description='TakeSelectorV3 (heuristic + VLM)')
    p.add_argument('video', help='Path to source video')
    p.add_argument('--transcript', default=None,
                   help='Optional transcript.json from Whisper')
    p.add_argument('--target-count', type=int, default=10)
    p.add_argument('--no-vlm', action='store_true',
                   help='Disable VLM and use heuristic only')
    p.add_argument('--narrative', action='store_true',
                   help='Also print NarrativeArc analysis')
    p.add_argument('--vlm-model', default='Qwen/Qwen2.5-VL-7B-Instruct')
    p.add_argument('--vlm-device', default='cuda')
    p.add_argument('--vlm-dtype', default='bfloat16')
    p.add_argument('--output-dir', default=None)
    args = p.parse_args()

    whisper_result: dict = {}
    if args.transcript and os.path.exists(args.transcript):
        with open(args.transcript, 'r', encoding='utf-8') as f:
            whisper_result = json.load(f)

    out_path, takes = select_best_takes(
        args.video,
        whisper_result=whisper_result,
        output_dir=args.output_dir,
        target_count=args.target_count,
        use_vlm=not args.no_vlm,
        return_takes=True,
        vlm_model_name=args.vlm_model,
        vlm_device=args.vlm_device,
        vlm_dtype=args.vlm_dtype,
    )

    print(f'\n→ Output video: {out_path}')
    print(f'→ {len(takes)} best takes:')
    for t in takes:
        vlm = getattr(t, 'vlm_score', None)
        vlm_s = f'{vlm:.1f}/10' if vlm is not None else '–'
        print(f'  rank={getattr(t, "rank", "?")}  '
              f'{t.start:6.1f}-{t.end:6.1f}s  '
              f'overall={t.score.overall:.3f}  vlm={vlm_s}')

    if args.narrative:
        sel = TakeSelectorV3(
            whisper_result=whisper_result,
            vlm_model_name=args.vlm_model,
            vlm_device=args.vlm_device,
            vlm_dtype=args.vlm_dtype,
        )
        if args.no_vlm:
            sel.vlm_scorer = None
        try:
            arc = sel.select_with_narrative(args.video,
                                             target_count=args.target_count)
            print('\n=== Narrative arc ===')
            print(json.dumps(arc.to_dict(), indent=2, ensure_ascii=False,
                             default=str))
        finally:
            sel.cleanup()
