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

# OPENCLAW_GATEWAY_URL is only meant for the MCP sidecar (it reaches the
# Gateway over the compose network). Inside the Gateway container itself it
# makes every `openclaw` call -- cron runs, agent/system-agent inference
# probes, delivery -- treat the Gateway as REMOTE and abort with "SECURITY
# ERROR: Gateway URL ... uses plaintext ws:// to a non-loopback address".
# Coolify re-injects its stored value into every service on each deploy, so
# compose alone cannot keep it out. Clear it here, only when this container
# is the Gateway (command starts with `openclaw`); the sidecar's command is
# `npm run mcp:server`, so it keeps the value it needs.
if [ "$1" = "openclaw" ]; then
  unset OPENCLAW_GATEWAY_URL
  # Interactive shells opened later (Coolify "Terminal" / docker exec) inherit
  # the container's configured environment, not this script's `unset`. Their
  # login profile is sourced by Coolify's terminal, so clear it there too,
  # idempotently, so `openclaw ...` typed by an operator works natively.
  for profile in /root/.profile /home/node/.profile; do
    if ! grep -qs 'OPENCLAW_GATEWAY_URL' "$profile" 2>/dev/null; then
      printf '\n# bbx-paw: Gateway container must not carry the sidecar-only gateway URL\nunset OPENCLAW_GATEWAY_URL\n' >> "$profile"
    fi
  done
  chown node:node /home/node/.profile 2>/dev/null || true
fi

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

# Run OpenClaw's self-healing state/config migration BEFORE anything else
# that invokes the OpenClaw CLI against config (plugin install-check below,
# then the Gateway itself). The .openclaw state/workspace directories are
# persistent bind mounts (see docker-compose.yaml), so they accumulate
# on-disk state across image upgrades. When a newer OpenClaw binary
# detects a legacy on-disk workspace/session layout it refuses to boot the
# gateway ("Legacy workspace setup state requires migration ... run
# openclaw doctor --fix"), which trips the restart-loop breaker and
# crash-loops the container forever until someone runs this manually.
# Running it here makes every container start self-healing, exactly like
# the ownership/permission fix-ups above.
#
# Must run BEFORE the WhatsApp plugin install-check block below: the
# config generator above intentionally writes a couple of keys
# (`plugins.bundledDiscovery`, `agents.defaults.memorySearch`) that
# OpenClaw's schema validator treats as "legacy"/"unrecognized" until
# `doctor --fix` normalizes them -- confirmed live: running `openclaw
# plugins inspect`/`plugins install` against the freshly-generated,
# not-yet-doctored config fails with "OpenClaw config is invalid ...
# Unrecognized key: bundledDiscovery", which made the install-check below
# always report "not installed" and attempt a pointless reinstall on
# every single restart even with the plugin correctly installed on disk.
#
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

# WhatsApp channel: install the OFFICIAL @openclaw/whatsapp plugin (Baileys
# under the hood) at RUNTIME, not at image build time. A build-time install
# would be silently wiped out the moment the (initially empty) host volume
# mounts over /home/node/.openclaw at container start -- so this must run
# here, after the volume is live, and persists in the host state dir across
# restarts exactly like the WhatsApp session itself (see docs/WHATSAPP-BAILEYS-SETUP.md).
#
# Install source: plain npm spec "@openclaw/whatsapp", NOT "clawhub:@openclaw/whatsapp".
# ClawHub always resolves to the newest published release regardless of
# compatibility and hard-fails install when that release requires a newer
# OpenClaw core than this image pins ("Plugin ... requires plugin API
# >=X, but this OpenClaw runtime exposes <pinned>"). The npm resolver is
# compatibility-aware: it automatically walks back to the newest
# @openclaw/whatsapp release that actually satisfies this core's pinned
# version (confirmed: resolves @openclaw/whatsapp@latest -> newest
# compatible 2026.8.2 when core is pinned at 2026.8.2). `--accept-capabilities`
# is required non-interactively because this plugin declares capabilities
# (prompt injection, conversation access) that normally prompt for consent;
# there is no TTY here to answer that prompt.
#
# Guard with `openclaw plugins inspect`, NOT a hardcoded directory path.
# Earlier revisions guarded on `-d "$OPENCLAW_DIR/extensions/whatsapp"`
# (the ClawHub-source install directory), but the npm resolver above
# installs into $OPENCLAW_DIR/npm/projects/<hash>/node_modules/@openclaw/whatsapp
# instead -- a directory-existence guard tied to one specific install
# source goes stale the moment the plugin is (re)installed from a
# different source (e.g. during manual recovery), causing this block to
# attempt a doomed reinstall on every subsequent container start. Asking
# OpenClaw itself whether the plugin is loaded is install-source-agnostic
# and self-correcting. `plugins install` still exits non-zero on a true
# second install of the same source ("plugin already exists ... delete it
# first"), which would otherwise abort this script under `set -e`, hence
# the `||` fallback below in addition to the guard.
if [ "${OPENCLAW_CHANNEL_WHATSAPP_ENABLED:-1}" = "1" ]; then
  if gosu node openclaw plugins inspect whatsapp >/dev/null 2>&1; then
    echo "[entrypoint] WhatsApp channel plugin already installed, skipping."
  else
    echo "[entrypoint] Installing WhatsApp channel plugin (@openclaw/whatsapp, npm) ..."
    gosu node openclaw plugins install @openclaw/whatsapp --accept-capabilities \
      || echo "[entrypoint] WARNING: WhatsApp plugin install failed; continuing without it. See docs/WHATSAPP-BAILEYS-SETUP.md."
  fi
fi

# Web search provider plugin (see resolveWebSearchProvider in
# config/openclaw.config.js). Default duckduckgo: key-free, official
# @openclaw/duckduckgo-plugin. Same rules as the WhatsApp block above: npm
# spec (compatibility-aware, resolves to the newest release this pinned core
# accepts -- 2026.8.2), --accept-capabilities because there is no TTY, guard
# with `plugins inspect` so it installs once, never abort startup on failure.
WEB_SEARCH_PROVIDER="$(printf '%s' "${OPENCLAW_WEB_SEARCH_PROVIDER:-duckduckgo}" | tr 'A-Z' 'a-z')"
if [ "$WEB_SEARCH_PROVIDER" = "duckduckgo" ]; then
  if gosu node openclaw plugins inspect duckduckgo >/dev/null 2>&1; then
    echo "[entrypoint] Web search plugin (duckduckgo) already installed, skipping."
  else
    echo "[entrypoint] Installing web search plugin (@openclaw/duckduckgo-plugin, npm) ..."
    gosu node openclaw plugins install @openclaw/duckduckgo-plugin --accept-capabilities \
      || echo "[entrypoint] WARNING: web search plugin install failed; continuing without web search."
  fi
fi

echo "[entrypoint] Starting as node: $*"
exec gosu node "$@"

