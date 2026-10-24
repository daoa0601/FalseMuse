import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { codexCall } from "../src/codex.ts";
import { OWNER, read, withMaster, type Event, type TestMaster } from "./test-master.ts";

/** Answers the Master's outbound fetches to one host, standing in for ChatGPT or T3 Code. */
type Outbound = (request: Request) => Promise<Response>;

/**
 * A local Master whose model calls go through `codexCall`, as node/master.ts makes them, with
 * fetches to the named hosts answered by fakes and every other fetch left alone.
 */
async function withFakes(
  fakes: Record<string, Outbound>,
  run: (master: TestMaster) => Promise<void>,
): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const fake = fakes[url.hostname];
    return fake ? fake(new Request(input, init)) : real(input, init);
  };
  try {
    await withMaster(async (master) => {
      master.answer = (request) => codexCall({ access: "token", accountId: "account" }, request);
      await run(master);
    });
  } finally {
    globalThis.fetch = real;
  }
}

/** The fields of a backend request these tests read. */
interface SentBody {
  model: string;
  input: object[];
  reasoning: unknown;
  prompt_cache_key: string;
}

const sse = (output: object[], headers: Record<string, string> = {}) =>
  new Response(
    `data: ${JSON.stringify({ type: "response.completed", response: { output, usage: { output_tokens: 1 } } })}\n\n`,
    { headers: { "content-type": "text/event-stream", ...headers } },
  );

const say = (text: string) => [{ type: "message", content: [{ type: "output_text", text }] }];

/**
 * A fake ChatGPT backend: scripted master steps, and a summary for each compaction unless
 * `compact` answers it. A held answer fails when the Master gives up on the call.
 */
function fakeSubscription(steps: object[][]) {
  const masterRequests: SentBody[] = [];
  const compactRequests: SentBody[] = [];
  const backend = {
    masterRequests,
    compactRequests,
    compact: (): Response | Promise<Response> => sse(say("user: summary")),
    outbound: async (request: Request): Promise<Response> => {
      // The body codexCall wrote.
      const body = (await request.json()) as SentBody;
      if (JSON.stringify(body.input).includes("Compaction: ")) {
        compactRequests.push(body);
        const held = new Promise<never>((_, reject) =>
          request.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
        return Promise.race([backend.compact(), held]);
      }
      masterRequests.push(body);
      return sse(steps[masterRequests.length - 1] ?? []);
    },
  };
  return backend;
}

const codeCall = (id: string, code: string) => ({
  type: "function_call",
  name: "codemode",
  call_id: id,
  arguments: JSON.stringify({ code }),
});

/** The output the master's next request resent for one tool call. */
function toolOutput(request: { input: object[] } | undefined, callId: string): string {
  const item = request?.input.find(
    (entry) =>
      "type" in entry &&
      entry.type === "function_call_output" &&
      "call_id" in entry &&
      entry.call_id === callId,
  );
  return item && "output" in item && typeof item.output === "string" ? item.output : "";
}

test("owner routes require authentication and SQLite and bucket data survive a restart", () =>
  withMaster(async (master) => {
    assert.equal((await master.fetch("/api/status")).status, 401);
    const login = await master.fetch("/login", {
      method: "POST",
      body: new URLSearchParams({ key: OWNER }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie") ?? "";
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    assert.doesNotMatch(cookie, new RegExp(OWNER));
    const session = cookie.split(";")[0] ?? "";
    assert.equal((await master.fetch("/api/status", { headers: { cookie: session } })).status, 200);
    assert.equal(
      (await master.fetch("/api/status", { headers: { cookie: `owner=${OWNER}` } })).status,
      401,
    );
    const wrongKey = await master.fetch("/login", {
      method: "POST",
      body: new URLSearchParams({ key: "guess" }),
    });
    assert.equal(wrongKey.status, 401);
    assert.equal(
      (await master.fetch("/api/status", { headers: { authorization: "Bearer guess" } })).status,
      401,
    );
    await master.json("/api/import", {
      messages: [{ kind: "user", text: "Remember the blue server", session: "sample", index: 0 }],
    });
    await master.request("/api/import", {
      messages: [{ kind: "user", text: "duplicate", session: "sample", index: 0 }],
    });
    await master.upload("sample", '{"text":"Stored transcript"}\n');

    const historical = "/api/transcript-upload?session=history-resume";
    const started = await master.json<{ complete: boolean }>(`${historical}&action=start`, {
      parts: 2,
    });
    assert.equal(started.complete, false);
    const firstPart = Buffer.alloc(10 * 1024 * 1024, "x");
    firstPart.write("first source line\n");
    const part = await master.fetch(`${historical}&action=part&number=1`, {
      method: "PUT",
      headers: { authorization: `Bearer ${OWNER}`, "content-length": String(firstPart.length) },
      body: firstPart,
    });
    assert.equal(part.status, 200, await part.text());
    const incomplete = await read<{ error: string }>(
      await master.request(`${historical}&action=finish`, {}),
    );
    assert.match(incomplete.error, /1 of 2 accepted parts/);

    await master.restart();
    assert.equal((await master.json<{ messages: number }>("/api/status")).messages, 1);
    const [first] = await master.json<{ text: string }[]>("/api/messages");
    assert.equal(first?.text, "Remember the blue server");
    const bucket = master.bucket();
    assert.match((await bucket.text("sessions/sample.jsonl")) ?? "", /Stored transcript/);

    const resumed = await master.json<{ accepted: number[] }>(`${historical}&action=start`, {
      parts: 2,
    });
    assert.deepEqual(resumed.accepted, [1]);
    const ending = Buffer.from('\n{"line":3,"event":{"text":"Recovered source ending"}}\n');
    const finalPart = await master.fetch(`${historical}&action=part&number=2`, {
      method: "PUT",
      headers: { authorization: `Bearer ${OWNER}`, "content-length": String(ending.length) },
      body: ending,
    });
    assert.equal(finalPart.status, 200, await finalPart.text());
    for (let finish = 0; finish < 2; finish++) {
      assert.equal(
        (await master.json<{ complete: boolean }>(`${historical}&action=finish`, {})).complete,
        true,
      );
    }
    const excerpt = await master.json<{ text: string }>(
      "/api/transcript?session=history-resume&start=3&count=1",
    );
    assert.match(excerpt.text, /Recovered source ending/);

    await bucket.put(
      "sessions/large.jsonl",
      "skip this line\n" + "X".repeat(80_000) + "☕ original ending\nthird line\n",
    );
    const selected = (
      await master.json<{ text: string }>("/api/transcript?session=large&start=2&count=1")
    ).text;
    assert.ok(selected.length <= 30_000);
    assert.match(selected, /characters omitted/);
    assert.match(selected, /☕ original ending$/);
    assert.doesNotMatch(selected, /skip this line|third line/);
  }));

// Longer than a line, so summarizing it needs the compactor's model.
const blueReply = "The blue server is in memory. ".repeat(20).trim();

test("a chat turn runs Code Mode over memory, without network access, and replies", () => {
  const backend = fakeSubscription([
    [
      codeCall(
        "search",
        "async () => { const hits = await codemode.search({query: 'blue server'}); return await codemode.zoom({id: hits[0].id, n: hits[0].n}); }",
      ),
    ],
    [codeCall("network", "async () => { return await fetch('https://example.com'); }")],
    say(blueReply),
  ]);
  return withFakes({ "chatgpt.com": backend.outbound }, async (master) => {
    await master.remember("Remember the blue server");
    const { id } = await master.json<{ id: number }>("/api/chat", {
      text: "Where is the blue server?",
    });
    const { steps, ...reply } = await master.finished(id);
    assert.deepEqual(reply, { id, replyId: id, status: "done", text: blueReply });
    // Both Code Mode calls and their results come before the reply, for a client to show.
    assert.deepEqual(
      steps.map((step) => (step as { kind: string }).kind),
      ["tool", "echo", "tool", "echo", "talk"],
    );
    const [, second, third] = backend.masterRequests;
    assert.match(toolOutput(second, "search"), /Remember the blue server/);
    assert.match(toolOutput(third, "network"), /network|fetch|outbound|connection|permission/i);
    const usage = await master.json<{ calls: { purpose: string }[] }>("/api/usage");
    assert.equal(usage.calls.filter((call) => call.purpose === "master").length, 3);
    // The compactor summarizes the turn's tool results beside the turn, not inside it.
    await master.settled(15);
    assert.ok(backend.compactRequests.length > 0, "The turn's reply was not compacted");
    for (const compaction of backend.compactRequests) {
      assert.deepEqual(compaction.reasoning, { effort: "high", summary: "auto" });
    }
  });
});

// A 1x1 PNG.
const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const pixelKey = `images/${createHash("sha256").update(Buffer.from(pixel, "base64")).digest("hex")}.png`;

test("the owner's image is seen with its message, and again when the Master looks", () => {
  const backend = fakeSubscription([
    [
      {
        type: "function_call",
        name: "look",
        call_id: "look-1",
        arguments: JSON.stringify({ image: pixelKey }),
      },
    ],
    say("A single red pixel."),
  ]);
  return withFakes({ "chatgpt.com": backend.outbound }, async (master) => {
    const refused = await master.request("/api/chat", {
      text: "And this?",
      images: [{ mimeType: "image/tiff", data: "AAAA" }],
    });
    assert.equal(refused.status, 400);
    const { id } = await master.json<{ id: number }>("/api/chat", {
      text: "What is this?",
      images: [{ mimeType: "image/png", data: pixel }],
    });
    assert.equal((await master.finished(id)).text, "A single red pixel.");
    assert.ok(await master.bucket().text(pixelKey), "The image was not stored");
    const sent = backend.masterRequests.map((request) => JSON.stringify(request.input));
    const seen = (text: string | undefined) =>
      (text ?? "").split(`data:image/png;base64,${pixel}`).length - 1;
    // With its message, then again after look, with the message resent.
    assert.deepEqual(sent.map(seen), [1, 2]);
    assert.ok(sent[0]?.includes(JSON.stringify(`What is this?\n[image ${pixelKey}]`).slice(1, -1)));
    // Turn state keeps only where each image is stored.
    assert.ok(!sent.some((text) => text.includes('"r2:')));
  });
});

test("a node runs an approved task through reviews, reconnects, recovery, and one report", () =>
  withMaster(async (master) => {
    await master.remember("Remember the blue server");
    const node = await master.json<{ key: string }>("/api/nodes", {
      name: "test-node",
      roots: ["/tmp"],
      tools: ["read"],
    });
    const first = await master.connectNode(node.key);
    assert.equal((await first.next()).type, "registered");
    const job = await master.json<{ id: string; status: string }>("/api/jobs", {
      machine: "test-node",
      cwd: "/tmp",
      task: "Read a file",
    });
    assert.equal(job.status, "approval");
    assert.equal(
      (await master.json<{ status: string }>(`/api/jobs/${job.id}/approve`, {})).status,
      "running",
    );
    const command = await first.next();
    assert.equal(command.type, "spawn");
    assert.equal(command["task"], "Read a file");

    const modelCall = {
      type: "model_call",
      id: "node-model-call",
      job: job.id,
      date: new Date().toISOString(),
      model: "gpt-6.1-sol",
      usage: { input: 100, output: 20, cacheRead: 50 },
      quota: { "x-codex-primary-used-percent": "91", "x-codex-turn-state": "private state" },
    };
    first.send(modelCall);
    assert.equal((await first.next()).type, "ack");
    first.send(modelCall);
    assert.equal((await first.next()).type, "ack");
    const ledger = await master.json<{
      quota: unknown;
      calls: { source: string; usage: { output: number } }[];
    }>("/api/usage");
    assert.equal(ledger.calls.length, 1);
    assert.equal(ledger.calls[0]?.source, "test-node");
    assert.equal(ledger.calls[0]?.usage.output, 20);
    assert.deepEqual(ledger.quota, { "x-codex-primary-used-percent": "91" });
    first.send({ ...modelCall, id: "wrong-job-call", job: "someone-elses-task" });
    assert.match(String((await first.next())["error"]), /does not belong/);

    first.send({
      type: "permission_request",
      job: job.id,
      id: "write-a-note",
      title: "Allow Pi write?",
      message: 'write /tmp/note.txt: "Reviewed note"',
    });
    assert.equal((await first.next()).type, "permission_pending");
    const [review] = await master.json<{ message: string }[]>("/api/permissions");
    assert.equal(review?.message, 'write /tmp/note.txt: "Reviewed note"');
    const nodeDecision = await master.fetch(`/api/permissions/${job.id}/write-a-note`, {
      method: "POST",
      headers: { authorization: `Bearer ${node.key}`, "content-type": "application/json" },
      body: JSON.stringify({ allowed: true }),
    });
    assert.equal(nodeDecision.status, 401);
    const denied = await master.json<{ allowed: boolean }>(
      `/api/permissions/${job.id}/write-a-note`,
      { allowed: false },
    );
    assert.equal(denied.allowed, false);
    assert.equal((await first.next())["allowed"], false);
    first.send({ type: "permission_received", job: job.id, id: "write-a-note" });
    const changed = await master.json<{ allowed: boolean }>(
      `/api/permissions/${job.id}/write-a-note`,
      { allowed: true },
    );
    assert.equal(changed.allowed, false);

    first.send({
      type: "permission_request",
      job: job.id,
      id: "write-a-plan",
      title: "Allow Pi write?",
      message: "write the reviewed plan",
    });
    assert.equal((await first.next()).type, "permission_pending");
    await master.json(`/api/permissions/${job.id}/write-a-plan`, { allowed: true });
    assert.equal((await first.next())["allowed"], true);
    first.close();

    const second = await master.connectNode(node.key);
    assert.equal((await second.next()).type, "registered");
    second.send({ type: "node_ready" });
    let permission = await second.next();
    while (permission.type !== "permission") permission = await second.next();
    assert.equal(permission["id"], "write-a-plan");
    second.send({ type: "permission_received", job: job.id, id: "write-a-plan" });
    second.close();

    const third = await master.connectNode(node.key);
    assert.equal((await third.next()).type, "registered");
    third.send({ type: "node_ready" });
    const resumedJob = await third.next();
    assert.equal(resumedJob.type, "spawn");
    assert.equal(resumedJob["id"], job.id);
    assert.equal(resumedJob["resume"], true);
    assert.equal((await third.next()).type, "ready");
    third.send({
      type: "permission_request",
      job: job.id,
      id: "later-call",
      title: "Allow Pi bash?",
      message: "Run a check",
    });
    assert.equal((await third.next()).type, "permission_pending");
    const resume = { type: "resume_job", id: "recovery-delivery", job: job.id };
    third.send(resume);
    assert.equal((await third.next()).type, "ack");
    assert.equal((await master.json<unknown[]>("/api/permissions")).length, 0);
    const expired = await read<{ state: string }>(
      await master.request(`/api/permissions/${job.id}/later-call`, { allowed: true }),
    );
    assert.equal(expired.state, "expired");
    third.send({
      type: "permission_request",
      job: job.id,
      id: "fresh-call",
      title: "Allow Pi bash?",
      message: "Check the recovered workspace",
    });
    assert.equal((await third.next()).type, "permission_pending");
    third.send(resume);
    assert.equal((await third.next()).type, "ack");
    const [fresh] = await master.json<{ request: string }[]>("/api/permissions");
    assert.equal(fresh?.request, "fresh-call");

    third.send({ type: "report", id: job.id, status: "done", report: "Read the requested file." });
    third.send({ type: "report", id: job.id, status: "done", report: "Duplicate delivery" });
    assert.equal((await third.next()).type, "ack");
    assert.equal((await master.json<unknown[]>("/api/permissions")).length, 0);
    assert.equal(
      (await master.request(`/api/permissions/${job.id}/fresh-call`, { allowed: true })).status,
      400,
    );
    const bucket = master.bucket();
    const auditEvents = await Promise.all(
      bucket
        .keys(`audit/${job.id}/`)
        // Audit records the Master wrote.
        .map(async (key) => JSON.parse((await bucket.text(key)) ?? "{}") as Event),
    );
    assert.ok(
      auditEvents.some(
        (event) =>
          event["action"] === "tool-denied" &&
          (event["message"] as Event | null)?.["request"] === "write-a-note",
      ),
    );
    assert.equal((await third.next()).type, "ack");
    assert.equal((await master.json<{ pending: number }>("/api/status")).pending, 1);
    const overwrite = await master.fetch("/node/transcript?session=someone-else", {
      method: "PUT",
      headers: { authorization: `Bearer ${node.key}` },
      body: "Cannot overwrite another session",
    });
    assert.equal(overwrite.status, 403);
    assert.equal((await master.json<{ cancelled: number }>("/api/cancel", {})).cancelled, 1);
    const messages = await master.json<{ text: string }[]>("/api/messages");
    assert.ok(messages.some((message) => message.text.includes("Read the requested file.")));
    third.close();
  }));

test("a node ingests its own hand-run recording once, after uploading the transcript", () =>
  withMaster(async (master) => {
    const node = await master.json<{ key: string }>("/api/nodes", {
      name: "test-node",
      roots: ["/tmp"],
      tools: ["read"],
    });
    const nodeRequest = (path: string, body: unknown) =>
      master.fetch(path, {
        method: "POST",
        headers: { authorization: `Bearer ${node.key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const session = "codex/hand-run";
    assert.equal((await nodeRequest("/node/recordings", { session, kind: "main" })).status, 200);
    const body = {
      session,
      messages: [
        {
          line: 8,
          kind: "user",
          text: "Keep the source timestamps.",
          timestamp: "2026-10-01T10:00:00Z",
        },
        { line: 12, kind: "talk", text: "Timestamps retained.", timestamp: "2026-10-01T10:01:00Z" },
      ],
    };
    assert.equal((await nodeRequest("/node/ingest", body)).status, 409);
    const transcript = await master.fetch(
      "/node/transcript?session=live/test-node/codex/hand-run",
      {
        method: "PUT",
        headers: { authorization: `Bearer ${node.key}` },
        body: '{"line":1,"event":{"type":"session"}}\n{"line":8,"event":{"text":"Keep the source timestamps."}}\n{"line":12,"event":{"text":"Timestamps retained."}}\n',
      },
    );
    assert.equal(transcript.status, 200);
    for (const appended of [2, 0]) {
      assert.equal(
        (await read<{ appended: number }>(await nodeRequest("/node/ingest", body))).appended,
        appended,
      );
    }
    const messages = await master.json<{ text: string; date: string }[]>("/api/messages");
    const original = messages.find((message) => message.text === "Keep the source timestamps.");
    assert.equal(original?.date, "2026-10-01T10:00:00Z");
    const sourceText = (
      await master.json<{ text: string }>("/api/transcript?session=codex/hand-run&start=8&count=5")
    ).text;
    assert.match(sourceText, /Keep the source timestamps/);
    assert.match(sourceText, /Timestamps retained/);
    assert.doesNotMatch(sourceText, /"type":"session"/);
  }));

test("a chat turn is private to the owner and reports its own status", () =>
  withMaster(async (master) => {
    // The model never answers, so the turn stays pending until it is cancelled.
    master.answer = () => new Promise(() => {});
    const chat = await master.request("/api/chat", {
      text: "Keep this terminal message in its own turn.",
    });
    const queued = await read<{ id: number }>(chat);
    assert.equal(chat.status, 202);
    assert.deepEqual(await master.json(`/api/turns/${queued.id}`), {
      id: queued.id,
      replyId: queued.id,
      status: "pending",
      text: "",
      steps: [],
    });
    assert.equal((await master.fetch(`/api/turns/${queued.id}`)).status, 401);
    assert.equal((await master.request("/api/turns/999999")).status, 404);
    // Imported history waits, so it never lands between the steps of a live turn.
    const history = {
      messages: [{ kind: "user", text: "An old message", session: "old", index: 0 }],
    };
    assert.equal((await master.request("/api/import", history)).status, 409);
    await master.json("/api/cancel", {});
    assert.equal(
      (await master.json<{ status: string }>(`/api/turns/${queued.id}`)).status,
      "cancelled",
    );
    assert.equal((await master.request("/api/import", history)).status, 200);
    const status = await master.json<{ unsummarized: number }>("/api/status");
    assert.equal(typeof status.unsummarized, "number");
  }));

test("a failed summary is tried again by itself, with the compactor's model and effort", () => {
  const backend = fakeSubscription([]);
  let failures = 1;
  backend.compact = () =>
    failures-- > 0
      ? Response.json({ error: { message: "Rate limited" } }, { status: 429 })
      : sse(say("user: Keep the decision"), { "x-codex-primary-used-percent": "19" });
  return withFakes({ "chatgpt.com": backend.outbound }, async (master) => {
    await master.json("/api/import", {
      messages: [{ kind: "user", text: "Keep the decision. ".repeat(60), session: "s", index: 1 }],
    });
    // A failed summary waits ten seconds for its retry.
    await master.settled(20);
    assert.match(
      (await master.json<{ text: string }>("/api/view")).text,
      /0\+1\|user: Keep the decision/,
    );
    assert.deepEqual(
      backend.compactRequests.map((request) => [request.model, request.prompt_cache_key]),
      [
        ["gpt-6-luna", "optchat"],
        ["gpt-6-luna", "optchat"],
      ],
    );
    const usage = await master.json<{
      calls: { purpose: string; quota: Record<string, string> }[];
    }>("/api/usage");
    assert.deepEqual(
      usage.calls.map((call) => [call.purpose, call.quota["x-codex-primary-used-percent"]]),
      [["compact", "19"]],
    );
  });
});

test("a chat turn answers while the compactor is stuck, naming the line it could not read", () => {
  const backend = fakeSubscription([say("Opening line 0 would tell me.")]);
  let release = () => {};
  // The backend takes the compaction and answers it only when the test ends.
  backend.compact = () =>
    new Promise((resolve) => (release = () => resolve(sse(say("user: summary")))));
  return withFakes({ "chatgpt.com": backend.outbound }, async (master) => {
    try {
      await master.json("/api/import", {
        messages: [
          { kind: "note", text: "Keep the decision. ".repeat(60), session: "s", index: 1 },
        ],
      });
      await master.until(() => backend.compactRequests.length === 1, "No compaction started");
      const asked = Date.now();
      const { id } = await master.json<{ id: number }>("/api/chat", {
        text: "What did we decide?",
      });
      await master.until(
        () => backend.masterRequests.length === 1,
        "The turn waited past its bound",
        15,
      );
      assert.ok(Date.now() - asked < 15_000, "The turn waited past its bound");
      const request = backend.masterRequests[0] as SentBody & {
        input: { content: { text: string }[] }[];
      };
      assert.equal(request.model, "gpt-6.1-sol");
      assert.match(
        request.input[0]?.content[0]?.text ?? "",
        /^<chat>\n0\+1\|\(not summarized yet: note, 1140 bytes; zoom\(0, 1\) reads it\)\n<\/chat>$/,
      );
      const done = await master.finished(id);
      assert.deepEqual([done.status, done.text], ["done", "Opening line 0 would tell me."]);
    } finally {
      release();
    }
  });
});

/** A computer's T3 Code: its OAuth sign-in and the MCP tools the Master calls. */
function fakeT3() {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  let challenge = "";
  let launches = 0;
  let redirect = "";
  const origin = "https://t3.example.test";
  const sse = (id: unknown, result: unknown, headers: Record<string, string> = {}) =>
    new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`, {
      headers: { "content-type": "text/event-stream", ...headers },
    });
  const tool = (name: string): unknown => {
    switch (name) {
      case "t3_project_list":
        return {
          projects: [{ id: "p1", title: "optchat", workspaceRoot: "/work/optchat", scripts: [] }],
          nextCursor: null,
        };
      case "orchestrator_capabilities":
        return {
          providers: [
            { providerInstanceId: "codex", displayName: "Codex", models: [{ id: "gpt-6.1-sol" }] },
          ],
        };
      case "t3_thread_launch":
        return { threadId: `th${++launches}`, projectId: "p1", runId: "r1", status: "starting" };
      case "t3_thread_read":
        return {
          thread: { title: "Fix tests", status: "completed", itemCount: 2, pendingRequestCount: 0 },
          items: [
            { position: 0, type: "user_message", text: "Make the tests pass" },
            { position: 1, type: "assistant_message", text: "All tests pass now." },
          ],
          nextPosition: null,
          hasMore: false,
        };
      default:
        throw new Error(`Unexpected tool ${name}`);
    }
  };
  // The bodies below are the Master's own requests; the fake reads the fields it checks.
  const outbound = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/mcp/authorize`,
        token_endpoint: `${origin}/oauth/mcp/token`,
        registration_endpoint: `${origin}/oauth/mcp/register`,
      });
    }
    if (url.pathname === "/oauth/mcp/register") {
      const body = (await request.json()) as { redirect_uris: string[] };
      assert.deepEqual(body.redirect_uris, [redirect]);
      return Response.json({ client_id: "client-1", redirect_uris: body.redirect_uris });
    }
    if (url.pathname === "/oauth/mcp/token") {
      const form = new URLSearchParams(await request.text());
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(form.get("code_verifier") ?? ""),
      );
      const expected = Buffer.from(digest).toString("base64url");
      if (form.get("code") !== "approved" || expected !== challenge) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return Response.json({ access_token: "t3-token", expires_in: 2_592_000 });
    }
    if (url.pathname === "/mcp") {
      if (request.headers.get("authorization") !== "Bearer t3-token") {
        return new Response("{}", { status: 401 });
      }
      const message = (await request.json()) as {
        id?: string;
        method: string;
        params: { name: string; arguments: Record<string, unknown> };
      };
      if (message.method === "initialize") return sse(message.id, {}, { "mcp-session-id": "s1" });
      if (message.method.startsWith("notifications/")) return new Response(null, { status: 202 });
      assert.equal(request.headers.get("mcp-session-id"), "s1");
      calls.push(message.params);
      return sse(message.id, { structuredContent: tool(message.params.name), content: [] });
    }
    return new Response("Not mocked", { status: 599 });
  };
  return {
    calls,
    outbound,
    /** The owner signs the Master in to the laptop's T3 Code, as the callback page finishes it. */
    async signIn(master: TestMaster): Promise<void> {
      redirect = `${master.url}/oauth/t3/callback`;
      const { authorize } = await master.json<{ authorize: string }>("/api/computers", {
        name: "laptop",
        url: "https://t3.example.test/mcp",
      });
      const params = new URL(authorize).searchParams;
      assert.equal(
        new URL(authorize).origin + new URL(authorize).pathname,
        "https://t3.example.test/oauth/mcp/authorize",
      );
      assert.deepEqual(
        [params.get("client_id"), params.get("redirect_uri"), params.get("code_challenge_method")],
        ["client-1", redirect, "S256"],
      );
      assert.equal(params.get("scope"), "orchestration:read orchestration:operate");
      challenge = params.get("code_challenge") ?? "";
      const callback = `/oauth/t3/callback?code=approved&state=${params.get("state")}&iss=https://t3.example.test`;
      const signedIn = await master.fetch(callback);
      assert.equal(signedIn.status, 200);
      assert.match(await signedIn.text(), /can now reach laptop/);
      // The state is single-use, and the route needs no owner key.
      assert.equal((await master.fetch(callback)).status, 400);
      const [computer] =
        await master.json<{ name: string; connected: boolean }[]>("/api/computers");
      assert.deepEqual([computer?.name, computer?.connected], ["laptop", true]);
    },
  };
}

test("the owner signs the Master in to a computer's T3 Code, and a launched thread reports back", () => {
  const t3 = fakeT3();
  const backend = fakeSubscription([
    [
      {
        type: "function_call",
        name: "launch",
        call_id: "launch-1",
        arguments: JSON.stringify({
          computer: "laptop",
          project: "optchat",
          title: "Fix tests",
          task: "Make the tests pass",
        }),
      },
    ],
    say("Started Fix tests on laptop."),
    say("**Fix tests is done.**\nAll pass."),
    say("QUIET"),
  ]);
  const fakes = { "t3.example.test": t3.outbound, "chatgpt.com": backend.outbound };
  return withFakes(fakes, async (master) => {
    await t3.signIn(master);
    await master.json("/api/instructions", { text: " Call me Sam. " }, "PUT");
    assert.deepEqual(await master.json("/api/instructions"), { text: "Call me Sam." });

    const { id } = await master.json<{ id: number }>("/api/chat", {
      text: "Fix the failing tests in optchat on my laptop",
    });
    await master.until(
      () => backend.masterRequests.length >= 3,
      "The thread's report did not start a turn",
      20,
    );
    const turn = await master.json<{ text: string; steps: { kind: string; text: string }[] }>(
      `/api/turns/${id}`,
    );
    assert.equal(turn.text, "Started Fix tests on laptop.");
    assert.deepEqual(
      turn.steps.map((step) => step.kind),
      ["tool", "echo", "talk"],
    );
    assert.match(turn.steps[0]?.text ?? "", /^launch /);
    // The thread runs at the access the owner approved: the Master asks for no mode.
    assert.deepEqual(t3.calls.find((call) => call.name === "t3_thread_launch")?.arguments, {
      projectId: "p1",
      title: "Fix tests",
      message: "Make the tests pass",
    });
    assert.match(
      JSON.stringify(backend.masterRequests[2]?.input),
      // Quoted as data, as JSON inside the request's JSON.
      /work: \\"\[laptop: Fix tests\] completed: All tests pass now\./,
    );
    const messages = await master.json<{ kind: string; text: string }[]>("/api/messages");
    assert.ok(
      messages.some(
        (message) =>
          message.kind === "work" && message.text.startsWith("[laptop: Fix tests] completed"),
      ),
    );
    const first = JSON.stringify(backend.masterRequests[0]?.input);
    assert.match(
      first,
      /^\[\{"role":"user","content":\[\{"type":"input_text","text":"<instructions>\\nCall me Sam\.\\n<\/instructions>"\}/,
    );
    assert.match(
      first,
      /"It is \w+day \d{4}-\d\d-\d\dT\d\d:\d\d[+-]\d\d:\d\d \(Europe\/Helsinki\)\."/,
    );

    // Nobody prompted for the reply to the report, so it is posted to T3 Code for the phone.
    const posts = () => t3.calls.filter((call) => call.arguments["scratch"] === true);
    await master.until(() => posts().length >= 1, "The reply to the report was not posted", 20);
    const post = posts()[0]?.arguments;
    assert.deepEqual(
      { ...post, message: undefined },
      {
        scratch: true,
        title: "OptChat: Fix tests is done.",
        modelSelection: { instanceId: "optchat", model: "default" },
        message: undefined,
      },
    );
    const posted = Number(/^OptChat turn (\d+)$/.exec(String(post?.["message"]))?.[1]);
    assert.equal(
      (await master.json<{ text: string }>(`/api/turns/${posted}`)).text,
      "**Fix tests is done.**\nAll pass.",
    );

    // A schedule's turn that needs nothing from the owner stays off the phone.
    await master.json("/api/schedules", {
      prompt: "Check on the threads",
      at: new Date(Date.now() + 300).toISOString(),
    });
    await master.until(
      async () =>
        backend.masterRequests.length >= 4 &&
        !(await master.json<{ pending: number }>("/api/status")).pending,
      "The scheduled turn did not run",
      20,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(posts().length, 1);
    // The posted thread is not watched, so its end never comes back as a turn.
    assert.equal(backend.masterRequests.length, 4);
  });
});

test("the Master hires a named helper and gives it jobs in its own thread", () => {
  const t3 = fakeT3();
  const call = (name: string, id: string, args: Record<string, unknown>) => [
    { type: "function_call", name, call_id: id, arguments: JSON.stringify(args) },
  ];
  const backend = fakeSubscription([
    call("hire", "hire-1", {
      name: "reviewer",
      instructions: "Review diffs for bugs.",
      computer: "laptop",
      project: "optchat",
      provider: "codex",
      model: "gpt-6.1-sol",
    }),
    call("delegate", "delegate-1", { helper: "reviewer", task: "Review the last commit." }),
    say("Hired reviewer; it is reviewing the last commit."),
    say("QUIET"),
    call("hire", "hire-2", { name: "reviewer", fresh: true }),
    call("delegate", "delegate-2", { helper: "reviewer", task: "Review it again." }),
    say("Reviewer starts again in a new thread."),
  ]);
  const fakes = { "t3.example.test": t3.outbound, "chatgpt.com": backend.outbound };
  return withFakes(fakes, async (master) => {
    await t3.signIn(master);
    await master.json("/api/chat", { text: "Hire a reviewer on my laptop and have it review." });
    // The helper's thread reports back as a turn of its own.
    await master.until(
      () => backend.masterRequests.length >= 4,
      "The helper's report did not start a turn",
      20,
    );
    const launch = t3.calls.find((entry) => entry.name === "t3_thread_launch")?.arguments;
    assert.deepEqual(
      { ...launch, message: undefined },
      {
        projectId: "p1",
        title: "Helper: reviewer",
        modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
        message: undefined,
      },
    );
    assert.match(
      String(launch?.["message"]),
      /Review diffs for bugs\.[\s\S]*Review the last commit\.$/,
    );
    assert.deepEqual(
      (await master.json<{ name: string; thread: string; auto: boolean }[]>("/api/helpers")).map(
        ({ name, thread, auto }) => [name, thread, auto],
      ),
      [["reviewer", "th1", false]],
    );
    assert.match(
      JSON.stringify(backend.masterRequests[3]?.input),
      /\[laptop: Fix tests\] completed/,
    );

    // A fresh start begins a new thread from the helper's jobs and the report that came back.
    await master.json("/api/chat", { text: "Give the reviewer a fresh start and review again." });
    const launches = () => t3.calls.filter((entry) => entry.name === "t3_thread_launch");
    await master.until(() => launches().length >= 2, "The fresh thread did not start", 20);
    assert.match(
      String(launches()[1]?.arguments["message"]),
      /<history>\nJob: Review the last commit\.\nResult: \[laptop: Fix tests\] completed: All tests pass now\.\n<\/history>\n\nReview it again\.$/,
    );
  });
});
