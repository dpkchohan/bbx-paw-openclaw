# =============================================================================
# BBX PAW — OpenClaw Gateway container
# =============================================================================
# Installs the OFFICIAL OpenClaw package from npm (not a custom build), adds
# our config generator + 4-tier model strategy, and starts the Gateway bound
# for Coolify/Docker bridge networking.
#
# Build:   docker build -t bbx-paw-openclaw .
# Run:     use docker-compose.yaml (handles volumes/env/ports/healthcheck).
# =============================================================================

FROM node:22-bookworm-slim

# OpenClaw requires Node 22.22.3+/24.15+/25.9+; node:22-bookworm-slim tracks
# the latest Node 22.x patch, which satisfies that floor as of this writing.
# Pin a newer major (e.g. node:24-bookworm-slim) if you need a hard match.

ENV NODE_ENV=production \
    HOME=/home/node \
    OPENCLAW_HOME=/home/node \
    OPENCLAW_STATE_DIR=/home/node/.openclaw \
    OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json \
    OPENCLAW_CONFIG_DIR=/home/node/.openclaw \
    OPENCLAW_WORKSPACE_DIR=/home/node/.openclaw/workspace \
    WORKSPACE_PATH=/home/node/.openclaw/workspace

WORKDIR /app

# Install curl/tini for the entrypoint + healthcheck, then the official
# OpenClaw CLI as a global npm package (per project restriction: use the
# published package, do not build OpenClaw from source).
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl tini ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g openclaw@latest --allow-scripts=openclaw && \
    npm cache clean --force

# Copy only what the config generator + entrypoint need. Application code
# here is intentionally minimal — OpenClaw itself is the agent runtime.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY config ./config
COPY docker/entrypoint.sh /usr/local/bin/openclaw-entrypoint.sh

RUN chmod +x /usr/local/bin/openclaw-entrypoint.sh && \
    install -d -m 0700 -o node -g node \
      /home/node/.openclaw \
      /home/node/.openclaw/workspace \
      /home/node/.config/openclaw

# Belt-and-suspenders permission fix: the `node` user must be able to write
# its state/config/workspace files under /home/node/.openclaw at runtime.
# The `install -d` step above already creates these with node:node
# ownership, but Coolify/host bind-mounts (docker-compose.yaml volumes) can
# still land as root:root on first run on some Docker hosts, which caused
# EACCES failures writing openclaw.json. Explicitly (re)create and chown/chmod
# both directories so the container never depends on the mount's initial
# ownership.
RUN mkdir -p /home/node/.openclaw && \
    chown -R node:node /home/node/.openclaw && \
    chmod -R 755 /home/node/.openclaw

RUN mkdir -p /home/node/.openclaw/workspace && \
    chown -R node:node /home/node/.openclaw/workspace

USER node

# Built-in OpenClaw probe endpoints: /healthz, /startupz, /readyz.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${OPENCLAW_PORT:-18789}/healthz" || exit 1

EXPOSE 18789

# Ensure .openclaw directory exists and is writable
RUN mkdir -p /home/node/.openclaw/workspace && \
    chown -R node:node /home/node/.openclaw && \
    chmod -R 755 /home/node/.openclaw

ENTRYPOINT ["tini", "-s", "--", "/usr/local/bin/openclaw-entrypoint.sh"]
CMD ["openclaw", "gateway", "--bind", "lan", "--port", "18789"]

