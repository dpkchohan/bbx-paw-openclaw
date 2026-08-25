const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { tools, invoke } = require("./tools.js");

const port = Number(process.env.MCP_PORT || 3001);
const host = process.env.MCP_HOST || "0.0.0.0";
const authToken = process.env.MCP_AUTH_TOKEN || "";
const sessions = new Map();

const schemas = {
  execute_dev_task: { prompt: z.string().min(1), repo_url: z.string().url().optional() },
  run_workflow: { workflow_name: z.string().min(1), params: z.record(z.any()).optional() },
  list_repos: {},
  create_pr: { repo: z.string().min(1), title: z.string().min(1), description: z.string().optional(), changes: z.array(z.object({ path: z.string().min(1), content: z.string() })) },
  get_status: {},
  execute_command: { command: z.string().min(1) },
};

function authorized(request) {
  return !authToken || request.headers.authorization === `Bearer ${authToken}`;
}

function createServer() {
  const server = new McpServer({ name: "bbx-paw-openclaw", version: "0.1.0" });
  for (const [name, definition] of Object.entries(tools)) {
    server.tool(name, definition.description, schemas[name], async (args) => {
      const response = await invoke(name, args);
      return { content: [{ type: "text", text: JSON.stringify(response) }], structuredContent: response };
    });
  }
  return server;
}

async function handleMcp(request, response) {
  if (!authorized(request)) { response.writeHead(401, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "Unauthorized" })); return; }
  const sessionId = request.headers["mcp-session-id"];
  let entry = sessionId && sessions.get(sessionId);
  if (!entry) {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => sessions.set(id, { server, transport }) });
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    entry = { server, transport };
    if (sessionId) sessions.set(sessionId, entry);
    await server.connect(transport);
  }
  await entry.transport.handleRequest(request, response);
}

const httpServer = http.createServer((request, response) => {
  response.setHeader("Access-Control-Allow-Origin", process.env.MCP_CORS_ORIGIN || "*");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Session-Id, Last-Event-ID");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
  if (request.url === "/healthz" && request.method === "GET") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ status: "ok", service: "bbx-paw-openclaw-mcp" })); return; }
  if (request.url === "/mcp" && ["GET", "POST", "DELETE"].includes(request.method)) { handleMcp(request, response).catch((error) => { if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" }); if (!response.writableEnded) response.end(JSON.stringify({ error: "MCP request failed" })); console.error("[mcp]", error); }); return; }
  response.writeHead(404, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "Not found" }));
});

httpServer.listen(port, host, () => console.log(`[mcp] listening on http://${host}:${port}/mcp`));
