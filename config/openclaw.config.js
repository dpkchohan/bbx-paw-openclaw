#!/usr/bin/env node
/**
 * config/openclaw.config.js
 * ---------------------------------------------------------------------------
 * Generates ~/.openclaw/openclaw.json (or $OPENCLAW_CONFIG_PATH) for the
 * OpenClaw Gateway from:
 *   - config/models.yaml          (4-tier model strategy)
 *   - process.env                 (secrets, ports, paths — see .env.example)
 *
 * OpenClaw's real config file is openclaw.json (JSON5) read from
 * OPENCLAW_CONFIG_PATH (default ~/.openclaw/openclaw.json). There is no
 * "openclaw.config.js" file consumed by OpenClaw itself — this script is
 * OUR generator that produces that JSON5 file so the 4-tier strategy in
 * models.yaml stays the single source of truth instead of being hand-edited
 * in two places.
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

function expandEnvTemplate(value, env) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (match, name) => {
    return env[name] !== undefined && env[name] !== "" ? env[name] : match;
  });
}

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

function buildBedrockModelEntry(id, opts) {
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

function buildConfig(env) {
  const modelsYaml = loadModelsYaml();
  const tiers = modelsYaml.tiers || {};
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1";

  // Resolve ${VAR} placeholders inside models.yaml against process.env.
  const resolvedTierModelId = {};
  for (const [tierName, tier] of Object.entries(tiers)) {
    resolvedTierModelId[tierName] = expandEnvTemplate(tier.model, env);
  }

  const bedrockModels = [];
  const seenBedrockIds = new Set();
  for (const [tierName, tier] of Object.entries(tiers)) {
    if (tier.provider !== "amazon-bedrock") continue;
    const modelId = resolvedTierModelId[tierName];
    if (!modelId || seenBedrockIds.has(modelId)) continue;
    seenBedrockIds.add(modelId);
    bedrockModels.push(buildBedrockModelEntry(modelId, tier));
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

  // Optional OpenAI-compatible provider for tiers that cannot run on Bedrock
  // (see the warning at the top of models.yaml — e.g. the "default" tier).
  const openaiCompatTiers = Object.entries(tiers).filter(
    ([, t]) => t.provider === "openai-compatible"
  );
  if (openaiCompatTiers.length > 0 && env.OPENAI_COMPATIBLE_BASE_URL) {
    providers["openai-compatible"] = {
      baseUrl: env.OPENAI_COMPATIBLE_BASE_URL,
      api: "openai-responses",
      apiKey: "${OPENAI_COMPATIBLE_API_KEY}",
      models: openaiCompatTiers.map(([tierName, tier]) =>
        buildBedrockModelEntry(resolvedTierModelId[tierName], tier)
      ),
    };
  }

  const defaultTierName = modelsYaml.defaultTier || "default";
  const defaultTier = tiers[defaultTierName];
  const defaultModelRef = defaultTier
    ? `${defaultTier.provider}/${resolvedTierModelId[defaultTierName]}`
    : `amazon-bedrock/${env.MODEL_CHEAP || "us.amazon.nova-pro-v1:0"}`;

  const fallbackRefs = Object.entries(tiers)
    .filter(([name]) => name !== defaultTierName)
    .map(([name, tier]) => `${tier.provider}/${resolvedTierModelId[name]}`);

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
