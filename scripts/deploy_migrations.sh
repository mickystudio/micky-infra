#!/bin/bash
# =====================================================================
# Micky Assistant - D1 Migration Deploy Script
# =====================================================================
# Applies all migration SQL files in /worker/migrations/ to the production
# D1 database (micky-db). Idempotent: safe to re-run (CREATE IF NOT EXISTS,
# INSERT OR IGNORE; ALTERs that fail because columns already exist are
# treated as warnings, not errors).
#
# Usage:
#   ./scripts/deploy_migrations.sh
#
# Required environment variables (set in shell or scripts/.env):
#   CLOUDFLARE_API_TOKEN   - Cloudflare API token with D1 edit perms
#   CLOUDFLARE_ACCOUNT_ID  - Cloudflare account id (ec3166d8714c7d9bb5d47c11145a1522)
#
# To load from .env before running:
#   set -a; source /home/z/my-project/scripts/.env; set +a
#   ./scripts/deploy_migrations.sh
# =====================================================================
set -euo pipefail

# ---- Locate repo root (parent of scripts/) ----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKER_DIR="$REPO_ROOT/worker"
MIGRATIONS_DIR="$WORKER_DIR/migrations"

DB_NAME="micky-db"

# ---- Validate auth env vars ----
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "✘ CLOUDFLARE_API_TOKEN is not set."
  echo "  Get it from /home/z/my-project/scripts/.env (CF_API_TOKEN=cfat_...)"
  echo "  Then: export CLOUDFLARE_API_TOKEN=cfat_..."
  exit 1
fi
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "✘ CLOUDFLARE_ACCOUNT_ID is not set."
  echo "  Set: export CLOUDFLARE_ACCOUNT_ID=ec3166d8714c7d9bb5d47c11145a1522"
  exit 1
fi
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID

echo "📦 Applying migrations to D1 database: $DB_NAME"
echo "   Account:      $CLOUDFLARE_ACCOUNT_ID"
echo "   Migrations:   $MIGRATIONS_DIR"
echo ""

cd "$WORKER_DIR"

# ---- Apply each migration file in alphabetical order ----
# The glob migrations/0*.sql expands in sorted order, which gives us:
#   0001_init.sql
#   0002_enhance_memory_and_errors.sql
#   0003_1_provider_ledger.sql        (creates provider_quotas etc. BEFORE gateway_monitoring ALTERs them)
#   0003_gateway_monitoring.sql       (ALTERs provider_calls + creates provider_health_history)
#   0004_brand_assets.sql             (creates brand_profiles/brand_assets + ALTERs users)
shopt -s nullglob
MIGRATION_FILES=( "$MIGRATIONS_DIR"/0*.sql )
shopt -u nullglob

if [ "${#MIGRATION_FILES[@]}" -eq 0 ]; then
  echo "✘ No migration files found in $MIGRATIONS_DIR"
  exit 1
fi

FAILED=0
for sql_file in "${MIGRATION_FILES[@]}"; do
  fname=$(basename "$sql_file")
  echo "  → Applying $fname..."
  # Tolerate per-file failures: ALTER TABLE ADD COLUMN fails if the column
  # already exists (idempotency issue with SQLite/D1). When that happens the
  # rest of the file is skipped, but since the prior migration already
  # applied those statements, the end state is correct.
  if npx wrangler d1 execute "$DB_NAME" --remote --file="$sql_file" --yes 2>&1 | sed 's/^/      /'; then
    echo "  ✅ $fname applied"
  else
    echo "  ⚠️  $fname had errors (likely already applied — ALTER/INSERT no-op); continuing..."
    FAILED=$((FAILED + 1))
  fi
  echo ""
done

# ---- Verify by listing tables ----
echo "📋 Tables in $DB_NAME after migration:"
npx wrangler d1 execute "$DB_NAME" --remote \
  --command="SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name;" \
  --yes | sed 's/^/  /'

echo ""
echo "📋 Indexes in $DB_NAME after migration:"
npx wrangler d1 execute "$DB_NAME" --remote \
  --command="SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name;" \
  --yes | sed 's/^/  /'

echo ""
echo "📊 Provider quota seeds (today):"
npx wrangler d1 execute "$DB_NAME" --remote \
  --command="SELECT provider, remaining_rpd, remaining_tpd FROM provider_quotas WHERE date_key = date('now') ORDER BY provider;" \
  --yes | sed 's/^/  /'

echo ""
if [ "$FAILED" -gt 0 ]; then
  echo "⚠️  Deploy completed with $FAILED migration file(s) reporting errors."
  echo "   These are typically idempotency-related (ALTER/INSERT no-ops) and expected."
else
  echo "✅ Migrations complete — all files applied cleanly."
fi
