import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskRunner } from "../node/runner.ts";
import type { NodeMessage } from "../src/protocol.ts";
import { close, listen, spawnCommand } from "./support.ts";

test("a settled task republishes its scanned transcript and report without needing model credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "optchat-runner-"));
  let transcript = "";
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-node");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    transcript = Buffer.concat(chunks).toString();
    response.end('{"ok":true}');
  });
  const url = await listen(server);
  try {
    const sessionFile = join(directory, "node-sessions/read-plan/session.jsonl");
    mkdirSync(join(directory, "node-sessions/read-plan"), { recursive: true });
    writeFileSync(
      sessionFile,
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "Read the plan" }] },
      }) + "\n",
    );
    const sent: NodeMessage[] = [];
    const runner = new TaskRunner(
      { name: "test-node", directory, roots: [directory], tools: ["read"], key: "test-node", url },
      (message) => sent.push(message),
    );
    const command = spawnCommand({ id: "read-plan", cwd: directory, task: "Read the plan" });
    runner.journal.save({
      command,
      sessionFile,
      state: "settled",
      actor: null,
      report: "The plan was read",
      failure: null,
      aborted: false,
      steering: [],
    });
    await runner.spawn(command);
    assert.match(transcript, /Read the plan/);
    assert.deepEqual(sent[0], {
      type: "report",
      id: "read-plan",
      report: "The plan was read",
      status: "done",
    });
    assert.ok(runner.journal.get(command.id));
    runner.acknowledge(command.id);
    assert.equal(runner.journal.get(command.id), null);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true });
  }
});
