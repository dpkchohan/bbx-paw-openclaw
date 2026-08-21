/**
 * workflows/trigger-jobs/openclaw-task.js
 * ---------------------------------------------------------------------------
 * Trigger.dev v3 task that lets BBX Chat hand a task off to the OpenClaw
 * agent running in the `openclaw` Gateway container and get the result back
 * asynchronously.
 *
 * Flow:
 *   BBX Chat  --POST /api/jobs/trigger-->  Trigger.dev (server.pddt.in)
 *                                                |
 *                                                v
 *                                     openclawTask.run() (this file)
 *                                                |
 *              1. Map payload.tier -> Bedrock/4-tier model id
 *              2. POST to the OpenClaw Gateway's OpenAI-compatible endpoint
 *                 (http://openclaw:18789/v1/chat/completions), using
 *                 `user: "conv:<sessionKey>"` so multi-turn jobs reuse the
 *                 same OpenClaw agent session.
 *              3. Persist status/result to MongoDB (shared with BBX Chat)
 *              4. Optionally POST a completion webhook back to BBX Chat
 *                                                |
 *                                                v
 *                                     BBX Chat polls GET /api/jobs/:jobId
 *                                     or receives the webhook notification.
 *
 * Trigger from BBX Chat's backend:
 *   import { tasks } from "@trigger.dev/sdk";
 *   const handle = await tasks.trigger("openclaw-task", {
 *     prompt: "Research NASA GSFC projects and create a summary report",
 *     tier: "coding",
 *     sessionKey: `bbx-user-${userId}`,
 *     userId,
 *     deliver: { webhookUrl: `${BBX_CHAT_BASE_URL}/api/jobs/webhook` },
 *   });
 * ---------------------------------------------------------------------------
 */

import { task } from "@trigger.dev/sdk";
import { MongoClient } from "mongodb";

const OPENCLAW_GATEWAY_URL =
  process.env.OPENCLAW_GATEWAY_URL || "http://openclaw:18789";
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";

const TIER_MODEL_REF = {
  cheap: `amazon-bedrock/${process.env.MODEL_CHEAP || "us.amazon.nova-pro-v1:0"}`,
  default: `amazon-bedrock/${process.env.MODEL_DEFAULT || "global.openai.gpt-5.6-luna"}`,
  coding: `amazon-bedrock/${process.env.MODEL_CODING || "anthropic.claude-sonnet-4-5-20250929-v1:0"}`,
  critical: `amazon-bedrock/${process.env.MODEL_CRITICAL || "global.anthropic.claude-sonnet-5"}`,
};



let mongoClientPromise = null;
function getMongoClient() {
  if (!process.env.MONGO_URI) return null;
  if (!mongoClientPromise) {
    mongoClientPromise = MongoClient.connect(process.env.MONGO_URI);
  }
  return mongoClientPromise;
}

async function recordJobState(jobId, patch) {
  const client = await getMongoClient();
  if (!client) return; // MongoDB is optional; job still runs without it.
  const db = client.db(process.env.MONGO_DB_NAME || "bbx_chat");
  const collection = db.collection(
    process.env.MONGO_PAW_JOBS_COLLECTION || "paw_jobs"
  );
  await collection.updateOne(
    { jobId },
    { $set: { jobId, updatedAt: new Date(), ...patch } },
    { upsert: true }
  );
}

async function callOpenClawGateway({ prompt, tier, sessionKey, modelOverride }) {
  const model = modelOverride || TIER_MODEL_REF[tier] || TIER_MODEL_REF.default;

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
  };
  // x-openclaw-model pins the exact backend provider/model for this call;
  // `model` stays a stable alias so BBX Chat and dashboards see one name.
  headers["x-openclaw-model"] = model;

  const response = await fetch(`${OPENCLAW_GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "openclaw/default",
      user: sessionKey ? `conv:${sessionKey}` : undefined,
      stream: false,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const raw = await response.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(
      `OpenClaw Gateway returned non-JSON (status ${response.status}): ${raw.slice(0, 500)}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `OpenClaw Gateway error (status ${response.status}): ${JSON.stringify(json)}`
    );
  }

  const choice = json.choices && json.choices[0];
  return {
    text: choice?.message?.content ?? "",
    usage: json.usage ?? null,
    raw: json,
  };
}

async function notifyBbxChat({ webhookUrl, jobId, status, result, error }) {
  if (!webhookUrl) return;
  await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bbx-webhook-secret": process.env.BBX_CHAT_WEBHOOK_SECRET || "",
    },
    body: JSON.stringify({ jobId, status, result, error }),
  }).catch((err) => {
    // Never fail the task just because the webhook callback failed; the
    // BBX Chat backend can still poll GET /api/jobs/:jobId.
    console.error(`[openclaw-task] webhook notify failed: ${err.message}`);
  });
}

export const openclawTask = task({
  id: "openclaw-task",
  // Autonomous research/coding runs can take a long time (spec example:
  // "spends 2 hours researching"). Give it generous headroom.
  maxDuration: 3 * 60 * 60, // 3 hours, in seconds
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 60000,
  },
  run: async (payload, { ctx }) => {
    const {
      prompt,
      tier = "default",
      sessionKey,
      userId,
      modelOverride,
      deliver,
    } = payload;

    if (!prompt || typeof prompt !== "string") {
      throw new Error("openclaw-task payload requires a non-empty 'prompt' string");
    }

    const jobId = ctx.run.id;

    await recordJobState(jobId, {
      status: "running",
      prompt,
      tier,
      sessionKey: sessionKey || null,
      userId: userId || null,
      startedAt: new Date(),
    });

    try {
      const result = await callOpenClawGateway({
        prompt,
        tier,
        sessionKey,
        modelOverride,
      });

      await recordJobState(jobId, {
        status: "completed",
        result: result.text,
        usage: result.usage,
        completedAt: new Date(),
      });

      await notifyBbxChat({
        webhookUrl: deliver?.webhookUrl,
        jobId,
        status: "completed",
        result: result.text,
      });

      return {
        jobId,
        status: "completed",
        tier,
        model: modelOverride || TIER_MODEL_REF[tier] || TIER_MODEL_REF.default,
        text: result.text,
        usage: result.usage,
      };
    } catch (error) {
      await recordJobState(jobId, {
        status: "failed",
        error: error.message,
        failedAt: new Date(),
      });

      await notifyBbxChat({
        webhookUrl: deliver?.webhookUrl,
        jobId,
        status: "failed",
        error: error.message,
      });

      // Re-throw so Trigger.dev's retry/backoff and dashboard error
      // reporting behave normally.
      throw error;
    }
  },
});
