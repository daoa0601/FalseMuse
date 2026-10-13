import { defineConfig, defineContainer } from "@cloudflare/config";
import * as entrypoint from "./src/worker.ts" with { type: "cf-worker" };

const sandbox = defineContainer({
  name: "optchat-pi",
  schedulingPolicy: "durable-object",
  images: { pi: { dockerfile: "./Dockerfile", buildContext: "./.sandbox-build" } },
  ssh: { enabled: false },
});

export default defineConfig({
  worker: {
    name: "optchat-memory",
    compatibilityDate: "2026-10-04",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint,
    exports: {
      Master: { type: "durable-object", storage: "sqlite" },
      Sandbox: { type: "durable-object", storage: "sqlite", container: sandbox },
    },
    env: {
      TRANSCRIPTS: { type: "r2", name: "optchat-memory-transcripts" },
      OWNER_KEY: { type: "secret" },
      LOADER: { type: "worker-loader" },
      COMPACTOR_MODEL: { type: "text", value: "gpt-6-luna" },
      COMPACTOR_EFFORT: { type: "text", value: "high" },
      MASTER_MODEL: { type: "text", value: "gpt-6.1-sol" },
      OWNER_TIMEZONE: { type: "text", value: "Europe/Helsinki" },
    },
  },
  containers: [sandbox],
});
