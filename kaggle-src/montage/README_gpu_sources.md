# GPU Compute Sources — Three-Tier Strategy (B9)

Micky Assistant uses a layered GPU strategy that maximises **free** compute
and falls back gracefully when any single source is unavailable.

| Tier | Source           | GPU                  | VRAM   | Cost            | Limit            | Best for                                        |
| ---- | ---------------- | -------------------- | ------ | --------------- | ---------------- | ----------------------------------------------- |
| 1    | **Kaggle**       | P100 / T4 ×2         | 16 GB  | **$0**          | 30 h/wk, 2 sess. | Primary montage pipeline, WhisperX, RVM, SDXL  |
| 2    | **HF Spaces ZeroGPU** | RTX Pro 6000    | 96 GB  | **$0**          | Queue-based      | Big-model VLM (Qwen2.5-VL-72B), video gen       |
| 3    | **Modal**        | Any (T4 → H100)       | 16–80  | $30/mo credits  | Credits/mo       | Async batch (100+ parallel jobs), burst capacity |

## 1. When to use each

### Tier 1 — Kaggle (primary, always on)

Kaggle is the default. Every montage task starts here via
`dispatchToKaggle(env, task)`. The kernel pulls the seven montage modules
from `mickystudio/micky-infra`, runs the pipeline, and POSTs the result
back to the Worker webhook.

- **30 h/wk** free GPU budget — enough for ~60 montage jobs/week.
- **2 concurrent sessions** — fine for normal user load.
- **12 h hard session cap** — long batches must split or move to Modal.

### Tier 2 — HF Spaces ZeroGPU (free, queue-based, 96 GB)

Use HF Spaces when:

1. The Kaggle 16 GB GPU cannot fit the model
   (Qwen2.5-VL-72B needs ~48 GB, Qwen-Video ~80 GB).
2. Kaggle sessions are exhausted (30 h/wk hit).
3. The task is single-shot (VLM scoring of 5 frames, 5-sec video clip).

The ZeroGPU runtime shares a pool of RTX Pro 6000s across all HF Spaces —
a job may queue for several minutes before getting a slot. Polling
cadence is **5 s** (HF rate-limit friendly) with a 30-min timeout.

**Caller pattern (Kaggle kernel):**

```python
from hf_spaces_runner import HFSpacesRunner, HFSpacesUnavailable

try:
    runner = HFSpacesRunner()  # reads HF_TOKEN from env
    out = runner.run_vlm_inference(
        frame_paths=['/kaggle/working/frame_001.jpg', ...],
        prompt="Rate composition, lighting, ...",
    )
    scores = out['scores']  # [8.5, 7.0, ...]
except HFSpacesUnavailable as exc:
    # Fall back to local Qwen2.5-VL-7B on Kaggle T4
    from vlm_scorer import VLMScorer
    scorer = VLMScorer()
    scores = [scorer.score_frame(p).overall for p in frame_paths]
```

**Caller pattern (Cloudflare Worker):**

```typescript
import { dispatchToHFSpaces } from './runners/kaggle_runner';

try {
  const result = await dispatchToHFSpaces(env, 'vlm', {
    images: base64Frames,
    prompt: 'Rate composition, lighting, ...',
  });
  // result.scores = number[], result.reasoning = string
} catch (err) {
  // Fall back to dispatchToKaggle(env, kaggleTaskForVLM)
}
```

### Tier 3 — Modal (serverless, paid, async batch)

Use Modal when:

1. You need to fan-out across 10+ GPUs simultaneously (e.g. scoring
   100 takes in parallel for a long-form video).
2. The job exceeds Kaggle's 12-h session cap.
3. You need an exotic GPU (H100 for diffusion, A100 for big LLMs).

Modal bills per-second at credit rates that vary by GPU ($0.000164/s for
T4, $0.00139/s for A100, $0.00349/s for H100). The $30/mo recurring
free credit covers ~50 T4-hours or ~6 H100-hours per month.

**Caller pattern (Kaggle kernel):**

```python
from modal_runner import ModalRunner, ModalNotConfigured

try:
    runner = ModalRunner(app_name='micky-montage')
    results = runner.run_async_batch(
        'vlm_score_one',
        batch_args=[{'frame': b64_1}, {'frame': b64_2}, ...],
    )
except ModalNotConfigured as exc:
    print(exc.hint)  # surfaces setup instructions in Telegram
    # Fall back to sequential HF Spaces calls
```

## 2. Setup instructions

### 2.1 HF_TOKEN (Tier 2 — HF Spaces)

Already configured for the existing LLM gateway. If you need to refresh:

1. Go to <https://huggingface.co/settings/tokens>.
2. Create a token with **read** access (no write needed for public Spaces).
3. **Worker side:** `wrangler secret put HF_TOKEN`
4. **Kaggle side:** add as a Kaggle User Secret named `HF_TOKEN`.

Optional: `wrangler secret put HF_SPACE_ID` to override the default
Space (`micky151246/micky-llm`).

### 2.2 MODAL_TOKEN_ID + MODAL_TOKEN_SECRET (Tier 3 — Modal)

1. Sign up at <https://modal.com> (Google login works).
2. Go to <https://modal.com/settings/tokens> → **New Token**.
3. Copy the `token_id` (starts with `ak-`) and `token_secret`
   (starts with `as-`).
4. **Worker side:**

   ```bash
   wrangler secret put MODAL_TOKEN_ID       # ak-...
   wrangler secret put MODAL_TOKEN_SECRET   # as-...
   # Optional:
   wrangler secret put MODAL_APP_NAME      # default: micky-montage
   ```

5. **Kaggle side:** add both as Kaggle User Secrets. Then in the kernel:

   ```python
   import os
   os.environ['MODAL_TOKEN_ID']     = UserSecretsClient().get_secret('MODAL_TOKEN_ID')
   os.environ['MODAL_TOKEN_SECRET'] = UserSecretsClient().get_secret('MODAL_TOKEN_SECRET')
   !pip install -q modal
   !modal token new --token-id $MODAL_TOKEN_ID --token-secret $MODAL_TOKEN_SECRET
   ```

6. Verify:

   ```bash
   modal token verify   # prints your workspace name
   ```

## 3. Cost analysis

| Source      | Monthly cost | Cap                  | Setup effort        |
| ----------- | ------------ | -------------------- | ------------------- |
| Kaggle      | $0           | 30 h/wk GPU          | None (existing)     |
| HF Spaces   | $0           | Queue-based, no hard | Add HF_TOKEN (1 min)|
| Modal       | $0–$30       | $30 free credits/mo  | 10 min, optional    |

**Current setup:** $0/month. Kaggle handles 100% of montage traffic; HF
Spaces ZeroGPU is the free overflow for big-model VLM and short video
generation.

**If you add Modal ($0 additional until credits exhausted):** burst
capacity for batch jobs (e.g. scoring 100 takes in parallel takes ~6
T4-minutes = ~$0.06 per batch, well within the $30/mo free tier).

## 4. Graceful degradation matrix

| Source unavailable        | Falls back to                      | Detect via                       |
| ------------------------- | ---------------------------------- | -------------------------------- |
| Kaggle (30 h/wk hit)      | HF Spaces ZeroGPU                  | `dispatchToKaggle` returns 429   |
| HF Spaces (5xx/timeout)   | Kaggle (smaller model)             | `HFSpacesUnavailable` exception  |
| HF Spaces (queue > 5 min) | Modal (paid burst)                 | `HFSpacesUnavailable` (timeout)   |
| Modal (no token)          | HF Spaces (sequential)            | `ModalNotConfigured` exception    |
| Modal (out of credits)    | Kaggle (sequential, slower)       | Modal HTTP 402                    |

## 5. File map

| File                                                              | Side     | Purpose                                   |
| ----------------------------------------------------------------- | -------- | ----------------------------------------- |
| `kaggle-src/montage/hf_spaces_runner.py`                          | Kaggle   | Python client for HF Spaces ZeroGPU       |
| `kaggle-src/montage/modal_runner.py`                              | Kaggle   | Python client for Modal serverless        |
| `worker/src/runners/hf_spaces_client.ts`                          | Worker   | TypeScript client (edge-compatible fetch) |
| `worker/src/runners/kaggle_runner.ts` (extended)                  | Worker   | Adds `dispatchToHFSpaces`, `dispatchToModal` |
| `worker/src/index.ts` (Env extended)                              | Worker   | Adds optional HF_TOKEN, MODAL_* env vars  |
| `kaggle-src/montage/README_gpu_sources.md` (this file)           | Both     | Operator setup guide                      |

## 6. Polling cadence cheat sheet

| Source      | Poll interval | Hard timeout          | Rate-limit risk |
| ----------- | ------------- | --------------------- | --------------- |
| HF Spaces   | 5 s           | 30 min                | Low             |
| Modal       | 2 s           | Per-invocation `timeout_ms` (default 5 min) | None            |
| Kaggle      | 60 s          | 12 h (session cap)    | None            |

---

*Created: 2026-12-01 — Task B9 — Phase P5-T1*
*Maintained by: mickystudio/micky-infra*
