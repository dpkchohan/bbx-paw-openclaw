#!/bin/sh
# =============================================================================
# BBX PAW OpenClaw container entrypoint
# =============================================================================
# Runs as root (see Dockerfile: no `USER node` before ENTRYPOINT) so it can
# fix ownership/permissions on bind-mounted volumes before anything else
# happens, then drops privileges to the `node` user via gosu.
#
# Why this is necessary: docker-compose.yaml bind-mounts host directories
# (${OPENCLAW_CONFIG_DIR:-./.openclaw}, ${OPENCLAW_WORKSPACE_DIR:-./workspace},
# ${OPENCLAW_AUTH_PROFILE_SECRET_DIR:-...}) onto /home/node/.openclaw,
# /home/node/.openclaw/workspace, and /home/node/.config/openclaw. A bind
# mount always reflects the *host* directory's existing ownership -- it is
# NOT affected by the image's build-time `chown -R node:node` (Dockerfile),
# because that chown only touches the image layer, and the mount replaces
# that layer's content at container start. On a fresh host (or Coolify's
# managed volumes), Docker auto-creates missing bind-mount sources as
# root:root, which makes the unprivileged `node` process fail with EACCES
# writing openclaw.json/session state. Running this fix-up as root on every
# container start (idempotent, cheap) makes the container self-healing
# regardless of what owns the mount initially.
#
# Steps:
# 1. Ensure the OpenClaw state/config/workspace directories exist.
# 2. Fix their ownership/permissions for the `node` user (root-only op).
# 3. Regenerate ~/.openclaw/openclaw.json from config/models.yaml + env, so
#    the 4-tier model strategy always matches the checked-in config even if
#    the mounted state volume is stale.
# 4. Drop privileges to `node` and exec the real command (default:
#    `openclaw gateway ...`), via gosu, so OpenClaw never actually runs as root.
# =============================================================================
set -e

OPENCLAW_HOME_DIR="${OPENCLAW_HOME:-/home/node}"
OPENCLAW_DIR="${OPENCLAW_STATE_DIR:-$OPENCLAW_HOME_DIR/.openclaw}"
OPENCLAW_WORKSPACE="${OPENCLAW_WORKSPACE_DIR:-$OPENCLAW_DIR/workspace}"
OPENCLAW_CONFIG_HOME="/home/node/.config/openclaw"

mkdir -p "$OPENCLAW_DIR" "$OPENCLAW_WORKSPACE" "$OPENCLAW_CONFIG_HOME"

echo "[entrypoint] Fixing ownership/permissions on mounted volumes ..."
chown -R node:node "$OPENCLAW_DIR" "$OPENCLAW_CONFIG_HOME"
chmod -R 755 "$OPENCLAW_DIR" "$OPENCLAW_CONFIG_HOME"

# Also cover npm's own state (~/.npm, ~/.config outside the openclaw
# subdirs). OpenClaw's runtime lazily installs/repairs provider plugins via
# npm (e.g. @openclaw/amazon-bedrock-provider) and fails with EACCES if any
# part of npm's cache is root-owned, even when the openclaw-specific
# directories above are already correct. Fixed at build time too (see
# Dockerfile), but repeating it here makes the container self-healing if a
# volume ever mounts over part of $HOME as root-owned.
chown -R node:node "$OPENCLAW_HOME_DIR/.npm" 2>/dev/null || true
chown -R node:node "$OPENCLAW_HOME_DIR/.config" 2>/dev/null || true

echo "[entrypoint] Generating OpenClaw config from config/models.yaml ..."
gosu node node /app/config/openclaw.config.js

# WhatsApp channel: install the OFFICIAL @openclaw/whatsapp plugin (Baileys
# under the hood) at RUNTIME, not at image build time. Plugins install into
# $OPENCLAW_STATE_DIR/extensions/<name> (confirmed: "Installing to
# /home/node/.openclaw/extensions/whatsapp…"), which is the exact directory
# docker-compose.yaml bind-mounts from the host. A build-time install would
# be silently wiped out the moment that (initially empty) host volume
# mounts over /home/node/.openclaw at container start -- so this must run
# here, after the volume is live, and persists in the host directory across
# restarts exactly like the WhatsApp session itself (see docs/WHATSAPP-BAILEYS-SETUP.md).
# Guard with a directory check because `openclaw plugins install` exits
# non-zero ("plugin already exists ... delete it first") on a second run,
# which would otherwise abort this script under `set -e`.
if [ "${OPENCLAW_CHANNEL_WHATSAPP_ENABLED:-1}" = "1" ]; then
  if [ ! -d "$OPENCLAW_DIR/extensions/whatsapp" ]; then
    echo "[entrypoint] Installing WhatsApp channel plugin (@openclaw/whatsapp) ..."
    gosu node openclaw plugins install clawhub:@openclaw/whatsapp \
      || echo "[entrypoint] WARNING: WhatsApp plugin install failed; continuing without it. See docs/WHATSAPP-BAILEYS-SETUP.md."
  else
    echo "[entrypoint] WhatsApp channel plugin already installed, skipping."
  fi
fi

# Run OpenClaw's self-healing state/config migration BEFORE starting the
# gateway. The .openclaw state/workspace directories are persistent bind
# mounts (see docker-compose.yaml), so they accumulate on-disk state across
# image upgrades. When a newer OpenClaw binary detects a legacy on-disk
# workspace/session layout it refuses to boot the gateway ("Legacy workspace
# setup state requires migration ... run openclaw doctor --fix"), which
# trips the restart-loop breaker and crash-loops the container forever until
# someone runs this manually. Running it here makes every container start
# self-healing, exactly like the ownership/permission fix-ups above.
# Non-fatal: `set -e` is relaxed for this single call so a doctor failure
# (e.g. nothing to migrate) never blocks the actual gateway from starting.
echo "[entrypoint] Running OpenClaw doctor --fix (state/workspace migration) ..."
set +e
gosu node openclaw doctor --fix
DOCTOR_EXIT=$?
set -e
if [ "$DOCTOR_EXIT" -ne 0 ]; then
  echo "[entrypoint] WARNING: openclaw doctor --fix exited with code $DOCTOR_EXIT; continuing anyway."
fi

echo "[entrypoint] Starting as node: $*"
exec gosu node "$@"

