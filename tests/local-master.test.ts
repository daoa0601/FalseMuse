import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { AddressInfo } from "node:net";
import { AlarmClock } from "../node/local-master.ts";
import { OWNER, REPLY, read, withMaster } from "./test-master.ts";

test("the local Master answers the owner with its own model login and keeps the turn across a restart", () =>
  withMaster(async (master) => {
    assert.equal((await master.fetch("/api/status")).status, 401);
    assert.equal((await master.fetch("/")).status, 200);
    // A Host header that is no URL is ignored; the Master answers for its own origin.
    const odd = httpRequest(master.url + "/api/status", { headers: { host: "[not a host" } });
    odd.end();
    const [answer] = (await once(odd, "response")) as [{ statusCode: number; resume(): void }];
    answer.resume();
    assert.equal(answer.statusCode, 401);
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
    assert.equal((await master.json<{ pending: number }>("/api/status")).pending, 0);
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

test("the local alarm waits past a timer's longest delay instead of firing early", async () => {
  let runs = 0;
  const clock = new AlarmClock(async () => {
    runs++;
  }, 40);
  clock.set(Date.now() + 120);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(runs, 0);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(runs, 1);
  assert.equal(clock.get(), null);

  const later = new AlarmClock(async () => {
    runs++;
  });
  later.set(Date.now() + 30 * 24 * 3_600_000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(runs, 1);
  await later.stop();
  await clock.stop();
});

/** The Worker's inbox socket as the local Master sees it, answering pings while `answering`. */
async function fakeInbox() {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const frames: string[] = [];
  const sockets: ServerSocket[] = [];
  const state = { answering: true, headers: [] as (string | undefined)[] };
  server.on("connection", (socket, request) => {
    sockets.push(socket);
    state.headers.push(request.headers.authorization);
    socket.on("message", (data) => {
      const frame = String(data);
      if (frame === "ping") {
        if (state.answering) socket.send("pong");
      } else frames.push(frame);
    });
  });
  const until = async (done: () => boolean, what: string) => {
    const deadline = Date.now() + 5_000;
    while (!done()) {
      assert.ok(Date.now() < deadline, what);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    frames,
    sockets,
    state,
    until,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("an inbox message becomes one owner turn however often it arrives, and its reply is posted", async () => {
  const inbox = await fakeInbox();
  try {
    await withMaster(
      async (master) => {
        await inbox.until(() => inbox.sockets.length === 1, "The Master did not connect");
        assert.equal(inbox.state.headers[0], `Bearer ${OWNER}`);
        const message = {
          type: "message",
          id: "0d9a6c1e-2b7f-4c1a-9e0b-6f2d3a4b5c6d",
          text: "Book the dentist.",
          sent: "2026-10-24T01:00:00.000Z",
        };
        inbox.sockets[0]?.send(JSON.stringify(message));
        inbox.sockets[0]?.send(JSON.stringify(message));
        inbox.sockets[0]?.send("not json");
        await inbox.until(() => inbox.frames.length === 2, "The Master did not acknowledge");
        const acks = inbox.frames.map((frame) => JSON.parse(frame) as { turn: number });
        assert.deepEqual(acks[0], { type: "delivered", id: message.id, turn: acks[0]?.turn });
        assert.equal(acks[1]?.turn, acks[0]?.turn);
        const turn = await master.finished(acks[0]?.turn ?? 0);
        assert.equal(turn.text, REPLY);
        assert.match(
          JSON.stringify(master.calls[0]?.input),
          /\[Left in the inbox at 2026-10-24T01:00:00.000Z\]\\nBook the dentist\./,
        );
        const posts = await master.json<{ turn: number; title: string }[]>("/api/posts");
        assert.deepEqual(
          posts.map(({ turn: id, title }) => [id, title]),
          [[acks[0]?.turn, REPLY]],
        );
      },
      { inbox: { url: inbox.url, headers: { authorization: `Bearer ${OWNER}` } } },
    );
  } finally {
    await inbox.close();
  }
});

test("the inbox link replaces a connection that stops answering, as after the laptop sleeps", async () => {
  const inbox = await fakeInbox();
  try {
    await withMaster(
      async () => {
        await inbox.until(() => inbox.sockets.length === 1, "The Master did not connect");
        inbox.state.answering = false;
        await inbox.until(() => inbox.sockets.length === 2, "The Master did not reconnect");
      },
      { inbox: { url: inbox.url, headers: {}, pingMs: 100, retryMs: [50, 50], log: () => {} } },
    );
  } finally {
    await inbox.close();
  }
});
