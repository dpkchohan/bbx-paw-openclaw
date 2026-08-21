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

# Install curl/tini/gosu for the entrypoint + healthcheck, then the official
# OpenClaw CLI as a global npm package (per project restriction: use the
# published package, do not build OpenClaw from source). gosu lets the
# entrypoint start as root (to fix bind-mount ownership at runtime, see
# docker/entrypoint.sh) and then drop privileges to the `node` user before
# exec'ing the actual OpenClaw process.
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl tini gosu ca-certificates && \
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

# Every RUN step above (apt-get, `npm install -g`, the later `npm install`,
# and `install -d`) executes as root with HOME=/home/node already set, so
# each one can create/touch files under /home/node as root:root -- most
# notably ~/.npm and the ~/.config parent directory. Left root-owned,
# OpenClaw's runtime fails at startup trying to lazily install/repair
# provider plugins via npm (e.g. @openclaw/amazon-bedrock-provider) against
# a root-owned npm cache, even though the openclaw-specific subdirectories
# above were already explicitly created as node:node. Chown the ENTIRE home
# directory once, here, as the last root-owned step, so nothing baked into
# this image layer is ever root-owned. docker/entrypoint.sh repeats an
# equivalent fix at runtime for bind-mounted volumes (which reflect the
# *host* directory's ownership and are therefore unaffected by this
# build-time chown).
RUN chown -R node:node /home/node

# NOTE: no `USER node` here. The container must start as root so
# docker/entrypoint.sh can fix ownership of bind-mounted volumes (which
# always reflect the *host* directory's ownership, not this image's build-time
# chown) before dropping privileges to `node` via gosu. See entrypoint.sh.

# Built-in OpenClaw probe endpoints: /healthz, /startupz, /readyz.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${OPENCLAW_PORT:-18789}/healthz" || exit 1

EXPOSE 18789

ENTRYPOINT ["tini", "-s", "--", "/usr/local/bin/openclaw-entrypoint.sh"]
CMD ["openclaw", "gateway", "--bind", "lan", "--port", "18789"]




