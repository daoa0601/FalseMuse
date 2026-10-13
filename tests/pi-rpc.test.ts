import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { PiRpc } from "../node/pi-rpc.ts";

function rpcProcess(directory: string, failStartup = false): PiRpc {
  writeFileSync(
    join(directory, "pi"),
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';
const send = event => process.stdout.write(JSON.stringify(event) + '\\n');
const ready = key => send({type:'extension_ui_request',method:'setStatus',statusKey:key,statusText:'ready'});
let commands = [];
const input = createInterface({input:process.stdin});
input.on('line', line => {
  const command = JSON.parse(line);
  commands.push(command.type);
  if(command.type === 'prompt') writeFileSync('prompt-received','yes');
  send({type:'response',id:command.id,success:true,data:{commands}});
});
input.on('close',()=>process.exit(0));
ready('optchat_permissions');
if(${failStartup}) send({type:'extension_error',extensionPath:'usage.js',event:'session_start',error:'Forced startup failure'});
else {
  const timer=setInterval(()=>{
    if(existsSync('release-startup')) {clearInterval(timer);ready('optchat_usage');}
  },10);
}
`,
    { mode: 0o700 },
  );
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  const previous = process.env["PATH"];
  try {
    process.env["PATH"] = directory + delimiter + previous;
    return new PiRpc({
      cwd: directory,
      sessionDirectory: directory,
      agentDirectory: directory,
      tools: ["read"],
    });
  } finally {
    process.env["PATH"] = previous;
  }
}

test("Pi receives no prompt until both required extensions confirm startup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "optchat-rpc-"));
  const rpc = rpcProcess(directory);
  try {
    const prompt = rpc.command("prompt", { message: "Read the requested file" });
    const state = await rpc.command("get_state");
    assert.deepEqual(state, { commands: ["get_state"] });
    writeFileSync(join(directory, "release-startup"), "ready");
    await prompt;
    assert.ok(existsSync(join(directory, "prompt-received")));
  } finally {
    rpc.close();
    await once(rpc.child, "exit");
    rmSync(directory, { recursive: true });
  }
});

test("an extension failure rejects the task and terminates Pi before a prompt is sent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "optchat-rpc-"));
  const rpc = rpcProcess(directory, true);
  const exited = once(rpc.child, "exit");
  const faults: Error[] = [];
  rpc.on("fault", (error) => faults.push(error));
  try {
    await assert.rejects(
      rpc.command("prompt", { message: "Never run this task" }),
      /usage.js failed during session_start/,
    );
    await exited;
    assert.equal(existsSync(join(directory, "prompt-received")), false);
    assert.equal(faults.length, 1);
    const cause = faults[0]?.cause;
    assert.ok(cause instanceof Error);
    assert.equal(cause.message, "Forced startup failure");
  } finally {
    rpc.close();
    rmSync(directory, { recursive: true });
  }
});

test("abort during startup cancels the waiting prompt and terminates Pi", async () => {
  const directory = mkdtempSync(join(tmpdir(), "optchat-rpc-"));
  const rpc = rpcProcess(directory);
  const exited = once(rpc.child, "exit");
  try {
    const prompt = rpc.command("prompt", { message: "Never run this task" });
    const rejected = assert.rejects(prompt, /aborted before startup finished/);
    await rpc.command("get_state");
    await rpc.command("abort");
    await rejected;
    await exited;
    assert.equal(existsSync(join(directory, "prompt-received")), false);
  } finally {
    rpc.close();
    rmSync(directory, { recursive: true });
  }
});
