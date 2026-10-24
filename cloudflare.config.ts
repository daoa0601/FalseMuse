import { defineConfig } from "@cloudflare/config";
import * as entrypoint from "./src/worker.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "optchat-memory",
    compatibilityDate: "2026-10-04",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint,
    exports: {
      // The Master moved to the laptop; these classes are deleted with their data. Keep the
      // tombstones until a deploy lists them as removable.
      Master: { type: "durable-object", state: "deleted" },
      Sandbox: { type: "durable-object", state: "deleted" },
      Inbox: { type: "durable-object", storage: "sqlite" },
    },
    env: {
      TRANSCRIPTS: { type: "r2", name: "optchat-memory-transcripts" },
      OWNER_KEY: { type: "secret" },
    },
  },
});
