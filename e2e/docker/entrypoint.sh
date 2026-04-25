#!/usr/bin/env bash
# Entrypoint for the dockerized E2E runner.
#
# Steps:
#   1. Install JS dependencies (npm ci against the bind-mounted repo).
#   2. Build the Tauri binary in --debug mode (faster than release;
#      debug info also helps when triaging panics from CI artifacts).
#   3. Start xvfb on :99 and export DISPLAY.
#   4. Hand off to wdio (or whatever command was passed via
#      `docker compose run e2e-runner ...`).
#
# The script is idempotent — re-running it after a code change skips
# the parts whose inputs haven't changed thanks to npm/cargo caches
# living on named volumes.
set -euo pipefail

cd /workspace

echo "[e2e] npm ci"
npm ci --no-audit --no-fund

echo "[e2e] tauri build --debug"
npm run tauri build -- --debug --no-bundle

echo "[e2e] starting Xvfb on :99"
Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp &
XVFB_PID=$!
trap 'kill "$XVFB_PID" 2>/dev/null || true' EXIT
export DISPLAY=:99

# Default command runs the wdio suite; passing args overrides this so
# `docker compose run e2e-runner bash` drops into a shell.
if [[ $# -eq 0 ]]; then
  exec npx wdio run e2e/wdio.conf.ts
else
  exec "$@"
fi
