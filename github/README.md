# Micky Assistant — GitHub Actions Runner

This repo (`mickystudio/micky-infra`, public) hosts:

- **GitHub Actions workflows** that act as the "fresh runner" for the Micky Assistant bot.
- **Bash + Python scripts** that handle model assembly, llama-server lifecycle, inference execution, PR creation, and Worker callbacks.
- **GGUF model Releases** (split into 2GB parts) and **daily backups** as Releases.

## Architecture

```
Worker (Cloudflare)  ─repository_dispatch→  runner.yml  ─PR→  micky-vault (private)
        ↑                                              │
        └────────── webhook callback (HMAC) ───────────┘
```

## Workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| `runner.yml` | `repository_dispatch` (run_task) or `workflow_dispatch` | Execute a single LLM inference / code task with retry + PR |
| `prewarm.yml` | `cron: 0 */4 * * *` or manual | Refresh GGUF Actions cache TTL (7-day expiry) |
| `backup.yml` | `cron: 0 2 * * *` or manual | Daily git-bundle + D1 export to a dated Release |

## Required Secrets

Set these in `mickystudio/micky-infra` → Settings → Secrets and variables → Actions:

| Secret | Purpose |
|---|---|
| `GH_PAT` | Personal Access Token with `repo` scope on `micky-vault` |
| `GH_WEBHOOK_SECRET` | HMAC secret shared with Worker for callback verification |
| `WORKER_WEBHOOK_URL` | `https://<worker>.workers.dev/webhook/github` |
| `WRANGLER_TOKEN` | (Optional) Cloudflare API token for D1 export in `backup.yml` |

## Model Releases

Upload `qwen2.5-coder-14b-q4_k_m.gguf` (Q4_K_M, ~9GB) split into 5 parts of ≤2GB each, tagged `v1`:

```
v1/
├── qwen2.5-coder-14b-q4_k_m.part01
├── qwen2.5-coder-14b-q4_k_m.part02
├── qwen2.5-coder-14b-q4_k_m.part03
├── qwen2.5-coder-14b-q4_k_m.part04
├── qwen2.5-coder-14b-q4_k_m.part05
└── checksums.txt
```

`checksums.txt` format:

```
<sha256>  qwen2.5-coder-14b-q4_k_m.gguf
```

## Scripts

| Script | Purpose |
|---|---|
| `assemble_model.sh` | Download split GGUF parts, concatenate, verify SHA256 |
| `run_inference.sh` | Start llama-server, wait for `/health`, run inference, cleanup |
| `run_task.py` | Call llama-server `/v1/chat/completions`, extract files, save output |
| `open_pr.py` | Commit generated code + open PR in micky-vault via API |
| `fetch_task_spec.py` | Pull `specs/tasks/<id>.json` from micky-vault using GH_PAT |
| `inject_error.py` | Append previous-attempt error to task spec for retry |
| `notify_worker.py` | Send HMAC-signed callback to Worker's `/webhook/github` |
