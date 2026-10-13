import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { close, listen } from "./support.ts";

test("terminal chat waits for its own reply through a pending backend error", async () => {
  let polls = 0;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/chat") {
      response.writeHead(202).end(JSON.stringify({ queued: true, id: 41 }));
    } else if (request.url === "/api/turns/41") {
      polls++;
      response.end(
        JSON.stringify({
          id: 41,
          replyId: 40,
          status: polls === 1 ? "pending" : "done",
          text: polls === 1 ? "" : "The stored reply arrived.",
        }),
      );
    } else if (request.url === "/api/status") {
      response.end(
        JSON.stringify({ authenticated: true, error: "Provider temporarily returned 403" }),
      );
    } else response.writeHead(404).end("{}");
  });
  const url = await listen(server);
  const directory = mkdtempSync(join(tmpdir(), "optchat-cli-"));
  try {
    mkdirSync(join(directory, "data"));
    writeFileSync(join(directory, "data/cloud.json"), JSON.stringify({ url }));
    writeFileSync(
      join(directory, "data/owner-secrets.json"),
      JSON.stringify({ OWNER_KEY: "test-owner" }),
    );
    const child = spawn(
      process.execPath,
      [resolve("scripts/chat.ts"), "Remember the terminal channel"],
      {
        cwd: directory,
      },
    );
    let output = "";
    let diagnostics = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostics += chunk.toString();
    });
    const code = await new Promise((done, reject) => {
      child.on("error", reject);
      child.on("exit", done);
    });
    assert.equal(code, 0, diagnostics);
    assert.match(output, /The stored reply arrived/);
    assert.match(diagnostics, /still pending and will retry/);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true });
  }
});
