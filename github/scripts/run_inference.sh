#!/usr/bin/env bash
# Starts llama-server in the background, waits for it to become healthy,
# runs inference against the OpenAI-compatible endpoint, then cleans up.
#
# Usage:
#   ./run_inference.sh <model_path> <task_json_file> [port]
#
# Env overrides:
#   CTX_SIZE       - context window (default: 8192)
#   N_THREADS      - CPU threads to use (default: 4, matches runner spec)
#   HEALTH_TIMEOUT - seconds to wait for /health (default: 60)
#   SERVER_BIN     - llama-server binary path (default: llama-server from PATH)
#   PYTHON_BIN     - python interpreter (default: python3)
#
# Exit codes:
#   0 — success
#   1 — bad arguments
#   2 — model file missing
#   3 — server failed to start within timeout
#   4 — inference failed
#   5 — server crashed unexpectedly

set -euo pipefail

# ---------- Args ----------
MODEL_PATH="${1:?Usage: run_inference.sh <model_path> <task_json_file> [port]}"
TASK_FILE="${2:?Usage: run_inference.sh <model_path> <task_json_file> [port]}"
PORT="${3:-8080}"

# ---------- Config ----------
CTX_SIZE="${CTX_SIZE:-8192}"
N_THREADS="${N_THREADS:-4}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"
SERVER_BIN="${SERVER_BIN:-llama-server}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFERENCE_SCRIPT="${INFERENCE_SCRIPT:-${SCRIPT_DIR}/run_task.py}"

# Pretty colors.
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${BLUE}[$(date -u '+%H:%M:%S')]${NC} $*"; }
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}!${NC} $*"; }
die()  { echo -e "${RED}✗${NC} $*" >&2; exit "${2:-1}"; }

# ---------- Pre-flight ----------
[ -f "$MODEL_PATH" ] || die "Model file not found: $MODEL_PATH" 2
[ -f "$TASK_FILE" ]  || die "Task file not found: $TASK_FILE" 1
[ -f "$INFERENCE_SCRIPT" ] || die "Inference script not found: $INFERENCE_SCRIPT" 1
command -v "$SERVER_BIN" >/dev/null 2>&1 || die "llama-server binary not in PATH" 1

MODEL_SIZE=$(du -h "$MODEL_PATH" | cut -f1)
log "Model: $MODEL_PATH ($MODEL_SIZE)"
log "Task:  $TASK_FILE"
log "Port:  $PORT  | ctx=$CTX_SIZE  | threads=$N_THREADS"

# Logs directory for debugging.
mkdir -p /tmp/llama-logs
SERVER_LOG="/tmp/llama-logs/server-$$.log"
ERR_LOG="/tmp/llama-logs/server-$$.err"
log "Server logs: $SERVER_LOG  (stderr: $ERR_LOG)"

# ---------- Start llama-server ----------
log "Starting llama-server on 127.0.0.1:${PORT}..."
"$SERVER_BIN" \
    -m "$MODEL_PATH" \
    -c "$CTX_SIZE" \
    --cache-type-k q8_0 \
    --cache-type-v q8_0 \
    -t "$N_THREADS" \
    --host 127.0.0.1 \
    --port "$PORT" \
    >"$SERVER_LOG" 2>"$ERR_LOG" &
SERVER_PID=$!

# ---------- Cleanup trap ----------
cleanup() {
    local exit_code=$?
    log "Cleaning up (exit_code=$exit_code, server_pid=$SERVER_PID)..."
    if kill -0 "$SERVER_PID" 2>/dev/null; then
        warn "Sending SIGTERM to llama-server (pid=$SERVER_PID)"
        kill -TERM "$SERVER_PID" 2>/dev/null || true
        # Wait up to 10 seconds for graceful shutdown.
        for _ in $(seq 1 10); do
            kill -0 "$SERVER_PID" 2>/dev/null || break
            sleep 1
        done
        if kill -0 "$SERVER_PID" 2>/dev/null; then
            warn "Sending SIGKILL to llama-server"
            kill -KILL "$SERVER_PID" 2>/dev/null || true
        fi
    fi
    wait "$SERVER_PID" 2>/dev/null || true
    log "Server stopped."
    # Tail last 20 lines of server log on failure for easy debugging.
    if [ "$exit_code" -ne 0 ]; then
        warn "Last 20 lines of server stdout:"
        tail -n 20 "$SERVER_LOG" 2>/dev/null || true
        warn "Last 20 lines of server stderr:"
        tail -n 20 "$ERR_LOG" 2>/dev/null || true
    fi
    rm -f "$SERVER_LOG" "$ERR_LOG" 2>/dev/null || true
    exit "$exit_code"
}
trap cleanup EXIT INT TERM

# ---------- Wait for /health ----------
log "Waiting up to ${HEALTH_TIMEOUT}s for /health..."
HEALTH_URL="http://127.0.0.1:${PORT}/health"
READY=0
for i in $(seq 1 "$HEALTH_TIMEOUT"); do
    # If server died early, exit immediately.
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        die "llama-server crashed during startup (see logs above)" 5
    fi
    if curl -fsS -o /dev/null --max-time 2 "$HEALTH_URL" 2>/dev/null; then
        READY=1
        ok "Server ready after ${i}s"
        break
    fi
    sleep 1
done

if [ "$READY" -ne 1 ]; then
    die "Server did not become healthy within ${HEALTH_TIMEOUT}s" 3
fi

# Show what model the server claims to be hosting (best-effort).
curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/v1/models" 2>/dev/null \
    | "$PYTHON_BIN" -c "import sys, json; d=json.load(sys.stdin); print('  Models:', [m['id'] for m in d.get('data', [])])" 2>/dev/null || true

# ---------- Run inference ----------
log "Running inference via ${INFERENCE_SCRIPT}..."
SERVER_URL="http://127.0.0.1:${PORT}"
if "$PYTHON_BIN" "$INFERENCE_SCRIPT" "$TASK_FILE" "$SERVER_URL"; then
    ok "Inference completed successfully"
else
    die "Inference failed (see Python traceback above)" 4
fi

# Save last error to /tmp/last_error.txt for retry-context injection.
# Only written on failure path — handled by the caller's retry loop.

ok "All done."
exit 0
