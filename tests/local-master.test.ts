import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startMaster, type LocalMaster } from "../node/local-master.ts";
import { runCode } from "../node/code-runner.ts";
import type { ModelResult, RelayedRequest } from "../src/codex.ts";
import { modelReply } from "./support.ts";

const OWNER = "test-owner";
const REPLY = "Answered on the laptop.";

/** Test responses are JSON from the Master itself; assertions check the fields they read. */
async function read<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/**
 * A local Master in a temporary directory with the local Code Mode runner. Model calls get
 * `answer`'s result, REPLY when it has none.
 */
class TestMaster {
  readonly directory = mkdtempSync(join(tmpdir(), "optchat-master-"));
  readonly calls: RelayedRequest[] = [];
  answer: (request: RelayedRequest) => ModelResult | undefined = () => undefined;
  master: LocalMaster | undefined;

  async start(): Promise<void> {
    this.master = await startMaster({
      directory: this.directory,
      ownerKey: OWNER,
      port: 0,
      config: {
        masterModel: "gpt-6.1-sol",
        compactorModel: "gpt-6-luna",
        compactorEffort: "high",
        timezone: "Europe/Helsinki",
      },
      callModel: async (request) => {
        this.calls.push(request);
        return this.answer(request) ?? modelReply(REPLY);
      },
      runCode,
    });
  }

  get url(): string {
    if (!this.master) throw new Error("The test Master is not running");
    return this.master.url;
  }

  fetch(path: string, init?: RequestInit): Promise<Response> {
    return fetch(this.url + path, init);
  }

  request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    return this.fetch(path, {
      method,
      headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async json<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.request(path, body);
    assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
    return read<T>(response);
  }

  /** Poll a turn until it leaves pending. */
  async finished(id: number): Promise<{ status: string; text: string; steps: unknown[] }> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const turn = await this.json<{ status: string; text: string; steps: unknown[] }>(
        `/api/turns/${id}`,
      );
      if (turn.status !== "pending") return turn;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Turn ${id} did not finish within five seconds`);
  }

  async stop(): Promise<void> {
    await this.master?.close();
    this.master = undefined;
  }
}

async function withMaster(run: (master: TestMaster) => Promise<void>): Promise<void> {
  const master = new TestMaster();
  await master.start();
  try {
    await run(master);
  } finally {
    await master.stop();
    rmSync(master.directory, { recursive: true, force: true });
  }
}

test("the local Master answers the owner with its own model login and keeps the turn across a restart", () =>
  withMaster(async (master) => {
    assert.equal((await master.fetch("/api/status")).status, 401);
    assert.equal((await master.fetch("/")).status, 200);
    const chat = await master.request("/api/chat", { text: "Hello from the test" });
    assert.equal(chat.status, 202);
    const { id } = await read<{ id: number }>(chat);
    assert.deepEqual(await master.finished(id), {
      id,
      replyId: id,
      status: "done",
      text: REPLY,
      steps: [{ index: 1, kind: "talk", text: REPLY }],
    });
    const turn = master.calls.find((call) =>
      JSON.stringify(call.input).includes("Hello from the test"),
    );
    assert.equal(turn?.model, "gpt-6.1-sol");

    await master.stop();
    await master.start();
    const messages = await master.json<{ kind: string; text: string }[]>("/api/messages");
    assert.deepEqual(
      messages.slice(-2).map((message) => [message.kind, message.text]),
      [
        ["user", "Hello from the test"],
        ["talk", REPLY],
      ],
    );
    assert.equal(
      (await master.json<{ authenticated: boolean }>("/api/status")).authenticated,
      true,
    );
  }));

test("a node connects over the local WebSocket, and a transcript uploaded in parts reads back", () =>
  withMaster(async (master) => {
    const { key } = await master.json<{ key: string }>("/api/nodes", {
      name: "laptop",
      roots: ["/tmp"],
    });
    const endpoint = master.url.replace(/^http/, "ws") + "/node/ws";
    const refused = new WebSocket(endpoint, ["optchat", "not-a-key"]);
    await new Promise((resolve) => refused.addEventListener("close", resolve));

    const socket = new WebSocket(endpoint, ["optchat", key]);
    const first = await new Promise<string>((resolve) =>
      socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true }),
    );
    assert.deepEqual(JSON.parse(first), { type: "registered", name: "laptop" });
    const online = (await master.json<{ name: string; online: boolean }[]>("/api/nodes")).find(
      (machine) => machine.name === "laptop",
    );
    assert.equal(online?.online, true);
    socket.close();

    const lines = [
      '{"line":1,"event":{"text":"first"}}\n',
      '{"line":2,"event":{"text":"second"}}\n',
    ];
    const upload = (action: string, extra = "") =>
      `/api/transcript-upload?session=local-1&action=${action}${extra}`;
    assert.deepEqual(await master.json(upload("start"), { parts: 2 }), {
      complete: false,
      parts: 2,
      accepted: [],
    });
    for (const [index, line] of lines.entries()) {
      const part = await master.fetch(upload("part", `&number=${index + 1}`), {
        method: "PUT",
        headers: { authorization: `Bearer ${OWNER}`, "content-length": String(line.length) },
        body: line,
      });
      assert.equal(part.status, 200, await part.text());
    }
    assert.deepEqual(await master.json(upload("finish"), {}), {
      complete: true,
      size: lines.join("").length,
    });
    const { text } = await master.json<{ text: string }>(
      "/api/transcript?session=local-1&start=1&count=2",
    );
    assert.equal(text, lines.join("").trim());
  }));

test("a scheduled prompt fires through the local timer and the Master answers it", () =>
  withMaster(async (master) => {
    const scheduled = await master.json<{ id: number }>("/api/schedules", {
      prompt: "Review the open questions in memory.",
      at: new Date(Date.now() + 300).toISOString(),
      every_minutes: 0,
    });
    const deadline = Date.now() + 5_000;
    let messages: { kind: string; text: string }[] = [];
    while (Date.now() < deadline) {
      messages = await master.json("/api/messages");
      if (messages.some((message) => message.kind === "talk")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(
      messages.map((message) => message.kind),
      ["note", "talk"],
    );
    assert.match(messages[0]?.text ?? "", new RegExp(`^\\[Scheduled ${scheduled.id},`));
    assert.equal(messages[1]?.text, REPLY);
  }));

test("a chat turn runs Code Mode in the local runner and replies", () =>
  withMaster(async (master) => {
    const code = "async () => (await codemode.machines({})).map((machine) => machine.name)";
    master.answer = (request) =>
      JSON.stringify(request.input).includes("function_call_output")
        ? undefined
        : {
            text: "",
            output: [
              {
                type: "function_call",
                name: "codemode",
                arguments: JSON.stringify({ code }),
                call_id: "call-1",
              },
            ],
            usage: null,
            quota: {},
          };
    await master.json("/api/nodes", { name: "laptop", roots: ["/tmp"] });
    const { id } = await master.json<{ id: number }>("/api/chat", { text: "Which machines?" });
    const turn = await master.finished(id);
    assert.equal(turn.text, REPLY);
    assert.deepEqual(
      turn.steps.map((step) => (step as { kind: string }).kind),
      ["tool", "echo", "talk"],
    );
    assert.deepEqual(JSON.parse((turn.steps[1] as { text: string }).text), {
      result: ["laptop"],
    });
  }));
