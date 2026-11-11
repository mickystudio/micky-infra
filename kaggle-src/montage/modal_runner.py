"""
Modal Runner (B9)
=================

Client for Modal (modal.com) — true serverless GPU with $30/mo
recurring free credits.  Used for async batch inference that does
not fit Kaggle's 12 h session limit or HF Spaces' ZeroGPU queue.

Public API
----------
    runner = ModalRunner()                # raises if no token configured

    fn_id = runner.deploy_function(
        function_code=...,
        name='vlm_score_batch',
        gpu='A10G',
    )

    result = runner.invoke_function('vlm_score_batch', args={'frames': [...]})

    results = runner.run_async_batch(
        'vlm_score_batch',
        batch_args=[{'frames': [...]}, {'frames': [...]}],
    )

Setup
-----
1. ``pip install modal`` (Kaggle: ``!pip install -q modal``).
2. Create a token at https://modal.com/settings/tokens.
3. Set env vars::

       export MODAL_TOKEN_ID=ak-...
       export MODAL_TOKEN_SECRET=as-...

4. ``modal token new --token-id $MODAL_TOKEN_ID --token-secret $MODAL_TOKEN_SECRET``
   caches credentials to ``~/.modal.toml``.

If either env var is missing, every method raises ``ModalNotConfigured``
with setup instructions — callers should fall back to HF Spaces or Kaggle.

Created: 2026-12-01  |  Task B9  |  Phase P5-T1
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import time
import urllib.error
import urllib.request
from typing import Any

log = logging.getLogger(__name__)

# --- Constants -------------------------------------------------------------

MODAL_API_BASE = 'https://modal.com/api/v1'
MODAL_APPS_BASE = 'https://modal.com/apps'
POLL_INTERVAL_SECONDS = 2  # Modal allows fast polling (no rate-limit risk)
DEFAULT_TIMEOUT_SECONDS = 300
HTTP_TIMEOUT_SECONDS = 60
SUPPORTED_GPUS = ('T4', 'L4', 'A10G', 'A100', 'H100')


class ModalNotConfigured(RuntimeError):
    """Raised when Modal credentials are missing.

    Carries a human-readable setup hint in ``.hint`` for surfacing in
    Telegram alerts.
    """

    def __init__(self, hint: str | None = None) -> None:
        self.hint = hint or (
            'Modal is not configured. Run:\n'
            '  pip install modal\n'
            '  export MODAL_TOKEN_ID=ak-...\n'
            '  export MODAL_TOKEN_SECRET=as-...\n'
            '  modal token new --token-id $MODAL_TOKEN_ID '
            '--token-secret $MODAL_TOKEN_SECRET\n'
            'Then retry.  Free tier: $30/mo recurring credits.'
        )
        super().__init__(self.hint)


class ModalInvocationError(RuntimeError):
    """Raised when a Modal function invocation fails or times out."""


# ===========================================================================
# ModalRunner
# ===========================================================================

class ModalRunner:
    """Async serverless GPU runner backed by modal.com."""

    def __init__(
        self,
        app_name: str = 'micky-montage',
        modal_token: str | None = None,
    ) -> None:
        self.app_name = app_name
        self.token_id = os.environ.get('MODAL_TOKEN_ID', '').strip()
        self.token_secret = os.environ.get('MODAL_TOKEN_SECRET', '').strip()
        if not (self.token_id and self.token_secret):
            raise ModalNotConfigured()
        # Modal HTTP API uses HTTP Basic auth with token_id:user,
        # token_secret:password.
        self._auth_header = _basic_auth(self.token_id, self.token_secret)

    # --- Public API -------------------------------------------------------

    def deploy_function(
        self,
        function_code: str,
        name: str,
        gpu: str = 'T4',
    ) -> str:
        """Deploy a Modal function via the CLI.

        Writes ``function_code`` to a temp .py file with the standard
        ``modal.App(...)`` decorator pattern, then runs ``modal deploy``.

        Returns the fully-qualified function ID
        (``{app_name}-{name}``) used by ``invoke_function``.
        """
        if gpu not in SUPPORTED_GPUS:
            raise ValueError(
                f'Unsupported GPU {gpu!r}; choose from {SUPPORTED_GPUS}'
            )
        # Write code to a temp file.
        deploy_dir = os.environ.get(
            'MICKY_MODAL_DIR', '/tmp/micky-modal-deploy'
        )
        os.makedirs(deploy_dir, exist_ok=True)
        script_path = os.path.join(deploy_dir, f'{name}.py')
        with open(script_path, 'w') as f:
            f.write(function_code)

        cmd = [
            'modal', 'deploy', script_path,
            '--app-name', self.app_name,
        ]
        log.info('Modal deploy: %s', ' '.join(cmd))
        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True,
                timeout=DEFAULT_TIMEOUT_SECONDS, check=False,
            )
        except FileNotFoundError as exc:
            raise ModalNotConfigured(
                'modal CLI not installed. Run: pip install modal'
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise ModalInvocationError(
                f'modal deploy timed out after {DEFAULT_TIMEOUT_SECONDS}s'
            ) from exc

        if result.returncode != 0:
            raise ModalInvocationError(
                f'modal deploy failed (exit {result.returncode}): '
                f'{result.stderr[:500]}'
            )
        # Modal deploy prints the function URL — extract the function ID.
        # Convention: we use ``{app_name}-{name}`` as our internal ID.
        fn_id = f'{self.app_name}-{name}'
        log.info('Modal function deployed: %s', fn_id)
        return fn_id

    def invoke_function(
        self,
        function_name: str,
        args: dict,
        timeout: int = DEFAULT_TIMEOUT_SECONDS,
    ) -> dict:
        """Invoke a Modal function synchronously via the HTTP API.

        Returns the function's return value (must be JSON-serialisable).
        Raises ``ModalInvocationError`` on any failure.
        """
        url = f'{MODAL_API_BASE}/{self.app_name}/{function_name}'
        body = json.dumps({'args': args, 'timeout': timeout}).encode('utf-8')
        req = urllib.request.Request(
            url, data=body, method='POST',
            headers={
                'Authorization': self._auth_header,
                'Content-Type': 'application/json',
                'User-Agent': 'MickyModalRunner/1.0',
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout + 30) as r:
                return json.loads(r.read().decode('utf-8') or '{}')
        except urllib.error.HTTPError as exc:
            text = _safe_read(exc)
            raise ModalInvocationError(
                f'Modal invoke {function_name} failed '
                f'({exc.code}): {text[:300]}'
            ) from exc
        except urllib.error.URLError as exc:
            raise ModalInvocationError(
                f'Modal invoke {function_name} unreachable: {exc.reason}'
            ) from exc

    def run_async_batch(
        self,
        function_name: str,
        batch_args: list[dict],
    ) -> list[dict]:
        """Submit multiple invocations in parallel and gather results.

        Uses a simple thread pool (default ``min(8, len(batch_args))``)
        — Modal supports thousands of concurrent containers, but Kaggle
        egress bandwidth is the practical bottleneck.
        """
        import concurrent.futures

        if not batch_args:
            return []

        workers = min(8, len(batch_args))
        results: list[dict] = [{}] * len(batch_args)

        def _invoke(idx: int, args: dict) -> tuple[int, dict]:
            try:
                return idx, self.invoke_function(function_name, args)
            except ModalInvocationError as exc:
                log.warning('Modal batch[%d] failed: %s', idx, exc)
                return idx, {'error': str(exc)}

        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [
                pool.submit(_invoke, i, a) for i, a in enumerate(batch_args)
            ]
            for fut in concurrent.futures.as_completed(futures):
                idx, res = fut.result()
                results[idx] = res
        return results

    # --- Internal --------------------------------------------------------

    def _health_check(self) -> bool:
        """Quick connectivity probe to the Modal API."""
        req = urllib.request.Request(
            f'{MODAL_API_BASE}/whoami',
            method='GET',
            headers={'Authorization': self._auth_header},
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                return r.status == 200
        except (urllib.error.HTTPError, urllib.error.URLError):
            return False


# ===========================================================================
# Helpers
# ===========================================================================

def _basic_auth(token_id: str, token_secret: str) -> str:
    """Build an HTTP Basic Authorization header from Modal credentials."""
    import base64 as _b64
    raw = f'{token_id}:{token_secret}'.encode('utf-8')
    return 'Basic ' + _b64.b64encode(raw).decode('ascii')


def _safe_read(exc: urllib.error.HTTPError) -> str:
    try:
        return exc.read().decode('utf-8', errors='replace')
    except Exception:  # noqa: BLE001
        return ''


# ===========================================================================
# Convenience: build a Modal function source from a snippet
# ===========================================================================

def build_modal_source(
    app_name: str,
    fn_name: str,
    body_code: str,
    gpu: str = 'T4',
    packages: list[str] | None = None,
) -> str:
    """Return a ready-to-deploy Modal .py source string.

    ``body_code`` is the body of a function that takes one dict arg
    named ``args`` and returns a JSON-serialisable value.
    """
    pkgs = packages or []
    pip_block = ', '.join(f'"{p}"' for p in pkgs) if pkgs else ''
    return f'''"""
Auto-generated Modal function: {app_name}/{fn_name}
GPU: {gpu}
"""
import modal

app = modal.App("{app_name}")

@app.function(gpu="{gpu}"{", image=modal.Image.debian_slim().pip_install(" + pip_block + ")" if pip_block else ""})
def {fn_name}(args):
{chr(10).join("    " + line for line in body_code.splitlines())}
    return {{"ok": True}}
'''
