import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../node/sqlite.ts";
import { Schedules, localTime } from "../src/schedules.ts";

test("a delayed repeating schedule queues one note and cancellation stops future runs", () => {
  const database = openDatabase(":memory:");
  try {
    database.exec("CREATE TABLE turns (text TEXT, kind TEXT, status TEXT)");
    const schedules = new Schedules(database);
    const start = Date.now() + 60_000;
    const schedule = schedules.create({
      prompt: "Check the open tasks",
      at: new Date(start).toISOString(),
      every_minutes: 60,
    });
    assert.equal(schedules.fireDue(start - 1), 0);
    const delayed = start + 4 * 60 * 60_000;
    assert.equal(schedules.fireDue(delayed), 1);
    assert.equal(schedules.fireDue(delayed), 0);
    const [queued] = database.rows<{ kind: string; text: string }>("SELECT * FROM turns");
    assert.equal(queued?.kind, "note");
    assert.match(queued?.text ?? "", /Check the open tasks/);
    assert.equal(schedules.nextWake(), delayed + 60 * 60_000);
    schedules.cancel(schedule.id);
    assert.equal(schedules.fireDue(delayed + 2 * 60 * 60_000), 0);
  } finally {
    database.close();
  }
});

test("the owner's local time is an ISO time with its offset, which a schedule accepts", () => {
  assert.equal(
    localTime(Date.parse("2026-10-11T15:05:00Z"), "Europe/Helsinki"),
    "Sunday 2026-10-11T18:05+03:00 (Europe/Helsinki)",
  );
  assert.equal(
    localTime(Date.parse("2026-12-31T23:30:00Z"), "UTC"),
    "Thursday 2026-12-31T23:30+00:00 (UTC)",
  );
  const database = openDatabase(":memory:");
  try {
    const now = Date.parse("2026-10-11T15:05:00Z");
    const at = localTime(now + 60 * 60_000, "Europe/Helsinki").split(" ")[1] ?? "";
    assert.equal(
      new Schedules(database).create({ prompt: "Check in", at }, now).at,
      now + 3_600_000,
    );
  } finally {
    database.close();
  }
});
