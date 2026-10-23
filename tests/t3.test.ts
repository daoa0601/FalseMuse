import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { openDatabase } from "../node/sqlite.ts";
import { Computers } from "../src/t3.ts";

test("a watched thread reports waiting once, then its last reply, and a revoked sign-in once", async () => {
  let status = "waiting";
  let authorized = true;
  let launches = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      const message = JSON.parse(body) as {
        id?: string;
        method: string;
        params?: { name: string; arguments?: { limit?: number; afterPosition?: number } };
      };
      if (!authorized) {
        response.writeHead(401).end();
        return;
      }
      const reply = (result: unknown, headers: Record<string, string> = {}) =>
        response
          .writeHead(200, { "content-type": "application/json", ...headers })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      if (message.method === "initialize") {
        reply({}, { "mcp-session-id": "s1" });
        return;
      }
      if (message.method.startsWith("notifications/")) {
        response.writeHead(202).end();
        return;
      }
      const args = message.params?.arguments;
      if (message.params?.name === "t3_thread_launch") launches++;
      // The last reply sits on the second page of messages.
      const page =
        args?.afterPosition === 1
          ? {
              items: [
                {
                  position: 2,
                  type: "assistant_message",
                  text: "Done: 41 tests pass. token=abc123secret",
                },
              ],
              nextPosition: 2,
              hasMore: false,
            }
          : {
              items: [{ position: 1, type: "assistant_message", text: "Starting." }],
              nextPosition: 1,
              hasMore: args?.limit === 100,
            };
      const structured =
        message.params?.name === "t3_thread_launch"
          ? { threadId: "th1", projectId: "p1", runId: "r1", status: "starting" }
          : message.params?.name === "t3_project_list"
            ? { projects: [{ id: "p1", title: "optchat", workspaceRoot: "/w" }], nextCursor: null }
            : {
                thread: {
                  title: "Fix tests",
                  status,
                  itemCount: 2,
                  pendingRequestCount: status === "waiting" ? 1 : 0,
                },
                ...page,
              };
      reply({ structuredContent: structured, content: [] });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const database = openDatabase(":memory:");
  try {
    const computers = new Computers(database);
    // As a finished sign-in leaves it.
    database.exec("INSERT INTO t3_computers VALUES ('laptop', ?, 'token', NULL, NULL)", url);
    await computers.launch("laptop", "OptChat", "Fix tests", "Make the tests pass", "call-1");
    const reports: string[] = [];
    const poll = () => computers.poll((text) => reports.push(text));
    await poll();
    await poll();
    assert.deepEqual(reports, [
      "[laptop: Fix tests] waiting for the owner in T3 Code (1 request(s) to answer)",
    ]);
    status = "running";
    await poll();
    status = "completed";
    await poll();
    assert.equal(
      reports[1],
      "[laptop: Fix tests] completed: Done: 41 tests pass. token=[REDACTED]",
    );
    assert.equal(computers.watching(), false);

    // A resumed turn repeats its launch call: it gets the first thread, not a second one.
    const again = await computers.launch(
      "laptop",
      "OptChat",
      "Fix tests",
      "Make the tests pass",
      "call-1",
    );
    assert.deepEqual(
      [launches, again],
      [1, { threadId: "th1", projectId: "p1", runId: "r1", status: "starting" }],
    );

    await computers.launch("laptop", "optchat", "Fix tests", "Again", "call-2");
    authorized = false;
    await poll();
    await poll();
    assert.deepEqual(reports.slice(2), [
      "[laptop] needs the owner to sign in again; its threads are not followed",
    ]);
    assert.deepEqual(
      computers.list().map((computer) => computer.connected),
      [false],
    );
  } finally {
    database.close();
    server.close();
  }
});

test("at most six threads run for the Master at once, and a thread silent for 12 hours stops counting", async () => {
  let status = "running";
  let launches = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      const message = JSON.parse(body) as {
        id?: string;
        method: string;
        params?: { name: string };
      };
      const reply = (result: unknown, headers: Record<string, string> = {}) =>
        response
          .writeHead(200, { "content-type": "application/json", ...headers })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      if (message.method === "initialize") {
        reply({}, { "mcp-session-id": "s1" });
        return;
      }
      if (message.method.startsWith("notifications/")) {
        response.writeHead(202).end();
        return;
      }
      const name = message.params?.name;
      const structured =
        name === "t3_thread_launch"
          ? { threadId: `th${++launches}`, projectId: "p1", runId: "r1", status: "starting" }
          : name === "t3_project_list"
            ? { projects: [{ id: "p1", title: "optchat", workspaceRoot: "/w" }], nextCursor: null }
            : {
                thread: { title: "Part", status, pendingRequestCount: 0 },
                items: [{ position: 1, type: "assistant_message", text: "Done." }],
                nextPosition: 1,
                hasMore: false,
              };
      reply({ structuredContent: structured, content: [] });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const database = openDatabase(":memory:");
  try {
    const computers = new Computers(database);
    database.exec("INSERT INTO t3_computers VALUES ('laptop', ?, 'token', NULL, NULL)", url);
    const start = Date.now();
    const launch = (part: number, now = start) =>
      computers.launch(
        "laptop",
        "optchat",
        `Audit: part ${part}`,
        "Look.",
        `call-${part}`,
        undefined,
        now,
      );
    for (let part = 1; part <= 6; part++) await launch(part);
    await assert.rejects(
      launch(7),
      /6 threads are running for you \(Audit: part 1, .*Audit: part 6\); wait for a report before starting another/,
    );
    assert.equal(launches, 6);
    // The Master sees which of its threads are still running.
    const [laptop] = await computers.overview();
    assert.deepEqual(
      laptop?.running.map(({ title, waiting }) => [title, waiting]),
      [1, 2, 3, 4, 5, 6].map((part) => [`Audit: part ${part}`, false]),
    );
    // A refused launch can be tried again under the same call id once a place is free.
    await launch(7, start + 12 * 3_600_000 + 1);
    assert.equal(launches, 7);

    // Finished threads free their places at once.
    status = "completed";
    await computers.poll(() => {});
    await launch(8);
    assert.equal(launches, 8);
  } finally {
    database.close();
    server.close();
  }
});

test("turns nobody prompted for go to one unwatched OptChat inbox, later if no computer takes them", async () => {
  let accepting = false;
  let inboxGone = false;
  let launches = 0;
  const calls: { name: string; arguments: unknown }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      const message = JSON.parse(body) as {
        id?: string;
        method: string;
        params?: { name: string; arguments?: unknown };
      };
      const reply = (result: unknown, headers: Record<string, string> = {}) =>
        response
          .writeHead(200, { "content-type": "application/json", ...headers })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      const failure = (text: string) => reply({ isError: true, content: [{ type: "text", text }] });
      const name = message.params?.name ?? "";
      if (message.method === "initialize") reply({}, { "mcp-session-id": "s1" });
      else if (message.method.startsWith("notifications/")) response.writeHead(202).end();
      else if (!accepting) failure("No provider instance optchat");
      else if (inboxGone && name !== "t3_thread_launch") failure("Thread not found");
      else {
        calls.push({ name, arguments: message.params?.arguments });
        const threadId = name === "t3_thread_launch" ? `inbox-${++launches}` : "any";
        reply({ structuredContent: { threadId }, content: [] });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const database = openDatabase(":memory:");
  try {
    const computers = new Computers(database);
    database.exec("INSERT INTO t3_computers VALUES ('laptop', ?, 'token', NULL, NULL)", url);
    computers.queuePost(7, "Fix tests is done.", 1_000);
    computers.queuePost(7, "A second queueing of the same turn", 1_000);
    assert.equal(computers.nextPost(), 1_000);
    assert.deepEqual(await computers.post(1_000), [
      "Turn 7 was not posted to T3 Code: laptop: t3_thread_launch failed: No provider instance optchat",
    ]);
    assert.equal(computers.nextPost(), 61_000);
    assert.deepEqual(await computers.post(60_999), []);
    accepting = true;
    assert.deepEqual(await computers.post(61_000), []);
    computers.queuePost(8, "The deploy finished.", 70_000);
    assert.deepEqual(await computers.post(70_000), []);
    assert.deepEqual(calls, [
      {
        name: "t3_thread_launch",
        arguments: {
          scratch: true,
          title: "OptChat: Fix tests is done.",
          modelSelection: { instanceId: "optchat", model: "default" },
          message: "OptChat turn 7",
        },
      },
      {
        name: "t3_thread_update",
        arguments: {
          threadId: "inbox-1",
          action: "rename",
          title: "OptChat: The deploy finished.",
          clientRequestId: "post-8-title",
        },
      },
      {
        name: "t3_thread_send",
        arguments: {
          threadId: "inbox-1",
          message: "OptChat turn 8",
          mode: "queue",
          clientRequestId: "post-8",
        },
      },
    ]);

    // An inbox the owner deleted is replaced by a new one.
    inboxGone = true;
    computers.queuePost(9, "Tests pass again.", 80_000);
    assert.deepEqual(await computers.post(80_000), []);
    assert.deepEqual(
      computers.posts().map((post) => [post.turn, post.thread]),
      [
        [9, "inbox-2"],
        [8, "inbox-1"],
        [7, "inbox-1"],
      ],
    );
    assert.equal(computers.nextPost(), null);
    assert.equal(computers.watching(), false);
  } finally {
    database.close();
    server.close();
  }
});
