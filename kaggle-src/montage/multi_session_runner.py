"""
Multi-session Kaggle runner (B14).
==================================
Distributes rendering (or any other) tasks across multiple Kaggle
accounts/sessions in parallel — useful when one Kaggle account has a
30 h/week quota and we want to multiply throughput by N accounts.

The runner is intentionally Kaggle-agnostic: it accepts a list of opaque
``kaggle_tokens`` (JSON blobs) and delegates per-session execution to a
pluggable ``submit_fn`` callable. By default, ``submit_fn`` shells out
to the Kaggle CLI (`kaggle kernels push`), but it can be replaced with
any function that follows the same contract — e.g. an HTTP API call, a
Celery task, or a local subprocess — which makes this class trivially
unit-testable.

Concurrency model:
    ThreadPoolExecutor (NOT ProcessPoolExecutor) — see ``parallel_renderer.py``
    for the rationale (Kaggle GPU sharing, subprocess-bound work).

Created: 2026-11-10  |  Task B14
"""
from __future__ import annotations

import json
import os
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field, asdict
from typing import Any, Callable, Optional


@dataclass
class SessionStatus:
    """Status snapshot for a single Kaggle session.

    session_id     : opaque string identifier for the session.
    status         : 'idle' | 'queued' | 'running' | 'complete' | 'error'.
    current_task   : task id currently being processed (or None).
    eta            : estimated seconds remaining (or None when unknown).
    metadata       : extra fields (kernel_slug, last_update, etc.).
    """
    session_id: str
    status: str = 'idle'
    current_task: Optional[str] = None
    eta: Optional[float] = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


# Task = dict with at least 'task_id' and any payload fields the caller needs.
Task = dict
# submit_fn(session, task) -> result_url_or_path
SubmitFn = Callable[['Session', Task], str]


@dataclass
class Session:
    """Internal per-session state."""
    session_id: str
    token: str
    current_task: Optional[str] = None
    last_status: str = 'idle'
    last_result: Optional[str] = None
    last_error: Optional[str] = None
    tasks_completed: int = 0
    started_at: Optional[float] = None


class MultiSessionRunner:
    """Distribute tasks across multiple Kaggle sessions in parallel.

    Tokens
    ------
    ``kaggle_tokens`` is a list of JSON strings (or dicts). Each token
    typically looks like::

        {"username": "<user>", "key": "<api-key>"}

    If ``None``, the runner reads ``KAGGLE_TOKEN_1``, ``KAGGLE_TOKEN_2``,
    ... from the environment (until an index is missing). If only one
    token is available, the runner falls back to sequential execution
    (with a clear warning so users know to add more accounts).
    """

    def __init__(
        self,
        kaggle_tokens: Optional[list[str]] = None,
        submit_fn: Optional[SubmitFn] = None,
    ) -> None:
        if kaggle_tokens is None:
            kaggle_tokens = self._discover_env_tokens()
        if not kaggle_tokens:
            kaggle_tokens = [self._read_default_kaggle_json()]
        # Filter out any None entries.
        self.tokens = [t for t in kaggle_tokens if t]
        if not self.tokens:
            raise ValueError(
                'No Kaggle tokens provided. Set KAGGLE_TOKEN_1 / KAGGLE_TOKEN_2 '
                'or pass kaggle_tokens=[...].'
            )

        self.sessions = [
            Session(session_id=f'session_{i}', token=t)
            for i, t in enumerate(self.tokens)
        ]
        self.submit_fn = submit_fn or _default_kaggle_submit

        if len(self.sessions) == 1:
            print('[multi-session] WARNING: only 1 Kaggle token found; '
                  'running sequentially. Add KAGGLE_TOKEN_2..N for parallelism.')

    # ------------------------------------------------------------------
    # Dispatch
    # ------------------------------------------------------------------
    def dispatch_to_sessions(
        self,
        tasks: list[Task],
        max_retries: int = 1,
    ) -> list[str]:
        """Distribute ``tasks`` across sessions round-robin and run them
        in parallel via ThreadPoolExecutor. Returns ordered result URLs.

        Each task is run on exactly one session (the one it was assigned
        to by round-robin). Within a session, tasks run sequentially
        (Kaggle kernels are queued per-account); across sessions they
        run in parallel.
        """
        if not tasks:
            return []

        # Round-robin assign tasks to sessions.
        assignments: dict[int, list[Task]] = {
            i: [] for i in range(len(self.sessions))
        }
        for ti, task in enumerate(tasks):
            sid = ti % len(self.sessions)
            assignments[sid].append(task)
            task.setdefault('task_id', f'task_{ti:03d}')

        # Each session processes its queue in its own thread.
        results: dict[str, str] = {}  # task_id -> result URL/path
        max_workers = max(1, len(self.sessions))

        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = []
            for sid, sess in enumerate(self.sessions):
                queue = assignments[sid]
                if not queue:
                    continue
                futures.append(
                    pool.submit(self._run_session_queue, sess, queue, max_retries)
                )
            for fut in as_completed(futures):
                try:
                    session_results = fut.result()
                    results.update(session_results)
                except Exception as e:
                    print(f'[multi-session] session queue crashed: {e}')

        # Return in original task order.
        ordered = []
        for task in tasks:
            tid = task.get('task_id')
            ordered.append(results.get(tid, ''))
        return ordered

    # ------------------------------------------------------------------
    # Monitor
    # ------------------------------------------------------------------
    def monitor_sessions(self) -> list[SessionStatus]:
        """Return a status snapshot for every session.

        Calls the optional ``status_fn`` (passed at construction time
        or set via ``self.status_fn``) to query each session. Defaults
        to the in-memory state captured by ``dispatch_to_sessions``.
        """
        statuses: list[SessionStatus] = []
        for sess in self.sessions:
            eta = None
            if sess.current_task and sess.started_at:
                # Rough ETA: assume ~5 min per task if no real telemetry.
                eta = max(0.0, 300.0 - (time.time() - sess.started_at))
            statuses.append(SessionStatus(
                session_id=sess.session_id,
                status=sess.last_status,
                current_task=sess.current_task,
                eta=eta,
                metadata={
                    'tasks_completed': sess.tasks_completed,
                    'last_result': sess.last_result,
                    'last_error': sess.last_error,
                },
            ))
        return statuses

    # ==================================================================
    # Internal helpers
    # ==================================================================
    def _run_session_queue(
        self,
        sess: Session,
        queue: list[Task],
        max_retries: int,
    ) -> dict[str, str]:
        """Run a session's task queue sequentially within its thread."""
        results: dict[str, str] = {}
        for task in queue:
            tid = task.get('task_id', f'task_{len(results)}')
            sess.current_task = tid
            sess.started_at = time.time()
            sess.last_status = 'running'

            attempt = 0
            while True:
                try:
                    result = self.submit_fn(sess, task)
                    results[tid] = result
                    sess.last_result = result
                    sess.last_status = 'complete'
                    sess.tasks_completed += 1
                    break
                except Exception as e:
                    attempt += 1
                    sess.last_error = str(e)
                    if attempt > max_retries:
                        print(f'[multi-session] {sess.session_id}: task {tid} '
                              f'failed after {attempt} attempts: {e}')
                        sess.last_status = 'error'
                        results[tid] = ''
                        break
                    print(f'[multi-session] {sess.session_id}: task {tid} '
                          f'retry {attempt}/{max_retries}: {e}')
                    time.sleep(min(2 ** attempt, 30))  # exp backoff, capped 30s
        sess.current_task = None
        sess.last_status = 'idle'
        return results

    @staticmethod
    def _discover_env_tokens() -> list[str]:
        """Read KAGGLE_TOKEN_1, KAGGLE_TOKEN_2, ... from env."""
        tokens: list[str] = []
        i = 1
        while True:
            val = os.environ.get(f'KAGGLE_TOKEN_{i}')
            if not val:
                break
            tokens.append(val)
            i += 1
        return tokens

    @staticmethod
    def _read_default_kaggle_json() -> Optional[str]:
        """Fall back to ~/.kaggle/kaggle.json if no env tokens found."""
        path = os.path.expanduser('~/.kaggle/kaggle.json')
        if os.path.exists(path):
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    return f.read().strip()
            except Exception:
                return None
        return None


# ---------------------------------------------------------------------------
# Default Kaggle submit function (CLI-based)
# ---------------------------------------------------------------------------
def _default_kaggle_submit(session: Session, task: Task) -> str:
    """Default submit_fn: shell out to the Kaggle CLI.

    Expects ``task`` to contain at least:
        - kernel_slug: kernel name to push
        - kernel_dir:   local dir with kernel-metadata.json
    Returns the kernel URL on Kaggle.
    """
    kernel_slug = task.get('kernel_slug') or task.get('task_id', 'micky-task')
    kernel_dir = task.get('kernel_dir', '.')
    # Honor per-session token via env.
    env = {**os.environ, 'KAGGLE_CONFIG': session.token} \
        if session.token else os.environ
    # Kaggle CLI reads username/key from KAGGLE_USERNAME / KAGGLE_KEY.
    try:
        token_obj = json.loads(session.token) if session.token.lstrip().startswith('{') else {}
        if 'username' in token_obj:
            env['KAGGLE_USERNAME'] = token_obj['username']
        if 'key' in token_obj:
            env['KAGGLE_KEY'] = token_obj['key']
    except Exception:
        pass

    subprocess.run(
        ['kaggle', 'kernels', 'push', '-p', kernel_dir],
        check=True, capture_output=True, env=env,
    )
    return f'https://www.kaggle.com/code/{env.get("KAGGLE_USERNAME", "unknown")}/{kernel_slug}'


# ---------------------------------------------------------------------------
# Standalone CLI (smoke test)
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    import argparse

    p = argparse.ArgumentParser(description='B14 multi-session Kaggle runner')
    p.add_argument('--tokens', nargs='+',
                   help='List of Kaggle token JSON strings (or paths)')
    p.add_argument('--tasks', type=int, default=4,
                   help='Number of fake tasks to dispatch (for smoke test)')
    p.add_argument('--dry-run', action='store_true',
                   help='Use no-op submit_fn (no real Kaggle calls)')
    args = p.parse_args()

    submit_fn = (lambda sess, task: f'dry-run://{sess.session_id}/{task["task_id"]}') \
        if args.dry_run else None
    runner = MultiSessionRunner(kaggle_tokens=args.tokens, submit_fn=submit_fn)

    tasks = [{'task_id': f'task_{i:03d}', 'kernel_slug': f'micky-{i:03d}'}
             for i in range(args.tasks)]
    print(f'[multi-session] dispatching {len(tasks)} tasks across '
          f'{len(runner.sessions)} sessions...')
    results = runner.dispatch_to_sessions(tasks)
    print('Results:')
    for t, r in zip(tasks, results):
        print(f'  {t["task_id"]}: {r}')

    print('\nSession statuses:')
    for s in runner.monitor_sessions():
        print(f'  {s.to_dict()}')
