#!/usr/bin/env bash
# Verify every blueprint runs (the runnable ones) or typechecks
# (the deploy-only ones). Run from repo root: scripts/blueprints/verify.sh
set -euo pipefail

cd "$(dirname "$0")/../.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

PASS=0
FAIL=0

run() {
  local label="$1"
  local script="$2"
  echo ""
  echo "▸ $label"
  if bun "$script" > /tmp/blueprint.out 2>&1; then
    grep -E "✓" /tmp/blueprint.out | sed 's/^/  /'
    PASS=$((PASS+1))
  else
    echo "  ✗ FAIL"
    tail -10 /tmp/blueprint.out | sed 's/^/    /'
    FAIL=$((FAIL+1))
  fi
}

run "01 — in-process, no HTTP"             scripts/blueprints/01-in-process.ts
run "02 — standalone Bun.serve"            scripts/blueprints/02-standalone-bun.ts
run "03 — mounted in a host Hono app"      scripts/blueprints/03-mounted-hono.ts
run "04 — mixed mode (HTTP + in-process)"  scripts/blueprints/04-mixed-mode.ts
run "05 — Cloudflare Workers (typecheck)"  scripts/blueprints/05-cloudflare-workers.ts
run "06 — Vercel Edge (typecheck)"         scripts/blueprints/06-vercel-edge.ts
run "07 — Node @hono/node-server (shape)"  scripts/blueprints/07-node-server.ts
run "08 — deploy-pipeline migrate"          scripts/blueprints/08-deploy-pipeline-migrate.ts
run "09 — custom embedder (Ollama)"         scripts/blueprints/09-custom-embedder-ollama.ts
run "10 — deterministic test stub"          scripts/blueprints/10-deterministic-test-stub.ts
run "11 — mixed providers"                  scripts/blueprints/11-mixed-providers.ts

echo ""
echo "=== blueprint verification ==="
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
