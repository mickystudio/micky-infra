"""
Micky WhisperX Transcription — Kaggle Kernel Source
====================================================

Kaggle kernel:  dentistmichaelnabil/micky-whisper
kernel_type:    script
GPU:            enabled
Internet:       enabled (needed for `git clone` + `pip install`)

This kernel supersedes the legacy openai-whisper kernel and uses the
new `whisperx_engine.py` module (WhisperX + word-level + diarization)
pulled live from mickystudio/micky-infra at runtime.

Inputs (via env vars or task_spec.json):
    INPUT_MEDIA       path/URL to media file (audio or video)
    WHISPER_MODEL     large-v3 | large-v2 | medium | base (default large-v3)
    WHISPER_LANGUAGE  ar | en | auto (default ar)
    WHISPER_TASK      transcribe | translate (default transcribe)
    HF_TOKEN          required for pyannote.audio diarization (skip if unset)
    SKIP_DIARIZATION  1 | 0   (default 0; auto-skips if HF_TOKEN missing)
    KAGGLE_TASK_ID    task id for GitHub release tagging

Outputs:
    /kaggle/working/output/transcript.json   (full text + word-level timestamps)
    /kaggle/working/output/transcript.srt    (SRT subtitles)
    /kaggle/working/output/transcript.txt    (plain text)
    (optional upload to GitHub Release on success)

Created: 2026-11-10  (Agent C3 — Kaggle kernel push)
"""
from __future__ import annotations

import os, sys, json, subprocess, traceback, time, urllib.request, urllib.error

# ----------------------------------------------------------------------
# Cell 1 — Install WhisperX + ffmpeg + supporting deps
# ----------------------------------------------------------------------
DEPS_BATCHES = [
    "torch torchaudio",
    "whisperx pyannote.audio faster-whisper ctranslate2",
    "ffmpeg-python soundfile librosa",
    "requests tqdm",
]
for batch in DEPS_BATCHES:
    print(f"[pip] installing: {batch}")
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "-q", *batch.split()],
        check=False,
    )

subprocess.run(
    "apt-get update -qq && apt-get install -y -qq ffmpeg",
    shell=True, check=False, capture_output=True,
)

# ----------------------------------------------------------------------
# Cell 2 — Pull whisperx_engine.py + helpers from GitHub
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
print(f"[cp] whisperx_engine.py + audio deps -> {DEST_DIR}")
# Pull whisperx_engine.py plus the audio_enhancer modules it may need
files_to_copy = [
    "whisperx_engine.py",
    "audio_enhancer.py",
    "audio_enhancer_v2.py",
]
for fname in files_to_copy:
    src_fp = f"{SRC_DIR}/kaggle-src/montage/{fname}"
    if os.path.isfile(src_fp):
        subprocess.run(["cp", src_fp, f"{DEST_DIR}/{fname}"], check=True)
        print(f"  copied {fname}")

# ----------------------------------------------------------------------
# Cell 3 — Bootstrap path + GPU check
# ----------------------------------------------------------------------
sys.path.insert(0, DEST_DIR)
os.chdir("/kaggle/working")

print("=" * 60)
print("Micky WhisperX Transcription — Kaggle Runner")
print("=" * 60)
print(f"Python  : {sys.version.split()[0]}")
print(f"CWD     : {os.getcwd()}")
print(f"Modules : {DEST_DIR}")

try:
    import torch
    gpu_name = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU only"
    print(f"GPU     : {gpu_name}")
    if not torch.cuda.is_available():
        print("[WARN] No GPU detected — WhisperX will be VERY slow on CPU.")
except Exception as exc:
    print(f"GPU     : (torch not yet loaded: {exc})")

# ----------------------------------------------------------------------
# Cell 4 — Resolve inputs (env vars override task_spec.json)
# ----------------------------------------------------------------------
INPUT_MEDIA = os.environ.get("INPUT_MEDIA", "")
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "large-v3")
WHISPER_LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "ar")
WHISPER_TASK = os.environ.get("WHISPER_TASK", "transcribe")
HF_TOKEN = os.environ.get("HF_TOKEN", os.environ.get("HUGGING_FACE_HUB_TOKEN", ""))
SKIP_DIARIZATION = os.environ.get("SKIP_DIARIZATION", "0") == "1" or not HF_TOKEN

# If no INPUT_MEDIA env var, look for task_spec.json
if not INPUT_MEDIA:
    spec_path = "/kaggle/working/task_spec.json"
    if os.path.exists(spec_path):
        with open(spec_path, "r", encoding="utf-8") as fh:
            spec = json.load(fh)
        INPUT_MEDIA = spec.get("file_url") or spec.get("input_media_path") or ""
        WHISPER_MODEL = spec.get("whisperx_model", WHISPER_MODEL)
        WHISPER_LANGUAGE = spec.get("language", WHISPER_LANGUAGE)
        WHISPER_TASK = spec.get("task", WHISPER_TASK)
        print(f"[OK] Loaded spec from {spec_path}")
    else:
        INPUT_MEDIA = "/kaggle/input/test_video.mp4"
        print(f"[!] No INPUT_MEDIA / task_spec.json — defaulting to {INPUT_MEDIA}")

print(f"\nInput         : {INPUT_MEDIA}")
print(f"Model         : {WHISPER_MODEL}")
print(f"Language      : {WHISPER_LANGUAGE}")
print(f"Task          : {WHISPER_TASK}")
print(f"Diarization   : {'SKIP (no HF_TOKEN)' if SKIP_DIARIZATION else 'ENABLED'}")
print(f"HF_TOKEN set  : {bool(HF_TOKEN)}")

if not os.path.exists(INPUT_MEDIA) and not INPUT_MEDIA.startswith(("http://", "https://")):
    raise FileNotFoundError(f"Input media not found: {INPUT_MEDIA}")

# ----------------------------------------------------------------------
# Cell 5 — Run WhisperX transcription
# ----------------------------------------------------------------------
from whisperx_engine import WhisperXEngine  # noqa: E402

print("\n[..] Initializing WhisperXEngine ...")
t0 = time.time()
engine = WhisperXEngine(
    model_name=WHISPER_MODEL,
    device="cuda" if torch.cuda.is_available() else "cpu",
    compute_type="float16" if torch.cuda.is_available() else "int8",
    language=WHISPER_LANGUAGE,
    hf_token=HF_TOKEN or None,
    skip_diarization=SKIP_DIARIZATION,
)
print(f"[OK] Engine initialized in {time.time()-t0:.1f}s")

print(f"\n[..] Transcribing: {INPUT_MEDIA}")
t1 = time.time()
try:
    # transcribe_simple() returns a plain dict (no pydantic models —
    # JSON-serializable out of the box).
    result = engine.transcribe_simple(INPUT_MEDIA)
    elapsed = time.time() - t1
    print(f"[OK] Transcribed in {elapsed:.1f}s  "
          f"({len(result.get('segments', []))} segments, "
          f"{len(result.get('text', ''))} chars)")
except Exception as exc:
    elapsed = time.time() - t1
    print(f"[FAIL] Transcription failed after {elapsed:.1f}s: {type(exc).__name__}: {exc}")
    traceback.print_exc()
    raise

# ----------------------------------------------------------------------
# Cell 6 — Save outputs (JSON + SRT + TXT)
# ----------------------------------------------------------------------
out_dir = "/kaggle/working/output"
os.makedirs(out_dir, exist_ok=True)

out_json = os.path.join(out_dir, "transcript.json")
with open(out_json, "w", encoding="utf-8") as fh:
    json.dump(result, fh, ensure_ascii=False, indent=2)
print(f"[OK] Wrote {out_json}  ({os.path.getsize(out_json)/1024:.1f} KB)")


def _fmt_ts(t: float) -> str:
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = int(t % 60)
    ms = int((t - int(t)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


out_srt = os.path.join(out_dir, "transcript.srt")
with open(out_srt, "w", encoding="utf-8") as fh:
    for i, seg in enumerate(result.get("segments", []), 1):
        fh.write(f"{i}\n")
        fh.write(f"{_fmt_ts(seg['start'])} --> {_fmt_ts(seg['end'])}\n")
        fh.write(f"{seg['text'].strip()}\n\n")
print(f"[OK] Wrote {out_srt}  ({os.path.getsize(out_srt)/1024:.1f} KB)")

out_txt = os.path.join(out_dir, "transcript.txt")
with open(out_txt, "w", encoding="utf-8") as fh:
    fh.write(result.get("text", ""))
print(f"[OK] Wrote {out_txt}  ({os.path.getsize(out_txt)/1024:.1f} KB)")

# Save pipeline result for downstream consumers
pipeline_result = {
    "engine": "whisperx",
    "model": WHISPER_MODEL,
    "language": result.get("language", WHISPER_LANGUAGE),
    "task": WHISPER_TASK,
    "input": INPUT_MEDIA,
    "segments_count": len(result.get("segments", [])),
    "char_count": len(result.get("text", "")),
    "outputs": {
        "json": out_json,
        "srt": out_srt,
        "txt": out_txt,
    },
    "diarization": not SKIP_DIARIZATION,
    "elapsed_seconds": elapsed,
}
with open("/kaggle/working/pipeline_result.json", "w", encoding="utf-8") as fh:
    json.dump(pipeline_result, fh, ensure_ascii=False, indent=2)

# ----------------------------------------------------------------------
# Cell 7 — Upload outputs to GitHub Release (optional)
# ----------------------------------------------------------------------
GH_TOKEN = os.environ.get("GH_TOKEN", os.environ.get("GITHUB_TOKEN", ""))
GH_REPO = os.environ.get("GH_REPO", "mickystudio/micky-infra")
TASK_ID = os.environ.get("KAGGLE_TASK_ID", "whisper-run")
RELEASE_TAG = os.environ.get("RELEASE_TAG", f"task-{TASK_ID}")

artifacts = [out_json, out_srt, out_txt, "/kaggle/working/pipeline_result.json"]
artifacts = [p for p in artifacts if os.path.exists(p)]
print(f"\n[Upload] {len(artifacts)} artifacts to upload")
for p in artifacts:
    print(f"  - {os.path.basename(p)}  ({os.path.getsize(p)/1024:.2f} KB)")


def gh_api(method, path, payload=None, upload_url=None, asset_path=None):
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
                req = urllib.request.Request(upload_url, data=fh.read(), headers=headers, method="POST")
        else:
            data = json.dumps(payload).encode() if payload else None
            url = f"https://api.github.com{path}" if upload_url is None else upload_url
            req = urllib.request.Request(url, data=data, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=180) as resp:
            body = resp.read().decode("utf-8", errors="ignore")
            return resp.status, (json.loads(body) if body else {})
    except urllib.error.HTTPError as exc:
        print(f"GitHub API error {exc.code}: {exc.read().decode('utf-8', errors='ignore')[:300]}")
        return exc.code, {}
    except Exception as exc:
        print(f"GitHub upload exception: {exc}")
        return 0, {}


if not GH_TOKEN:
    print("[Upload] GH_TOKEN not set — skipping GitHub release upload.")
    print("[Upload] Outputs remain available under /kaggle/working/output/")
else:
    # find or create release
    status, data = gh_api("GET", f"/repos/{GH_REPO}/releases/tags/{RELEASE_TAG}")
    if status == 200:
        upload_url = data.get("upload_url", "").replace("{?name,label}", "")
    else:
        payload = {
            "tag_name": RELEASE_TAG,
            "name": f"Kaggle whisper task {TASK_ID}",
            "body": "Auto-uploaded from Micky WhisperX Kaggle kernel",
            "draft": False,
            "prerelease": False,
        }
        status, data = gh_api("POST", f"/repos/{GH_REPO}/releases", payload=payload)
        upload_url = data.get("upload_url", "").replace("{?name,label}", "") if data else ""

    if upload_url:
        for fp in artifacts:
            name = os.path.basename(fp)
            url = f"{upload_url}?name={name}"
            status, data = gh_api("POST", "", upload_url=url, asset_path=fp)
            if status in (201, 200) and data:
                print(f"  uploaded: {name} -> {data.get('browser_download_url')}")

print("\n[Done] Micky WhisperX kernel finished.")
