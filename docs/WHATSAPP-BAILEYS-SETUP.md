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
| `docker/entrypoint.sh` | Installs `@openclaw/whatsapp` from ClawHub at **container runtime** (after the volume mounts), idempotently, on every start |
| `config/openclaw.config.js` | Generates the real `channels.whatsapp` config block (`enabled`, `dmPolicy`, `groupPolicy`, `allowFrom`, optional `accounts.default.authDir`) |
| `.env.example` | New optional `OPENCLAW_CHANNEL_WHATSAPP_ENABLED` / `OPENCLAW_WHATSAPP_*` vars |

No `src/channels/whatsapp.js`, no `@whiskeysockets/baileys`/`qrcode-terminal`
npm dependency, and no changes to `src/index.js` (this repo has no such
file — OpenClaw's own `openclaw gateway` process is the entire runtime; see
`docker/entrypoint.sh`'s `CMD`).

## Why the plugin installs at runtime, not in the Dockerfile

`openclaw plugins install` puts the plugin under
`$OPENCLAW_STATE_DIR/extensions/<name>` — confirmed directly from the
plugin installer's own log line:

```
Installing to /home/node/.openclaw/extensions/whatsapp…
```

`/home/node/.openclaw` is exactly the directory `docker-compose.yaml`
bind-mounts from the host (`OPENCLAW_CONFIG_DIR`). If the plugin were
installed during `docker build`, that install would be **silently wiped
out** the instant the (initially empty) host volume mounts over
`/home/node/.openclaw` at container start. So `docker/entrypoint.sh`
installs it after the volume is live, guarded by a directory check so it
only downloads once and then persists in the host directory across every
future restart — exactly like the WhatsApp session itself.

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
| `WhatsApp default: installed, configured, enabled, not linked` from `openclaw channels list --all` | Never completed QR login, or the session was logged out from the phone side (WhatsApp → Linked Devices). Re-run `channels login`. |
| Gateway logs show repeated WhatsApp connection drops/reconnects | Normal for WhatsApp Web — Baileys reconnects automatically. Only investigate if it never recovers for several minutes; check `docker logs bbx-paw-openclaw` for the specific disconnect reason (e.g. `loggedOut`, `connectionReplaced`). |
| `connectionReplaced` / session suddenly stops responding | Another device (often a real phone's WhatsApp Web tab, or the same session linked twice) took over the same linked-device slot. Unlink duplicates from the phone's Linked Devices list, then re-run `channels login`. |
| `loggedOut` in logs, channel stops responding permanently | The phone unlinked the device, or WhatsApp force-logged it out. There is no recovery short of a fresh QR scan — see "How to reset session" below. |
| `plugin already exists: /home/node/.openclaw/extensions/whatsapp (delete it first)` during a manual `openclaw plugins install` | Expected/harmless — the entrypoint already guards against this by checking for the directory first; this error only appears if you run the install command yourself a second time. |
| Config write conflicts (`Config overwrite: ... backup=openclaw.json.bak`) | Expected — `channels login` and `pairing approve` both write directly to `openclaw.json`. This repo's generator (`config/openclaw.config.js`) runs again on every container restart and regenerates the fields it owns (`enabled`, `dmPolicy`, `groupPolicy`, `allowFrom`) from `.env` every restart — keep `.env` as the source of truth for those. |

General diagnostics:

```bash
docker exec bbx-paw-openclaw gosu node openclaw channels list --all
docker exec bbx-paw-openclaw gosu node openclaw doctor
docker logs bbx-paw-openclaw --tail 200
```

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


