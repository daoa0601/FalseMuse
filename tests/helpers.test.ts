import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { openDatabase } from "../node/sqlite.ts";
import { Computers } from "../src/t3.ts";
import { Helpers } from "../src/helpers.ts";

/** A computer's T3 Code with one project; threads in `gone` refuse every call. */
async function withT3(
  run: (context: {
    helpers: Helpers;
    computers: Computers;
    calls: { name: string; arguments: Record<string, unknown> }[];
    gone: Set<string>;
  }) => Promise<void>,
): Promise<void> {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const gone = new Set<string>();
  let launches = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      const message = JSON.parse(body) as {
        id?: string;
        method: string;
        params?: { name: string; arguments: Record<string, unknown> };
      };
      const reply = (result: unknown, headers: Record<string, string> = {}) =>
        response
          .writeHead(200, { "content-type": "application/json", ...headers })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      const name = message.params?.name ?? "";
      const args = message.params?.arguments ?? {};
      if (message.method === "initialize") reply({}, { "mcp-session-id": "s1" });
      else if (message.method.startsWith("notifications/")) response.writeHead(202).end();
      else if (typeof args["threadId"] === "string" && gone.has(args["threadId"])) {
        reply({ isError: true, content: [{ type: "text", text: "Thread not found." }] });
      } else {
        if (name !== "t3_project_list") calls.push({ name, arguments: args });
        const structured =
          name === "t3_project_list"
            ? { projects: [{ id: "p1", title: "optchat", workspaceRoot: "/w" }], nextCursor: null }
            : name === "t3_thread_launch"
              ? { threadId: `th${++launches}`, projectId: "p1", runId: "r1", status: "starting" }
              : name === "t3_thread_read"
                ? { thread: { title: "Helper: reviewer", status: "running" }, items: [] }
                : { accepted: true };
        reply({ structuredContent: structured, content: [] });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const database = openDatabase(":memory:");
  try {
    const computers = new Computers(database);
    // As a finished sign-in leaves it.
    database.exec("INSERT INTO t3_computers VALUES ('laptop', ?, 'token', NULL, NULL)", url);
    await run({ helpers: new Helpers(database, computers), computers, calls, gone });
  } finally {
    database.close();
    server.close();
  }
}

const brief = (instructions: string, task: string) =>
  `You are reviewer, a helper the owner's chief of staff (OptChat) gives jobs to. Your standing instructions:\n<instructions>\n${instructions}\n</instructions>\n\n${task}`;

test("a hired helper keeps one thread: the first job briefs it and later jobs queue in it", () =>
  withT3(async ({ helpers, computers, calls, gone }) => {
    const hired = helpers.hire({
      name: "reviewer",
      instructions: "Review diffs for bugs. Be terse.",
      computer: "laptop",
      project: "optchat",
      provider: "codex",
      model: "gpt-6.1-sol",
    });
    assert.deepEqual(hired, {
      name: "reviewer",
      instructions: "Review diffs for bugs. Be terse.",
      computer: "laptop",
      project: "optchat",
      provider: "codex",
      model: "gpt-6.1-sol",
      auto: false,
      thread: null,
    });

    assert.deepEqual(await helpers.delegate("reviewer", "Review the last commit.", "call-1"), {
      helper: "reviewer",
      thread: "th1",
      started: true,
    });
    assert.deepEqual(calls.shift(), {
      name: "t3_thread_launch",
      arguments: {
        projectId: "p1",
        title: "Helper: reviewer",
        message: brief("Review diffs for bugs. Be terse.", "Review the last commit."),
        modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
      },
    });
    assert.equal(computers.watching(), true);

    // A resumed turn repeats its call: T3 Code drops the repeat by its request id.
    for (const request of ["call-2", "call-2"]) {
      assert.deepEqual(await helpers.delegate("reviewer", "Review the next one.", request), {
        helper: "reviewer",
        thread: "th1",
        started: false,
      });
    }
    assert.deepEqual(calls.splice(0), [
      {
        name: "t3_thread_send",
        arguments: {
          threadId: "th1",
          message: "Review the next one.",
          mode: "queue",
          clientRequestId: "call-2",
        },
      },
      {
        name: "t3_thread_send",
        arguments: {
          threadId: "th1",
          message: "Review the next one.",
          mode: "queue",
          clientRequestId: "call-2",
        },
      },
    ]);

    // New instructions go with the next job, in the same thread.
    helpers.hire({ name: "reviewer", instructions: "Also check the tests." });
    await helpers.delegate("reviewer", "Review the fix.", "call-3");
    assert.equal(
      calls.shift()?.arguments["message"],
      brief("Also check the tests.", "Review the fix."),
    );
    await helpers.delegate("reviewer", "And this one.", "call-4");
    assert.equal(calls.shift()?.arguments["message"], "And this one.");

    // A thread the owner deleted is replaced by a new, briefed one.
    gone.add("th1");
    assert.deepEqual(await helpers.delegate("reviewer", "Review again.", "call-5"), {
      helper: "reviewer",
      thread: "th2",
      started: true,
    });
    assert.deepEqual(
      calls.at(-1)?.arguments["message"],
      brief("Also check the tests.", "Review again."),
    );

    // Moving a helper to another project starts a new thread there.
    helpers.hire({ name: "reviewer", project: "p1" });
    assert.equal(helpers.list()[0]?.thread, null);

    assert.deepEqual(helpers.retire("reviewer"), { retired: "reviewer" });
    assert.deepEqual(helpers.list(), []);
  }));

test("hiring checks the name, the computer, the instructions and the model", () =>
  withT3(async ({ helpers, calls }) => {
    const valid = {
      name: "researcher",
      instructions: "Find sources.",
      computer: "laptop",
      project: "optchat",
    };
    assert.throws(() => helpers.hire({ ...valid, name: "Bad Name" }), /Name a helper/);
    assert.throws(
      () => helpers.hire({ ...valid, computer: "desktop" }),
      /No computer named desktop/,
    );
    assert.throws(() => helpers.hire({ ...valid, instructions: " " }), /needs instructions/);
    assert.throws(
      () => helpers.hire({ ...valid, instructions: "x".repeat(4001) }),
      /4,000 characters/,
    );
    assert.throws(
      () => helpers.hire({ ...valid, provider: "codex" }),
      /both a provider and a model/,
    );
    assert.throws(() => helpers.hire({ name: "researcher" }), /needs instructions/);
    assert.equal(helpers.hire({ ...valid, auto: true }).auto, true);
    // Without a model the thread uses the project's default in T3 Code.
    await helpers.delegate("researcher", "Find the ACP resume spec.", "call-1");
    assert.equal("modelSelection" in (calls[0]?.arguments ?? {}), false);
    await assert.rejects(
      helpers.delegate("nobody", "Anything.", "call-2"),
      /No helper named nobody/,
    );
    assert.throws(() => helpers.retire("nobody"), /No helper named nobody/);
  }));
