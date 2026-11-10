#!/usr/bin/env python3
"""Sends a signed webhook callback to the Worker after a task completes (or fails).

The Worker exposes `POST /webhook/github` which expects an HMAC-signed payload
(secret = GH_WEBHOOK_SECRET). The Worker updates D1 (`tasks.status`,
`tasks.completed_at`) and notifies the user via Telegram.

Usage:
    notify_worker.py --task-id <id> --status <status> [--inference <status>]
                     [--gates <status>] [--pr-url <url>] [--run-url <url>]

Environment:
    WORKER_WEBHOOK_URL   — https://<worker>.workers.dev/webhook/github
    GH_WEBHOOK_SECRET    — HMAC secret shared with the Worker

If either env var is missing, the script prints a warning and exits 0 (so the
workflow never fails just because the callback couldn't be delivered).
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import sys
from typing import Any

import requests

CALLBACK_TIMEOUT = 15


def sign_payload(payload: bytes, secret: str) -> str:
    """Compute the X-Hub-Signature-256 header value."""
    return "sha256=" + hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="Notify Worker of task outcome.")
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--status", required=True, help="Overall job status (success/failure/cancelled)")
    parser.add_argument("--inference", default="", help="Inference step status")
    parser.add_argument("--gates", default="", help="Gates step status")
    parser.add_argument("--pr-url", default="", help="PR HTML URL if opened")
    parser.add_argument("--run-url", default="", help="Actions run URL")
    args = parser.parse_args()

    url = os.environ.get("WORKER_WEBHOOK_URL")
    secret = os.environ.get("GH_WEBHOOK_SECRET")

    if not url or not secret:
        print("⚠ WORKER_WEBHOOK_URL or GH_WEBHOOK_SECRET not set — skipping callback.")
        return 0

    payload: dict[str, Any] = {
        "event": "workflow_run",
        "action": "completed" if args.status == "success" else "failed",
        "task_id": args.task_id,
        "status": args.status,
        "inference": args.inference,
        "gates": args.gates,
        "pr_url": args.pr_url,
        "run_url": args.run_url,
        "timestamp": int(__import__("time").time()),
    }
    body = json.dumps(payload).encode("utf-8")
    signature = sign_payload(body, secret)

    headers = {
        "Content-Type": "application/json",
        "X-GitHub-Event": "workflow_run",
        "X-Hub-Signature-256": signature,
    }

    try:
        resp = requests.post(url, data=body, headers=headers, timeout=CALLBACK_TIMEOUT)
        if resp.ok:
            print(f"✅ Worker notified: HTTP {resp.status_code}")
            return 0
        print(f"❌ Worker callback failed: HTTP {resp.status_code} — {resp.text}", file=sys.stderr)
        return 1
    except requests.RequestException as exc:
        print(f"❌ Worker callback exception: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
