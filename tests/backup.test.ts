import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  lastBackup,
  localDay,
  scheduleBackups,
  workerBucket,
  type RemoteBucket,
} from "../node/backup.ts";
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

test("a backup request dropped by the network or refused by a busy server is tried again", async () => {
  let attempts = 0;
  const server = createServer((request, response) => {
    attempts++;
    if (attempts === 1) {
      request.socket.destroy();
      return;
    }
    if (attempts === 2) {
      response.writeHead(503).end("busy");
      return;
    }
    if (attempts > 10) {
      response.writeHead(400).end('{"error":"Only snapshots can be deleted"}');
      return;
    }
    request.resume();
    request.on("end", () => response.writeHead(200).end('{"key":"a","size":3}'));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const directory = mkdtempSync(join(tmpdir(), "optchat-backup-"));
  try {
    writeFileSync(join(directory, "a"), "abc");
    const remote = workerBucket(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      {},
      { retryMs: 10 },
    );
    await remote.upload("a", join(directory, "a"), 3);
    assert.equal(attempts, 3);
    // A refusal is final.
    attempts = 10;
    await assert.rejects(remote.remove("sessions/x"), /answered 400/);
    assert.equal(attempts, 11);
  } finally {
    server.close();
    rmSync(directory, { recursive: true });
  }
});
