# BBX PAW OpenClaw Integration

**Personal Autonomous Workstation (PAW)** — a 24/7 AI agent that BBX Chat
users can hand long-running, autonomous tasks to (research, coding,
reporting) and that keeps working in the background via Trigger.dev, even
after the user closes their laptop.

This repo wires the **official [OpenClaw](https://github.com/openclaw/openclaw)**
agent gateway (installed from npm, not custom-built) into the existing BBX
infrastructure: BBX Chat, AWS Bedrock's 4-tier model strategy, Trigger.dev,
and Coolify.

> ⚠️ **Restriction honored:** OpenClaw is installed as the published
> `openclaw` npm package (`npm install -g openclaw@latest`). This repo does
> **not** vendor, fork, or reimplement OpenClaw — it only configures and
> operates it. See [docs/SETUP.md](docs/SETUP.md#openclaw-is-official-not-forked).

## Table of contents

- [What BBX PAW does](#what-bbx-paw-does)
- [Architecture](#architecture)
- [Repository structure](#repository-structure)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [4-tier model strategy](#4-tier-model-strategy)
- [Deploying to Coolify](#deploying-to-coolify)
- [Trigger.dev integration](#triggerdev-integration)
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

## Repository structure

```
/bbx-paw-openclaw/
├── README.md                       # this file
├── package.json                    # npm scripts: install OpenClaw, generate config, docker, trigger
├── .env.example                    # every env var this repo reads
├── .gitignore
├── docker-compose.yml              # Coolify deployment unit
├── Dockerfile                      # installs the OFFICIAL `openclaw` npm package
├── docker/
│   └── entrypoint.sh               # regenerates openclaw.json from models.yaml on boot
├── trigger.config.ts               # Trigger.dev v3 project config
├── config/
│   ├── openclaw.config.js          # generator: models.yaml + env -> ~/.openclaw/openclaw.json
│   └── models.yaml                 # single source of truth for the 4-tier model strategy
├── workflows/
│   └── trigger-jobs/
│       └── openclaw-task.js        # Trigger.dev v3 task: BBX Chat -> OpenClaw Gateway -> BBX Chat
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
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Bedrock inference + Titan embeddings |
| `MODEL_CHEAP`, `MODEL_DEFAULT`, `MODEL_CODING`, `MODEL_CRITICAL` | 4-tier model IDs (literal values, see below) |
| `OPENAI_API_KEY` | Auth for Tier 2 (`gpt-5.6-luna`), served directly by `https://api.openai.com/v1` — not a Bedrock model |
| `TRIGGER_API_URL`, `TRIGGER_SECRET_KEY`, `TRIGGER_PROJECT_REF` | Self-hosted Trigger.dev instance |
| `MONGO_URI`, `MONGO_DB_NAME`, `MONGO_PAW_JOBS_COLLECTION` | Job bookkeeping shared with BBX Chat |
| `WORKSPACE_PATH` | OpenClaw agent workspace mount |
| `BBX_CHAT_BASE_URL`, `BBX_CHAT_WEBHOOK_SECRET` | Completion callback to BBX Chat |

## 4-tier model strategy

Defined once in [config/models.yaml](config/models.yaml) and compiled into
OpenClaw's `openclaw.json` by [config/openclaw.config.js](config/openclaw.config.js):

| Tier | Model | Provider | Cost / 1M tokens | Use |
| --- | --- | --- | --- | --- |
| tier1_cheap | `us.amazon.nova-pro-v1:0` | Bedrock | $0.80 | classification, extraction, routing |
| tier2_default | `gpt-5.6-luna` | OpenAI (`https://api.openai.com/v1`) | $0.22 | general chat, default background worker |
| tier3_coding | `anthropic.claude-sonnet-4-5-20250929-v1:0` | Bedrock | $2.00 | code generation/review, analysis |
| tier4_critical | `global.anthropic.claude-sonnet-5` | Bedrock | $2.00 | high-stakes decisions, long autonomous research |

**Read this before deploying:** AWS Bedrock does not host OpenAI models, so
Tier 2 (`gpt-5.6-luna`) is served directly by the official OpenAI API using
`OPENAI_API_KEY` — not Bedrock. Tier 4's `global.anthropic.claude-sonnet-5`
uses a cross-region inference-profile prefix (`global.`); confirm exact
availability for your AWS account/region with `openclaw models list` before
go-live. All four model ids live in [config/models.yaml](config/models.yaml)
as the single source of truth.

## Deploying to Coolify

1. Push this repo to GitHub (already done: `dpkchohan/bbx-paw-openclaw`).
2. In Coolify, create a new resource → **Docker Compose** → point it at this
   repo's `docker-compose.yml`.
3. Set every variable from `.env.example` in Coolify's environment editor
   (Coolify injects them the same way `.env` would).
4. Deploy. Coolify builds the `Dockerfile` (installs the official `openclaw`
   npm package) and starts the `openclaw` service on the port from
   `OPENCLAW_PORT` (default `18789`).
5. Attach a domain/SSL in Coolify pointing at the container's port; this
   becomes the Gateway URL BBX Chat and Trigger.dev call.

Full steps, health checks, and rollback notes: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Trigger.dev integration

[workflows/trigger-jobs/openclaw-task.js](workflows/trigger-jobs/openclaw-task.js)
defines the `openclaw-task` Trigger.dev v3 task. BBX Chat's backend triggers
it like this:

```js
import { tasks } from "@trigger.dev/sdk";

const handle = await tasks.trigger("openclaw-task", {
  prompt: "Research NASA GSFC projects and create a summary report",
  tier: "coding",
  sessionKey: `bbx-user-${userId}`,
  userId,
  deliver: { webhookUrl: `${BBX_CHAT_BASE_URL}/api/jobs/webhook` },
});
```

The task calls the OpenClaw Gateway's `/v1/chat/completions` endpoint,
persists status/result to MongoDB, and notifies BBX Chat via webhook when
done. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#triggerdev-job) for
the full sequence diagram.

## Usage example

```
User (BBX Chat): "Research NASA GSFC projects and create a summary report"
  → BBX Chat triggers openclaw-task { tier: "coding" }
  → OpenClaw agent researches for ~2 hours, writes report.md to workspace/
  → Trigger.dev job persists result + calls BBX Chat webhook
  → BBX Chat notifies user: "Report ready"
```

## Status / what's implemented so far

- [x] Repo structure initialized (`config/`, `workflows/trigger-jobs/`, `docs/`, `workspace/`)
- [x] `package.json` + npm scripts for installing the official OpenClaw package
- [x] `.env.example` with every variable this repo reads (including `OPENAI_API_KEY`)
- [x] `config/models.yaml` — 4-tier model strategy with confirmed literal model IDs and providers
- [x] `config/openclaw.config.js` — generates `openclaw.json` from the YAML + env
- [x] `Dockerfile` + `docker-compose.yml` — Coolify-ready, installs official `openclaw` npm package
- [x] `workflows/trigger-jobs/openclaw-task.js` — Trigger.dev v3 task calling the Gateway
- [x] `docs/ARCHITECTURE.md`, `docs/SETUP.md`, `docs/DEPLOYMENT.md`
- [ ] Confirmed `global.anthropic.claude-sonnet-5` cross-region profile is invokable in your AWS account/region
- [ ] `OPENCLAW_GATEWAY_TOKEN`, `OPENAI_API_KEY`, and other secrets provisioned in Coolify
- [ ] BBX Chat backend wired to call `tasks.trigger("openclaw-task", ...)`
- [ ] End-to-end smoke test against the live Trigger.dev instance (`server.pddt.in`)

## Troubleshooting

See [docs/SETUP.md](docs/SETUP.md#troubleshooting) and
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#troubleshooting). Quick checks:

```bash
openclaw doctor                 # config/health issues
openclaw gateway status         # is the Gateway running?
openclaw models list            # which Bedrock models can this account see?
curl -fsS http://127.0.0.1:18789/healthz
```

