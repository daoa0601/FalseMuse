import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { JobJournal, prepareSession } from "../node/jobs.ts";
import { processHandle, processRunning } from "../node/process.ts";
import { spawnCommand } from "./support.ts";

test("a restarted journal retains the task and abort intent until acknowledgement", () => {
  const directory = mkdtempSync(join(tmpdir(), "optchat-jobs-"));
  try {
    const journal = new JobJournal(directory);
    journal.save({
      command: spawnCommand({ id: "read-plan", task: "Read the saved plan" }),
      sessionFile: join(directory, "session.jsonl"),
      state: "starting",
      actor: null,
      report: "",
      failure: null,
      aborted: true,
      steering: ["Do not write files"],
    });
    const recovered = new JobJournal(directory);
    const job = recovered.get("read-plan");
    assert.equal(job?.command.task, "Read the saved plan");
    assert.equal(job?.aborted, true);
    assert.equal(job?.steering[0], "Do not write files");
    assert.equal(statSync(join(directory, "read-plan.json")).mode & 0o777, 0o600);
    recovered.remove("read-plan");
    assert.equal(recovered.get("read-plan"), null);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("session recovery keeps complete records and preserves an unfinished tail separately", () => {
  const directory = mkdtempSync(join(tmpdir(), "optchat-session-"));
  try {
    const file = join(directory, "session.jsonl");
    writeFileSync(
      file,
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "Keep the original task" },
      }) + '\n{"type":"message","unfinished":',
    );
    prepareSession(file);
    const record = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(record.message.content, "Keep the original task");
    const [tail] = readdirSync(directory).filter((file) => file.endsWith(".tail"));
    assert.ok(tail);
    assert.match(readFileSync(join(directory, tail), "utf8"), /unfinished/);
    assert.equal(statSync(join(directory, tail)).mode & 0o777, 0o600);
    writeFileSync(file, '{"type":"session"}\ninvalid complete record\n');
    assert.throws(() => prepareSession(file), /:2 contains an invalid complete record/);
    assert.match(readFileSync(file, "utf8"), /invalid complete record/);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("recovery observes the old process until it has actually exited", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  await once(child, "spawn");
  const exited = once(child, "exit");
  try {
    assert.ok(child.pid);
    const handle = processHandle(child.pid);
    assert.ok(handle);
    assert.equal(processRunning(handle), true);
    assert.equal(processRunning({ ...handle, started: "another process" }), false);
    child.kill("SIGTERM");
    await exited;
    assert.equal(processRunning(handle), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
