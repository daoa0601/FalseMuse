import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

test("the prototype preserves an unfinished tree without accessing credentials when the recorded quota is exhausted", () => {
  const directory = mkdtempSync(join(tmpdir(), "optchat-prototype-"));
  try {
    const exportDirectory = join(directory, "data/phase1-2026-10-05");
    const prototype = join(directory, "data/prototype-2026-09-gpt-6-luna");
    mkdirSync(exportDirectory, { recursive: true });
    mkdirSync(prototype, { recursive: true });
    writeFileSync(
      join(exportDirectory, "import.jsonl"),
      JSON.stringify({
        kind: "user",
        text: "A long source message. ".repeat(40),
        session: "sample",
        index: 0,
        timestamp: "2026-09-15T12:00:00Z",
      }) + "\n",
    );
    writeFileSync(
      join(prototype, "calls.jsonl"),
      JSON.stringify({
        attempts: [
          {
            quota: {
              "x-codex-primary-used-percent": "100",
              "x-codex-primary-reset-at": String(Math.floor(Date.now() / 1000) + 86400),
            },
          },
        ],
      }) + "\n",
    );
    const child = spawnSync(
      process.execPath,
      [resolve("scripts/prototype.ts"), "2026-09", "gpt-6-luna", "30"],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const result: unknown = JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "null");
    assert.ok(typeof result === "object" && result !== null);
    assert.deepEqual(
      {
        calls: "calls" in result && result.calls,
        paused: "quotaPaused" in result && result.quotaPaused,
        settled: "settled" in result && result.settled,
      },
      { calls: 0, paused: true, settled: false },
    );
    assert.match(readFileSync(join(prototype, "view.txt"), "utf8"), /not summarized yet/);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
