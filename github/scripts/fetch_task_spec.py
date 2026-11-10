#!/usr/bin/env python3
"""Fetches a task spec JSON from micky-vault (private repo) using GH_PAT.

The Worker stores task specs as JSON files in micky-vault under
`specs/tasks/<task_id>.json`. This script fetches one such file via the
GitHub REST API (raw endpoint) and writes it to a local path.

Usage:
    fetch_task_spec.py --task-id <id> --output <path> [--repo <owner/name>]

Environment:
    GH_PAT  — Personal Access Token with `repo` scope on micky-vault.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any

import requests

GITHUB_API = "https://api.github.com"
DEFAULT_REPO = "mickystudio/micky-vault"
DEFAULT_SPEC_PATH_TEMPLATE = "specs/tasks/{task_id}.json"


def fetch_spec(task_id: str, repo: str, pat: str) -> dict[str, Any]:
    """Fetch the raw task spec from micky-vault via the GitHub API."""
    file_path = DEFAULT_SPEC_PATH_TEMPLATE.format(task_id=task_id)
    url = f"{GITHUB_API}/repos/{repo}/contents/{file_path}"
    headers = {
        "Authorization": f"token {pat}",
        "Accept": "application/vnd.github.raw+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    print(f"[fetch_task_spec] GET {url}")
    resp = requests.get(url, headers=headers, timeout=30)
    if resp.status_code == 404:
        # Fall back to /tasks/<id>.json (older convention).
        url = f"{GITHUB_API}/repos/{repo}/contents/tasks/{task_id}.json"
        print(f"[fetch_task_spec] fallback: GET {url}")
        resp = requests.get(url, headers=headers, timeout=30)
    resp.raise_for_status()
    return resp.json()


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch task spec from micky-vault.")
    parser.add_argument("--task-id", required=True, help="Task ID (UUID)")
    parser.add_argument("--output", required=True, help="Local output path")
    parser.add_argument("--repo", default=DEFAULT_REPO, help="owner/repo to fetch from")
    args = parser.parse_args()

    pat = os.environ.get("GH_PAT")
    if not pat:
        print("❌ GH_PAT env var is not set", file=sys.stderr)
        return 1

    try:
        spec = fetch_spec(args.task_id, args.repo, pat)
    except requests.RequestException as exc:
        print(f"❌ Failed to fetch task spec: {exc}", file=sys.stderr)
        return 1

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        __import__("json").dumps(spec, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"✅ Task spec saved to {out_path} ({out_path.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
