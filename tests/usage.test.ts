import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../node/sqlite.ts";
import { UsageLedger, allowsCompaction } from "../src/usage.ts";

test("node calls survive duplicate delivery and an older replay cannot replace the current quota", () => {
  const database = openDatabase(":memory:");
  try {
    const ledger = new UsageLedger(database);
    ledger.record({
      id: "cloud-call",
      date: "2026-10-05T10:00:00Z",
      purpose: "master",
      model: "gpt-6.1-sol",
      quota: { "x-codex-primary-used-percent": "85" },
      usage: { input_tokens: 12, output_tokens: 4 },
    });
    const node = {
      id: "node-call",
      source: "laptop",
      job: "read-plan",
      date: "2026-10-05T09:00:00Z",
      purpose: "pi",
      model: "gpt-6.1-sol",
      quota: {
        "x-codex-primary-used-percent": "70",
        "x-codex-turn-state": "private state",
        authorization: "private credential",
      },
      usage: {
        input: 20,
        output: 5,
        cacheRead: 10,
        cost: { total: 123 },
        diagnostic: "private response",
      },
    };
    ledger.record(node);
    ledger.record(node);
    const calls = ledger.recent();
    assert.equal(calls.length, 2);
    assert.equal(ledger.latestQuota()["x-codex-primary-used-percent"], "85");
    const recorded = calls.find((call) => call.source === "laptop");
    assert.equal(recorded?.job, "read-plan");
    assert.deepEqual(recorded?.usage, { input: 20, output: 5, cacheRead: 10 });
    assert.deepEqual(recorded?.quota, { "x-codex-primary-used-percent": "70" });
  } finally {
    database.close();
  }
});

test("compaction pauses at 80% of either window until that window resets", () => {
  const now = Date.parse("2026-10-08T00:00:00Z");
  const resetLater = String(now / 1000 + 3600);
  const resetEarlier = String(now / 1000 - 1);
  assert.equal(allowsCompaction({ "x-codex-secondary-used-percent": "79" }, now), true);
  assert.equal(
    allowsCompaction(
      { "x-codex-primary-used-percent": "80", "x-codex-primary-reset-at": resetLater },
      now,
    ),
    false,
  );
  assert.equal(
    allowsCompaction(
      { "x-codex-primary-used-percent": "100", "x-codex-primary-reset-at": resetEarlier },
      now,
    ),
    true,
  );
});
