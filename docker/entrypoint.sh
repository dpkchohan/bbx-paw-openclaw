#!/bin/sh
# =============================================================================
# BBX PAW OpenClaw container entrypoint
# =============================================================================
# 1. Ensure the OpenClaw state/config directory exists and is writable by
#    the current user before anything else runs. Host bind-mounts
#    (docker-compose.yaml volumes) can land as root-owned on first run on
#    some Docker hosts even though the image creates them as node:node,
#    which caused EACCES failures writing openclaw.json. This check is a
#    cheap, idempotent safety net on every container start.
# 2. Regenerate ~/.openclaw/openclaw.json from config/models.yaml + env on
#    every container start, so the 4-tier model strategy always matches the
#    checked-in config even if the mounted state volume is stale.
# 3. Exec the real command (default: `openclaw gateway ...`).
# =============================================================================
set -e

mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace

echo "[entrypoint] Generating OpenClaw config from config/models.yaml ..."
node /app/config/openclaw.config.js

echo "[entrypoint] Starting: $*"
exec "$@"
