import { defineConfig } from "@trigger.dev/sdk";

// =============================================================================
// BBX PAW — Trigger.dev v3 project config
// =============================================================================
// Points the Trigger.dev CLI/SDK at workflows/trigger-jobs/ for task
// discovery. Deploys to the self-hosted instance at https://server.pddt.in
// (already running BBX Chat's other background jobs on the same EC2 host).
//
// Required env for `npx trigger.dev@latest dev|deploy`:
//   TRIGGER_SECRET_KEY  - from the Trigger.dev dashboard / self-hosted UI
//   TRIGGER_API_URL     - https://server.pddt.in (self-hosted API base URL)
// =============================================================================
export default defineConfig({
  // Project ref from the Trigger.dev dashboard (Project settings page) on
  // the self-hosted instance at TRIGGER_API_URL. Fill this in once the
  // project is created there.
  project: process.env.TRIGGER_PROJECT_REF || "<project ref>",
  dirs: ["./workflows/trigger-jobs"],
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 2000,
      maxTimeoutInMs: 30000,
      factor: 2,
      randomize: true,
    },
  },
});
