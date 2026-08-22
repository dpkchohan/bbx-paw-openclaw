# GitHub MCP Server Setup

This repo runs the **official [github/github-mcp-server](https://github.com/github/github-mcp-server)**
as a stdio process spawned directly by the OpenClaw Gateway — not the older,
now-deprecated `@modelcontextprotocol/server-github` npm package.

Everything below is verified against a real, running container built from
this repo's `Dockerfile` — not simulated.

## Why not the npm package, and why not Docker-in-Docker

- `@modelcontextprotocol/server-github` is deprecated: `npm view
  @modelcontextprotocol/server-github deprecated` returns *"Package no
  longer supported. Contact Support at https://www.npmjs.com/support for
  more info."*
- GitHub's own replacement, `github/github-mcp-server`, only ships as a
  Docker image (`ghcr.io/github/github-mcp-server`) or prebuilt per-OS/arch
  binaries — no npm package.
- This repo's Gateway container doesn't have Docker-in-Docker access, so
  the Dockerfile downloads the published **Linux x86_64** binary directly
  at build time and verifies its SHA256 checksum against the release's own
  `*_checksums.txt` before installing it to `/usr/local/bin/github-mcp-server`.

## What this repo actually changed

| File | Change |
| --- | --- |
| `Dockerfile` | Downloads `github-mcp-server_Linux_x86_64.tar.gz` from the pinned GitHub release, verifies its SHA256, installs the binary to `/usr/local/bin/github-mcp-server` |
| `config/openclaw.config.js` | Generates `config.mcp.servers.github` (real schema key — see below) when `GITHUB_PERSONAL_ACCESS_TOKEN` is set; logs debug lines for the token presence and the generated MCP config on every run |
| `.env.example` | New `GITHUB_PERSONAL_ACCESS_TOKEN` var |

## The schema bug this avoids: `mcpServers` vs `mcp.servers`

A very common mistake (carried over from Claude Desktop's config format,
which really does use a top-level `mcpServers` key) is to write
`config.mcpServers.github = {...}`. **OpenClaw does not use that key.**
Confirmed via `openclaw config schema` (2026.7.1-2): the real, only valid
location is:

```json5
{
  mcp: {
    servers: {
      github: {
        enabled: true,
        command: "/usr/local/bin/github-mcp-server",
        args: ["stdio"],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "..." },
      },
    },
  },
}
```

`config/openclaw.config.js` logs both keys on every run so this is easy to
verify without guessing:

```
[openclaw.config] GitHub token set: true
[openclaw.config] mcpServers: undefined
[openclaw.config] mcp.servers: {"github":{"enabled":true,"command":"/usr/local/bin/github-mcp-server","args":["stdio"],"env":{"GITHUB_PERSONAL_ACCESS_TOKEN":"..."}}}
```

`mcpServers` will **always** log `undefined` — that's expected, not a bug;
it's not a real OpenClaw config key. The real data is on the `mcp.servers`
line.

## Setup


1. Create a GitHub Personal Access Token at
   [github.com/settings/tokens](https://github.com/settings/tokens) — a
   fine-grained PAT scoped to only the repos you want the agent to touch is
   recommended; a classic PAT needs at least the `repo` scope.
2. Set it in `.env`:
   ```bash
   GITHUB_PERSONAL_ACCESS_TOKEN=ghp_...
   ```
3. Rebuild and restart the container:
   ```bash
   npm run docker:build
   npm run docker:up
   npm run docker:logs
   ```
4. Confirm it loaded (all three verified live against a real container):
   ```bash
   docker exec bbx-paw-openclaw gosu node openclaw mcp list
   # OpenClaw-managed MCP servers (/home/node/.openclaw/openclaw.json):
   # - github

   docker exec bbx-paw-openclaw gosu node openclaw mcp probe github
   # MCP probe (/home/node/.openclaw/openclaw.json):
   # - github: 44 tools, resources, prompts

   docker exec bbx-paw-openclaw gosu node openclaw mcp status
   ```

## Troubleshooting


| Symptom | Cause / fix |
| --- | --- |
| `mcp list` doesn't show `github` at all | `GITHUB_PERSONAL_ACCESS_TOKEN` is unset — the generator intentionally omits the server entirely (`mcp.servers` stays `{}`) rather than writing a broken, credential-less entry. Check `docker logs` for `[openclaw.config] GitHub token set: false`. |
| `mcp probe github` fails to connect / times out | Confirm the binary exists and is executable inside the container: `docker exec bbx-paw-openclaw ls -la /usr/local/bin/github-mcp-server`. If missing, the Dockerfile's checksum-verified download step failed at build time — rebuild and check the build log for the `sha256sum -c` step. |
| `mcp probe github` connects but tool calls fail with 401/403 | The PAT is invalid, expired, or lacks the required scope for that tool. Regenerate the token; classic PATs need `repo` scope for most write operations. |
| Docker build fails at the `sha256sum -c` step | The pinned `GITHUB_MCP_SERVER_VERSION` / `GITHUB_MCP_SERVER_LINUX_X86_64_SHA256` build args in the `Dockerfile` no longer match what's published. Check the release's `github-mcp-server_<version>_checksums.txt` at `https://github.com/github/github-mcp-server/releases` and update both build args together. |
| Want to restrict which GitHub tools are available | Add `--toolsets=<csv>` or `--read-only` to the `args` array in `config/openclaw.config.js`'s `buildGitHubMcpServerConfig()` (e.g. `args: ["stdio", "--toolsets=issues,pull_requests,repos", "--read-only"]`). Available toolsets: `actions, code_quality, code_security, copilot, copilot_issue_intents, dependabot, discussions, gists, git, issues, labels, notifications, orgs, projects, pull_requests, repos, secret_protection, security_advisories, stargazers, users`. |

## Upgrading the binary version

```bash
# 1. Find the latest release version and its Linux x86_64 checksum:
curl -s https://api.github.com/repos/github/github-mcp-server/releases/latest | grep tag_name
curl -sL https://github.com/github/github-mcp-server/releases/download/v<NEW_VERSION>/github-mcp-server_<NEW_VERSION>_checksums.txt | grep Linux_x86_64

# 2. Update both ARGs in the Dockerfile:
#    ARG GITHUB_MCP_SERVER_VERSION="<NEW_VERSION>"
#    ARG GITHUB_MCP_SERVER_LINUX_X86_64_SHA256="<checksum from step 1>"

# 3. Rebuild:
npm run docker:build
```

## Related

- [docs/SETUP.md](SETUP.md) — general repo setup
- [docs/DEPLOYMENT.md](DEPLOYMENT.md) — Coolify deployment
- Upstream: [github/github-mcp-server](https://github.com/github/github-mcp-server)

