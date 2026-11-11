"""
HF Spaces ZeroGPU Runner (B9)
=============================

Client for Hugging Face Spaces running on ZeroGPU hardware
(RTX Pro 6000, up to 96 GB VRAM, queue-based, free tier).

Designed to be called from inside Kaggle kernels (or locally) to
offload big-model inference (Qwen2.5-VL-72B, Qwen-Video, etc.) when
the Kaggle T4 / P100 (16 GB) is insufficient.

Public API
----------
    runner = HFSpacesRunner()
    job_id = runner.run_video_generation(prompt="...", duration_sec=5.0)
    result = runner.wait_for_result(job_id, timeout=1800)

or for VLM scoring::

    out = runner.run_vlm_inference(
        frame_paths=["/kaggle/working/frame_001.jpg", ...],
        prompt="Rate composition, lighting, ...",
    )
    # out = {"scores": [8.5, 7.0, ...], "reasoning": "..."}

Queue behaviour
---------------
ZeroGPU jobs may wait several minutes for a GPU slot. ``wait_for_result``
polls ``/status/<job_id>`` every 5 seconds (HF rate-limit friendly)
until the job is ``complete`` or ``failed``.

Graceful degradation
--------------------
If the HF Space is unreachable (network error, 5xx, missing HF_TOKEN),
all top-level helper methods raise ``HFSpacesUnavailable`` — callers
are expected to catch this and fall back to the in-process Kaggle GPU
pipeline (``vlm_scorer.VLMScorer`` / local FFmpeg/Remotion).

Created: 2026-12-01  |  Task B9  |  Phase P5-T1
"""
from __future__ import annotations

import base64
import json
import logging
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

# --- Constants -------------------------------------------------------------

HF_SPACE_DEFAULT = 'micky151246/micky-llm'
POLL_INTERVAL_SECONDS = 5      # HF-friendly polling cadence
DEFAULT_TIMEOUT_SECONDS = 1800  # 30 min — ZeroGPU queue can be slow
HTTP_TIMEOUT_SECONDS = 30
MAX_IMAGE_BYTES = 8 * 1024 * 1024  # 8 MB per frame before base64


class HFSpacesUnavailable(RuntimeError):
    """Raised when the HF Space is unreachable or HF_TOKEN is missing.

    Callers should catch this and fall back to Kaggle-local GPU processing.
    """


# ===========================================================================
# HFSpacesRunner
# ===========================================================================

class HFSpacesRunner:
    """Thin HTTP client for a HF Space exposing a /vlm + /generate_video API.

    The Space is expected to expose these endpoints (all JSON):

        POST /vlm
            body: {images: [base64...], prompt: str}
            resp: {job_id: str}

        POST /generate_video
            body: {prompt: str, duration: float}
            resp: {job_id: str}

        GET  /status/<job_id>
            resp: {status: 'queued'|'running'|'complete'|'failed',
                   progress: float, result_url: str|null,
                   error: str|null}
    """

    def __init__(
        self,
        space_id: str = HF_SPACE_DEFAULT,
        hf_token: str | None = None,
    ) -> None:
        self.space_id = space_id.strip().strip('/')
        self.hf_token = hf_token or os.environ.get('HF_TOKEN', '').strip()
        if not self.hf_token:
            raise HFSpacesUnavailable(
                'HF_TOKEN not set. Create a token at '
                'https://huggingface.co/settings/tokens (read access is '
                'enough for public Spaces) and export it as HF_TOKEN.'
            )
        # Space URL: {owner}-{name}.hf.space (dashes replace slashes).
        slug = self.space_id.replace('/', '-')
        self.base_url = f'https://{slug}.hf.space'

    # --- HTTP plumbing ----------------------------------------------------

    def _headers(self) -> dict[str, str]:
        return {
            'Authorization': f'Bearer {self.hf_token}',
            'Content-Type': 'application/json',
            'User-Agent': 'MickyHFSpacesRunner/1.0',
        }

    def _post_json(self, endpoint: str, payload: dict) -> dict:
        url = f'{self.base_url}/{endpoint.lstrip("/")}'
        body = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(
            url, data=body, headers=self._headers(), method='POST'
        )
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SECONDS) as r:
                return json.loads(r.read().decode('utf-8') or '{}')
        except urllib.error.HTTPError as exc:
            text = _safe_read(exc)
            if exc.code in (502, 503, 504):
                raise HFSpacesUnavailable(
                    f'HF Space {self.space_id} temporarily unavailable '
                    f'({exc.code}): {text[:200]}'
                ) from exc
            raise HFSpacesUnavailable(
                f'HF Space POST {endpoint} failed ({exc.code}): {text[:200]}'
            ) from exc
        except urllib.error.URLError as exc:
            raise HFSpacesUnavailable(
                f'HF Space {self.space_id} unreachable: {exc.reason}'
            ) from exc

    def _get_json(self, path: str) -> dict:
        url = f'{self.base_url}/{path.lstrip("/")}'
        req = urllib.request.Request(
            url, headers=self._headers(), method='GET'
        )
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SECONDS) as r:
                return json.loads(r.read().decode('utf-8') or '{}')
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return {'status': 'failed', 'error': 'job not found'}
            raise HFSpacesUnavailable(
                f'HF Space GET {path} failed ({exc.code})'
            ) from exc
        except urllib.error.URLError as exc:
            raise HFSpacesUnavailable(
                f'HF Space {self.space_id} unreachable: {exc.reason}'
            ) from exc

    # --- Public job API ---------------------------------------------------

    def submit_job(self, endpoint: str, payload: dict) -> str:
        """POST to ``/{endpoint}`` and return the new ``job_id``."""
        data = self._post_json(endpoint, payload)
        job_id = data.get('job_id') or data.get('id')
        if not job_id:
            raise HFSpacesUnavailable(
                f'HF Space {endpoint} returned no job_id: {data!r}'
            )
        log.info('HF Spaces job submitted: %s (endpoint=%s)', job_id, endpoint)
        return str(job_id)

    def get_job_status(self, job_id: str) -> dict:
        """GET /status/<job_id> → dict with keys status/progress/result_url."""
        data = self._get_json(f'status/{job_id}')
        return {
            'status': str(data.get('status', 'unknown')).lower(),
            'progress': float(data.get('progress', 0.0) or 0.0),
            'result_url': data.get('result_url'),
            'error': data.get('error'),
        }

    def wait_for_result(
        self, job_id: str, timeout: int = DEFAULT_TIMEOUT_SECONDS
    ) -> dict:
        """Poll status every ``POLL_INTERVAL_SECONDS`` until terminal.

        Returns the final status dict. Raises ``HFSpacesUnavailable`` on
        timeout or job failure (so callers can fall back to Kaggle).
        """
        deadline = time.time() + max(timeout, 30)
        last_log = 0.0
        while time.time() < deadline:
            try:
                status = self.get_job_status(job_id)
            except HFSpacesUnavailable as exc:
                # Transient network glitch — retry once more next interval.
                log.warning('Transient HF status error: %s', exc)
                status = {'status': 'queued', 'progress': 0.0}

            s = status['status']
            if s == 'complete':
                log.info('HF Spaces job %s complete: %s',
                         job_id, status.get('result_url'))
                return status
            if s == 'failed':
                raise HFSpacesUnavailable(
                    f'HF Spaces job {job_id} failed: '
                    f'{status.get("error") or "unknown error"}'
                )
            if time.time() - last_log > 30:
                log.info(
                    'HF Spaces job %s: %s (%.0f%%) — waiting %ds more',
                    job_id, s, status['progress'] * 100,
                    int(deadline - time.time()),
                )
                last_log = time.time()
            time.sleep(POLL_INTERVAL_SECONDS)

        raise HFSpacesUnavailable(
            f'HF Spaces job {job_id} timed out after {timeout}s'
        )

    # --- High-level helpers ----------------------------------------------

    def run_vlm_inference(
        self, frame_paths: list[str], prompt: str
    ) -> dict:
        """POST /vlm with base64-encoded frames, wait, and return scores.

        Returns ``{scores: [float, ...], reasoning: str}``.

        Frames larger than ``MAX_IMAGE_BYTES`` are skipped (HF payload cap).
        Raises ``HFSpacesUnavailable`` on any failure — caller falls back.
        """
        images_b64: list[str] = []
        for fp in frame_paths:
            p = Path(fp)
            if not p.is_file():
                log.warning('VLM frame missing, skipping: %s', fp)
                continue
            raw = p.read_bytes()
            if len(raw) > MAX_IMAGE_BYTES:
                log.warning('VLM frame too large (%d KB), skipping: %s',
                            len(raw) // 1024, fp)
                continue
            images_b64.append(base64.b64encode(raw).decode('ascii'))

        if not images_b64:
            raise HFSpacesUnavailable(
                f'No valid frames to send to VLM (got {len(frame_paths)})'
            )

        job_id = self.submit_job('vlm', {
            'images': images_b64,
            'prompt': prompt,
        })
        result = self.wait_for_result(job_id)
        if not result.get('result_url'):
            # Some Spaces embed the answer directly in the status payload.
            raw = result.get('error') or '{}'
            try:
                inline = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                inline = {}
            return {
                'scores': list(inline.get('scores', [])),
                'reasoning': str(inline.get('reasoning', '')),
            }
        # Otherwise fetch the JSON result file from result_url.
        return self._fetch_json_result(result['result_url'])

    def run_video_generation(
        self, prompt: str, duration_sec: float = 5.0
    ) -> str:
        """POST /generate_video and download the result to a local path.

        Returns the local file path of the downloaded video.
        Raises ``HFSpacesUnavailable`` on failure.
        """
        job_id = self.submit_job('generate_video', {
            'prompt': prompt,
            'duration': float(duration_sec),
        })
        result = self.wait_for_result(job_id)
        url = result.get('result_url')
        if not url:
            raise HFSpacesUnavailable(
                f'HF Spaces video job {job_id} returned no result_url'
            )
        # Download to /tmp (or MICKY_OUTPUT_DIR if set).
        out_dir = Path(os.environ.get(
            'MICKY_OUTPUT_DIR', '/tmp/micky-hf-spaces'
        ))
        out_dir.mkdir(parents=True, exist_ok=True)
        dest = out_dir / f'hf_video_{job_id}.mp4'
        _download_file(url, dest)
        log.info('HF Spaces video saved: %s', dest)
        return str(dest)

    # --- Internal --------------------------------------------------------

    def _fetch_json_result(self, url: str) -> dict:
        """Fetch a JSON result file from result_url (HF CDN or R2)."""
        req = urllib.request.Request(url, method='GET')
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SECONDS) as r:
                return json.loads(r.read().decode('utf-8') or '{}')
        except (urllib.error.URLError, json.JSONDecodeError) as exc:
            raise HFSpacesUnavailable(
                f'Failed to fetch HF Spaces result JSON from {url}: {exc}'
            ) from exc


# ===========================================================================
# Helpers
# ===========================================================================

def _safe_read(exc: urllib.error.HTTPError) -> str:
    try:
        return exc.read().decode('utf-8', errors='replace')
    except Exception:  # noqa: BLE001 — best-effort read
        return ''


def _download_file(url: str, dest: Path) -> None:
    """Stream-download ``url`` into ``dest`` (chunked)."""
    req = urllib.request.Request(url, method='GET')
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, 'wb') as f:
        while True:
            chunk = r.read(64 * 1024)
            if not chunk:
                break
            f.write(chunk)


# ===========================================================================
# Smoke test — python -m hf_spaces_runner
# ===========================================================================

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO,
                        format='%(asctime)s %(levelname)s %(message)s')
    runner = HFSpacesRunner()
    print(f'HF Space URL: {runner.base_url}')
    # Quick connectivity probe (does not submit a real job).
    try:
        # /health is the conventional HF Spaces health endpoint.
        req = urllib.request.Request(
            f'{runner.base_url}/health', method='GET',
            headers=runner._headers(),
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            print(f'Health: HTTP {r.status}')
    except Exception as exc:  # noqa: BLE001
        print(f'Health probe failed (expected if not deployed): {exc}')
