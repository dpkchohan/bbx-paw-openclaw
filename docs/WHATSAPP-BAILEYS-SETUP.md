# WhatsApp Channel Setup (Baileys, via OpenClaw's official plugin)

## Why there's no custom Baileys code in this repo

OpenClaw already ships a production-ready WhatsApp channel built on
[Baileys](https://github.com/WhiskeySockets/Baileys) internally, distributed
as the official `@openclaw/whatsapp` plugin. Its own docs state: *"Status:
production-ready via WhatsApp Web (Baileys). The gateway owns the linked
session(s); there is no separate Twilio WhatsApp channel."*

This project's core rule — use the official OpenClaw package, don't
reimplement its functionality — applies here exactly as it does to OpenClaw
itself: we **install and configure** the official WhatsApp plugin, we do
**not** hand-roll a second, independent `@whiskeysockets/baileys` client.
Running two separate Baileys sessions against the same WhatsApp number would
duplicate work and risk kicking one session offline (WhatsApp Web caps how
many devices can stay linked to one number).

Everything below is verified against a real, running container built from
this repo's `Dockerfile` — not simulated.

## What this repo actually changed

| File | Change |
| --- | --- |
| `docker/entrypoint.sh` | Installs `@openclaw/whatsapp` from **npm** (not ClawHub) at **container runtime** (after the volume mounts), idempotently, on every start |
| `config/openclaw.config.js` | Generates the real `channels.whatsapp` config block (`enabled`, `dmPolicy`, `groupPolicy`, `allowFrom`, optional `accounts.default.authDir`), plus a `plugins.allow` / `plugins.entries` block that explicitly trusts the `amazon-bedrock` and `whatsapp` external plugins |
| `.env.example` | New optional `OPENCLAW_CHANNEL_WHATSAPP_ENABLED` / `OPENCLAW_WHATSAPP_*` vars |

No `src/channels/whatsapp.js`, no `@whiskeysockets/baileys`/`qrcode-terminal`
npm dependency, and no changes to `src/index.js` (this repo has no such
file — OpenClaw's own `openclaw gateway` process is the entire runtime; see
`docker/entrypoint.sh`'s `CMD`).

## Why "plugins: { allow, entries }" is in the generated config

Confirmed via a live container boot: without it, the Gateway logs this
warning on every start (the exact wording OpenClaw used, close to but not
identical to earlier reports of this issue):

```
[plugins] plugins.allow is empty; discovered non-bundled plugins may
auto-load: amazon-bedrock (...), whatsapp (...). To trust them explicitly,
set plugins.allow in openclaw.json (e.g. "plugins": { "allow":
["amazon-bedrock", "whatsapp"] })
```

`config/openclaw.config.js` now generates:

```json5
{
  plugins: {
    allow: ["amazon-bedrock", "whatsapp"],
    entries: {
      "amazon-bedrock": { enabled: true },
      whatsapp: { enabled: true },
    },
    bundledDiscovery: "compat",
  },
}
```

`bundledDiscovery: "compat"` is required alongside `plugins.allow` --
confirmed via a live `openclaw doctor` run: setting `plugins.allow` without
it triggers a second warning ("Legacy config keys detected: plugins.allow
now gates bundled provider discovery by default") and, confirmed via
`openclaw plugins list` / `openclaw doctor`'s Plugins summary, silently
disables several optional **bundled** feature plugins this repo never
uses: browser automation, Canvas, device pairing, file-transfer, local
Ollama models, phone control, and Talk voice. None of those are referenced
anywhere in this repo -- this Gateway only needs Bedrock inference,
`memory-core` (for `agents.defaults.memorySearch`), and the WhatsApp
channel -- so losing them is an acceptable, in fact leaner, result.
`bundledDiscovery: "compat"` is the doctor-recommended setting to
acknowledge and quiet that second warning.

## Why the plugin installs at runtime, not in the Dockerfile

`openclaw plugins install @openclaw/whatsapp` resolves and installs from
**npm**, under `$OPENCLAW_STATE_DIR/npm/projects/<hash>/node_modules/@openclaw/whatsapp`
— confirmed directly from the plugin installer's own log line:

```
Resolved @openclaw/whatsapp to @openclaw/whatsapp@2026.9.7, but that version
is incompatible with this OpenClaw runtime; using newest compatible
@openclaw/whatsapp@2026.8.2.
Installing @openclaw/whatsapp into:
/home/node/.openclaw/npm/projects/openclaw-whatsapp-<hash>…
```

**Why npm, not `clawhub:@openclaw/whatsapp`:** ClawHub's installer always
resolves to the single newest published release and hard-fails if that
release requires a newer OpenClaw core than this image pins — confirmed
live:

```
Plugin "@openclaw/whatsapp" requires plugin API >=2026.9.7, but this
OpenClaw runtime exposes 2026.8.2.
```

The npm resolver is compatibility-aware: given the same "latest is
2026.9.7" situation, it automatically walks back and installs the newest
`@openclaw/whatsapp` release that actually satisfies this core's pinned
version (2026.8.2 in this image). `docker/entrypoint.sh` therefore installs
via the plain npm spec `@openclaw/whatsapp` (never a version-pinned or
`clawhub:`-prefixed spec), with `--accept-capabilities` (there is no TTY in
the entrypoint to answer the interactive capability-consent prompt this
plugin otherwise requires).

`/home/node/.openclaw` is exactly the directory `docker-compose.yaml`
bind-mounts from the host (`OPENCLAW_CONFIG_DIR`), and `npm/projects/` lives
inside it — so this install, like the WhatsApp session itself, survives
container restarts and redeploys with no extra volume needed. If the
plugin were installed during `docker build` instead, that install would be
**silently wiped out** the instant the (initially empty) host volume mounts
over `/home/node/.openclaw` at container start — so `docker/entrypoint.sh`
installs it after the volume is live, guarded by `openclaw plugins inspect
whatsapp` (not a hardcoded directory path — the install location is an npm
implementation detail that has already changed once) so it only installs
once and then persists across every future restart.

## Where the session lives (and why no extra Docker volume is needed)

Confirmed by reading the plugin's own source (`resolveDefaultWebAuthDir()`
in `auth-store-*.js`):

```
resolveDefaultWebAuthDir() = path.join(resolveOAuthDir(), "whatsapp", "default")
resolveOAuthDir()          = path.join(OPENCLAW_STATE_DIR, "credentials")   // or $OPENCLAW_OAUTH_DIR override
```

So with this repo's `OPENCLAW_STATE_DIR=/home/node/.openclaw` (set in the
Dockerfile), the real default session path is:

```
/home/node/.openclaw/credentials/whatsapp/default/creds.json
```

That's already **inside** the `.openclaw` directory `docker-compose.yaml`
bind-mounts to `${OPENCLAW_CONFIG_DIR:-./.openclaw}` on the host — so the
WhatsApp session survives `docker compose down && docker compose up` and
container restarts automatically, with no additional bind mount, volume
declaration, or Docker change required. Set `OPENCLAW_WHATSAPP_AUTH_DIR`
(see `.env.example`) only if you want to relocate it elsewhere.

## First-time setup

> **⚠️ Always run OpenClaw CLI commands as `gosu node`, never as the raw
> container user.** This image's entrypoint runs as root only to fix
> volume ownership and config generation, then drops to the unprivileged
> `node` user (`exec gosu node openclaw gateway ...`) for the actual
> long-running Gateway process (confirmed: `ps` inside the container shows
> `openclaw-gateway` running as `uid=1000`/`node`, while PID 1 and `tini`
> are `uid=0`/root). **A plain `docker exec <container> <cmd>` — including
> Coolify's built-in "Open Terminal" button — attaches as root**, since
> there is deliberately no `USER node` directive before `ENTRYPOINT` (the
> ownership fix-up needs root). If you run `openclaw channels login`,
> `openclaw plugins install`, etc. without prefixing `gosu node`, OpenClaw
> writes `openclaw.json` and the WhatsApp credential files
> (`.openclaw/credentials/whatsapp/<account>/*`, including `creds.json` at
> mode `600`) as **root:root** — files the actual Gateway process (running
> as `node`) then cannot read. Symptom: QR pairing visibly succeeds and
> "auth saved" is logged, but `openclaw channels status --channel whatsapp
> --probe` keeps reporting `not linked, stopped` indefinitely, with no
> WhatsApp-specific error in the logs (the Gateway silently gets `EACCES`
> trying to read its own config/credentials and falls back to its last
> good in-memory state). If this happens, see **"Recovering from a
> root-owned config/credentials mix-up"** below — do not delete or
> re-pair the WhatsApp session to fix it, the credentials are fine, only
> their ownership is wrong.


1. Fill in `.env` (at minimum `OPENCLAW_GATEWAY_TOKEN`, AWS credentials).
   Optionally set `OPENCLAW_WHATSAPP_DM_POLICY` /
   `OPENCLAW_WHATSAPP_ALLOW_FROM` — defaults are `dmPolicy: "pairing"`
   (safe: unknown senders must be approved) and `groupPolicy: "disabled"`.
2. Start the container:
   ```bash
   npm run docker:up
   npm run docker:logs
   ```
   On first boot you'll see the entrypoint install the plugin:
   ```
   [entrypoint] Installing WhatsApp channel plugin (@openclaw/whatsapp) ...
   Installed plugin: whatsapp
   ```
3. Link the WhatsApp account (interactive, requires a shell into the
   container — see the headless section below if you don't have one):
   ```bash
   docker exec -it bbx-paw-openclaw gosu node openclaw channels login --channel whatsapp
   ```
   This prints a real scannable QR directly in the terminal — verified output:
   ```
   Waiting for WhatsApp connection...
   Open the WhatsApp app, go to Linked Devices, then scan this QR:
    ▄▄▄▄▄▄▄   ▄  ▄  ▄    ▄▄ ▄▄   ▄▄   ▄     ▄▄▄▄    ▄   ▄▄ ▄  ▄▄▄▄▄▄▄
    █ ▄▄▄ █ ▄ █▄ ▀▄▄▀ █▀▄█▄▀▄▄  ▀█▀█ ▀▄█ ▀▀█ ▄█▄▄▀▄▄ ▀▀▀▄ ▄ █ █ ▄▄▄ █
    ...
   ```
   On your phone: WhatsApp → **Settings → Linked Devices → Link a Device**,
   then scan. The QR expires after roughly 20-60 seconds — rerun the login
   command if it does.
4. Once scanned, the CLI reports the connection and the session is written
   to `.openclaw/credentials/whatsapp/default/creds.json` on the host.
5. If `dmPolicy: "pairing"` (default), the first message from a new number
   creates a pending approval request. Approve it:
   ```bash
   docker exec bbx-paw-openclaw gosu node openclaw pairing list whatsapp
   docker exec bbx-paw-openclaw gosu node openclaw pairing approve whatsapp <CODE>
   ```
   Requests expire after 1 hour; up to 3 pending requests per account.

## How to access the QR if the server has no console access

Three verified options, in order of convenience:

1. **Control UI (recommended for headless/remote hosts).** The plugin
   renders the QR as a PNG and pushes it over the Gateway's own protocol —
   confirmed in the plugin's source (`renderQrPngDataUrl`,
   `login-qr-runtime.js`). Open `openclaw dashboard` (or the Control UI URL
   Coolify exposes for this container) while a login is in progress and the
   QR image appears there — no terminal access needed at all.
2. **SSH + `docker exec -it`.** If you can SSH into the host but not attach
   a local terminal directly, run the same login command over SSH:
   ```bash
   ssh your-coolify-host
   docker exec -it bbx-paw-openclaw gosu node openclaw channels login --channel whatsapp
   ```
   The ASCII QR renders fine over SSH.
3. **`docker logs -f` in a second terminal + `docker exec` in a first.**
   Start `docker logs -f bbx-paw-openclaw` in one session so you can watch
   Gateway output, then run the login command in a second session — useful
   when you want to correlate the QR with connection-state log lines.

Do **not** rely on screenshotting the QR and sending it elsewhere (Slack,
email, etc.) — it expires quickly and OpenClaw's own docs warn that
"terminal-rendered QRs, screenshots, or chat attachments can expire in
transit."

## Multiple / named accounts

```bash
docker exec bbx-paw-openclaw gosu node openclaw channels add --channel whatsapp --account work --auth-dir /home/node/.openclaw/whatsapp-session-work
docker exec -it bbx-paw-openclaw gosu node openclaw channels login --channel whatsapp --account work
```

## Troubleshooting reconnection issues

| Symptom | Cause / fix |
| --- | --- |
| `WhatsApp default: installed, configured, enabled, not linked` from `openclaw channels list --all` | Never completed QR login, or the session was logged out from the phone side (WhatsApp → Linked Devices). Re-run `channels login` (as `gosu node`, see warning above). |
| Gateway logs show repeated WhatsApp connection drops/reconnects | Normal for WhatsApp Web — Baileys reconnects automatically. Only investigate if it never recovers for several minutes; check `docker logs bbx-paw-openclaw` for the specific disconnect reason (e.g. `loggedOut`, `connectionReplaced`). |
| `connectionReplaced` / session suddenly stops responding | Another device (often a real phone's WhatsApp Web tab, or the same session linked twice) took over the same linked-device slot. Unlink duplicates from the phone's Linked Devices list, then re-run `channels login`. |
| `loggedOut` in logs, channel stops responding permanently | The phone unlinked the device, or WhatsApp force-logged it out. There is no recovery short of a fresh QR scan — see "How to reset session" below. |
| **QR pairing succeeds, "Local login saved auth" is logged, but `channels status --probe` still shows `not linked, stopped` (or later `linked` but `stopped`/`health:not-running`), and the WhatsApp app shows the linked-device message feed as "paused"** | Root-owned `openclaw.json` and/or `.openclaw/credentials/whatsapp/<account>/*` from running CLI commands without `gosu node` (see the warning in "First-time setup" above). The Gateway (runs as `node`) gets silent `EACCES` reading them and keeps serving its last good in-memory state. Fix: see "Recovering from a root-owned config/credentials mix-up" immediately below. |
| `plugin "whatsapp" is already installed` (or similar) during a manual `openclaw plugins install` | Expected/harmless — the entrypoint already guards against this with `openclaw plugins inspect whatsapp`; this error only appears if you run the install command yourself a second time while the plugin is already loaded. |
| Config write conflicts (`Config overwrite: ... backup=openclaw.json.bak`) | Expected — `channels login` and `pairing approve` both write directly to `openclaw.json`. This repo's generator (`config/openclaw.config.js`) runs again on every container restart and regenerates the fields it owns (`enabled`, `dmPolicy`, `groupPolicy`, `allowFrom`) from `.env` every restart — keep `.env` as the source of truth for those. |
| Gateway crash-loops with a schema/enum validation error on `channels.whatsapp` | An invalid `OPENCLAW_WHATSAPP_DM_POLICY` / `OPENCLAW_WHATSAPP_GROUP_POLICY` value (e.g. `"allow"` or `"ignore"`, neither of which is a real enum value) reached `openclaw.json`. `config/openclaw.config.js` validates both against OpenClaw's real schema on every run and normally falls back to a safe default and logs a `[openclaw.config] WARNING: ...` line instead of letting this happen — check `docker logs` / Coolify's deployment logs for that exact line, it names the bad env var and its value. Fix the value in `.env` / Coolify's environment editor to one of the allowed values below. |

### Recovering from a root-owned config/credentials mix-up

If any OpenClaw CLI command was ever run against the live container
without `gosu node` (a plain `docker exec`, or Coolify's "Open Terminal"
button, both attach as root), check for this first:

```bash
docker exec bbx-paw-openclaw ls -la /home/node/.openclaw/openclaw.json
docker exec bbx-paw-openclaw ls -la /home/node/.openclaw/credentials/whatsapp/default/creds.json
```

If either shows `root root` instead of `node node`, the Gateway (which
runs as `node`) cannot read it. This is a pure ownership problem — the
WhatsApp session and config content are both still intact and valid, do
**not** delete or re-pair anything. Fix:

```bash
# 1. Re-run the same idempotent ownership fix the entrypoint already runs
#    on every start (safe, non-destructive, touches ownership only):
docker exec bbx-paw-openclaw chown -R node:node /home/node/.openclaw
docker exec bbx-paw-openclaw chown -R node:node /home/node/.npm /home/node/.config 2>/dev/null || true

# 2. Restart the container so the Gateway re-reads config + credentials
#    from a clean boot (a live-process permission fix alone is not enough:
#    the Gateway also needs to re-resolve the WhatsApp plugin module graph
#    fresh, which only happens at process start).
docker restart bbx-paw-openclaw   # or redeploy via Coolify

# 3. Verify:
docker exec bbx-paw-openclaw gosu node openclaw channels status --channel whatsapp --probe
# expect: ... linked, running, connected, ... health:healthy
```

This is exactly the self-healing ownership fix `docker/entrypoint.sh`
already performs at the top of every container start — restarting alone
is normally sufficient once the files are back under `node:node`.

General diagnostics:

```bash
docker exec bbx-paw-openclaw gosu node openclaw channels list --all
docker exec bbx-paw-openclaw gosu node openclaw doctor
docker logs bbx-paw-openclaw --tail 200
```

Look specifically for these two log lines, printed on every container start
right before the Gateway itself starts (from `config/openclaw.config.js`):

```
[openclaw.config] WhatsApp env vars set: OPENCLAW_WHATSAPP_DM_POLICY="...", ...
[openclaw.config] WhatsApp channels.whatsapp.dmPolicy="..." groupPolicy="..."
```

The first line shows every `OPENCLAW_WHATSAPP_*` / `OPENCLAW_CHANNEL_WHATSAPP_ENABLED`
env var actually visible to the container (confirms what Coolify/`.env`
really injected). The second line shows the exact values that were written
into `openclaw.json`, after validation/fallback. If you ever see a
`WARNING:` line between them, an invalid value was caught and replaced —
fix the source env var rather than editing `openclaw.json` directly (it
gets regenerated on every restart).


## How to reset the session (force a fresh QR)

```bash
docker compose down
rm -rf ./.openclaw/credentials/whatsapp/default   # host path, matches OPENCLAW_CONFIG_DIR
docker compose up -d
docker exec -it bbx-paw-openclaw gosu node openclaw channels login --channel whatsapp
```

If you set a custom `OPENCLAW_WHATSAPP_AUTH_DIR`, delete that directory
instead of the default path above. Deleting only `creds.json` (leaving the
rest of the directory) also works and is slightly less destructive.

## Access policy reference

Set via `.env` (`OPENCLAW_WHATSAPP_DM_POLICY`, `OPENCLAW_WHATSAPP_ALLOW_FROM`,
`OPENCLAW_WHATSAPP_GROUP_POLICY`), compiled into `channels.whatsapp` by
`config/openclaw.config.js`. Real schema values, confirmed via
`openclaw config schema`:

| Field | Type | Values |
| --- | --- | --- |
| `dmPolicy` | string enum | `pairing` (default), `allowlist`, `open`, `disabled` |
| `groupPolicy` | string enum | `open`, `disabled` (default here), `allowlist` |
| `allowFrom` | string[] | E.164 numbers, e.g. `+15551234567` |

## Related

- [docs/SETUP.md](SETUP.md) — general repo setup
- [docs/DEPLOYMENT.md](DEPLOYMENT.md) — Coolify deployment
- Upstream: [OpenClaw WhatsApp channel docs](https://docs.openclaw.ai/channels/whatsapp)


