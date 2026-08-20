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
 * Tier -> OpenClaw provider mapping (see config/models.yaml header comment):
 *   provider: bedrock -> OpenClaw provider id "amazon-bedrock" (auth: aws-sdk,
 *             credentials from AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_REGION)
 *   provider: openai  -> OpenClaw provider id "openai" (auth via OPENAI_API_KEY,
 *             base URL from each tier's `base_url`, default https://api.openai.com/v1)
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
const PROVIDER_ID_MAP = {
  bedrock: "amazon-bedrock",
  openai: "openai",
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
    name: opts.label,
    reasoning: !!opts.reasoning,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
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


function buildConfig(env) {
  const modelsYaml = loadModelsYaml();
  const tiers = modelsYaml.tiers || {};
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1";

  const bedrockModels = [];
  const seenBedrockIds = new Set();
  const openaiModels = [];
  const seenOpenaiIds = new Set();
  let openaiBaseUrl = null;

  for (const [, tier] of Object.entries(tiers)) {
    const pid = providerId(tier);
    if (pid === "amazon-bedrock") {
      if (!tier.model || seenBedrockIds.has(tier.model)) continue;
      seenBedrockIds.add(tier.model);
      bedrockModels.push(buildModelEntry(tier.model, tier));
    } else if (pid === "openai") {
      if (!tier.model || seenOpenaiIds.has(tier.model)) continue;
      seenOpenaiIds.add(tier.model);
      openaiModels.push(buildModelEntry(tier.model, tier));
      openaiBaseUrl = openaiBaseUrl || tier.base_url;
    }
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
  if (openaiModels.length > 0) {
    providers["openai"] = {
      baseUrl: openaiBaseUrl || "https://api.openai.com/v1",
      api: "openai-responses",
      apiKey: "${OPENAI_API_KEY}",
      models: openaiModels,
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
    },
    agents: {
      defaults: {
        workspace: resolveWorkspacePath(),
        model: {
          primary: defaultModelRef,
          fallbacks: fallbackRefs,
        },
      },
      entries: {
        main: {
          identity: {
            name: "BBX PAW",
            theme: "autonomous research and coding assistant for BBX",
            emoji: "🐾",
          },
        },
      },
    },
    models: {
      providers,
    },
    memory: {
      search: {
        // Bedrock Titan embeddings for agent memory search — uses the same
        // AWS SDK credential chain as inference, no extra API key needed.
        provider: "bedrock",
        model: "amazon.titan-embed-text-v2:0",
      },
    },
    // NOTE: OpenClaw's own control-plane/session state is always SQLite
    // (see docs/ARCHITECTURE.md "Storage" section) — it is NOT MongoDB.
    // MONGO_URI is consumed by our own trigger-jobs/openclaw-task.js for
    // job bookkeeping shared with BBX Chat, not by the OpenClaw gateway.
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
