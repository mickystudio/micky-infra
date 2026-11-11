"""
LLM highlight scorer (B3).
=========================
Third layer of take selection. After Whisper transcription (B2) and
heuristic scene-boundary detection (B1), this module asks an LLM to read
each candidate window's transcript and score it on five virality
dimensions replicating OpusClip's approach: hook_strength,
content_value, emotional_intensity, payoff_presence, pacing.

Final ranking blends LLM (60%) with heuristic TakeScore (40%) from B1.

Recursion: calls back into Micky Assistant's *own* OpenAI-compatible
gateway (micky-assistant.cources01.workers.dev/v1/chat/completions)
using the demo BYOK key — same LLM budget the user already pays for.

Robustness:
    - LLM is OPTIONAL. On network error / malformed JSON, gracefully
      degrades to neutral 0.5 scores so the heuristic still ranks.
    - LLM responses are cached to disk (24h TTL) keyed by sha256(prompt).

Created: 2026-11-15  |  Agent B3  |  Phase P4-T3
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

# --- Optional sibling import (B1) — defensive so file is importable standalone
try:  # pragma: no cover
    from take_selector_v2 import SceneBoundary, Take, TakeScore  # type: ignore
    _HAS_B1 = True
except Exception:  # noqa: BLE001
    _HAS_B1 = False

    @dataclass
    class SceneBoundary:  # type: ignore[no-redef]
        start_sec: float = 0.0
        end_sec: float = 0.0
        confidence: float = 0.0
        scene_idx: int = 0

    Take = dict  # B1's Take dataclass — we only read .start_sec/.end_sec/.score
    TakeScore = dict  # B1's TakeScore — we only read .overall

# --- Public dataclasses --------------------------------------------------------
@dataclass
class CandidateWindow:
    """Duration-filtered slice of the video built from one or more scenes."""
    start_sec: float
    end_sec: float
    duration_sec: float
    transcript_text: str
    scene_indices: List[int] = field(default_factory=list)

@dataclass
class HighlightScore:
    """One LLM-issued score row, mapped back to a candidate window."""
    window_idx: int
    hook_strength: float
    content_value: float
    emotional_intensity: float
    payoff_presence: float
    pacing: float
    overall: float
    reasoning: str = ""

@dataclass
class Highlight:
    """Final ranked take, ready for the renderer / caption generator."""
    start_sec: float
    end_sec: float
    score: float
    transcript_excerpt: str
    hook_text: str = ""
    reason: str = ""
    scene_indices: List[int] = field(default_factory=list)

# --- Constants ----------------------------------------------------------------
DEFAULT_ENDPOINT = "https://micky-assistant.cources01.workers.dev/v1/chat/completions"
DEFAULT_API_KEY = "micky_demo_byok_key_1234567890abcdefghijklmnop"
DEFAULT_MODEL = "qwen3-32b"
CACHE_TTL_SEC = 24 * 3600  # 24 hours
DEFAULT_CACHE_DIR = "/tmp/micky_llm_cache"

# --- Module-level helpers -----------------------------------------------------
def _clamp01(x: float) -> float:
    try:
        return max(0.0, min(1.0, float(x)))
    except (TypeError, ValueError):
        return 0.5

def _neutral_score(idx: int) -> HighlightScore:
    return HighlightScore(
        window_idx=idx, hook_strength=0.5, content_value=0.5,
        emotional_intensity=0.5, payoff_presence=0.5, pacing=0.5,
        overall=0.5, reasoning="LLM unavailable — neutral fallback",
    )

def _strip_fences(text: str) -> str:
    t = text.strip()
    m = re.match(r"^```(?:json)?\s*\n?(.*?)\n?```$", t, re.DOTALL)
    if m:
        return m.group(1).strip()
    if t.startswith("```"):
        t = t.lstrip("`").lstrip("json").lstrip()
    if t.endswith("```"):
        t = t.rstrip("`").rstrip()
    return t.strip()

def _safe_json_load(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        for opener, closer in (("[", "]"), ("{", "}")):
            s, e = text.find(opener), text.rfind(closer)
            if s != -1 and e != -1 and e > s:
                try:
                    return json.loads(text[s: e + 1])
                except json.JSONDecodeError:
                    continue
        return None

def _f(row: Dict[str, Any], key: str, default: float = 0.5) -> float:
    try:
        return float(row.get(key, default))
    except (TypeError, ValueError):
        return default

def _attr_or_key(obj: Any, attr: str, key: str, default: float = 0.0) -> float:
    if isinstance(obj, dict):
        v = obj.get(key, obj.get(attr, default))
    else:
        v = getattr(obj, attr, getattr(obj, key, default))
    try:
        return float(v)
    except (TypeError, ValueError):
        return float(default)

def _sb_start(sb: Any) -> float:
    # Try start_sec (SceneBoundary), then start (B1's Take), then dict keys.
    if isinstance(sb, dict):
        return float(sb.get("start_sec", sb.get("start", 0.0)))
    return float(getattr(sb, "start_sec", getattr(sb, "start", 0.0)))

def _sb_end(sb: Any) -> float:
    if isinstance(sb, dict):
        return float(sb.get("end_sec", sb.get("end", 0.0)))
    return float(getattr(sb, "end_sec", getattr(sb, "end", 0.0)))

def _sb_idx(sb: Any, i: int) -> int:
    v = sb.get("scene_idx", i) if isinstance(sb, dict) else getattr(sb, "scene_idx", i)
    try:
        return int(v)
    except (TypeError, ValueError):
        return i

def _hs_overall(hs: Any) -> float:
    """Extract the heuristic overall score from a TakeScore / Take / dict.

    Handles B1's Take (which has .score.overall nested), TakeScore (direct
    .overall), and plain dicts (with 'overall' or 'score' keys).
    """
    if isinstance(hs, dict):
        if "overall" in hs:
            return float(hs["overall"])
        if "score" in hs:
            s = hs["score"]
            if isinstance(s, dict):
                return float(s.get("overall", 0.5))
            return float(getattr(s, "overall", 0.5))
        return 0.5
    # B1's Take has .score (TakeScore) with .overall — try that first
    nested = getattr(hs, "score", None)
    if nested is not None and not isinstance(nested, (int, float)):
        return float(getattr(nested, "overall", 0.5))
    return float(getattr(hs, "overall", 0.5))

# --- Scorer -------------------------------------------------------------------
class LLMHighlightScorer:
    """LLM-backed virality scorer.

    Example:
        scorer = LLMHighlightScorer()
        highlights = scorer.score_highlights(whisperx_result, scene_boundaries)
    """

    def __init__(
        self,
        llm_endpoint: Optional[str] = None,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        cache_dir: Optional[str] = None,
        timeout: float = 30.0,
    ) -> None:
        self.llm_endpoint = llm_endpoint or os.environ.get("MICKY_WORKER_URL") or DEFAULT_ENDPOINT
        self.api_key = api_key or os.environ.get("MICKY_BYOK_KEY") or DEFAULT_API_KEY
        self.model = model or DEFAULT_MODEL
        self.timeout = float(timeout)
        self.cache_dir = Path(cache_dir or os.environ.get("MICKY_LLM_CACHE_DIR", DEFAULT_CACHE_DIR))
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        self._requests = None  # lazy import

    # --- Public API -----------------------------------------------------------
    def score_highlights(
        self,
        whisperx_result: Dict[str, Any],
        scene_boundaries: Sequence[Any],
        target_count: int = 10,
        min_duration: float = 30.0,
        max_duration: float = 120.0,
        user_direction: str = "",
        language: str = "ar",
        heuristic_scores: Optional[List[Any]] = None,
        llm_weight: float = 0.6,
    ) -> List[Highlight]:
        """End-to-end scoring pipeline. Returns ranked ``Highlight`` list."""
        candidates = self.build_candidate_windows(
            scene_boundaries, whisperx_result,
            min_duration=min_duration, max_duration=max_duration,
        )
        if not candidates:
            return []
        prompt = self.build_scoring_prompt(
            candidates, user_direction=user_direction, language=language
        )
        try:
            raw = self.call_llm(prompt)
        except Exception as exc:  # noqa: BLE001 — graceful degrade
            print(f"[llm_scorer] LLM call failed: {exc!r} — using neutral scores")
            raw = "[]"
        llm_scores = self.parse_llm_response(raw, candidates)
        return self._rank(llm_scores, candidates, heuristic_scores, llm_weight, target_count)

    # --- Step 1 — build candidate windows ------------------------------------
    def build_candidate_windows(
        self, scene_boundaries: Sequence[Any], whisperx_result: Dict[str, Any],
        min_duration: float = 30.0, max_duration: float = 120.0,
    ) -> List[CandidateWindow]:
        """Walk scenes, merge adjacent ones until each window falls in
        [min_duration, max_duration]. Long single scenes are split."""
        if not scene_boundaries:
            return []
        scenes = sorted(
            ({"start_sec": _sb_start(sb), "end_sec": _sb_end(sb),
              "idx": _sb_idx(sb, i)} for i, sb in enumerate(scene_boundaries)),
            key=lambda s: s["start_sec"],
        )
        windows: List[CandidateWindow] = []
        i, n = 0, len(scenes)
        while i < n:
            j = i
            cur_start, cur_end = scenes[i]["start_sec"], scenes[i]["end_sec"]
            indices = [scenes[i]["idx"]]
            while (cur_end - cur_start) < min_duration and j + 1 < n:
                j += 1
                cur_end = scenes[j]["end_sec"]
                indices.append(scenes[j]["idx"])
            duration = cur_end - cur_start
            # Tail-merge: too short & last scene → fold into previous window
            if duration < min_duration and j + 1 >= n and windows:
                prev = windows[-1]
                prev.end_sec = cur_end
                prev.duration_sec = prev.end_sec - prev.start_sec
                prev.scene_indices.extend(indices)
                prev.transcript_text = self._extract_transcript(
                    whisperx_result, prev.start_sec, prev.end_sec)
                i = j + 1
                continue
            if duration > max_duration:
                for c_start, c_end in self._split_long(cur_start, cur_end, max_duration):
                    windows.append(CandidateWindow(
                        c_start, c_end, c_end - c_start,
                        self._extract_transcript(whisperx_result, c_start, c_end),
                        list(indices)))
            else:
                windows.append(CandidateWindow(
                    cur_start, cur_end, duration,
                    self._extract_transcript(whisperx_result, cur_start, cur_end),
                    list(indices)))
            i = j + 1
        return [w for w in windows if w.transcript_text.strip()]

    @staticmethod
    def _split_long(start: float, end: float, max_dur: float) -> List[tuple]:
        chunks, cur = [], start
        while end - cur > max_dur:
            chunks.append((cur, cur + max_dur))
            cur += max_dur
        if end - cur > 5.0:
            chunks.append((cur, end))
        return chunks

    @staticmethod
    def _extract_transcript(
        whisperx_result: Dict[str, Any], start: float, end: float
    ) -> str:
        """Concatenate WhisperX segment texts that overlap [start, end]."""
        out: List[str] = []
        for seg in whisperx_result.get("segments", []):
            seg_start, seg_end = float(seg.get("start", 0.0)), float(seg.get("end", 0.0))
            if seg_end < start or seg_start > end:
                continue
            txt = (seg.get("text") or "").strip()
            if not txt:
                continue
            speaker = seg.get("speaker")
            out.append(f"[{speaker}] {txt}" if speaker else txt)
        return " ".join(out).strip()

    # --- Step 2 — build LLM prompt --------------------------------------------
    def build_scoring_prompt(
        self, candidate_windows: List[CandidateWindow],
        user_direction: str = "", language: str = "ar",
    ) -> str:
        """Return JSON-string prompt with ``system`` + ``user`` keys."""
        if language == "ar":
            system = (
                "أنت محرر فيديو فيروسي خبير. قيّم كل مقطع من 0 إلى 1 على "
                "المعايير الخمسة: hook_strength (قوة البداية)، "
                "content_value (قيمة المحتوى)، emotional_intensity (الشدة العاطفية)، "
                "payoff_presence (وجود نتيجة مرضية)، pacing (إيقاع الكلام). "
                "أرجع JSON Array يحتوي على عناصر بالشكل: "
                '{"window_idx": int, "hook_strength": float, "content_value": float, '
                '"emotional_intensity": float, "payoff_presence": float, '
                '"pacing": float, "reasoning": str}. لا تضع أي نص خارج JSON.'
            )
            user_header = "فيما يلي نوافذ مرشحة. قيّم كل واحدة على المعايير الخمسة."
            if user_direction:
                user_header += f"\n\nتوجيه المستخدم: {user_direction}"
        else:
            system = (
                "You are a viral video editor. Score each segment 0-1 on "
                "five dimensions: hook_strength, content_value, "
                "emotional_intensity, payoff_presence, pacing. "
                'Return ONLY a JSON array of objects: '
                '{"window_idx": int, "hook_strength": float, '
                '"content_value": float, "emotional_intensity": float, '
                '"payoff_presence": float, "pacing": float, "reasoning": str}. '
                "Do not include any text outside the JSON array."
            )
            user_header = "Below are candidate windows. Score each on the five dimensions."
            if user_direction:
                user_header += f"\n\nUser direction: {user_direction}"
        payload = [
            {"window_idx": i, "start": round(w.start_sec, 2), "end": round(w.end_sec, 2),
             "duration": round(w.duration_sec, 2), "text": w.transcript_text[:2000]}
            for i, w in enumerate(candidate_windows)
        ]
        user_body = user_header + "\n\n" + json.dumps(payload, ensure_ascii=False, indent=2)
        return json.dumps({"system": system, "user": user_body}, ensure_ascii=False)

    # --- Step 3 — call LLM (with 24h disk cache) ------------------------------
    def call_llm(self, prompt: str) -> str:
        """POST prompt to the gateway, return raw text response. Cached 24h."""
        cache_key = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:32]
        cache_path = self.cache_dir / f"{cache_key}.json"
        cached = self._cache_io(cache_path)
        if cached is not None:
            return cached
        if self._requests is None:
            try:
                import requests  # type: ignore
                self._requests = requests
            except ImportError as exc:
                raise RuntimeError(
                    "requests package not installed — run pip install requests"
                ) from exc
        try:
            prompt_obj = json.loads(prompt)
        except Exception:  # noqa: BLE001
            prompt_obj = {"system": "", "user": prompt}
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": prompt_obj.get("system", "")},
                {"role": "user", "content": prompt_obj.get("user", "")},
            ],
            "temperature": 0.3, "max_tokens": 4000,
            "response_format": {"type": "json_object"},
        }
        headers = {"Content-Type": "application/json",
                   "Authorization": f"Bearer {self.api_key}"}
        resp = self._requests.post(
            self.llm_endpoint, headers=headers,
            data=json.dumps(body).encode("utf-8"), timeout=self.timeout,
        )
        if resp.status_code != 200:
            raise RuntimeError(
                f"LLM gateway returned HTTP {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
        choices = data.get("choices") or []
        if not choices:
            raise RuntimeError(f"LLM response had no choices: {data}")
        text = choices[0].get("message", {}).get("content", "")
        self._cache_io(cache_path, text)
        return text

    def _cache_io(self, cache_path: Path, text: Optional[str] = None) -> Optional[str]:
        """Read (text=None) or write (text=str) cache entry. Returns cached
        text on read hit, None on miss/expiry/IO error."""
        try:
            if text is None:
                if not cache_path.exists():
                    return None
                if time.time() - cache_path.stat().st_mtime > CACHE_TTL_SEC:
                    return None
                return cache_path.read_text(encoding="utf-8")
            cache_path.write_text(text, encoding="utf-8")
            return text
        except OSError:
            return None

    # --- Step 4 — parse LLM response -----------------------------------------
    def parse_llm_response(
        self, response: str, candidates: List[CandidateWindow]
    ) -> List[HighlightScore]:
        """Parse LLM JSON into HighlightScore objects.

        Handles bare arrays, ```json fences, object wrappers with a
        ``scores``/``results``/``data`` field, and malformed JSON
        (returns neutral 0.5 scores so the caller can still rank).
        """
        n = len(candidates)
        fallback = [_neutral_score(i) for i in range(n)]
        if not response or not response.strip():
            return fallback
        parsed = _safe_json_load(_strip_fences(response))
        if parsed is None:
            return fallback
        if isinstance(parsed, dict):
            for key in ("scores", "results", "data", "windows"):
                if isinstance(parsed.get(key), list):
                    parsed = parsed[key]
                    break
            else:
                parsed = [parsed]
        if not isinstance(parsed, list):
            return fallback
        out: List[HighlightScore] = []
        for i in range(n):
            row = self._find_row(parsed, i)
            if row is None:
                out.append(_neutral_score(i))
                continue
            out.append(HighlightScore(
                window_idx=i, hook_strength=_clamp01(_f(row, "hook_strength")),
                content_value=_clamp01(_f(row, "content_value")),
                emotional_intensity=_clamp01(_f(row, "emotional_intensity")),
                payoff_presence=_clamp01(_f(row, "payoff_presence")),
                pacing=_clamp01(_f(row, "pacing")),
                # use -1 sentinel so missing overall → recomputed below
                overall=_f(row, "overall", -1.0),
                reasoning=str(row.get("reasoning", ""))[:500],
            ))
        for hs in out:
            if hs.overall < 0:  # missing → recompute from 5 dimensions, then clamp
                hs.overall = _clamp01(round(
                    0.25 * hs.hook_strength + 0.25 * hs.content_value
                    + 0.20 * hs.emotional_intensity + 0.20 * hs.payoff_presence
                    + 0.10 * hs.pacing, 4,
                ))
            else:
                hs.overall = _clamp01(hs.overall)
        while len(out) < n:
            out.append(_neutral_score(len(out)))
        return out[:n]

    @staticmethod
    def _find_row(parsed: List[Any], idx: int) -> Optional[Dict[str, Any]]:
        for r in parsed:
            if isinstance(r, dict) and (
                r.get("window_idx") == idx or r.get("index") == idx
            ):
                return r
        if idx < len(parsed) and isinstance(parsed[idx], dict):
            return parsed[idx]
        return None

    # --- Step 5 — rank (LLM-only or blended) ---------------------------------
    def rank_with_heuristic_blend(
        self, llm_scores: List[HighlightScore], heuristic_scores: List[Any],
        candidates: Optional[List[CandidateWindow]] = None,
        llm_weight: float = 0.6, target_count: int = 10,
    ) -> List[Highlight]:
        """Blend LLM (``llm_weight``) with heuristic (``1 - llm_weight``).

        ``heuristic_scores`` items can be B1 ``TakeScore`` dataclasses or
        plain dicts; we read ``.overall`` / ``["overall"]`` / ``["score"]``.
        """
        return self._rank(
            llm_scores, candidates or [], heuristic_scores, llm_weight, target_count,
        )

    def rank_llm_only(
        self, llm_scores: List[HighlightScore],
        candidates: List[CandidateWindow], target_count: int = 10,
    ) -> List[Highlight]:
        """Rank by LLM score only — used when no heuristic_scores supplied."""
        return self._rank(llm_scores, candidates, None, 1.0, target_count)

    def _rank(
        self, llm_scores: List[HighlightScore], candidates: List[CandidateWindow],
        heuristic_scores: Optional[List[Any]], llm_weight: float,
        target_count: int,
    ) -> List[Highlight]:
        """Unified ranker: blends LLM with heuristic (or LLM-only if no hs)."""
        if not candidates:
            return []
        n = len(candidates)
        if not llm_scores:
            llm_scores = [_neutral_score(i) for i in range(n)]
        h_weight = max(0.0, 1.0 - llm_weight) if heuristic_scores else 0.0
        h_map = self._index_heuristics(heuristic_scores or [], candidates)
        out: List[Highlight] = []
        for i, cand in enumerate(candidates):
            llm_hs = llm_scores[i] if i < len(llm_scores) else _neutral_score(i)
            h_overall = h_map.get(i, 0.5) if heuristic_scores else 0.0
            final = llm_weight * llm_hs.overall + h_weight * h_overall
            out.append(Highlight(
                start_sec=cand.start_sec, end_sec=cand.end_sec,
                score=round(final, 4),
                transcript_excerpt=cand.transcript_text[:280],
                hook_text="",  # filled by HighlightIntegrator.generate_hook_texts
                reason=llm_hs.reasoning,
                scene_indices=list(cand.scene_indices),
            ))
        out.sort(key=lambda h: h.score, reverse=True)
        return out[:target_count]

    @staticmethod
    def _index_heuristics(
        heuristic_scores: List[Any], candidates: List[CandidateWindow]
    ) -> Dict[int, float]:
        """For each candidate, find the heuristic score whose time range
        overlaps most. Returns dict {candidate_idx: heuristic_overall}."""
        out: Dict[int, float] = {}
        for i, cand in enumerate(candidates):
            best_overlap, best_score = 0.0, 0.5
            for hs in heuristic_scores:
                overlap = max(0.0, min(cand.end_sec, _sb_end(hs)) - max(cand.start_sec, _sb_start(hs)))
                if overlap > best_overlap:
                    best_overlap, best_score = overlap, _hs_overall(hs)
            out[i] = best_score
        return out

