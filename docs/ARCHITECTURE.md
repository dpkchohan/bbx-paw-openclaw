# Architecture

## Overview

BBX PAW connects four systems that already exist independently:

1. **BBX Chat** (`https://chat.bharatbaas.com`) — LibreChat-based chat app,
   MongoDB, S3 uploads, Bedrock/Claude/Tavily, deployed via Coolify.
2. **Trigger.dev** (`https://server.pddt.in`) — self-hosted background job
   runner, 8 Docker containers, already integrated with BBX Chat for
   Bedrock workflows.
3. **AWS Bedrock** (`us-east-1`) — 4-tier model strategy, all on Bedrock's
   native Converse API (Amazon Nova Pro / GPT-5.6 Luna / Claude Sonnet 4.5 /
   Claude Sonnet 5).
4. **OpenClaw** (this repo) — the official open-source personal AI assistant
   gateway, installed from npm, configured to use the above three.

## Component diagram

```
                         ┌─────────────────────────┐
                         │        BBX Chat          │
                         │  chat.bharatbaas.com      │
                         │  (LibreChat, MongoDB, S3) │
                         └───────────┬───────────────┘
                                     │ POST /api/jobs/trigger
                                     │ tasks.trigger("openclaw-task", {...})
                                     ▼
                         ┌─────────────────────────┐
                         │      Trigger.dev          │
                         │  server.pddt.in            │
                         │  (self-hosted, 8 containers)│
                         └───────────┬───────────────┘
                                     │ runs workflows/trigger-jobs/openclaw-task.js
                                     ▼
        ┌────────────────────────────────────────────────────┐
        │           OpenClaw Gateway container                │
        │           (this repo, Coolify, EC2)                 │
        │                                                      │
        │  POST /v1/chat/completions                           │
        │  Authorization: Bearer OPENCLAW_GATEWAY_TOKEN        │
        │  x-openclaw-model: <tier-specific model ref>         │
        └───────┬───────────────────────────────┬──────────────┘
                │                               │
                ▼                               ▼
     ┌─────────────────────┐        ┌───────────────────────────┐
     │   AWS Bedrock         │        │ workspace/ (Docker volume)│
     │   us-east-1            │        │ agent files + local SQLite│
     │   4-tier models        │        │ session/memory state       │
     └─────────────────────┘        └───────────────────────────┘
                │
                ▼
     ┌─────────────────────┐
     │  MongoDB (shared)     │
     │  paw_jobs collection  │
     └───────────┬───────────┘
                 │
                 ▼
     ┌─────────────────────┐
     │  BBX Chat webhook /   │
     │  GET /api/jobs/:jobId │
     │  "Report ready"        │
     └─────────────────────┘
```

## Trigger.dev job

`workflows/trigger-jobs/openclaw-task.js` exports the `openclaw-task`
Trigger.dev v3 task:

1. Validates the payload (`prompt` required; `tier`, `sessionKey`, `userId`,
   `modelOverride`, `deliver.webhookUrl` optional).
2. Writes a `running` row to MongoDB (`paw_jobs` collection) keyed by the
   Trigger.dev run id.
3. Calls `POST {OPENCLAW_GATEWAY_URL}/v1/chat/completions` with:
   - `Authorization: Bearer OPENCLAW_GATEWAY_TOKEN`
   - `x-openclaw-model: <tier ref>` (e.g. `amazon-bedrock/us.anthropic.claude-sonnet-4-5-...`)
   - `user: "conv:<sessionKey>"` so repeated calls with the same
     `sessionKey` continue the same OpenClaw agent session/conversation.
4. On success/failure, updates MongoDB and — if `deliver.webhookUrl` was
   given — POSTs `{ jobId, status, result|error }` to BBX Chat.
5. `maxDuration` is 3 hours to accommodate long autonomous research runs
   (per the "spends 2 hours researching" example in the project brief).

## Why OpenClaw's storage stays SQLite (not MongoDB)

OpenClaw's own control-plane and per-agent state (`~/.openclaw/state/openclaw.sqlite`
and `~/.openclaw/agents/<id>/agent/openclaw-agent.sqlite`) is **always
SQLite** — this is a hard architectural fact of the upstream project, not a
configuration choice, and there is no supported way to point it at MongoDB.
`MONGO_URI` in this repo is therefore used only by our own
`openclaw-task.js` for **job bookkeeping shared with BBX Chat** (status
polling, history) — it never touches OpenClaw's internal state.

## Gateway configuration generation

`config/models.yaml` is the single source of truth for the 4-tier model
strategy. `config/openclaw.config.js` reads it plus `process.env` and
writes `~/.openclaw/openclaw.json` (JSON5). The Docker entrypoint
(`docker/entrypoint.sh`) runs this generator on every container start so a
stale mounted `.openclaw/` volume never drifts from the checked-in model
strategy. All four tiers compile into a single `amazon-bedrock` provider
block — see the header comments in both files for the exact model ids
(including GPT-5.6 Luna's `global.openai.gpt-5.6-luna` cross-region
inference profile, confirmed via the AWS Bedrock console) and notes on
reconfirming inference-profile availability per AWS account/region.

## Ports and network

| Port | Purpose |
| --- | --- |
| `18789` (default, `OPENCLAW_PORT`) | Gateway WS + HTTP multiplexed (Control UI, CLI, OpenAI-compatible API) |

The Gateway binds to `lan` (`0.0.0.0`) inside the container so Docker
bridge networking / Coolify's reverse proxy can reach it; `OPENCLAW_GATEWAY_TOKEN`
is mandatory whenever binding beyond loopback.
