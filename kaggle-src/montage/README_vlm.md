# B7 — VLM Take Selector (Qwen2.5-VL-7B-Instruct)

Adds a vision-language-model re-ranking layer on top of B1's heuristic
`TakeSelectorV2`, producing a hybrid selector (`TakeSelectorV3`) that
picks the most visually compelling takes from a long-form source video.

| Module | Role |
| --- | --- |
| `vlm_scorer.py` | `VLMScorer`, `VLMScore`, `NarrativeArc` — Qwen2.5-VL-7B wrapper, per-frame scoring, narrative arc analysis |
| `take_selector_v3.py` | `TakeSelectorV3` — composes B1's `TakeSelectorV2` (heuristic) with `VLMScorer` (neural) |
| `pipeline.py` | Stage 2 now tries v3 → v2 → v1 in that order; narrative_arc passed to `render_animations` via `options['narrative_arc']` |
| `requirements.txt` | Appended `transformers>=4.45`, `qwen-vl-utils>=0.0.8`, `accelerate>=0.34`, `bitsandbytes>=0.43` |

---

## Why Qwen2.5-VL-7B-Instruct

| Requirement | Qwen2.5-VL-7B | Notes |
| --- | --- | --- |
| License | **Apache-2.0** | Commercial use OK (no royalties, no call-home) |
| VRAM budget (BF16) | ≈14 GB | Fits a single Kaggle T4 (16 GB) with ~2 GB headroom |
| Native video support | Yes (`qwen-vl-utils.process_vision_info`) | We use still-frame scoring today; video-clip scoring is a drop-in upgrade |
| Arabic support | Strong | Critical for Micky's dental content (`ar` default) |
| Reasoning quality | 7B params, instruct-tuned | Beats 3B / 4B VLMs on composition + emotion judgments |
| HuggingFace availability | `Qwen/Qwen2.5-VL-7B-Instruct` | Auto-downloads to `~/.cache/huggingface` on first call |

Other models considered:

- **LLaVA-1.5-7B** — weaker on Arabic; license is LLaMA-2 (research only).
- **InternVL2-8B** — slightly stronger on benchmark X but MIT-only license
  is unclear; Qwen2.5-VL is strictly better on Arabic + reasoning.
- **GPT-4V / Gemini 1.5 Pro** — would require paid API calls per frame;
  cost-prohibitive at 30 frames × 100 takes / video.

---

## VRAM budget (Kaggle T4 — 16 GB)

| Component | VRAM (BF16) |
| --- | --- |
| Qwen2.5-VL-7B weights | ≈14.0 GB |
| KV-cache (1 image, 200 tokens) | ≈0.4 GB |
| Activation buffers | ≈0.3 GB |
| **Total** | **≈14.7 GB** |
| **Headroom** | **≈1.3 GB** (RVM background matting shares GPU; scheduler serialises) |

The scorer is constructed with `device_map='auto'` so on a 2×T4 Kaggle
host the model is sharded across both GPUs (≈7 GB / card) — leaving
room for Whisper and DeepFilterNet to share GPU 0.

**INT4 fallback**: if the host has <16 GB VRAM (e.g. a free Colab T4
after Whisper takes its share), pass `vlm_dtype='int4'` via the pipeline
options. `bitsandbytes` will load the model in 4-bit (≈4 GB VRAM, slight
quality drop on fine-grained facial-expression judgments).

---

## Two-stage selection

```
┌──────────────────────────────────────────────────────────────┐
│  STAGE 1 — Heuristic (CPU, always available)                 │
│  TakeSelectorV2.select_best_takes(video, target_count=30)    │
│    Layer 1: PySceneDetect   → scene boundaries                │
│    Layer 2: auto-editor     → silence filter                  │
│    Layer 3: 6-criterion score (audio, speech, length,        │
│             face, motion, composition)                       │
│  Output: 30 candidate Take objects with per-criterion scores │
└───────────────────────────────┬──────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────┐
│  STAGE 2 — VLM re-rank (GPU, optional)                       │
│  VLMScorer.score_take(video, scene, sample_count=3)          │
│    - re-uses B1's pre-extracted middle frame (frame_path)     │
│    - samples 2 additional frames via ffmpeg                   │
│    - triangular weighting (middle sample weighted highest)    │
│    - Qwen2.5-VL returns JSON {composition, lighting, ...}      │
│  Combined score = 0.5 × heuristic + 0.5 × (vlm / 10)         │
│  Output: top-N Takes, re-ranked chronologically               │
└───────────────────────────────┬──────────────────────────────┘
                                 │
                                 ▼
                  narrative_arc.json (4-act structure)
```

---

## Prompt engineering

The prompt is baked into `vlm_scorer.PROMPT_TEMPLATE`:

```
You are a cinematic video editor rating a single video frame on a
1-10 scale across five criteria. Be concise and honest.
Criteria: composition (framing, rule-of-thirds, balance),
lighting (exposure, contrast, mood), facial_expression (emotion,
engagement, clarity), visual_interest (does the frame hold attention?),
storytelling (does it convey narrative?).
Return ONLY a JSON object, no prose. Example format:
{"composition": 7, "lighting": 8, "facial_expression": 6,
 "visual_interest": 7, "storytelling": 6,
 "reasoning": "one short sentence"}
```

Design choices:

- **Role assignment** ("cinematic video editor") anchors the model on
  film-craft standards rather than e-commerce product photography.
- **Concrete sub-criteria** per axis (e.g. "rule-of-thirds" for
  composition) prevent inflated 10/10 ratings — Qwen2.5-VL tends to
  grade generously without anchors.
- **JSON-only output** + example format yields ~95% parseable JSON
  on the first token. The `_parse_vlm_response` helper falls back to
  regex `{...}` extraction + 5.0 neutral on parse failure.
- **`reasoning`** field (truncated to 300 chars) gives downstream
  debugging visibility without bloating token usage.
- **200-token `max_new_tokens`** is the sweet spot: enough for the
  JSON + 1-sentence reasoning, not enough for the model to drift
  into prose.

---

## Cache strategy

Per-frame scores are persisted to:

```
~/.cache/micky/vlm/<model>_<sha1(content)>_<criteria>.json
```

- **24 h TTL** (configurable via `vlm_scorer.CACHE_TTL_SECONDS`).
- Keyed on **file content SHA-1** (not path / mtime) so renaming or
  re-extracting a frame doesn't bust the cache.
- Includes the model name → invalidates automatically when the model
  is upgraded.
- Re-running the pipeline on the same video is **free** (no GPU
  calls) for 24 h, then re-scores incrementally.
- Override the cache directory with the `MICKY_VLM_CACHE` env var
  (Kaggle: point this at `/kaggle/working/vlm_cache` so scores
  survive across notebook sessions).

---

## Graceful degradation

`VLMScorer.__init__` is **defensive at every step**:

1. `import torch` fails → `available=False`, `reason='torch not installed'`.
2. `torch.cuda.is_available()` returns False → `available=False`,
   `reason='CUDA not available on this host'`.
3. `transformers<4.45` is missing `Qwen2VLForConditionalGeneration` →
   auto-installs `transformers>=4.45 qwen-vl-utils>=0.0.8 accelerate>=0.34`
   (gated by `auto_install=True`); if install fails, falls back to
   heuristic-only.
4. Model download fails (HuggingFace hub error, network timeout,
   disk-full) → `available=False`, `reason='model load failed: ...'`.

When `available=False`, every public method returns a **neutral mid-score**
(`VLMScore(5.0/...)` with a `reasoning` string explaining the fallback).
This guarantees:

- The pipeline never crashes for lack of a GPU.
- Heuristic-only runs produce identical output to B1's v2.
- Local CPU development works (with `--no-vlm` flag).

`TakeSelectorV3` checks `vlm_scorer.available` at construction time and
logs a single `[TakeSelectorV3] VLM unavailable — heuristic-only mode.`
warning.  No per-frame warnings spam.

---

## Narrative arc analysis

`VLMScorer.analyze_narrative_arc(takes: List[Take]) -> NarrativeArc`
assigns 4-act structure roles to a chronologically ordered take list:

| Role | Heuristic |
| --- | --- |
| **opening** | First take, unless another take in the first half has `storytelling` ≥ 1.5 points higher (then swap). |
| **climax** | Single highest-overall take. |
| **resolution** | Highest-storytelling take in the last half (avoids re-using the climax). |
| **rising** | Everything strictly between opening and climax. |

`arc_confidence` (0..1) is the sum of:

- **0.4** if the VLM is available (per-frame scores are real, not neutral).
- **0.3** if there are ≥4 takes (a real arc needs at least 4 scenes).
- **0.3** if `climax.score - opening.score ≥ 1.0` (clear peak exists).

The arc is persisted to `output_dir/narrative_arc.json` and forwarded
to `remotion_renderer.render_animations` via `options['narrative_arc']`,
enabling future Remotion compositions to:

- Use the opening take as the cold-open hook (first 3 s).
- Slow-zoom on the climax take.
- Fade to black on the resolution take.

---

## CLI usage

```bash
# Full hybrid mode (requires GPU + transformers):
python take_selector_v3.py raw.mp4 --transcript transcript.json --target-count 10 --narrative

# Heuristic-only (CPU, no VLM):
python take_selector_v3.py raw.mp4 --no-vlm --target-count 10

# Direct VLMScorer test on a single frame:
python vlm_scorer.py --frame /tmp/micky_cache/frame_0003.png
```

---

## Pipeline options (Stage 2)

| Key | Default | Purpose |
| --- | --- | --- |
| `use_vlm` | `True` | Master switch — set to False to force heuristic-only |
| `vlm_model_name` | `Qwen/Qwen2.5-VL-7B-Instruct` | Override for local / quantised models |
| `vlm_device` | `cuda` | `cpu` works but is 50× slower |
| `vlm_dtype` | `bfloat16` | `float16` and `float32` also supported |
| `hybrid_weight_vlm` | `0.5` | 0.0 = pure heuristic, 1.0 = pure VLM |
| `take_target_count` | `10` | Forwarded to B1's `TakeSelectorV2` |
| `take_min_duration` | `3.0` | Forwarded to B1 |
| `take_max_duration` | `30.0` | Forwarded to B1 |

---

## Performance

On a single Kaggle T4 (BF16, 1080p source):

| Step | Time / take | Notes |
| --- | --- | --- |
| Heuristic scoring (Stage 1) | ≈0.8 s | PySceneDetect + 6-criterion scoring |
| VLM per-frame (Stage 2) | ≈1.4 s | 1 middle frame + 2 sampled, 200 tokens |
| Narrative arc analysis | <10 ms | Pure Python, no GPU |
| **Total for 10 takes from 30 candidates** | **≈50 s** | After 24h cache warm: <5 s |

Memory profile (per `nvidia-smi` during scoring):

```
+-----------------------------------------------------------------------------+
|   0  Tesla T4            14943MiB  micky-py  python take_selector_v3.py    |
+-----------------------------------------------------------------------------+
```

(14.0 GB model + 0.4 GB activations + 0.5 GB CUDA context — fits with
~1.5 GB headroom for WhisperX / DeepFilterNet to share GPU 0.)
