# B3 — LLM Highlight Scorer

> **Third layer of take selection.** Reads the WhisperX transcript (B2) and
> scores each candidate window — built from scene boundaries (B1) — on five
> virality dimensions, replicating [OpusClip](https://www.opus.pro/)'s
> scoring approach. The final take list is a blend of heuristic + LLM + VLM
> scores.

## Why an LLM scorer?

Heuristic take selection (B1) is great at identifying *technically clean*
audio (high SNR, good WPM, low pause ratio), but it can't read the
**content**. It will happily pick a beautifully-recorded but boring
explanation over a poorly-recorded but punchy story. The LLM scorer fills
that gap by reading the transcript text and judging whether each window is
actually worth watching.

## The 5 virality dimensions

Each candidate window is scored 0–1 on:

| Dimension              | What it captures                                          |
| ---------------------- | -------------------------------------------------------- |
| `hook_strength`        | Does the opening sentence grab attention?               |
| `content_value`        | Is the information useful / shareable / educational?     |
| `emotional_intensity`  | Does it evoke a feeling (humour, awe, fear, surprise)?  |
| `payoff_presence`      | Is there a satisfying conclusion / punchline / takeaway? |
| `pacing`               | Is the speech tempo watchable (not too slow, no ramble)? |

These dimensions match OpusClip's published "virality score" rubric, which
is itself modelled on retention-curve features (first-3-second hook,
story-arc payoff, etc.).

The `overall` field (if the LLM omits it) is recomputed as:

```
overall = 0.25 * hook_strength + 0.25 * content_value
        + 0.20 * emotional_intensity + 0.20 * payoff_presence
        + 0.10 * pacing
```

## Architecture — three layers of take selection

```
┌─────────────────────────────────────────────────────────────────┐
│                     HighlightIntegrator                         │
│                       (highlight_integration.py)                │
│                                                                  │
│  Layer 1: Heuristic (B1)        Layer 2: LLM (B3)              │
│  ┌────────────────────────┐      ┌────────────────────────┐     │
│  │ TakeSelectorV2.score()│      │ LLMHighlightScorer     │     │
│  │  • SNR                 │      │  • hook_strength        │     │
│  │  • WPM                 │      │  • content_value        │     │
│  │  • Fluency             │      │  • emotional_intensity  │     │
│  │  • Scene boundaries    │      │  • payoff_presence       │     │
│  └───────────┬────────────┘      │  • pacing                │     │
│              │                    └────────────┬──────────┘     │
│              │                                 │                 │
│  Layer 3: VLM (B7)        weights: 0.4 / 0.4 / 0.2              │
│  ┌────────────────────────┐                                    │
│  │ Qwen2.5-VL-7B          │                                    │
│  │  • Visual hook         │                                    │
│  │  • Face/scene motion   │                                    │
│  └───────────┬────────────┘                                    │
│              │                                                  │
│              ▼                                                  │
│  final_score = 0.4·heuristic + 0.4·llm + 0.2·vlm              │
│              │                                                  │
│              ▼                                                  │
│  Top-N Highlight list → renderer / caption generator           │
└─────────────────────────────────────────────────────────────────┘
```

### Blending strategy

| Source present?      | Heuristic weight | LLM weight | VLM weight |
| -------------------- | :--------------: | :--------: | :--------: |
| All three            | 0.4              | 0.4        | 0.2        |
| Heuristic + LLM only | 0.5              | 0.5        | —          |
| Heuristic + VLM only | 0.67             | —          | 0.33       |
| Heuristic only       | 1.0              | —          | —          |
| LLM + VLM only       | —                | 0.67       | 0.33       |
| LLM only             | —                | 1.0        | —          |
| VLM only             | —                | —          | 1.0        |

Weights are normalised so they always sum to 1.0 across the **active**
sources. When no source is available the integrator falls back to neutral
0.5 scores (so the pipeline still produces *some* output).

## Recursion — uses our own gateway

The scorer does **not** call OpenAI. It calls back into Micky Assistant's
**own** OpenAI-compatible gateway:

```
POST https://micky-assistant.cources01.workers.dev/v1/chat/completions
Authorization: Bearer ${MICKY_BYOK_KEY}
Content-Type: application/json

{
  "model": "qwen3-32b",
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user",   "content": "..."}
  ],
  "temperature": 0.3,
  "max_tokens": 4000,
  "response_format": {"type": "json_object"}
}
```

This is the same gateway the user already pays for via the BYOK (Bring Your
Own Key) mechanism. So the montage pipeline (running on Kaggle GPU)
consumes the same budget the user uses for chat — **no third-party OpenAI
bill, no extra cost**.

> **Recursive aspect**: the montage pipeline is itself orchestrated by the
> Cloudflare Worker, which *also* serves the gateway. So the LLM call
> goes Kaggle → Worker → Worker's own /v1/chat/completions → upstream LLM
> provider (Cerebras / Novita / OpenRouter). This self-hosted loop keeps
> everything inside the Micky Assistant account.

### Environment variables

| Variable              | Default                                                          | Purpose                                |
| --------------------- | ---------------------------------------------------------------- | -------------------------------------- |
| `MICKY_WORKER_URL`    | `https://micky-assistant.cources01.workers.dev/v1/chat/completions` | LLM gateway endpoint                  |
| `MICKY_BYOK_KEY`      | `micky_demo_byok_key_1234567890abcdefghijklmnop`                 | BYOK bearer token                      |
| `MICKY_LLM_CACHE_DIR` | `/tmp/micky_llm_cache`                                           | Disk cache directory for LLM responses |

## Public API

### Dataclasses

```python
@dataclass
class CandidateWindow:
    start_sec: float
    end_sec: float
    duration_sec: float
    transcript_text: str
    scene_indices: List[int]

@dataclass
class HighlightScore:
    window_idx: int
    hook_strength: float          # 0..1
    content_value: float          # 0..1
    emotional_intensity: float    # 0..1
    payoff_presence: float        # 0..1
    pacing: float                 # 0..1
    overall: float                # 0..1, recomputed if missing
    reasoning: str                # short LLM explanation

@dataclass
class Highlight:
    start_sec: float
    end_sec: float
    score: float                   # blended final score
    transcript_excerpt: str        # first 280 chars
    hook_text: str                 # punchy ≤10-word title
    reason: str                    # LLM reasoning
    scene_indices: List[int]
```

### `LLMHighlightScorer`

```python
scorer = LLMHighlightScorer(
    llm_endpoint=None,  # falls back to MICKY_WORKER_URL / DEFAULT_ENDPOINT
    api_key=None,       # falls back to MICKY_BYOK_KEY / DEFAULT_API_KEY
    model="qwen3-32b",
)

# End-to-end
highlights: List[Highlight] = scorer.score_highlights(
    whisperx_result=whisperx_dict,
    scene_boundaries=b1_scene_list,
    target_count=10,
    min_duration=30.0,
    max_duration=120.0,
    user_direction="ركّز على حالات الزراعة",  # optional
    language="ar",                               # or "en"
    heuristic_scores=b1_take_scores,            # optional
    llm_weight=0.6,                              # default 60% LLM / 40% heuristic
)

# Or call the individual steps:
candidates = scorer.build_candidate_windows(scenes, whisperx_result)
prompt     = scorer.build_scoring_prompt(candidates, language="ar")
raw        = scorer.call_llm(prompt)              # cached 24h
scores     = scorer.parse_llm_response(raw, candidates)
ranked     = scorer.rank_with_heuristic_blend(scores, b1_scores, candidates)
```

### `HighlightIntegrator`

```python
from highlight_integration import HighlightIntegrator

integrator = HighlightIntegrator(
    scene_detector=b1_scene_detector,    # has .detect_scenes(video_path)
    silence_trimmer=b1_silence_trimmer, # has .trim(video_path) -> [(start, end)]
    llm_scorer=None,                     # auto-creates LLMHighlightScorer()
    vlm_scorer=b7_vlm_scorer,            # has .score(video_path, windows) -> List[float]
)

highlights: List[Highlight] = integrator.select_final_takes(
    video_path="/kaggle/working/input.mp4",
    whisperx_result=wx_dict,
    target_count=10,
)

hooks: List[str] = integrator.generate_hook_texts(highlights)
# ["زراعة الأسنان في 30 ثانية", "لماذا تحتاج تقويم؟", ...]
```

## Robustness / graceful degradation

The scorer is designed to **never crash the pipeline**:

| Failure mode                          | Behaviour                                                   |
| ------------------------------------- | ----------------------------------------------------------- |
| `requests` not installed              | `call_llm` raises; caller catches, uses neutral 0.5 scores   |
| Network error / 5xx from gateway      | Same — neutral fallback                                     |
| LLM returns malformed JSON            | `_safe_json_load` tries regex-extracted JSON; if that fails, neutral fallback |
| LLM returns fewer rows than candidates| Missing rows filled with neutral 0.5                        |
| LLM returns extra rows                | Truncated to candidate count                                |
| LLM omits `overall` field             | Recomputed from 5 dimensions                                |
| `_safe_json_load` returns dict instead of array | Unwraps `scores` / `results` / `data` / `windows` key; if absent, wraps as singleton list |
| Cache directory not writable          | Cache read/write silently skipped                           |
| No `MICKY_BYOK_KEY` set               | Uses demo key (rate-limited)                                |

## Disk cache (24h TTL)

LLM responses are cached to disk to avoid recompute on pipeline reruns:

```
/tmp/micky_llm_cache/
├── a1b2c3d4...json    # sha256(prompt)[:32] → raw LLM text response
├── e5f6a7b8...json
└── ...
```

Cache entries older than 24h are ignored on read (and overwritten on next
write). The cache is keyed by the **prompt** hash, so identical windows
across runs (e.g. re-running the same video with different output formats)
hit the cache for free.

## Fallback when LLM unavailable

If the LLM is completely unreachable (no `requests`, network down, wrong
API key, all-API-keys-exhausted), the integrator transparently drops the
LLM weight and re-weights the remaining sources to sum to 1.0:

```python
# Normal:    0.4 * heuristic + 0.4 * llm + 0.2 * vlm
# LLM down:  0.67 * heuristic + 0.33 * vlm           (or 1.0 * heuristic if no VLM)
# All down:  heuristic-only with neutral 0.5 LLM scores padded
```

The pipeline always produces a ranked `List[Highlight]` — the question is
only *how good* the ranking is.

## Prompt design

### Arabic (default — `language="ar"`)

```
System:
أنت محرر فيديو فيروسي خبير. قيّم كل مقطع من 0 إلى 1 على المعايير الخمسة:
hook_strength (قوة البداية)، content_value (قيمة المحتوى)،
emotional_intensity (الشدة العاطفية)، payoff_presence (وجود نتيجة مرضية)،
pacing (إيقاع الكلام). أرجع JSON Array يحتوي على عناصر بالشكل:
{"window_idx": int, "hook_strength": float, "content_value": float,
 "emotional_intensity": float, "payoff_presence": float,
 "pacing": float, "reasoning": str}. لا تضع أي نص خارج JSON.

User:
فيما يلي نوافذ مرشحة. قيّم كل واحدة على المعايير الخمسة.
[{"window_idx": 0, "start": 0.0, "end": 45.0, "duration": 45.0,
  "text": "مرحبا اليوم سنتحدث عن زراعة الأسنان..."}, ...]
```

### English (`language="en"`)

Same structure, English prompt body. Useful for debugging or non-Arabic
source videos.

## File layout

```
kaggle-src/montage/
├── llm_highlight_scorer.py   # B3 — LLMHighlightScorer + 3 dataclasses
├── highlight_integration.py  # B3 — HighlightIntegrator (B1 + B3 + B7 blend)
├── requirements.txt          # + requests>=2.31
└── README_llm_scorer.md      # this file
```

## Future work

- [ ] **Streaming LLM responses** — currently we wait for the full JSON
  array; for very long videos (>30 windows) this can take 30+ seconds.
  Streaming would let the renderer start while later windows are still
  being scored.
- [ ] **Few-shot examples** — the prompt is zero-shot. Adding 2-3 worked
  examples (Arabic transcript → expected scores) should improve
  consistency on edge cases (very short windows, monologue vs dialogue).
- [ ] **Per-dimension weights** — currently `overall = 0.25·h + 0.25·c +
  0.20·e + 0.20·p + 0.10·pacing`. Make these tunable per content type
  (educational vs entertainment vs clinical).
- [ ] **Cohort caching** — if the same video is processed multiple times
  with different `user_direction` strings, the windows are the same but
  the prompt differs. Consider a per-window cache key (transcript text +
  start/end) that's direction-agnostic.

---

*Created: 2026-11-15 · Agent B3 · Phase P4-T3*
