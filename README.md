# BBX PAW — OpenClaw + MCP

AI orchestration layer for BBX Chat. Exposes OpenClaw (agent gateway), WhatsApp
inbound, and Trigger.dev workflows to LibreChat over the Model Context Protocol.

## Architecture

```
BBX Chat (chat.bharatbaas.com)  ──┐
                                  ├─► MCP :3001  (mcp container)
WhatsApp (Baileys)  ──────────────┤        │
                                  │        └─► OPENCLAW_GATEWAY_URL=http://openclaw:18789
                                  └─► OpenClaw Gateway :18789 (openclaw container)
                                             ↓
                                    GitHub / AWS Bedrock / Trigger.dev
```

Two containers, **one image**, sharing the Compose default network.

| Service | Port | Entrypoint | Healthcheck |
|---|---|---|---|
| `openclaw` | `18789` | image ENTRYPOINT (gateway + WhatsApp) | `/readyz` |
| `mcp` | `3001` | `npm run mcp:server` | `/healthz` |

Config is shared via YAML anchors (`&openclaw-build`, `&openclaw-environment`,
`&openclaw-volumes`) so both containers stay in lockstep.

> ⚠️ **Never add a `command:` key to the `openclaw` service.** It replaces the
> image ENTRYPOINT, which silently kills the gateway *and* WhatsApp. See
> Troubleshooting → Bug 1.

## MCP Tools

| Tool | Status | Notes |
|---|---|---|
| `list_repos` | ✅ verified | Lists repos visible to the GitHub token |
| `get_status` | ✅ verified | Gateway readiness via `/readyz` |
| `run_workflow` | ✅ verified | Triggers a Trigger.dev task, returns run ID |
| `create_pr` | ✅ verified | Branch + commit + PR in one call |
| `execute_dev_task` | ⚠️ partial | Reachable, but synchronous — see below |
| `execute_command` | 🔒 disabled | Needs `MCP_ENABLE_COMMANDS=true` + `MCP_COMMAND_ALLOWLIST` |

### `execute_dev_task` timeout

Synchronous by design. MCP clients typically abort around **60s**, so any
non-trivial coding task returns `MCP error -32001: Request timed out` even
though the gateway keeps working. Use WhatsApp for long-running tasks until an
async run-and-poll flow is wired up.

Routing: the gateway is tried **first**, unless
`PREFER_TRIGGER_FOR_DEV_TASK=true`.

## BBX CHAT MCP Integration

Add via LibreChat UI → **MCP Servers** → *Add MCP Server*:

| Field | Value |
|---|---|
| Name | `BBX PAW` |
| URL | `http://openclaw.pddt.in:3001/mcp` |
| Transport | **Streamable HTTP** |
| Auth | None |

> ⚠️ **Streamable HTTP is required — SSE will fail.** The server uses
> `StreamableHTTPServerTransport`.
>
> ⚠️ Use the **public URL**. `host.docker.internal:3001` is rejected with
> *"MCP server domain is not in allowed domain list"* (LibreChat SSRF guard);
> bypassing it would require `mcpSettings.allowedAddresses` in `librechat.yaml`.

Port `3001` must be open in the EC2 security group — this is the single most
common cause of "server not accessible".

## Trigger.dev (v4)

Self-hosted at `https://server.pddt.in`. **The trigger and read endpoints sit on
different version prefixes** — this is not a typo:

| Action | Endpoint |
|---|---|
| Trigger | `POST /api/v1/tasks/{taskId}/trigger` — body `{ "payload": { ... } }` |
| Read run | `GET /api/v3/runs/{runId}` |
| Batch | `POST /api/v1/tasks/{taskId}/batch-trigger` — body `{ "items": [...] }` |
| Cancel | `POST /api/v1/runs/{runId}/cancel` |

The v2 route is dead and returns an **HTML** body, so responses are checked for
HTML and converted into a readable error rather than a JSON parse failure.

### Environment scoping (important)

A secret key encodes org + project + **environment**. A `tr_dev_*` key can only
see Development runs; `tr_prod_*` only Production.

v4 does **not** validate that a task exists in the target environment. Triggering
a Production-only task with a Development key returns a happy `200` and a real
run ID — then the run sits unclaimed until its **10-minute TTL** expires:

```json
{ "status": "EXPIRED", "attemptCount": 0, "attempts": [],
  "error": { "message": "Run expired because the TTL (10m) was reached" } }
```

**`attemptCount: 0` with an empty `attempts` array means no worker ever picked
the run up** — it is never a task-code or Bedrock error.

A healthy run looks like this (`region` resolves to a real worker pool, and
`version` matches the deployed worker):

```json
{ "status": "COMPLETED", "isSuccess": true, "attemptCount": 1,
  "version": "20260823.1", "region": "bootstrap", "durationMs": 963 }
```

If `region` is an opaque ID instead of a named pool, the run was queued where no
worker exists.

## Environment Variables

| Variable | Purpose |
|---|---|
| `OPENCLAW_GATEWAY_URL` | Defaults to `http://openclaw:18789`. **Must not** fall back to loopback — `127.0.0.1` resolves to the *mcp* container itself. |
| `TRIGGER_API_URL` | `https://server.pddt.in` |
| `TRIGGER_SECRET_KEY` | Use the `tr_prod_*` key for deployed tasks |
| `PREFER_TRIGGER_FOR_DEV_TASK` | Leave unset/`false` to keep dev tasks on the gateway |
| `MCP_ENABLE_COMMANDS` | `true` to enable `execute_command` |
| `MCP_COMMAND_ALLOWLIST` | Comma-separated allowlist |
| `OPENCLAW_GATEWAY_TOKEN` | Currently unset; gateway warns while bound `--bind lan` |

## Troubleshooting

### Bug 1 — gateway and WhatsApp both dead

**Symptom:** MCP responds on `3001`, but `18789` refuses connections and no
WhatsApp messages arrive.

**Cause:** `command: ["npm","run","mcp:server"]` on the `openclaw` service
replaced the image ENTRYPOINT, so only the MCP server started.

**Fix:** remove the `command:` override from `openclaw`; run MCP as a separate
`mcp` service off the same image. Healthy logs show all three:
`[gateway] ready`, `[whatsapp] Listening for WhatsApp inbound messages`,
`[mcp] listening on http://0.0.0.0:3001/mcp`.

### Bug 2 — `Trigger.dev 404` with an HTML body

**Symptom:** `execute_dev_task` / `run_workflow` fail with a 404 whose body is
HTML, not JSON.

**Cause:** the dead v2 API route. The Remix frontend answers unmatched paths
with an HTML 404 page (`No route matches URL ...`).

**Fix:** use the v4 routes above and detect HTML bodies explicitly.

### Bug 3 — `get_status` returns `fetch failed`

**Symptom:** gateway is up, but the MCP tool cannot reach it.

**Cause:** the fallback `http://127.0.0.1:18789` is the *mcp* container's own
loopback.

**Fix:** set `OPENCLAW_GATEWAY_URL=http://openclaw:18789`. Compose
service-name DNS works even when `container_name` is set — verified with
`getent hosts openclaw`.

### Bug 4 — runs trigger successfully but never execute

**Symptom:** `200` + run ID, but the Production Runs dashboard stays on the
"How to run your tasks" empty state.

**Cause:** a Development key was in use, so runs were created in the wrong
environment where no worker knows the task.

**Fix:** swap `TRIGGER_SECRET_KEY` to the `tr_prod_*` key and redeploy. To
confirm which environment a run landed in, query it with the *old* key — a
`{"error":"Not found"}` response proves it is no longer in that environment.

### Windows / PowerShell notes

- Use `curl.exe`, not `curl` — the bare name aliases to `Invoke-WebRequest` and
  mangles `-H`.
- PowerShell rejects `&&`; chain with `;` or separate lines.
- `.pem` files need permissions repaired before SSH:
  `icacls <file> /inheritance:r /grant:r "$env:USERNAME`:F"`

## Known Issues

- `getRun()` targets `/api/v1/runs/{runId}`, which returns an HTML 404. It needs
  to move to `/api/v3/runs/{runId}` before being wired to a `get_run_status`
  tool for polling async runs.
- `execute_dev_task` remains synchronous (see above).
