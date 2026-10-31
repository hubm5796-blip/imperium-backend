#!/usr/bin/env bash
# Local replacement for .github/workflows/ci.yml (Actions permanently off, owner 2026-10-30).
# NOTE: wrangler --dry-run does NOT execute module scope — the real deploy gate is
# `npx wrangler deploy` at merge time (see VERIFICATION.md 2026-10-31 lazy-app incident).
set -euo pipefail
cd "$(dirname "$0")/.."
npm run typecheck
npm test
npm run build
npx wrangler deploy --dry-run --outdir=dist-worker
echo "LOCAL CHECK: ALL GREEN"
