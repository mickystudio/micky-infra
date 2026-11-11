# Storyboard Checkpoint + Rough-Cut Review (Task B11)

Pro-video editors show a **storyboard** (grid of thumbnail stills with
take-level metadata) to the client *before* the final render — so the
client can approve, swap, or trim individual takes without paying the
30-60 min render cost twice. This module brings that workflow to the
Micky Assistant Telegram bot.

---

## Pro workflow

```
┌─────────────┐    ┌──────────────┐    ┌─────────────┐    ┌─────────────┐
│ 1. Upload   │ -> │ 2. Whisper  │ -> │ 3. Take     │ -> │ 4. STORYBOARD│
│    raw MP4  │    │    transcribe│    │    selector │    │    PAUSE     │
└─────────────┘    └──────────────┘    └─────────────┘    └──────┬──────┘
                                                                 │
                                                                 ▼
                                                       ┌─────────────────┐
                                                       │  Bot sends JPG  │
                                                       │  + inline KB    │
                                                       │  (30 min TTL)   │
                                                       └────────┬────────┘
                                                                │
                                       ┌────────────────────────┼────────────────────────┐
                                       ▼                        ▼                        ▼
                                ┌─────────────┐         ┌──────────────┐         ┌──────────────┐
                                │ ✅ Approve  │         │ ✏️ Edit #N    │         │ 🔄 Regenerate│
                                └──────┬──────┘         └──────┬───────┘         └──────┬───────┘
                                       │                       │                        │
                                       ▼                       ▼                        ▼
                                ┌─────────────┐         ┌──────────────┐         ┌──────────────┐
                                │ resume_     │         │ Re-run take  │         │ take_selector│
                                │  pipeline() │         │   selector    │         │  new seed    │
                                │             │         │   (single)   │         │              │
                                │ Stages 3-8  │         └──────┬───────┘         └──────┬───────┘
                                └──────┬──────┘                │                        │
                                       ▼                       ▼                        ▼
                                       └────────────────────► 5. Final render  ◄─────────┘
```

The user gets the storyboard image immediately after take selection
(Stage 2), long before the expensive color grading, caption burning,
and Remotion animation stages kick in. Approving re-runs the pipeline
from Stage 3 onward using the saved pipeline state.

---

## Storyboard image format

| Property         | Value                                                  |
|------------------|--------------------------------------------------------|
| Layout           | 3-column grid (responsive row count)                  |
| Cell size        | 320 × 236 px (16:9 thumbnail + 56 px label band)      |
| Thumbnail        | Middle frame of each take, extracted via FFmpeg       |
| Label            | `#idx · duration · score` (e.g. `#3 · 12.4s · 0.82`) |
| Background       | Dark (#18181C) with gray label band (#282830)         |
| File format      | JPEG (quality 78, optimize=true)                     |
| **Max file size**| **< 500 KB** (auto re-encoded until it fits)         |

The 500 KB budget is enforced by `StoryboardGenerator._enforce_size_budget()`:
if the initial save exceeds 500 KB, it re-encodes at progressively lower
quality (70 → 60 → 50 → 40 → 30) and finally downscales (75% → 60% →
45% → 30% → 15%) until the file fits.

### Hook text

When a `NarrativeArc` is supplied (from the VLM scorer), takes that play
a structural role get tagged in their label:

```
#1 · 8.3s · 0.87  · take #1 · opening
#4 · 12.1s · 0.92 · take #4 · climax
#7 · 5.6s · 0.78  · take #7 · resolution
```

---

## Approval flow (Telegram bot)

### 1. Storyboard delivery

After Stage 2 completes, the Kaggle runner writes:

* `output_dir/storyboard.json` — full storyboard metadata (takes, scores,
  thumbnail paths, base64 thumbnails inline for the bot payload).
* `output_dir/storyboard/storyboard_<hash>.jpg` — the grid image.
* `/tmp/micky_pipeline_state_<hash>.json` — the full pipeline state
  (transcript path, selected video, narrative arc, options) needed for
  `resume_pipeline()`.
* `output_dir/storyboard/thumbnails/thumb_<idx>.jpg` — per-take
  thumbnails (used by the bot for inline previews if the user asks).
* `output_dir/storyboard/previews/preview_<idx>.mp4` — per-take 2-second
  silent preview clips (used for the inline "edit take" preview).

The Kaggle runner POSTs the storyboard JSON to the Worker, which calls
`sendStoryboardForApproval()` — sending the image as a Telegram photo
with this caption:

> 🎬 *Storyboard ready for review!*
>
> 📊 6 takes · total 47.3s
>
> ✅ /approve — approve and start render
> ✏️ /edit <take#> <description> — edit a take
> 🔄 click "Regenerate" to change the seed
>
> _⏳ expires in 30 minutes_

### 2. Inline keyboard

```
┌─────────────────────────────┐
│       ✅ Approve            │
├─────────────────────────────┤
│  ✏️ #1  │  ✏️ #2  │  ✏️ #3   │
├─────────────────────────────┤
│  ✏️ #4  │  ✏️ #5  │  ✏️ #6   │
├─────────────────────────────┤
│  🔄 Regenerate  │  🗑️ Cancel │
└─────────────────────────────┘
```

### 3. Storage

The approval payload is stored in the **LOCKS KV namespace** under
`storyboard:approval:<token>` with a **30-minute TTL**:

```json
{
  "schema": "micky.storyboard.approval.v1",
  "approval_token": "22ea3d05-fa08-42f9-b07d-036a019abf61",
  "chat_id": 123456789,
  "task_id": "task_abc123",
  "pipeline_state_path": "/tmp/micky_pipeline_state_29cda17660b7cc0c.json",
  "storyboard_image_file_id": "AgACAgUAA...",
  "takes": [
    { "idx": 0, "start": 0.0, "end": 8.3, "duration": 8.3, "score": 0.87, ... },
    ...
  ],
  "narrative_arc": { "opening": {...}, "climax": {...}, ... },
  "take_count": 6,
  "created_at": 1731412345,
  "expires_at": 1731414145
}
```

Why KV and not D1? The token expires quickly (30 min), the payload is
large (includes per-take metadata), and KV is already wired up for
short-lived per-chat state (wizard state, etc.). The state file on
Kaggle's side has its own 24h `/tmp` cleanup TTL.

### 4. Approval token security

* Tokens are **UUIDv4** — 122 bits of entropy, unguessable.
* The 30-minute TTL matches Telegram's `getFile` URL expiry buffer.
* Callback queries are validated against `chat_id` — a token leaked to
  another chat is rejected with `chat_id mismatch (token belongs to
  another user)`.
* Token format is validated via regex
  (`/^[A-Fa-f0-9-]{36}$/`) before any KV lookup.

---

## Edit / Regenerate options

### ✏️ Edit take

When the user clicks an `✏️ #N` button (or runs `/edit N <description>`),
the bot:

1. Stores `storyboard:edit_state:<chat_id>` in KV with the token + take
   index (10-min TTL — enough time for the user to type the description).
2. Asks the user what to change (free-text prompt).
3. The next free-text message in that chat is routed to
   `handleStoryboardEdit()` which enqueues a `montage_take_edit` task.
4. The Kaggle runner re-runs Stage 2 with the edit description as a
   prompt constraint (e.g. "make this shorter" → reduce max_duration for
   that scene; "different framing" → re-extract thumbnails).
5. The updated storyboard is re-sent to the chat.

### 🔄 Regenerate

When the user clicks `🔄 Regenerate`, the bot enqueues a
`montage_regenerate_storyboard` task with a new random seed. The Kaggle
runner re-runs Stage 2 only (Whisper transcription is cached in the
state file). The new storyboard replaces the old one and re-uses the
same approval token (TTL is reset).

### 🗑️ Cancel

Clears the KV entries. The state file on Kaggle's `/tmp` will be cleaned
up by its own 24h cron (the bot doesn't have direct FS access).

---

## Pipeline pause / resume

### `run_pipeline()` flow

```
Stage 1 (transcribe)  → Stage 2 (take select)  → B11 STORYBOARD PAUSE
                                                       │
                                          if generate_storyboard:
                                              return {status:'paused_for_approval',
                                                      storyboard: {...},
                                                      pipeline_state_path: '...'}
                                                       │
                                          (else continue to Stage 3-8)
```

### `resume_pipeline(state_path, approved_takes=None)`

Called by the Kaggle runner when the user clicks ✅ Approve:

1. Loads the saved state from `/tmp/micky_pipeline_state_<hash>.json`.
2. Marks `status='approved'` so a second resume call is a no-op
   (idempotency).
3. Optionally overrides `selected_takes` (when the user edited one).
4. Re-runs `run_pipeline()` with `skip_stages={'transcribe', 'takes',
   'storyboard'}` so it picks up at Stage 3 (audio enhancement).
5. Updates the state file with the final result.

### Idempotency

* **State file path** is keyed by `sha1(input_video_path + '|' +
  output_dir)` — re-invoking the pipeline with the same inputs returns
  the existing paused result without regenerating the storyboard.
* **Resume** marks the state `status='approved'` before re-running, so
  a duplicate Approve click is a no-op.
* **Final result** is written back to the state file, so even a
  subsequent call returns the cached result.

---

## CLI usage

```bash
# Default (with storyboard pause):
python pipeline.py --input raw.mp4 --output /tmp/out

# Disable storyboard pause (skip approval, render straight through):
python pipeline.py --input raw.mp4 --output /tmp/out --no-storyboard

# Resume a paused pipeline:
python pipeline.py --resume /tmp/micky_pipeline_state_29cda17660b7cc0c.json
```

### Spec-based invocation (orchestration callers)

```json
{
  "file_url": "/input/raw.mp4",
  "output_dir": "/tmp/out",
  "generate_storyboard": true
}
```

Returns `status='paused_for_approval'` with the storyboard payload —
the orchestration layer (Worker) sends the photo to Telegram and waits
for the user's approval before calling `resume_pipeline`.

---

## Module reference

### `kaggle-src/montage/storyboard.py`

| Class / function | Purpose |
|------------------|---------|
| `StoryboardGenerator(output_dir)` | Main entry point. |
| `.generate_storyboard(takes, scene_boundaries, narrative_arc)` | Build `Storyboard`. |
| `.format_storyboard_image(thumbnails, cols, labels)` | Compose grid JPG (PIL). |
| `.export_storyboard_json(storyboard)` | JSON dict with base64 thumbnails. |
| `.export_storyboard_pdf(storyboard, output_path)` | Multi-page PDF (reportlab). |
| `.prepare_for_user_approval(storyboard, token?)` | Approval payload dict. |
| `Storyboard` | `image_path`, `takes`, `narrative_arc`, `created_at`. |
| `StoryboardTake` | `idx`, `take`, `thumbnail_path`, `preview_clip_path`, `hook_text`, `score`. |

### `worker/src/bot/storyboard_handler.ts`

| Function | Purpose |
|----------|---------|
| `sendStoryboardForApproval(env, ctx, chatId, taskId, statePath, data, img?)` | Send photo + store payload in KV. |
| `handleStoryboardApproval(env, ctx, callbackQuery)` | Routes `sb:approve/edit/regen/cancel` callbacks. |
| `handleStoryboardEdit(env, ctx, chatId, takeIdx, description)` | Apply free-text edit + enqueue task. |
| `isStoryboardCallback(data)` | Returns true if `data` starts with `sb:`. |
| `hasActiveStoryboardEdit(env, chatId)` | Wizard state check for the main router. |
| `getActiveStoryboardEdit(env, chatId)` | Reads the active `{token, take_idx}` state. |

### Pipeline additions (`kaggle-src/montage/pipeline.py`)

| Function | Purpose |
|----------|---------|
| `_maybe_pause_for_storyboard(...)` | Build storyboard, save state, return paused result. |
| `_pipeline_state_path(input, output)` | Stable `/tmp/micky_pipeline_state_<hash>.json` path. |
| `resume_pipeline(state_path, approved_takes?)` | Re-run pipeline from Stage 3. |

### Bot commands (added to `worker/src/bot/handlers.ts`)

| Command | Effect |
|---------|--------|
| `/storyboard` | Show storyboard help / status. |
| `/storyboard <task_id>` | Look up a specific task's storyboard status. |
| `/approve` | Approve the most recent pending storyboard for this chat. |
| `/edit <take#> <description>` | Edit a specific take (free-text description). |

---

## Failure modes & recovery

| Scenario | Behavior |
|----------|----------|
| `Pillow` not installed | `StoryboardGenerator` skips thumbnail extraction, writes placeholder JPGs. Pipeline still pauses. |
| `reportlab` not installed | `export_storyboard_pdf()` raises `ImportError`; the bot falls back to sending only the JPG. |
| FFmpeg fails on a specific take | `_extract_thumbnail` writes a red `thumb_<idx>_err.jpg` placeholder; grid still renders. |
| State file corrupt / missing at resume time | `resume_pipeline` raises `FileNotFoundError`; the bot asks the user to re-run with `/montage`. |
| Approval token expired (30+ min) | `loadApprovalPayload` returns `null`; the bot tells the user to `/storyboard` again. |
| User clicks Approve twice | First click sets `status='approved'` in the state file; second click finds the cached result and returns it. |
| Kaggle kernel killed mid-render | Worker cron detects stale kernel after 5 min and notifies the user; state file persists for retry. |

---

Created: 2026-11-12 (Phase P4-T9 — Agent B11)
