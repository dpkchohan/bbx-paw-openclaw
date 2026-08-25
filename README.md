# BBX PAW OpenClaw Integration

**Personal Autonomous Workstation (PAW)** — a 24/7 AI agent that BBX Chat
users can hand long-running, autonomous tasks to (research, coding,
reporting) and that keeps working in the background via Trigger.dev, even
after the user closes their laptop.

This repo wires the **official [OpenClaw](https://github.com/openclaw/openclaw)**
agent gateway (installed from npm, not custom-built) into the existing BBX
infrastructure: BBX Chat, a 4-tier AWS Bedrock model strategy (Amazon Nova
Pro, GPT-5.6 Luna, Claude Sonnet 4.5, Claude Sonnet 5 — all on Bedrock),
Trigger.dev, and Coolify.

> ⚠️ **Restriction honored:** OpenClaw is installed as the published
> `openclaw` npm package (`npm install -g openclaw@latest`). This repo does
> **not** vendor, fork, or reimplement OpenClaw — it only configures and
> operates it. See [docs/SETUP.md](docs/SETUP.md#openclaw-is-official-not-forked).

## Table of contents

- [What BBX PAW does](#what-bbx-paw-does)
- [Architecture](#architecture)
- [MCP server](#mcp-server)
- [Repository structure](#repository-structure)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [4-tier model strategy](#4-tier-model-strategy)
- [Deploying to Coolify](#deploying-to-coolify)
- [Trigger.dev integration](#triggerdev-integration)
- [WhatsApp channel](#whatsapp-channel)
- [GitHub MCP server](#github-mcp-server)
- [BBX CHAT (LibreChat) MCP Integration](#bbx-chat-librechat-mcp-integration)
- [Usage example](#usage-example)
- [Status / what's implemented so far](#status--whats-implemented-so-far)
- [Troubleshooting](#troubleshooting)

## What BBX PAW does

1. A BBX Chat user sends a task ("Research NASA GSFC projects and create a
   summary report").
2. BBX Chat's backend triggers the `openclaw-task` Trigger.dev job
   (`workflows/trigger-jobs/openclaw-task.js`) on the existing self-hosted
   Trigger.dev instance (`https://server.pddt.in`).
3. The job calls the OpenClaw Gateway (this repo's Docker container) over its
   OpenAI-compatible HTTP API, picking a model tier (cheap / default /
   coding / critical) based on the task.
4. OpenClaw's agent runtime does the actual work — web research, file
   creation, multi-step reasoning — inside its workspace, using AWS Bedrock
   for inference and Titan embeddings for memory search.
5. The job persists status/result to MongoDB (shared with BBX Chat) and
   optionally calls a BBX Chat webhook so the user is notified when the
   report is ready.
6. Runs 24/7 on the same Coolify-managed EC2 host as BBX Chat — independent
   of anyone's laptop.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full diagram and a
breakdown of every moving part (Gateway, Bedrock, Trigger.dev job, MongoDB,
Coolify). Short version:

```
BBX Chat (chat.bharatbaas.com)
        │  POST /api/jobs/trigger
        ▼
Trigger.dev (server.pddt.in, self-hosted, 8 containers)
        │  runs workflows/trigger-jobs/openclaw-task.js
        ▼
OpenClaw Gateway container  ──POST /v1/chat/completions──▶  AWS Bedrock
 (this repo, Coolify, same EC2 host as BBX Chat)              (4-tier models)
        │
        ▼
  workspace/ (Docker volume) ── reports, files, agent memory (local SQLite)
        │
        ▼
MongoDB (shared with BBX Chat) ── job status/result bookkeeping
        │
        ▼
BBX Chat webhook / GET /api/jobs/:jobId ── user notified "Report ready"
```

`docker-compose.yaml` runs **two services from the same image**:

- **`openclaw`** — the OpenClaw gateway, started by the image's default
  `ENTRYPOINT`/`CMD` (`openclaw gateway --bind lan --port 18789`). It listens
  on port `18789`, has a readiness healthcheck at `GET /readyz`, and runs the
  WhatsApp channel plugin. **WARNING: do not add a `command:` override to this
  service.** It replaces the image command/entrypoint behavior and can silently
  kill both the gateway and WhatsApp.
- **`mcp`** — runs `npm run mcp:server`, listens on port `3001`, depends on
  `openclaw`, and has a healthcheck at `GET /healthz`.
- Both services share an environment anchor that sets
  `OPENCLAW_GATEWAY_URL=http://openclaw:18789`. This lets the `mcp` container
  reach the gateway by its Compose service name. `127.0.0.1` would be the
  `mcp` container's own loopback and fails with `fetch failed`.

## MCP server

[src/mcp/server.js](src/mcp/server.js) exposes six tools over MCP:

- `execute_dev_task`
- `run_workflow`
- `list_repos`
- `create_pr`
- `get_status`
- `execute_command`

Endpoints are `GET /healthz` and `GET|POST|DELETE /mcp`. The transport is
**Streamable HTTP** (`StreamableHTTPServerTransport`), **not SSE**; choosing
SSE in an MCP client will fail. Optional bearer authentication is enabled by
setting `MCP_AUTH_TOKEN`.

`execute_command` is disabled unless `MCP_ENABLE_COMMANDS=true`, and the
requested binary must also be listed in `MCP_COMMAND_ALLOWLIST`.

## Repository structure

```
/bbx-paw-openclaw/
├── README.md                       # this file
├── package.json                    # npm scripts: install OpenClaw, generate config, docker, trigger
├── .env.example                    # every env var this repo reads
├── .gitignore
├── docker-compose.yaml              # Coolify deployment unit (.yaml — Coolify requires this extension)
├── Dockerfile                      # installs the OFFICIAL `openclaw` npm package
├── docker/
│   └── entrypoint.sh               # regenerates openclaw.json from models.yaml on boot
├── trigger.config.ts               # Trigger.dev project config
├── config/
│   ├── openclaw.config.js          # generator: models.yaml + env -> ~/.openclaw/openclaw.json
│   └── models.yaml                 # single source of truth for the 4-tier model strategy
├── src/
│   └── mcp/                        # Streamable HTTP MCP server and tool implementations
├── workflows/
│   └── trigger-jobs/
│       └── openclaw-task.js        # Trigger.dev task: BBX Chat -> OpenClaw Gateway -> BBX Chat
├── docs/
│   ├── ARCHITECTURE.md
│   ├── SETUP.md
│   └── DEPLOYMENT.md
└── workspace/                      # gitignored — OpenClaw agent workspace (mounted volume)
```

## Quick start

```bash
git clone https://github.com/dpkchohan/bbx-paw-openclaw
cd bbx-paw-openclaw
cp .env.example .env        # fill in AWS/Mongo/Trigger.dev/gateway-token values
npm install
npm run setup                # installs the OFFICIAL openclaw npm package globally
npm run generate:config      # renders ~/.openclaw/openclaw.json from config/models.yaml
openclaw onboard --install-daemon   # first-time onboarding wizard
openclaw gateway status
```

Or run everything in Docker (recommended for parity with the Coolify deploy):

```bash
npm run docker:build
npm run docker:up
npm run docker:logs
```

Full walkthrough: [docs/SETUP.md](docs/SETUP.md).

## Environment variables

See [.env.example](.env.example) for the authoritative, commented list.
Summary:

| Variable | Purpose |
| --- | --- |
| `OPENCLAW_PORT`, `OPENCLAW_GATEWAY_BIND`, `OPENCLAW_GATEWAY_TOKEN` | Gateway network/auth |
| `OPENCLAW_GATEWAY_URL` | MCP-to-gateway URL; Compose sets `http://openclaw:18789` |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Bedrock inference (all 4 tiers) + Titan embeddings — the only model credentials needed |
| `MODEL_CHEAP`, `MODEL_DEFAULT`, `MODEL_CODING`, `MODEL_CRITICAL` | 4-tier model IDs (literal values, see below) |
| `TRIGGER_API_URL`, `TRIGGER_SECRET_KEY`, `TRIGGER_PROJECT_REF` | Self-hosted Trigger.dev instance |
| `MCP_AUTH_TOKEN`, `MCP_ENABLE_COMMANDS`, `MCP_COMMAND_ALLOWLIST` | Optional MCP bearer auth and controlled command execution |
| `MONGO_URI`, `MONGO_DB_NAME`, `MONGO_PAW_JOBS_COLLECTION` | Job bookkeeping shared with BBX Chat |
| `WORKSPACE_PATH` | OpenClaw agent workspace mount |
| `BBX_CHAT_BASE_URL`, `BBX_CHAT_WEBHOOK_SECRET` | Completion callback to BBX Chat |

## 4-tier model strategy

Defined once in [config/models.yaml](config/models.yaml) and compiled into
OpenClaw's `openclaw.json` by [config/openclaw.config.js](config/openclaw.config.js).
**All four tiers now run on Amazon Bedrock's native Converse API** — a
single AWS-credentials-only setup, no other provider keys required:

| Tier | Model | Model ID | Cost / 1M tokens (in/out) | Use |
| --- | --- | --- | --- | --- |
| tier1_cheap | Amazon Nova Pro | `us.amazon.nova-pro-v1:0` | $0.80 / $3.20 | classification, extraction, routing |
| tier2_default | GPT-5.6 Luna | `global.openai.gpt-5.6-luna` | $0.22 / $1.32 | general chat, default background worker |
| tier3_coding | Claude Sonnet 4.5 | `anthropic.claude-sonnet-4-5-20250929-v1:0` | $2.00 / $10.00 | code generation/review, analysis |
| tier4_critical | Claude Sonnet 5 | `global.anthropic.claude-sonnet-5` | $2.00 / $10.00 | high-stakes decisions, long autonomous research |

**GPT-5.6 Luna via Bedrock, not the OpenAI API:** GPT-5.6 Luna is OpenAI's
model hosted directly inside Amazon Bedrock's own model catalog (vendor
prefix `openai.`), confirmed via the AWS Bedrock console (context window
272K tokens, pricing $0.22/$1.32 per 1M input/output tokens, available in
`us-east-1`/`us-east-2`/`us-west-2`). It is invoked through the same native
`amazon-bedrock` provider and `bedrock-runtime` endpoint as every other
tier — using its `global.` cross-region inference profile, exactly like
Tier 4's Claude Sonnet 5. This is **distinct from Bedrock Mantle**
(OpenClaw provider id `amazon-bedrock-mantle`), a separate OpenAI-compatible
`/v1` surface Bedrock also offers for GPT-OSS/Qwen/Kimi/GLM and a few Claude
models — Luna doesn't need Mantle because it already has a first-class
Bedrock Converse API model id. Confirm the exact inference-profile IDs for
your AWS account/region with `openclaw models list` before go-live; see
[config/models.yaml](config/models.yaml) for full sourcing notes.

## Deploying to Coolify

1. Push this repo to GitHub (already done: `dpkchohan/bbx-paw-openclaw`).
2. In Coolify, create a new resource → **Docker Compose** → point it at this
   repo's `docker-compose.yaml`.
3. Set every variable from `.env.example` in Coolify's environment editor
   (Coolify injects them the same way `.env` would).
4. Deploy. Coolify builds the `Dockerfile` (installs the official `openclaw`
   npm package) and starts both the `openclaw` gateway and `mcp` service.
5. Route the gateway to port `18789` and the public MCP service to port
   `3001`, as appropriate for the deployment.

Full steps, health checks, and rollback notes: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Trigger.dev integration

The self-hosted instance runs `@trigger.dev/sdk` v4. The correct trigger
route is:

```text
POST {TRIGGER_API_URL}/api/v1/tasks/{taskId}/trigger
body: { "payload": { ... } }
```

The old v2 route (`POST /api/v1/tasks/trigger` with
`{ taskIdentifier, payload }`) is dead and returns an HTML 404 page from the
webapp. `run_workflow` passes its `workflow_name` as the `taskId`.

`execute_dev_task` calls the OpenClaw gateway first. It only uses Trigger.dev
when `PREFER_TRIGGER_FOR_DEV_TASK` is exactly `"true"`.

A `getRun(runId)` helper exists for
`GET {TRIGGER_API_URL}/api/v1/runs/{runId}` and is exported, but is not yet
wired to an MCP tool.

[workflows/trigger-jobs/openclaw-task.js](workflows/trigger-jobs/openclaw-task.js)
defines the `openclaw-task` Trigger.dev task. The task calls the OpenClaw
Gateway's `/v1/chat/completions` endpoint, persists status/result to MongoDB,
and notifies BBX Chat via webhook when done. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#triggerdev-job) for the full
sequence diagram.

## WhatsApp channel

BBX PAW users can also message the agent directly on WhatsApp, using
OpenClaw's own official `@openclaw/whatsapp` plugin (Baileys-based) — this
repo does not implement a custom WhatsApp/Baileys client. The plugin is
installed automatically by `docker/entrypoint.sh` at container runtime, and
configured via `channels.whatsapp` in the generated `openclaw.json`
(`config/openclaw.config.js`, controlled by `OPENCLAW_WHATSAPP_*` env vars).
It runs in the `openclaw` service, not the `mcp` service.

Full setup, QR linking, headless-server QR access, and troubleshooting:
[docs/WHATSAPP-BAILEYS-SETUP.md](docs/WHATSAPP-BAILEYS-SETUP.md).

## GitHub MCP server

The Gateway can also give the agent direct access to GitHub (repos, issues,
PRs, Actions, etc.) via the **official** [github/github-mcp-server](https://github.com/github/github-mcp-server),
run as a plain stdio process spawned by the Gateway itself — not the
deprecated `@modelcontextprotocol/server-github` npm package. The
Dockerfile downloads and checksum-verifies the published Linux x86_64
binary at build time; `config/openclaw.config.js` wires it into OpenClaw's
real `mcp.servers.github` config key (not the commonly-assumed but incorrect
top-level `mcpServers`) whenever `GITHUB_PERSONAL_ACCESS_TOKEN` is set.

Full setup and troubleshooting:
[docs/GITHUB-MCP-SETUP.md](docs/GITHUB-MCP-SETUP.md).

## BBX CHAT (LibreChat) MCP Integration

- Deployed via Coolify on AWS EC2; auto-deploys on merge to `main`.
- Public MCP endpoint: `http://openclaw.pddt.in:3001/mcp`
- The AWS Security Group must allow inbound TCP `3001`.
- DNS has an A record `openclaw.pddt.in` pointing to the EC2 elastic IP.

To add it in the LibreChat UI:

1. Open **MCP Servers → Add MCP Server**.
2. Name: `BBX PAW`
3. URL: `http://openclaw.pddt.in:3001/mcp`
4. Transport: **Streamable HTTP**
5. Authentication: **None**

Private/internal hosts such as `host.docker.internal` are blocked by
LibreChat's SSRF protection unless added to `mcpSettings.allowedAddresses`
(or `allowedDomains`, which is a strict whitelist) in `librechat.yaml`.

Verified working from BBX CHAT: `list_repos` returned all 18 repositories, and
`get_status` returned `{"ready":true}` with `Gateway readiness HTTP 200`.

## Usage example

```
User (BBX Chat): "Research NASA GSFC projects and create a summary report"
  → BBX Chat triggers openclaw-task { tier: "coding" }
  → OpenClaw agent researches for ~2 hours, writes report.md to workspace/
  → Trigger.dev job persists result + calls BBX Chat webhook
  → BBX Chat notifies user: "Report ready"
```

## Status / what's implemented so far

- [x] Repo structure initialized (`config/`, `src/mcp/`, `workflows/trigger-jobs/`, `docs/`, `workspace/`)
- [x] `package.json` + npm scripts for installing the official OpenClaw package
- [x] `.env.example` with every variable this repo reads (AWS credentials only — no other provider keys)
- [x] `config/models.yaml` — 4-tier model strategy, all tiers on Amazon Bedrock, including GPT-5.6 Luna verified via the Bedrock console
- [x] `config/openclaw.config.js` — generates `openclaw.json` from the YAML + env (single `amazon-bedrock` provider block)
- [x] `Dockerfile` + `docker-compose.yaml` — Coolify-ready, installs official `openclaw` npm package, copies `src/` and runs separate gateway/MCP services from the same image
- [x] MCP server with six tools, Streamable HTTP transport, health/readiness endpoints, optional bearer auth, and guarded command execution
- [x] Trigger.dev v4 task trigger route and gateway-first `execute_dev_task` routing
- [x] `docs/ARCHITECTURE.md`, `docs/SETUP.md`, `docs/DEPLOYMENT.md`
- [x] WhatsApp channel — official `@openclaw/whatsapp` plugin (Baileys), installed at runtime, configured via `config/openclaw.config.js`, documented in `docs/WHATSAPP-BAILEYS-SETUP.md`
- [x] GitHub MCP server — official `github/github-mcp-server` binary, checksum-verified at build time, configured via `config.mcp.servers.github`, documented in `docs/GITHUB-MCP-SETUP.md`
- [ ] Confirmed `global.openai.gpt-5.6-luna` and `global.anthropic.claude-sonnet-5` cross-region profiles are invokable from the Gateway's exact AWS credentials/region
- [ ] `OPENCLAW_GATEWAY_TOKEN` and other secrets provisioned in Coolify
- [ ] BBX Chat backend wired to call `tasks.trigger("openclaw-task", ...)`
- [ ] End-to-end smoke test against the live Trigger.dev instance (`server.pddt.in`)
- [ ] WhatsApp account linked (QR scan) on the production deployment
- [ ] `GITHUB_PERSONAL_ACCESS_TOKEN` provisioned in Coolify for the production deployment

## Troubleshooting

See [docs/SETUP.md](docs/SETUP.md#troubleshooting) and
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#troubleshooting). Quick checks:

- **Only the MCP server starts; WhatsApp and the gateway are dead:** a
  `command:` override on the `openclaw` service replaced the image's
  entrypoint. Remove the override; only the `mcp` service should use
  `command: ["npm", "run", "mcp:server"]`.
- **`get_status` / `execute_dev_task` return `fetch failed`:**
  `OPENCLAW_GATEWAY_URL` was unset in the `mcp` container, so it fell back to
  `127.0.0.1:18789`. Set it to `http://openclaw:18789`.
- **Trigger.dev calls return raw HTML / 404:** the API version path is wrong.
  Use the v4 route `POST {TRIGGER_API_URL}/api/v1/tasks/{taskId}/trigger` with
  `{ "payload": { ... } }`, not the old v2 route.

```bash
openclaw doctor                 # config/health issues
openclaw gateway status         # is the Gateway running?
openclaw models list            # which Bedrock models can this account see?
curl -fsS http://127.0.0.1:18789/healthz
curl -fsS http://127.0.0.1:3001/healthz
```
