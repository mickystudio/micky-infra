"""
Micky Montage Pipeline — Kaggle Kernel Source
==============================================

Kaggle kernel:  dentistmichaelnabil/micky-montage
kernel_type:    script   (run via IPython, so !-magics work)
GPU:            enabled
Internet:       enabled (needed for `git clone` + `pip install`)
Datasets:       dentististmichaelnabil/micky-assets (LUTs/fonts/music_cc0)

This kernel pulls the latest montage modules from
    github.com/mickystudio/micky-infra  (branch: main)
at runtime via `git clone`, then runs `run_pipeline_from_spec(spec)`.

Module inventory (kaggle-src/montage/, 20+ modules):
    pipeline.py                  — orchestrator + run_pipeline_from_spec()
    scene_detector.py            — PySceneDetect
    silence_trimmer.py           — auto-editor wrapper
    take_selector.py / _v2 / _v3 — heuristic -> VLM -> VLM+LLM scoring
    whisperx_engine.py           — WhisperX word-level + diarization
    audio_enhancer.py / _v2      — DeepFilterNet2 + ffmpeg studio chain
    beat_sync.py                 — librosa beat-tracking + cut alignment
    music_library.py             — Jamendo CC-BY + local CC0 ingestion
    cc0_downloader.py            — Freesound CC0 SFX downloader
    kinetic_captions.py          — CapCut-style animated ASS (pyonfx)
    ass_builder.py               — low-level ASS writer (pysubs2)
    caption_generator.py         — Hormozi word-by-word captions (RTL)
    llm_highlight_scorer.py      — 5-dim virality scoring via Micky gateway
    highlight_integration.py     — fuse LLM + VLM scores
    mood_detector.py             — audio+vision mood classification
    color_matcher.py             — histogram-matching reference matching
    color_grader.py / _v2        — 3D LUT (teal_orange, medical_clean, warm_clinical) + AI adaptive
    luts_downloader.py           — fetch LUT packs from micky-assets dataset
    vlm_scorer.py                — Qwen2.5-VL frame scoring
    sound_designer.py            — music + SFX + ducking + LUFS normalize
    ai_video_gen.py               — Wan2.1 B-roll + OpenVoice v2 narration
    voice_clone.py               — OpenVoice v2 / Coqui XTTS wrapper
    storyboard.py                — checkpoint JPG + PDF review export
    platform_adapter.py          — IG/TikTok/YT/FB/WA aspect+bitrate
    ab_variant_generator.py      — A/B test variant generator
    parallel_renderer.py         — multi-process FFmpeg render
    multi_session_runner.py      — concurrent session manager
    multicam_sync.py             — FFT cross-correlation + clap detection
    multicam_switcher.py         — beat/scene-driven cam switching
    brand_overlay.py             — logo + watermark + lower-thirds
    background_remover.py        — Robust Video Matting (RVM)
    multi_export.py              — 5-platform export orchestrator
    remotion_renderer.py         — Remotion (React) overlay renderer
    hf_spaces_runner.py          — HF Spaces inference fallback
    modal_runner.py              — Modal.com sandbox runner

Created: 2026-11-10  (Agent C3 — Kaggle kernel push)
"""
from __future__ import annotations

import os, sys, json, subprocess, traceback, time, urllib.request, urllib.error

# ----------------------------------------------------------------------
# Cell 1 — Install heavy dependencies
# ----------------------------------------------------------------------
# Kaggle script kernels run via IPython, so !-magics work. But to keep
# this file valid Python (also runnable locally), we shell out via
# subprocess.run() — Kaggle's IPython also accepts these just fine.
DEPS_BATCHES = [
    "scenedetect auto-editor pysubs2 pyonfx beat-this librosa mutagen soundfile",
    "whisperx pyannote.audio faster-whisper ctranslate2",
    "transformers accelerate qwen-vl-utils torch",
    "color-matcher opencv-contrib-python Pillow reportlab",
    "diffusers TTS requests scipy",
    "remotion ffmpeg-python",
]
for batch in DEPS_BATCHES:
    print(f"[pip] installing: {batch}")
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "-q", *batch.split()],
        check=False,
    )

# ffmpeg (Kaggle GPU image ships it, but apt install is a safe no-op)
subprocess.run(
    "apt-get update -qq && apt-get install -y -qq ffmpeg",
    shell=True, check=False, capture_output=True,
)

# ----------------------------------------------------------------------
# Cell 2 — Download montage modules from GitHub
# ----------------------------------------------------------------------
GH_REPO_URL = "https://github.com/mickystudio/micky-infra.git"
SRC_DIR = "/tmp/micky-infra"
DEST_DIR = "/kaggle/working/montage"

if os.path.isdir(SRC_DIR):
    subprocess.run(["rm", "-rf", SRC_DIR], check=False)

print(f"[git] cloning {GH_REPO_URL} (depth=1)")
subprocess.run(
    ["git", "clone", "--depth", "1", GH_REPO_URL, SRC_DIR],
    check=True,
)

os.makedirs(DEST_DIR, exist_ok=True)
print(f"[cp] kaggle-src/montage/*.py -> {DEST_DIR}")
subprocess.run(
    f"cp -r {SRC_DIR}/kaggle-src/montage/*.py {DEST_DIR}/",
    shell=True, check=True,
)
# Optional non-py files (requirements, fonts dir)
subprocess.run(
    f"cp -r {SRC_DIR}/kaggle-src/montage/requirements.txt {DEST_DIR}/ 2>/dev/null || true",
    shell=True, check=False,
)
subprocess.run(
    f"cp -r {SRC_DIR}/kaggle-src/montage/fonts {DEST_DIR}/ 2>/dev/null || true",
    shell=True, check=False,
)

# ----------------------------------------------------------------------
# Cell 3 — Wire up assets (LUTs, fonts, music library)
# ----------------------------------------------------------------------
# Mounted dataset: /kaggle/input/micky-assets/{luts,fonts,music_cc0}
ASSETS_DIR = "/kaggle/working/assets"
os.makedirs(ASSETS_DIR, exist_ok=True)
for asset_name in ("luts", "fonts", "music_cc0"):
    src = f"/kaggle/input/micky-assets/{asset_name}"
    dst = f"{ASSETS_DIR}/{asset_name}"
    if os.path.isdir(src) and not os.path.exists(dst):
        os.symlink(src, dst)
        print(f"[ln] {src} -> {dst}")
    elif os.path.exists(dst):
        print(f"[ln] (already exists) {dst}")
    else:
        print(f"[ln] (dataset missing) {src}")

# ----------------------------------------------------------------------
# Cell 4 — Bootstrap path + GPU check + load task spec
# ----------------------------------------------------------------------
sys.path.insert(0, DEST_DIR)
os.chdir("/kaggle/working")

print("=" * 60)
print("Micky Montage Pipeline — Kaggle Runner")
print("=" * 60)
print(f"Python  : {sys.version.split()[0]}")
print(f"CWD     : {os.getcwd()}")
print(f"Modules : {DEST_DIR}")
print(f"Assets  : {ASSETS_DIR}")

try:
    import torch  # noqa: WPS433
    gpu_name = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU only"
    print(f"GPU     : {gpu_name}")
except Exception as exc:  # noqa: BLE001
    print(f"GPU     : (torch not yet loaded: {exc})")

# Pull task spec from one of:
#   (a) /kaggle/working/task_spec.json   (uploaded with the kernel input)
#   (b) KAGGLE_TASK_SPEC env var         (JSON string)
#   (c) KAGGLE_TASK_URL env var          (URL to fetch JSON from)
spec_path = "/kaggle/working/task_spec.json"
spec: dict | None = None

if os.path.exists(spec_path):
    with open(spec_path, "r", encoding="utf-8") as fh:
        spec = json.load(fh)
    print(f"[OK] Loaded task_spec.json ({os.path.getsize(spec_path)} bytes)")
elif os.environ.get("KAGGLE_TASK_SPEC"):
    spec = json.loads(os.environ["KAGGLE_TASK_SPEC"])
    print("[OK] Loaded spec from KAGGLE_TASK_SPEC env var")
elif os.environ.get("KAGGLE_TASK_URL"):
    print(f"[..] Fetching task spec from {os.environ['KAGGLE_TASK_URL']}")
    with urllib.request.urlopen(os.environ["KAGGLE_TASK_URL"], timeout=30) as resp:
        spec = json.loads(resp.read().decode("utf-8"))
    with open(spec_path, "w", encoding="utf-8") as fh:
        json.dump(spec, fh, ensure_ascii=False, indent=2)
    print(f"[OK] Cached spec to {spec_path}")
else:
    # Default smoke-test spec — runs a tiny end-to-end sanity check
    print("[!] No task_spec.json / KAGGLE_TASK_SPEC / KAGGLE_TASK_URL provided.")
    print("[!] Falling back to default smoke-test spec.")
    spec = {
        "file_url": os.environ.get("INPUT_MEDIA", "/kaggle/input/test_video.mp4"),
        "output_dir": "/kaggle/working/output",
        "language": os.environ.get("WHISPER_LANGUAGE", "ar"),
        "caption_style": os.environ.get("CAPTION_STYLE", "hormozi"),
        "background": os.environ.get("BACKGROUND", "dental_office"),
        "lut": os.environ.get("LUT", "medical_clean"),
        "platforms": ["instagram", "tiktok", "youtube"],
        "use_whisperx": True,
    }

spec_preview = json.dumps(spec, ensure_ascii=False, indent=2, default=str)
print(f"\n[Spec] {spec_preview[:600]}{'...' if len(spec_preview) > 600 else ''}")

# ----------------------------------------------------------------------
# Cell 5 — Execute the pipeline
# ----------------------------------------------------------------------
from pipeline import run_pipeline_from_spec  # noqa: E402

t0 = time.time()
try:
    result = run_pipeline_from_spec(spec)
    elapsed = time.time() - t0
    print(f"\n{'=' * 60}")
    print(f"[OK] Pipeline completed in {elapsed:.1f}s")
    print(f"{'=' * 60}")
    print(json.dumps(result, indent=2, default=str, ensure_ascii=False))
    with open("/kaggle/working/pipeline_result.json", "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2, default=str)
    print("\n[OK] Result saved to /kaggle/working/pipeline_result.json")
except Exception as exc:  # noqa: BLE001
    elapsed = time.time() - t0
    print(f"\n[FAIL] Pipeline crashed after {elapsed:.1f}s: {type(exc).__name__}: {exc}")
    print(traceback.format_exc())
    raise

# ----------------------------------------------------------------------
# Cell 6 — Upload results to GitHub Release (optional, needs GH_TOKEN)
# ----------------------------------------------------------------------
GH_TOKEN = os.environ.get("GH_TOKEN", os.environ.get("GITHUB_TOKEN", ""))
GH_REPO = os.environ.get("GH_REPO", "mickystudio/micky-infra")
TASK_ID = os.environ.get("KAGGLE_TASK_ID", spec.get("task_id", "kaggle-run"))
RELEASE_TAG = os.environ.get("RELEASE_TAG", f"task-{TASK_ID}")


def gh_api(method: str, path: str, payload=None, upload_url=None, asset_path=None):
    """GitHub REST API helper (creates release + uploads assets)."""
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {GH_TOKEN}",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    try:
        if upload_url and asset_path:
            import mimetypes
            mime = mimetypes.guess_type(asset_path)[0] or "application/octet-stream"
            headers["Content-Type"] = mime
            with open(asset_path, "rb") as fh:
                req = urllib.request.Request(
                    upload_url, data=fh.read(), headers=headers, method="POST"
                )
        else:
            data = json.dumps(payload).encode() if payload else None
            url = (
                f"https://api.github.com{path}" if upload_url is None else upload_url
            )
            req = urllib.request.Request(url, data=data, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=180) as resp:
            body = resp.read().decode("utf-8", errors="ignore")
            return resp.status, (json.loads(body) if body else {})
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="ignore")[:300]
        print(f"GitHub API error {exc.code}: {err_body}")
        return exc.code, {}
    except Exception as exc:  # noqa: BLE001
        print(f"GitHub upload exception: {exc}")
        return 0, {}


def ensure_release() -> str:
    """Create the release if it doesn't exist; return upload_url template."""
    status, data = gh_api("GET", f"/repos/{GH_REPO}/releases/tags/{RELEASE_TAG}")
    if status == 200:
        return data.get("upload_url", "").replace("{?name,label}", "")
    payload = {
        "tag_name": RELEASE_TAG,
        "name": f"Kaggle task {TASK_ID}",
        "body": "Auto-uploaded from Micky Montage Kaggle kernel",
        "draft": False,
        "prerelease": False,
    }
    status, data = gh_api("POST", f"/repos/{GH_REPO}/releases", payload=payload)
    return (
        data.get("upload_url", "").replace("{?name,label}", "") if data else ""
    )


def upload_asset(upload_url: str, asset_path: str):
    name = os.path.basename(asset_path)
    url = f"{upload_url}?name={name}"
    status, data = gh_api("POST", "", upload_url=url, asset_path=asset_path)
    if status in (201, 200) and data:
        print(f"  uploaded: {name} -> {data.get('browser_download_url')}")
        return data.get("browser_download_url")
    print(f"  FAILED to upload {name} (status={status})")
    return None


# Collect output artifacts (skip anything >200MB — GitHub release cap)
output_dir = spec.get("output_dir", "/kaggle/working/output")
artifacts = []
if os.path.isdir(output_dir):
    for root, _dirs, files in os.walk(output_dir):
        for fn in files:
            fp = os.path.join(root, fn)
            try:
                if os.path.getsize(fp) < 200 * 1024 * 1024:
                    artifacts.append(fp)
            except OSError:
                pass

result_json = "/kaggle/working/pipeline_result.json"
if os.path.exists(result_json):
    artifacts.append(result_json)

print(f"\n[Upload] {len(artifacts)} artifacts to upload")
for p in artifacts[:20]:
    try:
        size_kb = os.path.getsize(p) / 1024
        rel = os.path.relpath(p, output_dir) if os.path.isabs(p) else p
        print(f"  - {rel}  ({size_kb:.1f} KB)")
    except OSError:
        pass

if not GH_TOKEN:
    print("[Upload] GH_TOKEN not set — skipping GitHub release upload.")
    print("[Upload] Artifacts remain available under /kaggle/working/output/")
else:
    upload_url = ensure_release()
    if upload_url:
        for fp in artifacts:
            upload_asset(upload_url, fp)

print("\n[Done] Micky montage kernel finished.")
