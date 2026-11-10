#!/usr/bin/env python3
"""Injects a prior error into a task spec's prompt context for retry attempts.

When the workflow retries a failed task, this script reads the last error
from /tmp/last_error.txt (written by run_task.py) and appends it as a
"previous attempt feedback" message to the task's `spec` field, so the LLM
gets a chance to correct itself.

Usage:
    inject_error.py --task <task.json> --error <error.txt> --output <task.json>

The output overwrites the input file in-place when --output == --task.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

INJECTION_TEMPLATE = """
---
PREVIOUS ATTEMPT FEEDBACK (please correct the issue and retry):

{error}

---
Above is the error from the previous attempt. Please regenerate the response,
fixing whatever went wrong. Re-output the complete solution.
"""


def inject(task: dict[str, Any], error_text: str) -> dict[str, Any]:
    """Append error context to the task's spec field."""
    spec = task.get("spec", "")
    injection = INJECTION_TEMPLATE.format(error=error_text.strip() or "(no error text available)")
    task["spec"] = spec + injection
    # Bump a retry counter for traceability.
    task["_retry_attempt"] = task.get("_retry_attempt", 0) + 1
    return task


def main() -> int:
    parser = argparse.ArgumentParser(description="Inject error context into task spec for retry.")
    parser.add_argument("--task", required=True, help="Path to task JSON (input)")
    parser.add_argument("--error", required=True, help="Path to error text file")
    parser.add_argument("--output", required=True, help="Path to write updated task JSON")
    args = parser.parse_args()

    try:
        with open(args.task, encoding="utf-8") as f:
            task = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"❌ Cannot read task file: {exc}", file=sys.stderr)
        return 1

    try:
        with open(args.error, encoding="utf-8") as f:
            error_text = f.read()
    except OSError as exc:
        print(f"⚠ Cannot read error file (using empty): {exc}", file=sys.stderr)
        error_text = ""

    updated = inject(task, error_text)
    Path(args.output).write_text(
        json.dumps(updated, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"✅ Injected error context (retry attempt #{updated.get('_retry_attempt', 1)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
