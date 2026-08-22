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
function buildWhatsAppChannelConfig(env) {
  if (env.OPENCLAW_CHANNEL_WHATSAPP_ENABLED === "0") {
    return { enabled: false };
  }

  const allowFrom = (env.OPENCLAW_WHATSAPP_ALLOW_FROM || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const config = {
    enabled: true,
    // "pairing" (default) queues an approval request for unknown senders
    // instead of silently allowing everyone -- see docs/WHATSAPP-BAILEYS-SETUP.md.
    dmPolicy: env.OPENCLAW_WHATSAPP_DM_POLICY || "pairing",
    groupPolicy: env.OPENCLAW_WHATSAPP_GROUP_POLICY || "disabled",
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
      whatsapp: buildWhatsAppChannelConfig(env),
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
