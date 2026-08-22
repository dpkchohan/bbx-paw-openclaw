#!/usr/bin/env node
/**
 * config/openclaw.config.js
 * ---------------------------------------------------------------------------
 * Generates ~/.openclaw/openclaw.json (or $OPENCLAW_CONFIG_PATH) for the
 * OpenClaw Gateway from:
 *   - config/models.yaml          (4-tier model strategy — literal model ids)
 *   - process.env                 (secrets, ports, paths — see .env.example)
 *
 * OpenClaw's real config file is openclaw.json (JSON5) read from
 * OPENCLAW_CONFIG_PATH (default ~/.openclaw/openclaw.json). There is no
 * "openclaw.config.js" file consumed by OpenClaw itself — this script is
 * OUR generator that produces that JSON5 file so the 4-tier strategy in
 * models.yaml stays the single source of truth instead of being hand-edited
 * in two places.
 *
 * All 4 tiers run on Amazon Bedrock's native Converse API (OpenClaw provider
 * id "amazon-bedrock", auth: "aws-sdk"). This includes Tier 2 (GPT-5.6
 * Luna), which is OpenAI's model hosted directly in Bedrock's own catalog
 * ("openai." vendor prefix) — not the separate Bedrock Mantle provider. See
 * the header comment in config/models.yaml for the full explanation and the
 * confirmed model id / inference profile.
 *
 * Because every tier is Bedrock, this is a single AWS-credentials-only
 * setup: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION (or any
 * other AWS SDK credential source — instance role, SSO, shared profile).
 * No OpenAI API key or separate endpoint config is required.
 *
 * Usage:
 *   node config/openclaw.config.js            # write config + print summary
 *   node config/openclaw.config.js --print     # print JSON5 to stdout only
 *
 * Run this automatically:
 *   - locally: `npm run generate:config` before `openclaw onboard`
 *   - in Docker: the container entrypoint runs it before `openclaw gateway`
 * ---------------------------------------------------------------------------
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
require("dotenv").config();

let yaml;
try {
  yaml = require("js-yaml");
} catch (err) {
  console.error(
    "[openclaw.config] Missing dependency 'js-yaml'. Run `npm install` first."
  );
  process.exit(1);
}

const REPO_ROOT = path.resolve(__dirname, "..");
const MODELS_YAML_PATH = path.join(__dirname, "models.yaml");

// Maps config/models.yaml's short `provider` value to OpenClaw's real
// provider id used in openclaw.json / model refs (provider/model-id).
// All current tiers use "bedrock" -> "amazon-bedrock"; this map is kept
// extensible in case a future tier needs a different provider.
const PROVIDER_ID_MAP = {
  bedrock: "amazon-bedrock",
};

function loadModelsYaml() {
  const raw = fs.readFileSync(MODELS_YAML_PATH, "utf8");
  return yaml.load(raw);
}

function resolveConfigPath() {
  const explicit = process.env.OPENCLAW_CONFIG_PATH;
  if (explicit) return explicit;
  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, "openclaw.json");
}

function resolveWorkspacePath() {
  return (
    process.env.OPENCLAW_WORKSPACE_DIR ||
    process.env.WORKSPACE_PATH ||
    path.join(REPO_ROOT, "workspace")
  );
}

function buildModelEntry(id, opts) {
  return {
    id,
    name: opts.name || opts.label,
    reasoning: !!opts.reasoning,
    input: ["text", "image"],
    cost: {
      input: opts.inputCostPerMillionTokensUsd || 0,
      output: opts.outputCostPerMillionTokensUsd || 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: opts.contextWindow || 200000,
    maxTokens: opts.maxTokens || 8192,
  };
}

function providerId(tier) {
  return PROVIDER_ID_MAP[tier.provider] || tier.provider;
}

// Builds the top-level `plugins` config block that explicitly trusts every
// non-bundled plugin this generator actually configures. Confirmed via a
// live container boot: leaving plugins.allow unset makes the Gateway log
// "plugins.allow is empty; discovered non-bundled plugins may auto-load:
// amazon-bedrock (...), whatsapp (...). To trust them explicitly, set
// plugins.allow in openclaw.json (e.g. "plugins": { "allow": [...] })"
// on every start. Schema-confirmed via `openclaw config schema`:
// plugins.allow is string[], plugins.entries.<id>.enabled is boolean.
//
// bundledDiscovery: "compat" is required alongside plugins.allow --
// confirmed via a live `openclaw doctor` run: setting plugins.allow without
// it triggers a "Legacy config keys detected: plugins.allow now gates
// bundled provider discovery by default" warning, and (confirmed via
// `openclaw plugins list` / `openclaw doctor`'s Plugins summary) drops
// several optional bundled feature plugins this repo never uses -- browser
// automation, Canvas, device pairing, file-transfer, local Ollama models,
// phone control, and Talk voice -- from "enabled" to "disabled". None of
// those are referenced anywhere in this repo (this Gateway only needs
// Bedrock inference, memory-core for agents.defaults.memorySearch, and the
// WhatsApp channel), so this is an acceptable, in fact leaner, result.
// "compat" is the doctor-recommended setting to acknowledge and quiet that
// warning; "allowlist" would keep the same stricter behavior without
// quieting it. plugins.allow/entries below exist to trust the two
// non-bundled (external) plugins this config actually configures.
function buildPluginsConfig({ hasBedrockProvider, whatsappEnabled }) {

  const allow = [];
  const entries = {};

  if (hasBedrockProvider) {
    allow.push("amazon-bedrock");
    entries["amazon-bedrock"] = { enabled: true };
  }
  if (whatsappEnabled) {
    allow.push("whatsapp");
    entries.whatsapp = { enabled: true };
  }

  return { allow, entries, bundledDiscovery: "compat" };
}

// -----------------------------------------------------------------------------
// GitHub MCP server (official github/github-mcp-server, spawned as a plain
// stdio process -- installed at build time by the Dockerfile as a prebuilt
// Linux binary at /usr/local/bin/github-mcp-server, NOT via npm).
// -----------------------------------------------------------------------------
// The older `@modelcontextprotocol/server-github` npm package is deprecated
// ("Package no longer supported", confirmed via `npm view
// @modelcontextprotocol/server-github deprecated`). GitHub's own
// `github/github-mcp-server` replaced it and only ships as a Docker image
// or prebuilt per-OS/arch binaries -- no npm package. Docker-in-Docker
// isn't available inside this container, so the Dockerfile downloads and
// checksum-verifies the Linux x86_64 binary directly (see Dockerfile
// comments), and this generator wires it into OpenClaw as a plain stdio
// MCP server.
//
// Real schema confirmed via `openclaw config schema` (2026.7.1-2): the
// correct top-level key is "mcp.servers.<name>" (a keyed object), NOT a
// top-level "mcpServers" key (that shape is Claude Desktop's config
// format, not OpenClaw's). Each entry accepts command/args/env/cwd for a
// stdio server (confirmed against the schema's mcp.servers.additionalProperties
// shape) -- exactly the same shape `openclaw mcp add --command --arg --env`
// would write.
function buildGitHubMcpServerConfig(env) {
  const token = env.GITHUB_PERSONAL_ACCESS_TOKEN || "";

  console.log(
    `[openclaw.config] GitHub token set: ${!!token}`
  );

  if (!token) {
    // No token configured -- omit the server entirely rather than writing
    // a broken entry with no credentials. `openclaw mcp doctor` would flag
    // a configured-but-unauthenticated server anyway.
    return null;
  }

  return {
    enabled: true,
    command: "/usr/local/bin/github-mcp-server",
    args: ["stdio"],
    env: {
      GITHUB_PERSONAL_ACCESS_TOKEN: token,
    },
  };
}



// -----------------------------------------------------------------------------
// WhatsApp channel (official @openclaw/whatsapp plugin, Baileys under the
// hood -- installed at runtime by docker/entrypoint.sh, NOT vendored here).
// -----------------------------------------------------------------------------
// This project deliberately does not hand-roll a Baileys client. OpenClaw
// ships a production-ready WhatsApp channel (its own docs: "Status:
// production-ready via WhatsApp Web (Baileys). The gateway owns the linked
// session(s)"). Building a second, independent Baileys session here would
// duplicate that functionality and could conflict with it (WhatsApp Web
// only tolerates a limited number of linked devices for one number), and it
// would violate this repo's own restriction against reimplementing
// OpenClaw. See docs/WHATSAPP-BAILEYS-SETUP.md for the full linking/QR
// workflow (openclaw channels login --channel whatsapp).
//
// Real schema confirmed via `openclaw config schema` (2026.7.1-2, plugin
// @openclaw/whatsapp@2026.7.1): channels.whatsapp.{enabled, dmPolicy,
// allowFrom, groupPolicy, groupAllowFrom, configWrites, ...} plus
// channels.whatsapp.accounts.<id>.{enabled, authDir, dmPolicy, allowFrom, ...}.
// There is no "autoReconnect" or "logMessages" key -- the plugin's
// Baileys-backed connection controller reconnects automatically by design,
// and channel activity is already covered by the Gateway's own structured
// logs, so neither needs a config toggle.
const VALID_WHATSAPP_DM_POLICIES = ["pairing", "allowlist", "open", "disabled"];
const VALID_WHATSAPP_GROUP_POLICIES = ["open", "disabled", "allowlist"];

// Validates a candidate enum value against OpenClaw's real schema for this
// field. Returns the candidate unchanged when valid; otherwise logs a loud,
// unmissable warning (visible in `docker logs` / Coolify build+runtime
// logs) and falls back to `fallback` so the Gateway never receives a value
// that would make it reject the whole config at startup. This exists
// specifically to catch bad values coming from .env / Coolify's env editor
// (e.g. a stray OPENCLAW_WHATSAPP_DM_POLICY=allow or =ignore) BEFORE they
// reach openclaw.json, since OpenClaw's schema validator has no fallback of
// its own -- an invalid enum value there crashes the Gateway at boot.
function validateEnumEnvValue({ envVarName, rawValue, allowedValues, fallback }) {
  if (rawValue === undefined || rawValue === "") return fallback;
  if (allowedValues.includes(rawValue)) return rawValue;
  console.error(
    `[openclaw.config] WARNING: ${envVarName}="${rawValue}" is not a valid value. ` +
      `Allowed: ${allowedValues.join(", ")}. Falling back to "${fallback}". ` +
      `Check .env / Coolify environment variables for this deployment.`
  );
  return fallback;
}

function buildWhatsAppChannelConfig(env) {
  if (env.OPENCLAW_CHANNEL_WHATSAPP_ENABLED === "0") {
    return { enabled: false };
  }

  const allowFrom = (env.OPENCLAW_WHATSAPP_ALLOW_FROM || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Debug visibility: print every OPENCLAW_WHATSAPP_* / OPENCLAW_CHANNEL_
  // WHATSAPP_* env var that is actually set in this process, and the exact
  // dmPolicy/groupPolicy values about to be written to openclaw.json. This
  // runs on every container start (docker/entrypoint.sh calls this script
  // before `openclaw gateway`), so it shows up in `docker logs` / Coolify's
  // deployment logs immediately before any Gateway startup/crash output.
  const relevantEnvKeys = Object.keys(env).filter(
    (key) => key.startsWith("OPENCLAW_WHATSAPP_") || key === "OPENCLAW_CHANNEL_WHATSAPP_ENABLED"
  );
  console.log(
    `[openclaw.config] WhatsApp env vars set: ${
      relevantEnvKeys.length > 0
        ? relevantEnvKeys.map((key) => `${key}=${JSON.stringify(env[key])}`).join(", ")
        : "(none)"
    }`
  );

  const dmPolicy = validateEnumEnvValue({
    envVarName: "OPENCLAW_WHATSAPP_DM_POLICY",
    rawValue: env.OPENCLAW_WHATSAPP_DM_POLICY,
    allowedValues: VALID_WHATSAPP_DM_POLICIES,
    fallback: "pairing",
  });
  const groupPolicy = validateEnumEnvValue({
    envVarName: "OPENCLAW_WHATSAPP_GROUP_POLICY",
    rawValue: env.OPENCLAW_WHATSAPP_GROUP_POLICY,
    allowedValues: VALID_WHATSAPP_GROUP_POLICIES,
    fallback: "disabled",
  });
  console.log(
    `[openclaw.config] WhatsApp channels.whatsapp.dmPolicy="${dmPolicy}" groupPolicy="${groupPolicy}"`
  );

  const config = {
    enabled: true,
    // "pairing" (default) queues an approval request for unknown senders
    // instead of silently allowing everyone -- see docs/WHATSAPP-BAILEYS-SETUP.md.
    dmPolicy,
    groupPolicy,
  };


  if (allowFrom.length > 0) {
    config.allowFrom = allowFrom;
  }

  // Session credentials (Baileys creds.json) persist under
  // $OPENCLAW_STATE_DIR/credentials/whatsapp/<accountId>/ by default, which
  // is already inside the bind-mounted .openclaw volume -- no extra Docker
  // volume/path is needed for the session to survive container restarts.
  // Set OPENCLAW_WHATSAPP_AUTH_DIR only to relocate it outside that default.
  if (env.OPENCLAW_WHATSAPP_AUTH_DIR) {
    config.accounts = {
      default: { authDir: env.OPENCLAW_WHATSAPP_AUTH_DIR },
    };
  }

  return config;
}


// Fixed origins this Gateway must always accept, regardless of env config:
//   - openclaw.pddt.in: the Control UI / dashboard domain (see
//     https://openclaw.pddt.in) that Coolify routes to this container.
//   - loopback (http://localhost:<port> / http://127.0.0.1:<port>): what
//     OpenClaw itself auto-seeds when gateway.controlUi.allowedOrigins is
//     left unset (see gateway startup log: "seeded
//     gateway.controlUi.allowedOrigins ... for bind=lan"). Setting this
//     list explicitly (for openclaw.pddt.in) would otherwise silently drop
//     that auto-seeded local access, so we merge it back in here.
function buildAllowedOrigins(env) {
  const port = Number(env.OPENCLAW_PORT || 18789);
  const fixedOrigins = [
    "https://openclaw.pddt.in",
    "http://openclaw.pddt.in",
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ];

  // Merge in any additional origins an operator supplies via env (comma
  // separated), and dedupe the combined list while preserving order.
  const extraOrigins = (env.OPENCLAW_EXTRA_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return Array.from(new Set([...fixedOrigins, ...extraOrigins]));
}




function buildConfig(env) {
  const modelsYaml = loadModelsYaml();
  const tiers = modelsYaml.tiers || {};
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1";

  const bedrockModels = [];
  const seenBedrockIds = new Set();

  for (const [, tier] of Object.entries(tiers)) {
    const pid = providerId(tier);
    if (pid !== "amazon-bedrock") continue; // all current tiers are Bedrock
    if (!tier.model || seenBedrockIds.has(tier.model)) continue;
    seenBedrockIds.add(tier.model);
    bedrockModels.push(buildModelEntry(tier.model, tier));
  }

  const providers = {};
  if (bedrockModels.length > 0) {
    providers["amazon-bedrock"] = {
      baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
      api: "bedrock-converse-stream",
      auth: "aws-sdk",
      models: bedrockModels,
    };
  }

  const defaultTierName = modelsYaml.defaultTier;
  const defaultTier = tiers[defaultTierName];
  const defaultModelRef = defaultTier
    ? `${providerId(defaultTier)}/${defaultTier.model}`
    : `amazon-bedrock/${env.MODEL_CHEAP || "us.amazon.nova-pro-v1:0"}`;

  const fallbackRefs = Object.entries(tiers)
    .filter(([name]) => name !== defaultTierName)
    .map(([, tier]) => `${providerId(tier)}/${tier.model}`);

  const whatsappConfig = buildWhatsAppChannelConfig(env);
  const githubMcpServerConfig = buildGitHubMcpServerConfig(env);

  const config = {
    gateway: {
      mode: "local",
      bind: env.OPENCLAW_GATEWAY_BIND || "lan",
      port: Number(env.OPENCLAW_PORT || 18789),
      auth: {
        token: "${OPENCLAW_GATEWAY_TOKEN}",
      },
      http: {
        endpoints: {
          // Powers BBX Chat / Trigger.dev integration via a plain
          // OpenAI-compatible /v1/chat/completions call. See docs/ARCHITECTURE.md.
          chatCompletions: { enabled: true },
        },
      },
      // Explicit CORS allowlist for the Control UI. When bind="lan" and this
      // is left unset, OpenClaw auto-seeds ["http://localhost:<port>",
      // "http://127.0.0.1:<port>"] at runtime without writing config (see
      // gateway startup log: "seeded gateway.controlUi.allowedOrigins ...").
      // We set it explicitly here so openclaw.pddt.in can reach the Control
      // UI/Gateway HTTP API, while still merging in those same loopback
      // defaults so setting this list doesn't silently drop local access.
      controlUi: {
        allowedOrigins: buildAllowedOrigins(env),
      },
    },
    agents: {
      defaults: {
        workspace: resolveWorkspacePath(),
        model: {
          primary: defaultModelRef,
          fallbacks: fallbackRefs,
        },
        // Bedrock Titan embeddings for agent memory search — uses the same
        // AWS SDK credential chain as inference, no extra API key needed.
        memorySearch: {
          provider: "bedrock",
          model: "amazon.titan-embed-text-v2:0",
        },
      },
      // NOTE: OpenClaw's real config schema is agents.list (an array of
      // agent objects), NOT agents.entries (a keyed object) — confirmed via
      // `openclaw config schema`. An earlier version of this generator used
      // the wrong shape and failed Gateway startup with
      // "agents: Invalid input, memory: Invalid input".
      list: [
        {
          id: "main",
          default: true,
          identity: {
            name: "BBX PAW",
            theme: "autonomous research and coding assistant for BBX",
            emoji: "🐾",
          },
        },
      ],
    },
    models: {
      providers,
    },
    channels: {
      whatsapp: whatsappConfig,
    },
    // Trust the non-bundled plugins this config actually configures.
    // Without this, the Gateway logs a warning on every start:
    // "plugins.allow is empty; discovered non-bundled plugins may
    // auto-load: amazon-bedrock (...), whatsapp (...). To trust them
    // explicitly, set plugins.allow in openclaw.json ..." -- confirmed via
    // a live container boot. plugins.allow is the schema-confirmed
    // allowlist (string[]); plugins.entries.<id>.enabled additionally
    // force-enables each entry (also schema-confirmed: boolean). Built
    // dynamically so it only lists plugins this exact config uses.
    plugins: buildPluginsConfig({
      hasBedrockProvider: bedrockModels.length > 0,
      whatsappEnabled: whatsappConfig.enabled !== false,
    }),

    // GitHub MCP server (see buildGitHubMcpServerConfig above). Real schema
    // key is mcp.servers.<name>, not a top-level "mcpServers" -- omitted
    // entirely (mcp.servers stays {}) when GITHUB_PERSONAL_ACCESS_TOKEN is
    // unset.
    mcp: {
      servers: githubMcpServerConfig
        ? { github: githubMcpServerConfig }
        : {},
    },

    // NOTE: OpenClaw's own control-plane/session state is always SQLite
    // (see docs/ARCHITECTURE.md "Storage" section) — it is NOT MongoDB.
    // MONGO_URI is consumed by our own trigger-jobs/openclaw-task.js for
    // job bookkeeping shared with BBX Chat, not by the OpenClaw gateway.
    //
    // NOTE: there is no top-level "memory.search" key in OpenClaw's schema
    // (confirmed via `openclaw config schema`) — memory-search/embedding
    // config lives per-agent at agents.defaults.memorySearch / agents.list[].
    // memorySearch, which is set above.
  };

  // Debug visibility: OpenClaw's real schema is config.mcp.servers, not a
  // top-level config.mcpServers (that shape is Claude Desktop's config
  // format, not OpenClaw's -- confirmed via `openclaw config schema`).
  // config.mcpServers is logged anyway, exactly as requested, so it's
  // visible in `docker logs` / Coolify's deployment logs that this key is
  // always undefined on this generator's output -- the real data lives at
  // config.mcp.servers, logged on the line below it.
  console.log(
    `[openclaw.config] mcpServers: ${JSON.stringify(config.mcpServers)}`
  );
  console.log(
    `[openclaw.config] mcp.servers: ${JSON.stringify(config.mcp.servers)}`
  );

  return config;
}


function toJson5(config) {
  // OpenClaw config is JSON5 but plain JSON is valid JSON5, so pretty JSON
  // is sufficient here and keeps this generator dependency-free.
  return JSON.stringify(config, null, 2) + "\n";
}

function main() {
  const args = process.argv.slice(2);
  const printOnly = args.includes("--print");

  const config = buildConfig(process.env);
  const rendered = toJson5(config);

  if (printOnly) {
    process.stdout.write(rendered);
    return;
  }

  const configPath = resolveConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, rendered, "utf8");

  console.log(`[openclaw.config] Wrote ${configPath}`);
  console.log(
    `[openclaw.config] Default model: ${config.agents.defaults.model.primary}`
  );
  console.log(
    `[openclaw.config] Fallback models: ${config.agents.defaults.model.fallbacks.join(", ") || "(none)"}`
  );
  console.log(
    `[openclaw.config] Workspace: ${config.agents.defaults.workspace}`
  );
}

main();

module.exports = { buildConfig, resolveConfigPath, resolveWorkspacePath };
