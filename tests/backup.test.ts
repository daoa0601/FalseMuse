import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lastBackup, localDay, scheduleBackups, type RemoteBucket } from "../node/backup.ts";
import { openDatabase } from "../node/sqlite.ts";

test("the owner's day and hour come from their time zone", () => {
  const now = Date.parse("2026-10-23T22:30:00Z");
  assert.deepEqual(localDay(now, "Europe/Helsinki"), { date: "2026-10-24", hour: 1 });
  assert.deepEqual(localDay(now, "UTC"), { date: "2026-10-23", hour: 22 });
});

test("backups run once a day from their hour, and a restart the same day does not run another", async () => {
  const directory = mkdtempSync(join(tmpdir(), "optchat-backup-"));
  const uploads: string[] = [];
  const remote: RemoteBucket = {
    list: async () => [],
    upload: async (key) => {
      uploads.push(key);
    },
    remove: async () => {},
  };
  const database = openDatabase(join(directory, "master.sqlite"));
  const today = localDay(Date.now(), "UTC").date;
  const schedule = () =>
    scheduleBackups({
      snapshot: (target) => database.exec("VACUUM INTO ?", target),
      bucket: join(directory, "bucket"),
      directory,
      remote,
      timezone: "UTC",
      hour: 0,
      checkMs: 20,
      log: () => {},
    });
  try {
    const first = schedule();
    const deadline = Date.now() + 5_000;
    while (lastBackup(directory) !== today) {
      assert.ok(Date.now() < deadline, "No backup ran");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    await first.stop();
    const second = schedule();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await second.stop();
    assert.deepEqual(uploads, [`snapshots/master-${today}.sqlite.gz`]);
  } finally {
    database.close();
    rmSync(directory, { recursive: true });
  }
});
