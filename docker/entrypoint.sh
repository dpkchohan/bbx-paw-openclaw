#!/bin/sh
# Ensure config directory exists
mkdir -p ~/.openclaw

# =============================================================================
# BBX PAW OpenClaw container entrypoint
# =============================================================================
# 1. Regenerate ~/.openclaw/openclaw.json from config/models.yaml + env on
#    every container start, so the 4-tier model strategy always matches the
#    checked-in config even if the mounted state volume is stale.
# 2. Exec the real command (default: `openclaw gateway ...`).
# =============================================================================
set -e

echo "[entrypoint] Generating OpenClaw config from config/models.yaml ..."
node /app/config/openclaw.config.js

echo "[entrypoint] Starting: $*"
exec "$@"
