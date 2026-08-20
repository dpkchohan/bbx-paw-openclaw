# Deployment (Coolify)

## Target

- Platform: **Coolify**
- Host: same AWS EC2 instance already running BBX Chat
- Unit: a separate Docker Compose resource (`docker-compose.yml` in this
  repo), running as its own container(s) alongside BBX Chat's, not merged
  into BBX Chat's stack.

## One-time setup

1. **Push to GitHub** (already the case): `dpkchohan/bbx-paw-openclaw`.
2. In Coolify: **New Resource → Docker Compose** (or "Docker Compose
   based application") → connect the GitHub repo → branch `main`.
3. Point Coolify's build/deploy config at the repo root — it will pick up
   `docker-compose.yml` and `Dockerfile` automatically.
4. In Coolify's **Environment Variables** tab, add every variable listed in
   `.env.example`. At minimum for a working deploy:
   - `OPENCLAW_GATEWAY_TOKEN` (generate with `openssl rand -hex 32`)
   - `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
   - `OPENAI_API_KEY` (required for Tier 2 / `gpt-5.6-luna`, served by `https://api.openai.com/v1`)
   - `MODEL_CHEAP`, `MODEL_DEFAULT`, `MODEL_CODING`, `MODEL_CRITICAL`
   - `MONGO_URI` (BBX Chat's existing MongoDB connection string)
   - `TRIGGER_API_URL`, `TRIGGER_SECRET_KEY`
5. Configure **persistent volumes** in Coolify for:
   - `OPENCLAW_CONFIG_DIR` → `/home/node/.openclaw`
   - `OPENCLAW_WORKSPACE_DIR` → `/home/node/.openclaw/workspace`
   - `OPENCLAW_AUTH_PROFILE_SECRET_DIR` → `/home/node/.config/openclaw`

   These must survive redeploys — losing them wipes agent memory, session
   state, and any in-progress workspace files.
6. Set the exposed port to `${OPENCLAW_PORT:-18789}` and attach a
   subdomain + SSL (Coolify handles Let's Encrypt automatically), e.g.
   `paw.bharatbaas.com`.
7. Click **Deploy**. Coolify builds the `Dockerfile` (installs the official
   `openclaw` npm package — see `docs/SETUP.md`), starts the container, and
   runs the built-in healthcheck against `/healthz`.

## CI/CD

Coolify's GitHub integration redeploys automatically on push to `main`
(same model as BBX Chat's existing pipeline). No separate GitHub Actions
workflow is required for the container itself; add one later if you want
pre-deploy checks (e.g. `node --check` on the Trigger.dev job files, `npm
run generate:config -- --print` as a config-lint step).

## Connecting Trigger.dev to the deployed Gateway

Once the Coolify domain is live (e.g. `https://paw.bharatbaas.com`):

1. Set `OPENCLAW_GATEWAY_URL=https://paw.bharatbaas.com` in the
   **Trigger.dev project's** environment variables (not just this repo's
   `.env`) — `workflows/trigger-jobs/openclaw-task.js` reads it from the
   Trigger.dev job's own runtime environment.
2. Set the matching `OPENCLAW_GATEWAY_TOKEN` there too.
3. Deploy the task: `npm run trigger:deploy`.
4. Smoke test from BBX Chat staging by triggering a small `tier: "cheap"`
   job end-to-end before wiring up `tier: "critical"` production paths.

## Post-deploy verification

```bash
curl -fsS https://paw.bharatbaas.com/healthz
curl -fsS https://paw.bharatbaas.com/v1/models \
  -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN"
```

Expect `/v1/models` to list `openclaw/default` plus every model id declared
in `config/models.yaml`.

## Rollback

Coolify keeps prior deployments; use its **Rollback** action to redeploy
the last known-good image. Because state (`workspace/`, `.openclaw/`) lives
in mounted volumes rather than the image, rolling back the container image
does not lose in-progress agent workspace data.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Healthcheck failing after deploy | Check `openclaw doctor` output in container logs; usually a bad/missing env var |
| Gateway unreachable from Coolify's proxy | Confirm `OPENCLAW_GATEWAY_BIND=lan` (not `loopback`) and the exposed port matches `OPENCLAW_PORT` |
| Volumes reset on redeploy | Confirm Coolify's persistent storage paths match `docker-compose.yml`'s volume targets exactly |
| Trigger.dev jobs time out | Increase `maxDuration` in `workflows/trigger-jobs/openclaw-task.js` (currently 3 hours) or check Bedrock throttling/quota |
