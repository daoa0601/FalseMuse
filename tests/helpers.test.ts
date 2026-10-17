import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { openDatabase } from "../node/sqlite.ts";
import { Computers } from "../src/t3.ts";
import { Helpers } from "../src/helpers.ts";

/**
 * A computer's T3 Code with two projects and three providers; threads in `gone` refuse every call,
 * and every thread reports `status`, with "Found 2 bugs." as its last reply.
 */
async function withT3(
  run: (context: {
    helpers: Helpers;
    computers: Computers;
    calls: { name: string; arguments: Record<string, unknown> }[];
    gone: Set<string>;
    finish: () => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const gone = new Set<string>();
  let status = "running";
  let launches = 0;
  const providers = [
    {
      providerInstanceId: "codex",
      displayName: "Codex",
      models: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }],
    },
    {
      providerInstanceId: "claudeAgent",
      displayName: "Claude",
      models: [{ id: "claude-opus-5-5" }],
    },
    { providerInstanceId: "optchat", displayName: "OptChat", models: [{ id: "default" }] },
  ];
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
        const reads = ["t3_project_list", "orchestrator_capabilities", "t3_thread_read"];
        if (!reads.includes(name)) calls.push({ name, arguments: args });
        const structured =
          name === "t3_project_list"
            ? {
                projects: [
                  { id: "p1", title: "optchat", workspaceRoot: "/w" },
                  { id: "p2", title: "website", workspaceRoot: "/v" },
                ],
                nextCursor: null,
              }
            : name === "orchestrator_capabilities"
              ? { providers }
              : name === "t3_thread_launch"
                ? { threadId: `th${++launches}`, projectId: "p1", runId: "r1", status: "starting" }
                : name === "t3_thread_read"
                  ? {
                      thread: { title: "Helper: reviewer", status },
                      items: [{ position: 1, type: "assistant_message", text: "Found 2 bugs." }],
                      nextPosition: 1,
                      hasMore: false,
                    }
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
    const helpers = new Helpers(database, computers);
    // The watched threads finish, and the worker hands each finished one's report to the helpers.
    const finish = async () => {
      status = "completed";
      await computers.poll((text, finished) => {
        if (finished) helpers.record(finished, text);
      });
      status = "running";
    };
    await run({ helpers, computers, calls, gone, finish });
  } finally {
    database.close();
    server.close();
  }
}

const brief = (instructions: string, task: string, history?: string) =>
  `You are reviewer, a helper the owner's chief of staff (OptChat) gives jobs to. Your standing instructions:\n<instructions>\n${instructions}\n</instructions>\n\n${
    history === undefined
      ? ""
      : `This is a new thread. Your recent jobs and their results, oldest first:\n<history>\n${history}\n</history>\n\n`
  }${task}`;

test("a hired helper keeps one thread: the first job briefs it and later jobs queue in it", () =>
  withT3(async ({ helpers, computers, calls, gone, finish }) => {
    const hired = await helpers.hire({
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
      // Kept by its id, so another spelling of the same project keeps the thread.
      project: "p1",
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
    await finish();
    assert.equal(computers.watching(), false);

    // A resumed turn repeats its call: T3 Code drops the repeat by its request id.
    for (const request of ["call-2", "call-2"]) {
      assert.deepEqual(await helpers.delegate("reviewer", "Review the next one.", request), {
        helper: "reviewer",
        thread: "th1",
        started: false,
      });
    }
    const queued = {
      name: "t3_thread_send",
      arguments: {
        threadId: "th1",
        message: "Review the next one.",
        mode: "queue",
        clientRequestId: "call-2",
      },
    };
    assert.deepEqual(calls.splice(0), [queued, queued]);

    // New instructions go with the next job, in the same thread.
    await helpers.hire({ name: "reviewer", instructions: "Also check the tests." });
    await helpers.delegate("reviewer", "Review the fix.", "call-3");
    assert.equal(
      calls.shift()?.arguments["message"],
      brief("Also check the tests.", "Review the fix."),
    );
    await helpers.delegate("reviewer", "And this one.", "call-4");
    assert.equal(calls.shift()?.arguments["message"], "And this one.");

    // Another model switches the same thread.
    await helpers.hire({ name: "reviewer", provider: "claudeAgent", model: "claude-opus-5-5" });
    assert.deepEqual(calls.shift(), {
      name: "t3_thread_configure",
      arguments: {
        threadId: "th1",
        modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      },
    });
    assert.equal(helpers.list()[0]?.thread, "th1");

    // A thread the owner deleted is replaced by a new one that gets the helper's recent history.
    gone.add("th1");
    assert.deepEqual(await helpers.delegate("reviewer", "Review again.", "call-5"), {
      helper: "reviewer",
      thread: "th2",
      started: true,
    });
    const history = [
      "Job: Review the last commit.",
      "Result: [laptop: Helper: reviewer] completed: Found 2 bugs.",
      "Job: Review the next one.",
      "Job: Review the fix.",
      "Job: And this one.",
    ].join("\n");
    assert.deepEqual(calls.shift()?.arguments, {
      projectId: "p1",
      title: "Helper: reviewer",
      message: brief("Also check the tests.", "Review again.", history),
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    });

    // A fresh start on request does the same.
    await helpers.hire({ name: "reviewer", fresh: true });
    assert.equal(helpers.list()[0]?.thread, null);
    await helpers.delegate("reviewer", "Start over.", "call-6");
    assert.match(
      String(calls.shift()?.arguments["message"]),
      /Job: Review again\.\n<\/history>\n\nStart over\.$/,
    );

    // Naming its project another way keeps the thread; another project starts a new one there.
    await helpers.hire({ name: "reviewer", project: "OptChat" });
    assert.equal(helpers.list()[0]?.thread, "th3");
    await assert.rejects(
      helpers.hire({ name: "reviewer", project: "nowhere" }),
      /No project nowhere on laptop; it has optchat, website/,
    );
    await helpers.hire({ name: "reviewer", project: "website" });
    assert.deepEqual(
      helpers.list().map(({ project, thread }) => [project, thread]),
      [["p2", null]],
    );

    assert.deepEqual(helpers.retire("reviewer"), { retired: "reviewer" });
    assert.deepEqual(helpers.list(), []);
  }));

test("hiring checks the name, the computer, the instructions and the model", () =>
  withT3(async ({ helpers, computers, calls }) => {
    const valid = {
      name: "researcher",
      instructions: "Find sources.",
      computer: "laptop",
      project: "optchat",
    };
    await assert.rejects(helpers.hire({ ...valid, name: "Bad Name" }), /Name a helper/);
    await assert.rejects(
      helpers.hire({ ...valid, computer: "desktop" }),
      /No computer named desktop/,
    );
    await assert.rejects(helpers.hire({ ...valid, instructions: " " }), /needs instructions/);
    await assert.rejects(
      helpers.hire({ ...valid, instructions: "x".repeat(4001) }),
      /4,000 characters/,
    );
    await assert.rejects(
      helpers.hire({ ...valid, provider: "codex" }),
      /both a provider and a model/,
    );
    await assert.rejects(
      helpers.hire({ ...valid, provider: "cursor", model: "auto" }),
      /laptop has no provider cursor; it has codex, claudeAgent/,
    );
    await assert.rejects(
      helpers.hire({ ...valid, provider: "codex", model: "gpt-5" }),
      /codex on laptop has no model gpt-5; it has gpt-6.1-sol, gpt-6-astra/,
    );
    // A helper is never OptChat itself, whose turns are the Master's own.
    await assert.rejects(
      helpers.hire({ ...valid, provider: "optchat", model: "default" }),
      /laptop has no provider optchat/,
    );
    await assert.rejects(helpers.hire({ name: "researcher" }), /needs instructions/);
    assert.equal((await helpers.hire({ ...valid, auto: true })).auto, true);
    // Without a model the thread uses the project's default in T3 Code.
    await helpers.delegate("researcher", "Find the ACP resume spec.", "call-1");
    assert.equal("modelSelection" in (calls[0]?.arguments ?? {}), false);
    await assert.rejects(
      helpers.delegate("nobody", "Anything.", "call-2"),
      /No helper named nobody/,
    );
    assert.throws(() => helpers.retire("nobody"), /No helper named nobody/);
    // The Master sees each computer's providers and models when it lists the computers.
    const [laptop] = await computers.overview();
    assert.deepEqual(laptop && "providers" in laptop ? laptop.providers : null, [
      { provider: "codex", label: "Codex", models: ["gpt-6.1-sol", "gpt-6-astra"] },
      { provider: "claudeAgent", label: "Claude", models: ["claude-opus-5-5"] },
    ]);
  }));

test("a resumed turn's repeated job does not reach the thread it started a second time", () =>
  withT3(async ({ helpers, calls }) => {
    await helpers.hire({
      name: "reviewer",
      instructions: "Review diffs.",
      computer: "laptop",
      project: "optchat",
    });
    const first = await helpers.delegate("reviewer", "Review the last commit.", "call-1");
    assert.deepEqual(
      await helpers.delegate("reviewer", "Review the last commit.", "call-1"),
      first,
    );
    assert.deepEqual(
      calls.map(({ name }) => name),
      ["t3_thread_launch"],
    );
  }));

test("an empty provider and model put a helper back on the project's default", () =>
  withT3(async ({ helpers }) => {
    await helpers.hire({
      name: "reviewer",
      instructions: "Review diffs.",
      computer: "laptop",
      project: "optchat",
      provider: "codex",
      model: "gpt-6.1-sol",
    });
    await helpers.delegate("reviewer", "Review the last commit.", "call-1");
    const reset = await helpers.hire({ name: "reviewer", provider: "", model: "" });
    // T3 Code takes no selection back to the default, so the next job starts a new thread.
    assert.deepEqual([reset.provider, reset.model, reset.thread], [null, null, null]);
  }));
