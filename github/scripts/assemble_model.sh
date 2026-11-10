#!/usr/bin/env bash
# Assembles Qwen2.5-Coder-14B GGUF (Q4_K_M) from split GitHub Release assets.
#
# The Q4_K_M 14B model is ~9 GB. GitHub Releases cap individual files at 2 GB,
# so the model is split into 5 parts of ~2 GB each (plus a checksums.txt).
#
# Usage:
#   ./assemble_model.sh [version]        # default version = v1
#
# Output:
#   ./${MODEL_NAME}.gguf                 # assembled + verified GGUF file
#
# Exits non-zero on any failure (network, checksum mismatch, etc.).
# Safe under `set -euo pipefail`.

set -euo pipefail

# ---------- Config ----------
VERSION="${1:-v1}"
MODEL_NAME="qwen2.5-coder-14b-q4_k_m"
PARTS_DIR="./model_parts"
FINAL_FILE="./${MODEL_NAME}.gguf"
GITHUB_REPO="mickystudio/micky-infra"
PART_COUNT="${PART_COUNT:-5}"

# Pretty colors for logs.
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log()  { echo -e "${BLUE}[$(date -u '+%H:%M:%S')]${NC} $*"; }
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}!${NC} $*"; }
die()  { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

# ---------- Pre-flight ----------
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"

log "Assembling ${MODEL_NAME} (${VERSION}) from ${GITHUB_REPO}"
log "Part count: ${PART_COUNT}"

mkdir -p "$PARTS_DIR"
cd "$PARTS_DIR"

# ---------- Download parts ----------
BASE_URL="https://github.com/${GITHUB_REPO}/releases/download/${VERSION}"

download_part() {
    local idx="$1"
    # Two-digit zero-padded filename: part01, part02, ..., part05
    local part_file="${MODEL_NAME}.part${idx}"
    local part_url="${BASE_URL}/${part_file}"
    local out_file="${part_file}"

    # Resume support via -C -; re-attempt up to 3 times.
    local attempt=1
    while [ "$attempt" -le 3 ]; do
        log "Downloading ${part_file} (attempt ${attempt}/3)..."
        if curl -L --fail \
                  --connect-timeout 30 \
                  --max-time 1200 \
                  --retry 3 \
                  --retry-delay 5 \
                  -C - \
                  -o "$out_file" \
                  "$part_url"; then
            ok "Downloaded ${part_file} ($(du -h "$out_file" | cut -f1))"
            return 0
        fi
        warn "Download of ${part_file} failed (attempt ${attempt})"
        attempt=$((attempt + 1))
        sleep 5
    done
    die "Failed to download ${part_file} after 3 attempts"
}

for i in $(seq -w 1 "$PART_COUNT"); do
    if [ -f "${MODEL_NAME}.part${i}" ]; then
        # Skip if file already exists with non-zero size.
        if [ -s "${MODEL_NAME}.part${i}" ]; then
            ok "Skipping ${MODEL_NAME}.part${i} (already exists)"
            continue
        fi
    fi
    download_part "$i"
done

# ---------- Download checksums ----------
log "Downloading checksums.txt..."
CHECKSUMS_FILE="checksums.txt"
if ! curl -L --fail -o "$CHECKSUMS_FILE" "${BASE_URL}/${CHECKSUMS_FILE}"; then
    die "Failed to download ${CHECKSUMS_FILE}"
fi
ok "Got checksums file"

# ---------- Concatenate parts ----------
cd - >/dev/null
log "Concatenating ${PART_COUNT} parts into ${FINAL_FILE}..."
rm -f "$FINAL_FILE"
# Order matters: use explicit zero-padded sort to avoid locale issues.
for i in $(seq -w 1 "$PART_COUNT"); do
    cat "${PARTS_DIR}/${MODEL_NAME}.part${i}" >> "$FINAL_FILE"
done
ok "Concatenated. Final size: $(du -h "$FINAL_FILE" | cut -f1)"

# ---------- Verify checksum ----------
log "Verifying SHA256 checksum..."
EXPECTED=$(grep "${MODEL_NAME}" "${PARTS_DIR}/${CHECKSUMS_FILE}" | awk '{print $1}')
if [ -z "$EXPECTED" ]; then
    die "No checksum found for ${MODEL_NAME} in ${CHECKSUMS_FILE}"
fi

ACTUAL=$(sha256sum "$FINAL_FILE" | awk '{print $1}')

log "Expected: ${EXPECTED}"
log "Actual:   ${ACTUAL}"

if [ "$EXPECTED" != "$ACTUAL" ]; then
    die "Checksum mismatch! Files may be corrupted. Re-run with a clean PARTS_DIR."
fi
ok "Checksum verified"

# ---------- Cleanup parts (keep checksums for reference) ----------
rm -rf "$PARTS_DIR"
ok "Cleaned up parts directory"

# ---------- Done ----------
echo
ok "Model assembled: ${FINAL_FILE}"
ls -lh "$FINAL_FILE"
echo
log "Done. Ready for inference."
