const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const API_VERSION = "2022-11-28";

function result(status, output, logs = "") {
  return { status, output, logs, timestamp: new Date().toISOString() };
}

function json(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Accept: "application/vnd.github+json", ...options.headers },
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${json(body).slice(0, 1000)}`);
  return body;
}

function githubHeaders() {
  const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_PERSONAL_ACCESS_TOKEN is not configured");
  return { Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": API_VERSION };
}

function parseRepo(repo) {
  const value = String(repo || "").replace(/^https?:\/\/github.com\//, "").replace(/\.git$/, "").replace(/^\//, "");
  const [owner, name] = value.split("/");
  if (!owner || !name || value.split("/").length !== 2) throw new Error("repo must be in owner/name or GitHub URL format");
  return { owner, name };
}

function triggerAuth() {
  const base = process.env.TRIGGER_API_URL;
  const key = process.env.TRIGGER_SECRET_KEY || process.env.TRIGGER_API_KEY;
  if (!base || !key) throw new Error("TRIGGER_API_URL and TRIGGER_SECRET_KEY are required");
  return { base: base.replace(/\/$/, ""), key };
}

async function parseTriggerResponse(response, url) {
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  if (/text\/html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(text)) {
    throw new Error(`Trigger.dev ${response.status} at ${url} returned HTML instead of JSON (likely a wrong API path or the webapp 404 page)`);
  }
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { throw new Error(`Trigger.dev ${response.status} at ${url} returned a non-JSON response: ${text.slice(0, 1000)}`); }
  if (!response.ok) throw new Error(`Trigger.dev ${response.status}: ${json(body).slice(0, 1000)}`);
  return body;
}

// Trigger.dev v4 self-hosted contract:
//   POST {TRIGGER_API_URL}/api/v1/tasks/{taskId}/trigger
//   Headers: Authorization: Bearer <key>, Content-Type: application/json
//   Body: { "payload": { ... } }
async function trigger(taskId, payload) {
  const { base, key } = triggerAuth();
  const url = `${base}/api/v1/tasks/${encodeURIComponent(taskId)}/trigger`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ payload: payload || {} }),
  });
  return parseTriggerResponse(response, url);
}

// GET {TRIGGER_API_URL}/api/v1/runs/{runId} — poll a previously triggered run.
async function getRun(runId) {
  const { base, key } = triggerAuth();
  const url = `${base}/api/v1/runs/${encodeURIComponent(runId)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
  });
  return parseTriggerResponse(response, url);
}

async function executeDevTaskViaTrigger({ prompt, repo_url }) {
  const data = await trigger("openclaw-task", { prompt, repo_url });
  return result("in_progress", data, "Task submitted to Trigger.dev");
}

async function executeDevTaskViaGateway({ prompt, repo_url }) {
  const base = process.env.OPENCLAW_GATEWAY_URL || `http://127.0.0.1:${process.env.OPENCLAW_PORT || 18789}`;
  const headers = { "Content-Type": "application/json" };
  if (process.env.OPENCLAW_GATEWAY_TOKEN) headers.Authorization = `Bearer ${process.env.OPENCLAW_GATEWAY_TOKEN}`;
  const response = await fetch(`${base.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST", headers, body: JSON.stringify({ model: "openclaw/default", stream: false, messages: [{ role: "user", content: repo_url ? `${prompt}\n\nRepository: ${repo_url}` : prompt }] }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`OpenClaw Gateway ${response.status}: ${json(data).slice(0, 1000)}`);
  return result("success", data.choices?.[0]?.message?.content || data, "OpenClaw Gateway completed the task");
}

// The OpenClaw gateway is the primary execution path for execute_dev_task.
// Trigger.dev is only used when explicitly opted into via
// PREFER_TRIGGER_FOR_DEV_TASK="true" (kept behind this flag since there is
// no "openclaw-task" deployed on the Trigger.dev instance yet).
async function executeDevTask({ prompt, repo_url }) {
  if (process.env.PREFER_TRIGGER_FOR_DEV_TASK === "true") {
    return executeDevTaskViaTrigger({ prompt, repo_url });
  }
  return executeDevTaskViaGateway({ prompt, repo_url });
}

async function runWorkflow({ workflow_name, params = {} }) {
  const data = await trigger(workflow_name, params);
  return result("in_progress", data, `Workflow ${workflow_name} submitted`);
}

async function listRepos() {
  const data = await request("https://api.github.com/user/repos?per_page=100&sort=updated", { headers: githubHeaders() });
  return result("success", data.map((repo) => ({ name: repo.full_name, url: repo.html_url, private: repo.private, default_branch: repo.default_branch })), `Found ${data.length} repositories`);
}

async function createPr({ repo, title, description = "", changes = [] }) {
  const { owner, name } = parseRepo(repo);
  const headers = githubHeaders();
  const repository = await request(`https://api.github.com/repos/${owner}/${name}`, { headers });
  const base = repository.default_branch;
  const baseRef = await request(`https://api.github.com/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(base)}`, { headers });
  const branch = `mcp/${Date.now().toString(36)}`;
  await request(`https://api.github.com/repos/${owner}/${name}/git/refs`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseRef.object.sha }) });
  for (const change of changes) {
    if (!change || typeof change.path !== "string" || typeof change.content !== "string") throw new Error("Each change must contain string path and content");
    const encoded = Buffer.from(change.content).toString("base64");
    const path = change.path.split("/").map(encodeURIComponent).join("/");
    let existing;
    try { existing = await request(`https://api.github.com/repos/${owner}/${name}/contents/${path}?ref=${encodeURIComponent(branch)}`, { headers }); } catch (error) { if (!String(error.message).startsWith("404")) throw error; }
    await request(`https://api.github.com/repos/${owner}/${name}/contents/${path}`, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ message: `chore: update ${change.path}`, content: encoded, branch, ...(existing?.sha ? { sha: existing.sha } : {}) }) });
  }
  const pr = await request(`https://api.github.com/repos/${owner}/${name}/pulls`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ title, body: description, head: branch, base }) });
  return result("success", { number: pr.number, url: pr.html_url, branch }, `Created pull request in ${owner}/${name}`);
}

async function getStatus() {
  const base = process.env.OPENCLAW_GATEWAY_URL || `http://127.0.0.1:${process.env.OPENCLAW_PORT || 18789}`;
  const response = await fetch(`${base.replace(/\/$/, "")}/readyz`);
  const data = await response.json().catch(() => ({}));
  return result(response.ok ? "success" : "error", data, `Gateway readiness HTTP ${response.status}`);
}

function allowedCommand(command) {
  const allowlist = (process.env.MCP_COMMAND_ALLOWLIST || "").split(",").map((x) => x.trim()).filter(Boolean);
  const executable = String(command).trim().split(/\s+/)[0];
  return allowlist.includes(executable);
}

async function executeCommand({ command }) {
  if (process.env.MCP_ENABLE_COMMANDS !== "true") return result("error", "execute_command is disabled", "Set MCP_ENABLE_COMMANDS=true only in a controlled environment");
  if (!allowedCommand(command)) return result("error", "Command is not on MCP_COMMAND_ALLOWLIST", "Commands must be explicitly allowlisted");
  const [file, ...args] = String(command).trim().split(/\s+/);
  const { stdout, stderr } = await execFileAsync(file, args, { timeout: Number(process.env.MCP_COMMAND_TIMEOUT_MS || 30000), maxBuffer: 1024 * 1024, shell: false });
  return result("success", stdout, stderr);
}

const tools = {
  execute_dev_task: { description: "Submit a development task to OpenClaw or Trigger.dev.", inputSchema: { type: "object", properties: { prompt: { type: "string", minLength: 1 }, repo_url: { type: "string" } }, required: ["prompt"] }, handler: executeDevTask },
  run_workflow: { description: "Submit a Trigger.dev workflow/task.", inputSchema: { type: "object", properties: { workflow_name: { type: "string", minLength: 1 }, params: { type: "object", additionalProperties: true } }, required: ["workflow_name"] }, handler: runWorkflow },
  list_repos: { description: "List repositories visible to the configured GitHub token.", inputSchema: { type: "object", properties: {} }, handler: listRepos },
  create_pr: { description: "Create a branch, apply text-file changes, and open a GitHub pull request.", inputSchema: { type: "object", properties: { repo: { type: "string" }, title: { type: "string" }, description: { type: "string" }, changes: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } }, required: ["repo", "title", "changes"] }, handler: createPr },
  get_status: { description: "Check OpenClaw gateway readiness.", inputSchema: { type: "object", properties: {} }, handler: getStatus },
  execute_command: { description: "Run an explicitly allowlisted local command; disabled by default.", inputSchema: { type: "object", properties: { command: { type: "string", minLength: 1 } }, required: ["command"] }, handler: executeCommand },
};

async function invoke(name, args) {
  const tool = tools[name];
  if (!tool) throw new Error(`Unknown MCP tool: ${name}`);
  try { return await tool.handler(args || {}); } catch (error) { return result("error", "Tool execution failed", error.message); }
}

module.exports = { tools, invoke, getRun };
