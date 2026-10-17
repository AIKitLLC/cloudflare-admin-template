#!/usr/bin/env bash
# Run the same checks as CI: install, typecheck (both configs), lint, unit,
# integration, Next.js build, and the OpenNext Worker bundle build.
#
# Usage: scripts/ci-local.sh [--maxWorkers N] [--skip-install] [--no-frozen-lockfile]
#
#   --maxWorkers N        Cap test parallelism (Vitest workers and node:test
#                         concurrency). Use 1 or 2 on low-resource machines.
#   --skip-install        Reuse the existing node_modules.
#   --no-frozen-lockfile  Allow pnpm to update pnpm-lock.yaml.
#
# Needs no secrets and no Cloudflare account. Integration tests use a local,
# synthetic D1/R2 runtime. Nothing is deployed.
set -euo pipefail

cd "$(dirname "$0")/.."

max_workers=""
skip_install=0
frozen="--frozen-lockfile"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --maxWorkers=*) max_workers="${1#*=}"; shift ;;
    --maxWorkers) max_workers="${2:-}"; shift 2 ;;
    --skip-install) skip_install=1; shift ;;
    --no-frozen-lockfile) frozen="--no-frozen-lockfile"; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ -n "$max_workers" && ! "$max_workers" =~ ^[1-9][0-9]*$ ]]; then
  echo "--maxWorkers must be a positive integer" >&2
  exit 2
fi

export CI="${CI:-1}"
export NEXT_TELEMETRY_DISABLED=1
export WRANGLER_SEND_METRICS=false
export CLOUDFLARE_SEND_METRICS=false

vitest_args=()
node_test_args=()
if [[ -n "$max_workers" ]]; then
  vitest_args+=("--maxWorkers=$max_workers")
  node_test_args+=("--test-concurrency=$max_workers")
fi

step() {
  local name="$1"; shift
  local start=$SECONDS
  echo "::group::$name"
  "$@"
  echo "::endgroup::"
  echo "ok: $name ($((SECONDS - start))s)"
}

echo "node $(node --version), pnpm $(pnpm --version)"

if [[ $skip_install -eq 0 ]]; then
  step "install" pnpm install "$frozen"
fi
step "typecheck" pnpm run typecheck
step "typecheck (firebase)" pnpm run typecheck:firebase
step "lint" pnpm run lint
step "unit tests" node --import tsx --test "${node_test_args[@]}" tests/unit/*.test.ts
step "integration tests" pnpm exec cross-env NODE_OPTIONS=--no-deprecation \
  vitest run --config ./vitest.config.mts "${vitest_args[@]}"
step "next build" pnpm run build
step "worker bundle" pnpm run build:worker

echo "All checks passed."
