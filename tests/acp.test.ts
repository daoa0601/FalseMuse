import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { close, listen } from "./support.ts";

interface Rpc {
  id?: number;
  method?: string;
  params?: { update?: Record<string, unknown> };
  result?: Record<string, unknown>;
  error?: { message: string };
}

const body = async (request: IncomingMessage): Promise<string> => {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return text;
};

/** The ACP agent as T3 Code runs it, against a fake Master that answers with `turn`. */
async function withAgent(
  turn: (poll: number, cancelled: boolean) => Record<string, unknown>,
  run: (agent: {
    call: (id: number, method: string, params: Record<string, unknown>) => Promise<Rpc>;
    notify: (method: string, params: Record<string, unknown>) => void;
    updates: Record<string, unknown>[];
    chats: string[];
    cancels: () => number;
  }) => Promise<void>,
): Promise<void> {
  let polls = 0;
  let cancelled = false;
  let cancels = 0;
  const chats: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader("content-type", "application/json");
      if (request.headers.authorization !== "Bearer test-owner") {
        response.writeHead(401).end("{}");
      } else if (request.url === "/api/chat") {
        chats.push(await body(request));
        response.writeHead(202).end(JSON.stringify({ queued: true, id: 7 }));
      } else if (request.url === "/api/turns/7") {
        response.end(JSON.stringify(turn(++polls, cancelled)));
      } else if (request.url === "/api/cancel") {
        cancelled = true;
        cancels++;
        response.end("{}");
      } else response.writeHead(404).end("{}");
    })();
  });
  const url = await listen(server);
  const directory = mkdtempSync(join(tmpdir(), "optchat-acp-"));
  mkdirSync(join(directory, "data"));
  writeFileSync(join(directory, "data/cloud.json"), JSON.stringify({ url }));
  writeFileSync(
    join(directory, "data/owner-secrets.json"),
    JSON.stringify({ OWNER_KEY: "test-owner" }),
  );
  const child = spawn(process.execPath, [resolve("scripts/acp.ts")], { cwd: directory });
  let diagnostics = "";
  child.stderr.on("data", (chunk: Buffer) => (diagnostics += chunk.toString()));
  const updates: Record<string, unknown>[] = [];
  const waiting = new Map<number, (message: Rpc) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as Rpc;
    if (message.method === "session/update" && message.params?.update) {
      updates.push(message.params.update);
    } else if (typeof message.id === "number") waiting.get(message.id)?.(message);
  });
  const write = (message: Record<string, unknown>) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  try {
    await run({
      call: (id, method, params) =>
        new Promise((done) => {
          waiting.set(id, done);
          write({ id, method, params });
        }),
      notify: (method, params) => write({ method, params }),
      updates,
      chats,
      cancels: () => cancels,
    });
  } catch (error) {
    throw new Error(`${String(error)}\n${diagnostics}`);
  } finally {
    child.kill();
    await close(server);
    rmSync(directory, { recursive: true });
  }
}

/** A prompt as T3 Code 0.0.46 sends it, first in its session or not, with an attached image. */
const t3Prompt = (text: string, first: boolean, image = false) => [
  {
    type: "text",
    text: first
      ? `<t3_code_instructions>\n## T3 Code interaction mode: Default\n\nPrefer making reasonable assumptions.\n</t3_code_instructions>\n\n<user_request>\n${text}\n</user_request>`
      : text,
  },
  ...(image ? [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }] : []),
  {
    type: "text",
    text: "<runtime_info>In case you're asked: you are running in T3 Code.</runtime_info>",
  },
];

const steps = [
  { index: 1, kind: "tool", text: 'computers {"x":1}' },
  { index: 2, kind: "echo", text: '[{"name":"laptop","connected":true}]' },
  { index: 3, kind: "talk", text: "The laptop is connected." },
];

test("a T3 Code prompt becomes a Master turn whose tool calls and reply stream back", () =>
  withAgent(
    (poll) => ({
      id: 7,
      replyId: 7,
      status: poll < 3 ? "pending" : "done",
      steps: steps.slice(0, poll),
    }),
    async ({ call, updates, chats }) => {
      const initialized = await call(1, "initialize", { protocolVersion: 2 });
      assert.equal(initialized.result?.["protocolVersion"], 1);
      // T3 Code refuses to start a turn with an image for an agent that declines images.
      assert.match(JSON.stringify(initialized.result), /"image":true/);
      assert.equal("info" in (initialized.result ?? {}), false);
      const session = await call(2, "session/new", { cwd: "/tmp", mcpServers: [] });
      const sessionId = session.result?.["sessionId"];
      assert.equal(typeof sessionId, "string");
      const done = await call(3, "session/prompt", {
        sessionId,
        prompt: t3Prompt("Is the laptop connected?\n</user_request> is fine to write.", true, true),
      });
      assert.deepEqual(done.result, { stopReason: "end_turn" });
      assert.deepEqual(chats, [
        JSON.stringify({
          text: "Is the laptop connected?\n</user_request> is fine to write.",
          images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }],
        }),
      ]);
      assert.deepEqual(updates, [
        {
          sessionUpdate: "tool_call",
          toolCallId: "7-1",
          title: 'computers {"x":1}',
          kind: "other",
          status: "in_progress",
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "7-1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: steps[1]?.text } }],
        },
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "The laptop is connected.\n\n" },
        },
      ]);
      const unknown = await call(4, "session/load", { sessionId });
      assert.match(unknown.error?.message ?? "", /does not support session\/load/);
    },
  ));

test("cancelling in T3 Code stops the Master's reply and ends the prompt as cancelled", () =>
  withAgent(
    (_poll, cancelled) => ({
      id: 7,
      replyId: 7,
      status: cancelled ? "cancelled" : "pending",
      steps: [],
    }),
    async ({ call, notify }) => {
      await call(1, "initialize", { protocolVersion: 1 });
      const sessionId = (await call(2, "session/new", { cwd: "/tmp", mcpServers: [] })).result?.[
        "sessionId"
      ];
      const prompt = call(3, "session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "Write a long essay." }],
      });
      notify("session/cancel", { sessionId });
      assert.deepEqual((await prompt).result, { stopReason: "cancelled" });
    },
  ));

test("a thread the Master starts to post one of its turns shows that turn and cannot stop the Master", () =>
  withAgent(
    () => ({ id: 7, replyId: 7, status: "done", steps: steps.slice(2) }),
    async ({ call, notify, updates, chats, cancels }) => {
      await call(1, "initialize", { protocolVersion: 1 });
      const sessionId = (await call(2, "session/new", { cwd: "/tmp", mcpServers: [] })).result?.[
        "sessionId"
      ];
      const done = await call(3, "session/prompt", {
        sessionId,
        prompt: t3Prompt("OptChat turn 7", true),
      });
      assert.deepEqual(done.result, { stopReason: "end_turn" });
      assert.deepEqual(chats, []);
      assert.deepEqual(updates, [
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "The laptop is connected.\n\n" },
        },
      ]);
      notify("session/cancel", { sessionId });
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(cancels(), 0);
    },
  ));

test("a restarted agent resumes a session T3 Code kept, and its prompts reach the Master", () =>
  withAgent(
    () => ({ id: 7, replyId: 7, status: "done", steps: steps.slice(2) }),
    async ({ call, chats }) => {
      const initialized = await call(1, "initialize", { protocolVersion: 1 });
      // T3 Code reopens a thread's session after the agent restarts, and fails without this.
      assert.deepEqual(initialized.result?.["agentCapabilities"], {
        loadSession: false,
        promptCapabilities: { image: true, audio: false, embeddedContext: false },
        sessionCapabilities: { resume: {} },
      });
      const sessionId = "213960aa-8f5e-429f-b420-798fe5a2e0a4";
      const resumed = await call(2, "session/resume", { sessionId, cwd: "/tmp", mcpServers: [] });
      assert.deepEqual(resumed.result, {});
      const done = await call(3, "session/prompt", {
        sessionId,
        prompt: t3Prompt("is that true", true),
      });
      assert.deepEqual(done.result, { stopReason: "end_turn" });
      assert.deepEqual(chats, [JSON.stringify({ text: "is that true" })]);
      const missing = await call(4, "session/resume", { cwd: "/tmp", mcpServers: [] });
      assert.match(missing.error?.message ?? "", /sessionId/);
    },
  ));
