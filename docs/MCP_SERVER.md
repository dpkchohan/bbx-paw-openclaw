# OpenClaw MCP server

This repository includes an isolated [Model Context Protocol](https://modelcontextprotocol.io/) server for LibreChat. It does not alter, proxy, or replace the OpenClaw Gateway. The MCP service uses Streamable HTTP at `/mcp` and has a separate health endpoint at `/healthz`.

## Start

```bash
npm install
MCP_PORT=3001 npm run mcp:server
```

`MCP_PORT` defaults to `3001`; `MCP_HOST` defaults to `0.0.0.0`. For a remotely reachable deployment, set `MCP_AUTH_TOKEN` and configure LibreChat with the same bearer token. `MCP_CORS_ORIGIN` can be set to the exact LibreChat origin instead of the default `*`.

The package lock should be regenerated with `npm install` after adding the SDK dependency if your checkout predates this change.

## LibreChat connection

Configure an MCP server using the Streamable HTTP URL, for example:

```yaml
mcpServers:
  paw-openclaw:
    url: https://paw.example.com/mcp
    headers:
      Authorization: Bearer ${PAW_MCP_AUTH_TOKEN}
```

The exact key names depend on the LibreChat release. The important value is the service URL ending in `/mcp`; this is not the OpenClaw Gateway URL. Confirm connectivity with `GET /healthz`, then let LibreChat perform MCP initialization and `tools/list` discovery.

## Exposed tools

| Tool | Required input | Behavior |
| --- | --- | --- |
| `execute_dev_task` | `prompt`; optional `repo_url` | Submits `openclaw-task` to Trigger.dev when configured, otherwise calls the Gateway's OpenAI-compatible endpoint. |
| `run_workflow` | `workflow_name`; optional `params` | Submits a Trigger.dev task and returns `in_progress` with its response. |
| `list_repos` | none | Lists repositories visible to `GITHUB_PERSONAL_ACCESS_TOKEN` or `GITHUB_TOKEN`. |
| `create_pr` | `repo`, `title`, `changes` | Creates a branch, writes the supplied text files, and opens a pull request. `changes` is an array of `{path, content}`. |
| `get_status` | none | Reads the OpenClaw Gateway `/readyz` endpoint. |
| `execute_command` | `command` | Disabled by default. Requires `MCP_ENABLE_COMMANDS=true` and the executable in `MCP_COMMAND_ALLOWLIST`. |

All tool results are JSON with this shape:

```json
{
  "status": "success|error|in_progress",
  "output": "...",
  "logs": "...",
  "timestamp": "2026-08-24T20:00:00.000Z"
}
```

## Configuration

Set only the integrations you use:

- `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_PORT`
- `TRIGGER_API_URL`, `TRIGGER_SECRET_KEY` (or `TRIGGER_API_KEY`)
- `GITHUB_PERSONAL_ACCESS_TOKEN` (fine-grained and least-privilege recommended)
- `MCP_PORT`, `MCP_HOST`, `MCP_AUTH_TOKEN`, `MCP_CORS_ORIGIN`
- `MCP_ENABLE_COMMANDS`, `MCP_COMMAND_ALLOWLIST`, `MCP_COMMAND_TIMEOUT_MS`

Do not expose an unauthenticated MCP endpoint on the public internet. Use a reverse proxy/TLS and a temporary, least-privilege GitHub token.

## Examples

After connecting through an MCP client, invoke:

```json
{"name":"get_status","arguments":{}}
```

```json
{"name":"execute_dev_task","arguments":{"prompt":"Inspect the test suite and summarize failing areas","repo_url":"https://github.com/example/project"}}
```

```json
{"name":"create_pr","arguments":{"repo":"owner/repo","title":"Update docs","description":"Documentation update","changes":[{"path":"docs/example.md","content":"# Example\n"}]}}
```

## Testing

```bash
npm install
MCP_PORT=3001 npm run mcp:server
curl -fsS http://127.0.0.1:3001/healthz
```

For protocol-level verification, use an MCP client or LibreChat to initialize the Streamable HTTP session, call `tools/list`, and invoke `get_status`. The service logs startup failures and converts tool exceptions into safe structured error results; it does not return arbitrary stack traces to the client.
