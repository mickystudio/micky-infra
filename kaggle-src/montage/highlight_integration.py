"""
Highlight integration (B3).
============================
Glue layer that combines:
    - B1 (heuristic): ``scene_detector`` + ``silence_trimmer`` + ``TakeSelectorV2``
    - B3 (LLM):       ``LLMHighlightScorer``
    - B7 (VLM):       optional ``vlm_scorer`` (visual virality)

Final take list is computed by blending the three score sources:

    final_score = 0.4 * heuristic + 0.4 * llm + 0.2 * vlm

When LLM or VLM is unavailable (network down / API key missing / malformed
JSON), the integrator gracefully drops their contribution and reweights
the remaining sources to sum to 1.0.

Also generates punchy hook texts (≤10 words) for each highlight via the
LLM — used as captions / on-screen titles by the renderer.

Created: 2026-11-15  |  Agent B3  |  Phase P4-T3
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional, Sequence

from llm_highlight_scorer import (
    CandidateWindow,
    Highlight,
    HighlightScore,
    LLMHighlightScorer,
)

# Default blend weights — must sum to 1.0 when all three sources are present.
DEFAULT_HEURISTIC_WEIGHT = 0.4
DEFAULT_LLM_WEIGHT = 0.4
DEFAULT_VLM_WEIGHT = 0.2


class HighlightIntegrator:
    """Combines heuristic + LLM + VLM scorers into one ranked take list.

    Args:
        scene_detector: B1 object with a ``detect_scenes(video_path)``
            method returning ``List[SceneBoundary]``.
        silence_trimmer: B1 object with a ``trim(video_path)`` method
            returning a list of non-silent ``[start, end]`` ranges.
        llm_scorer: optional ``LLMHighlightScorer`` instance. If None,
            the integrator tries to instantiate one; if that fails
            (no requests / no API key) the LLM weight is dropped.
        vlm_scorer: optional B7 object with a ``score(video_path,
            windows)`` method returning a list of float scores aligned
            to the windows. None disables VLM.
    """

    def __init__(
        self,
        scene_detector: Any,
        silence_trimmer: Any,
        llm_scorer: Optional[LLMHighlightScorer] = None,
        vlm_scorer: Any = None,
    ) -> None:
        self.scene_detector = scene_detector
        self.silence_trimmer = silence_trimmer
        self.vlm_scorer = vlm_scorer
        # Lazy-init the LLM scorer if not provided
        if llm_scorer is not None:
            self.llm_scorer = llm_scorer
        else:
            try:
                self.llm_scorer = LLMHighlightScorer()
            except Exception as exc:  # noqa: BLE001
                print(f"[integrator] LLM scorer unavailable: {exc!r}")
                self.llm_scorer = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def select_final_takes(
        self,
        video_path: str,
        whisperx_result: Dict[str, Any],
        target_count: int = 10,
        min_duration: float = 30.0,
        max_duration: float = 120.0,
        user_direction: str = "",
        language: str = "ar",
    ) -> List[Highlight]:
        """Run the full three-way scoring pipeline and return top-N."""
        # Step 1 — scene boundaries from B1
        scenes = self._safe_call(self.scene_detector, "detect_scenes", video_path) or []
        if not scenes:
            print("[integrator] no scenes detected — falling back to whole video")
            # Synthesize one scene spanning the whole video using whisper end
            end = self._estimate_duration(whisperx_result)
            scenes = [type("S", (), {"start_sec": 0.0, "end_sec": end, "scene_idx": 0})()]

        # Step 2 — silence-filtered ranges (for masking)
        silence = self._safe_call(self.silence_trimmer, "trim", video_path) or []

        # Step 3 — heuristic scores from B1's TakeSelectorV2
        heuristic_scores = self._get_heuristic_scores(
            video_path, whisperx_result, scenes
        )

        # Step 4 — build candidate windows (reuse B3's window builder so all
        # three score sources rank the same windows)
        candidates = self.llm_scorer.build_candidate_windows(
            scenes, whisperx_result,
            min_duration=min_duration, max_duration=max_duration,
        ) if self.llm_scorer else []
        if not candidates:
            print("[integrator] no candidate windows — empty result")
            return []

        # Step 5 — mask out windows that fall entirely in silence
        candidates = [c for c in candidates if not self._is_silenced(c, silence)]
        if not candidates:
            return []

        # Step 6 — LLM scores
        llm_scores: List[HighlightScore] = []
        if self.llm_scorer:
            prompt = self.llm_scorer.build_scoring_prompt(
                candidates, user_direction=user_direction, language=language
            )
            try:
                raw = self.llm_scorer.call_llm(prompt)
                llm_scores = self.llm_scorer.parse_llm_response(raw, candidates)
            except Exception as exc:  # noqa: BLE001 — graceful degrade
                print(f"[integrator] LLM scoring failed: {exc!r}")
                llm_scores = []

        # Step 7 — VLM scores (B7)
        vlm_scores: List[float] = []
        if self.vlm_scorer:
            try:
                vlm_scores = self.vlm_scorer.score(
                    video_path,
                    [(c.start_sec, c.end_sec) for c in candidates],
                ) or []
            except Exception as exc:  # noqa: BLE001 — graceful degrade
                print(f"[integrator] VLM scoring failed: {exc!r}")
                vlm_scores = []

        # Step 8 — blend and rank
        highlights = self._blend_and_rank(
            candidates, llm_scores, heuristic_scores, vlm_scores, target_count
        )

        # Step 9 — generate hook texts (best-effort, non-blocking)
        if self.llm_scorer and highlights:
            try:
                hooks = self.generate_hook_texts(highlights)
                for h, hook in zip(highlights, hooks):
                    h.hook_text = hook
            except Exception as exc:  # noqa: BLE001
                print(f"[integrator] hook generation failed: {exc!r}")

        return highlights

    # ------------------------------------------------------------------
    # Hook text generation
    # ------------------------------------------------------------------
    def generate_hook_texts(self, highlights: List[Highlight]) -> List[str]:
        """For each highlight, ask the LLM for a punchy hook (≤10 words).

        Returns a list of strings aligned to ``highlights``. On any LLM
        failure, returns an empty hook for each highlight (caller treats
        empty as "no hook" — renderer can fall back to transcript excerpt).
        """
        if not self.llm_scorer or not highlights:
            return ["" for _ in highlights]

        excerpts = [
            {"idx": i, "text": h.transcript_excerpt[:500]}
            for i, h in enumerate(highlights)
        ]
        prompt = self._build_hook_prompt(excerpts)
        try:
            raw = self.llm_scorer.call_llm(prompt)
        except Exception as exc:  # noqa: BLE001
            print(f"[integrator] hook LLM call failed: {exc!r}")
            return ["" for _ in highlights]

        parsed = self._parse_hook_response(raw, len(highlights))
        # Pad if needed
        while len(parsed) < len(highlights):
            parsed.append("")
        return parsed[:len(highlights)]

    @staticmethod
    def _build_hook_prompt(excerpts: List[Dict[str, Any]]) -> str:
        system = (
            "You are a viral video hook writer. For each segment, write a "
            "punchy hook/title of at most 10 words. Return ONLY a JSON array "
            'of objects: {"idx": int, "hook": str}. The hook should make '
            "the viewer want to watch the segment."
        )
        user_body = (
            "Score each segment with a punchy hook:\n\n"
            + json.dumps(excerpts, ensure_ascii=False, indent=2)
        )
        return json.dumps(
            {"system": system, "user": user_body}, ensure_ascii=False
        )

    @staticmethod
    def _parse_hook_response(raw: str, n: int) -> List[str]:
        from llm_highlight_scorer import _safe_json_load, _strip_fences  # reuse
        out: List[str] = []
        parsed = _safe_json_load(_strip_fences(raw or ""))
        if not isinstance(parsed, list):
            return ["" for _ in range(n)]
        for i in range(n):
            row = next(
                (r for r in parsed
                 if isinstance(r, dict) and r.get("idx") == i),
                None,
            )
            if row is None and i < len(parsed) and isinstance(parsed[i], dict):
                row = parsed[i]
            out.append(str(row.get("hook", ""))[:200] if row else "")
        return out

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _get_heuristic_scores(
        self,
        video_path: str,
        whisperx_result: Dict[str, Any],
        scenes: Sequence[Any],
    ) -> List[Any]:
        """Try to invoke B1's TakeSelectorV2.select_best_takes() to get
        heuristic takes (each carrying a TakeScore). Returns [] on any
        failure — the integrator then runs LLM/VLM-only."""
        # B1's TakeSelectorV2 takes (scene_detector, silence_trimmer, whisper)
        # in its __init__ — try to instantiate it with our own deps.
        try:
            import take_selector_v2 as b1  # type: ignore
            selector = b1.TakeSelectorV2(
                scene_detector=self.scene_detector,
                silence_trimmer=self.silence_trimmer,
                whisper_result=whisperx_result,
            )
            # B1's signature: select_best_takes(video_path, target_count,
            # min_duration, max_duration). Use generous bounds so we get all
            # candidates and let our scorer narrow them later.
            takes = selector.select_best_takes(
                video_path, target_count=50,
                min_duration=5.0, max_duration=300.0,
            ) or []
            # Each Take has .start, .end, .score (TakeScore with .overall)
            return takes
        except Exception as exc:  # noqa: BLE001
            print(f"[integrator] heuristic scoring failed: {exc!r}")
            return []

    @staticmethod
    def _blend_and_rank(
        candidates: List[CandidateWindow],
        llm_scores: List[HighlightScore],
        heuristic_scores: List[Any],
        vlm_scores: List[float],
        target_count: int,
    ) -> List[Highlight]:
        """Blend the three sources and return top-N Highlight objects.

        Drops sources whose length doesn't match candidates, then
        re-weights remaining sources to sum to 1.0.
        """
        from llm_highlight_scorer import _neutral_score, _hs_overall, _sb_start, _sb_end

        n = len(candidates)
        # Pad LLM scores to match candidates
        if len(llm_scores) < n:
            llm_scores = list(llm_scores) + [
                _neutral_score(i) for i in range(len(llm_scores), n)
            ]

        # Build heuristic lookup aligned to candidate windows
        h_map: Dict[int, float] = {}
        if heuristic_scores:
            for i, cand in enumerate(candidates):
                best_overlap, best_score = 0.0, 0.5
                for hs in heuristic_scores:
                    overlap = max(
                        0.0, min(cand.end_sec, _sb_end(hs)) - max(cand.start_sec, _sb_start(hs))
                    )
                    if overlap > best_overlap:
                        best_overlap, best_score = overlap, _hs_overall(hs)
                h_map[i] = best_score

        # Determine which sources are available
        has_h = bool(heuristic_scores)
        has_llm = bool(llm_scores)
        has_vlm = bool(vlm_scores) and len(vlm_scores) >= n

        # Normalise weights so they sum to 1.0 across active sources
        w_h = DEFAULT_HEURISTIC_WEIGHT if has_h else 0.0
        w_llm = DEFAULT_LLM_WEIGHT if has_llm else 0.0
        w_vlm = DEFAULT_VLM_WEIGHT if has_vlm else 0.0
        total_w = w_h + w_llm + w_vlm
        if total_w <= 0:
            w_h, w_llm = 0.5, 0.5  # fallback: neutral 0.5 for everything
            has_llm = True  # so the loop below uses llm_scores
            total_w = 1.0
        w_h, w_llm, w_vlm = w_h / total_w, w_llm / total_w, w_vlm / total_w

        out: List[Highlight] = []
        for i, cand in enumerate(candidates):
            llm_hs = llm_scores[i] if i < len(llm_scores) else _neutral_score(i)
            h_overall = h_map.get(i, 0.5) if has_h else 0.0
            v_overall = float(vlm_scores[i]) if has_vlm and i < len(vlm_scores) else 0.0
            final = (
                w_h * h_overall + w_llm * llm_hs.overall + w_vlm * v_overall
            )
            out.append(Highlight(
                start_sec=cand.start_sec, end_sec=cand.end_sec,
                score=round(final, 4),
                transcript_excerpt=cand.transcript_text[:280],
                hook_text="",
                reason=llm_hs.reasoning,
                scene_indices=list(cand.scene_indices),
            ))
        out.sort(key=lambda h: h.score, reverse=True)
        return out[:target_count]

    @staticmethod
    def _safe_call(obj: Any, method_name: str, *args, **kwargs) -> Any:
        if obj is None:
            return None
        method = getattr(obj, method_name, None)
        if method is None or not callable(method):
            return None
        try:
            return method(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001
            print(f"[integrator] {method_name}() failed: {exc!r}")
            return None

    @staticmethod
    def _is_silenced(window: CandidateWindow, silence_ranges: Sequence[Any]) -> bool:
        """True if the window falls entirely inside one of the silence ranges."""
        if not silence_ranges:
            return False
        for sr in silence_ranges:
            if isinstance(sr, (list, tuple)) and len(sr) >= 2:
                s_start, s_end = float(sr[0]), float(sr[1])
            elif isinstance(sr, dict):
                s_start, s_end = float(sr.get("start", 0)), float(sr.get("end", 0))
            else:
                continue
            if window.start_sec >= s_start and window.end_sec <= s_end:
                return True
        return False

    @staticmethod
    def _estimate_duration(whisperx_result: Dict[str, Any]) -> float:
        """Fallback: estimate video duration from WhisperX segment end times."""
        segs = whisperx_result.get("segments", [])
        if not segs:
            return 60.0
        return float(segs[-1].get("end", 60.0))


# ---------------------------------------------------------------------------
# CLI smoke test
# ---------------------------------------------------------------------------
if __name__ == "__main__":  # pragma: no cover
    import argparse
    import sys
    p = argparse.ArgumentParser(description="Highlight integrator smoke test")
    p.add_argument("video_path", help="Path to input video")
    p.add_argument("--transcript", help="Path to WhisperX result JSON")
    p.add_argument("--target", type=int, default=5)
    args = p.parse_args()

    # Mock B1 + B7 to demonstrate integration
    class MockSceneDetector:
        def detect_scenes(self, video_path: str):
            from llm_highlight_scorer import SceneBoundary
            # Pretend we have 3 scenes at 0-30, 30-90, 90-150 seconds
            return [
                SceneBoundary(start_sec=0.0, end_sec=30.0, scene_idx=0),
                SceneBoundary(start_sec=30.0, end_sec=90.0, scene_idx=1),
                SceneBoundary(start_sec=90.0, end_sec=150.0, scene_idx=2),
            ]

    class MockSilenceTrimmer:
        def trim(self, video_path: str):
            return []  # no silence

    class MockVLMScorer:
        def score(self, video_path, windows):
            return [0.7] * len(windows)

    integrator = HighlightIntegrator(
        scene_detector=MockSceneDetector(),
        silence_trimmer=MockSilenceTrimmer(),
        vlm_scorer=MockVLMScorer(),
    )
    wx = {}
    if args.transcript and os.path.exists(args.transcript):
        with open(args.transcript, "r", encoding="utf-8") as f:
            wx = json.load(f)
    else:
        wx = {
            "segments": [
                {"start": 0.0, "end": 30.0,
                 "text": "مرحبا، اليوم سنتحدث عن زراعة الأسنان."},
                {"start": 30.0, "end": 90.0,
                 "text": "زراعة الأسنان تتم على عدة مراحل، الأول هو الفحص."},
                {"start": 90.0, "end": 150.0,
                 "text": "النهاية، تذكر أن العناية بالأسنان مهمة جدا."},
            ]
        }
    highlights = integrator.select_final_takes(
        args.video_path, wx, target_count=args.target
    )
    for h in highlights:
        print(f"[{h.start_sec:.1f}-{h.end_sec:.1f}] score={h.score:.3f} "
              f"hook={h.hook_text!r}")
    sys.exit(0)
