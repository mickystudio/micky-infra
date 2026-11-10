#!/usr/bin/env python3
"""Executes a single inference task via the llama-server OpenAI-compatible API.

Reads a task JSON spec, builds a chat-completions request, calls the local
llama-server, parses the response (extracting fenced code blocks into discrete
files when the task spec lists expected file paths), and writes the structured
output to /tmp/task_output.json for downstream PR / artifact steps.

Usage:
    run_task.py <task_json_file> [server_url]

Output:
    /tmp/task_output.json  — structured payload consumed by open_pr.py
    /tmp/last_error.txt    — written only on failure (for retry injection)

Task JSON schema (expected fields):
    {
      "id":            str  (required),
      "title":         str,
      "task_type":     "inference" | "code" | "montage" | "graphics",
      "system_prompt": str   (optional),
      "spec":          str   (required — the actual user prompt),
      "files":         [str] (optional — expected file paths to extract),
      "max_tokens":    int   (optional, default 4096),
      "temperature":   float (optional, default 0.4),
      "model":         str   (optional, default "qwen2.5-coder-14b")
    }
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

import requests

DEFAULT_MODEL = "qwen2.5-coder-14b"
DEFAULT_MAX_TOKENS = 4096
DEFAULT_TEMPERATURE = 0.4
DEFAULT_SERVER_URL = "http://127.0.0.1:8080"
OUTPUT_PATH = Path("/tmp/task_output.json")
ERROR_PATH = Path("/tmp/last_error.txt")
REQUEST_TIMEOUT = 600   # 10 minutes per inference call
MAX_RETRIES = 2         # HTTP-level retries (independent of workflow-level retry)


def load_task(path: str) -> dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        task = json.load(f)
    if not isinstance(task, dict):
        raise ValueError(f"Task JSON must be an object, got {type(task).__name__}")
    if "id" not in task:
        raise ValueError("Task JSON missing required field: 'id'")
    if "spec" not in task:
        raise ValueError("Task JSON missing required field: 'spec'")
    return task


def build_messages(task: dict[str, Any]) -> list[dict[str, str]]:
    """Build the chat messages list from the task spec."""
    messages: list[dict[str, str]] = []
    system_prompt = task.get("system_prompt")
    if not system_prompt:
        # Sensible default that constrains output to clean, documented code.
        task_type = task.get("task_type", "inference")
        if task_type == "code":
            system_prompt = (
                "You are an expert software engineer. Generate production-quality code "
                "matching the requested files exactly. Wrap each file in a fenced code block "
                "with a header line of the form: ```language:path/to/file.ext"
            )
        else:
            system_prompt = (
                "You are Micky Assistant, a helpful professional assistant for a dentist. "
                "Reply in Arabic unless asked otherwise. Be concise but thorough."
            )
    messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": task["spec"]})
    return messages


def call_llama_server(
    server_url: str,
    messages: list[dict[str, str]],
    task: dict[str, Any],
) -> dict[str, Any]:
    """Call the OpenAI-compatible /v1/chat/completions endpoint with retries."""
    url = f"{server_url.rstrip('/')}/v1/chat/completions"
    payload = {
        "model": task.get("model", DEFAULT_MODEL),
        "messages": messages,
        "max_tokens": int(task.get("max_tokens", DEFAULT_MAX_TOKENS)),
        "temperature": float(task.get("temperature", DEFAULT_TEMPERATURE)),
        "stream": False,
    }

    last_exc: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 2):  # 1..MAX_RETRIES+1
        try:
            print(f"[run_task] POST {url} (attempt {attempt}/{MAX_RETRIES + 1})")
            resp = requests.post(url, json=payload, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as exc:
            last_exc = exc
            print(f"[run_task] request failed: {exc}", file=sys.stderr)
            if attempt <= MAX_RETRIES:
                time.sleep(2 * attempt)
    # All retries exhausted.
    raise RuntimeError(f"llama-server call failed after {MAX_RETRIES + 1} attempts: {last_exc}")


# Regex to match fenced code blocks with optional language:path header.
# Examples it matches:
#   ```python:src/foo.py
#   ```ts:src/index.ts
#   ```python
#   ```js
_CODEBLOCK_RE = re.compile(
    r"```(?P<lang>[^\n:]*)?(?::(?P<path>[^\n]+))?\n(?P<body>.*?)```",
    re.DOTALL,
)


def extract_files(content: str, requested: list[str]) -> dict[str, str]:
    """Parse fenced code blocks into {file_path: content}.

    If a block has a `language:path` header, that path wins. Otherwise we map
    blocks to `requested` in order of appearance.
    """
    files: dict[str, str] = {}
    blocks = list(_CODEBLOCK_RE.finditer(content))

    # First pass: blocks with explicit paths.
    pending_idx = 0
    for m in blocks:
        path = (m.group("path") or "").strip()
        body = m.group("body").rstrip("\n")
        if path:
            files[path] = body
        else:
            # Map to next requested file path (if any).
            if pending_idx < len(requested):
                files[requested[pending_idx]] = body
                pending_idx += 1

    # If no blocks were extracted but files were requested, dump entire content
    # into each requested file (degenerate case).
    if not files and requested:
        for path in requested:
            files[path] = content

    return files


def save_error(message: str) -> None:
    """Persist the last error so the workflow's retry loop can inject it."""
    ERROR_PATH.write_text(message, encoding="utf-8")


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: run_task.py <task_json_file> [server_url]", file=sys.stderr)
        return 1

    task_path = sys.argv[1]
    server_url = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_SERVER_URL

    try:
        task = load_task(task_path)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        save_error(f"Failed to load task: {exc}")
        print(f"❌ {exc}", file=sys.stderr)
        return 1

    messages = build_messages(task)

    try:
        result = call_llama_server(server_url, messages, task)
    except Exception as exc:
        save_error(f"llama-server call failed: {exc}")
        print(f"❌ {exc}", file=sys.stderr)
        return 1

    try:
        content = result["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        save_error(f"Malformed response from llama-server: {exc}\nRaw: {result!r}")
        print(f"❌ Malformed response: {exc}", file=sys.stderr)
        return 1

    requested_files = task.get("files") or []
    files = extract_files(content, requested_files)

    output: dict[str, Any] = {
        "id": task["id"],
        "title": task.get("title", ""),
        "task_type": task.get("task_type", "inference"),
        "model": task.get("model", DEFAULT_MODEL),
        "output": {
            "summary": f"Generated {len(content)} chars across {len(files)} file(s)",
            "files": files,
            "content": content,
            "usage": result.get("usage", {}),
        },
        "spec": task["spec"],
        "base_branch": task.get("base_branch", "main"),
    }

    OUTPUT_PATH.write_text(json.dumps(output, indent=2, ensure_ascii=False), encoding="utf-8")

    # Best-effort: clear any stale error from previous attempts.
    if ERROR_PATH.exists():
        ERROR_PATH.unlink()

    print(f"✅ Task {task['id']} completed — {len(content)} chars, {len(files)} file(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
