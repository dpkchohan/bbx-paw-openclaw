# Setup

## OpenClaw is official, not forked

This project installs OpenClaw exactly as published upstream:

```bash
npm install -g openclaw@latest --allow-scripts=openclaw
```

(`--allow-scripts=openclaw` is required on npm 12 / npm 11.16+ to allow
OpenClaw's own pre/post-install lifecycle scripts to run; omit the flag on
npm 11.15 and earlier.) `npm run setup` runs this for you. Nothing in this
repo patches, forks, or reimplements OpenClaw itself — `config/`,
`workflows/`, and `docker/` only *configure and operate* the official
binary/package.

## Prerequisites

- Node.js 22.22.3+, 24.15+, or 25.9+ (OpenClaw's own requirement)
- Docker + Docker Compose (for the containerized path / Coolify parity)
- AWS credentials with Bedrock model access enabled in `us-east-1`
  (`bedrock:InvokeModelWithResponseStream`, `bedrock:ListFoundationModels`)
- Access to the shared MongoDB instance used by BBX Chat (optional but
  recommended — enables job status bookkeeping)
- A Trigger.dev project on the self-hosted instance at `server.pddt.in`

## Local (non-Docker) setup

```bash
git clone https://github.com/dpkchohan/bbx-paw-openclaw
cd bbx-paw-openclaw
cp .env.example .env
# edit .env: AWS_*, OPENCLAW_GATEWAY_TOKEN, MONGO_URI, TRIGGER_*, etc.

npm install
npm run setup                 # npm install -g openclaw@latest
npm run generate:config       # writes ~/.openclaw/openclaw.json from config/models.yaml
openclaw onboard --install-daemon
openclaw gateway status
openclaw models list          # confirm Bedrock models are visible with your creds
```

Generate `OPENCLAW_GATEWAY_TOKEN` with:

```bash
openssl rand -hex 32
```

Never paste a documented example token — OpenClaw refuses to start if the
token matches a known placeholder value verbatim.

## Docker setup (recommended, mirrors Coolify)

```bash
cp .env.example .env
# fill in .env as above
npm run docker:build
npm run docker:up
npm run docker:logs
```

The container entrypoint (`docker/entrypoint.sh`) regenerates
`~/.openclaw/openclaw.json` from `config/models.yaml` on every start, then
runs `openclaw gateway --bind lan --port 18789`.

Verify:

```bash
curl -fsS http://127.0.0.1:18789/healthz
curl -fsS http://127.0.0.1:18789/v1/models -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN"
```

## Trigger.dev project setup

1. Create a project on the self-hosted dashboard at `https://server.pddt.in`.
2. Copy its **project ref** into `TRIGGER_PROJECT_REF` in `.env` and
   `trigger.config.ts`.
3. Copy the **secret key** into `TRIGGER_SECRET_KEY`.
4. From this repo:
   ```bash
   npm run trigger:dev      # local dev loop against the self-hosted instance
   npm run trigger:deploy   # deploy workflows/trigger-jobs/openclaw-task.js
   ```
5. In BBX Chat's own backend, call `tasks.trigger("openclaw-task", {...})`
   (see README "Trigger.dev integration" for the exact payload shape).

## Confirming Bedrock model IDs

The model IDs in `.env.example` for Tier 3/4 (Claude Sonnet 4.5 / Sonnet 5)
are best-effort placeholders. Confirm the exact inference-profile IDs your
AWS account can invoke:

```bash
aws bedrock list-foundation-models --region us-east-1 \
  --query "modelSummaries[?contains(modelId,'claude')].modelId"
# or, once the Gateway has credentials:
openclaw models list
```

Update `MODEL_CODING` / `MODEL_CRITICAL` in `.env` to match, then re-run
`npm run generate:config` (or restart the Docker container, which
regenerates automatically).

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `openclaw gateway status` shows not running | Gateway crashed on bad config | `openclaw doctor --fix`, check logs |
| `refusing to bind gateway ... without auth` | `OPENCLAW_GATEWAY_BIND=lan` with no token | Set `OPENCLAW_GATEWAY_TOKEN` |
| `No credentials found` from `openclaw models status` | AWS creds not visible to the Gateway process | Confirm `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION` are set in the container env |
| Trigger.dev job fails with `OpenClaw Gateway error (status 401)` | Wrong/missing `OPENCLAW_GATEWAY_TOKEN` in the Trigger.dev job's env | Set it in the Trigger.dev project's environment variables |
| Trigger.dev job fails with `ECONNREFUSED` to `openclaw:18789` | `OPENCLAW_GATEWAY_URL` doesn't resolve from Trigger.dev's network | Point it at the public Coolify domain for the Gateway instead of the Docker service name |
| `unauthorized during connect` | Auth mismatch between client and Gateway | Regenerate/align `OPENCLAW_GATEWAY_TOKEN` everywhere it's referenced |
