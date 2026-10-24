import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  Miniflare,
  Response as WorkerResponse,
  type MiniflareOptions,
  type Request as WorkerRequest,
  type WebSocket,
} from "miniflare";

import { moveToLaptop } from "../scripts/move-to-laptop.ts";
import { startMaster } from "../node/local-master.ts";
import { backUp, workerBucket } from "../node/backup.ts";
import { openDatabase } from "../node/sqlite.ts";
import { modelReply } from "./support.ts";

const OWNER = "test-owner";

/** Test responses are JSON from our own Worker; assertions check the fields they read. */
async function read<T>(response: Response | { json(): Promise<unknown> }): Promise<T> {
  return (await response.json()) as T;
}

/** Answers the Worker's outbound fetches, standing in for the ChatGPT and OAuth services. */
type Outbound = (request: WorkerRequest) => Promise<WorkerResponse>;

function options(directory: string, outbound?: Outbound): MiniflareOptions {
  const built: unknown = JSON.parse(
    readFileSync(".cloudflare/output/v0/workers/default/worker.config.json", "utf8"),
  );
  return {
    resourcePersistencePath: directory,
    workers: [
      {
        config: {
          ...(built as object),
          exports: {
            Master: { type: "durable-object", storage: "sqlite" },
            Sandbox: { type: "durable-object", storage: "sqlite" },
            Inbox: { type: "durable-object", storage: "sqlite" },
          },
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: readFileSync(
                  ".cloudflare/output/v0/workers/default/bundle/worker.js",
                  "utf8",
                ),
              },
            },
          },
          env: {
            LOADER: { type: "worker-loader" },
            TRANSCRIPTS: { type: "r2", name: "transcripts" },
            OWNER_KEY: { type: "text", value: OWNER },
            COMPACTOR_MODEL: { type: "text", value: "gpt-6-luna" },
            COMPACTOR_EFFORT: { type: "text", value: "high" },
            MASTER_MODEL: { type: "text", value: "gpt-6.1-sol" },
            OWNER_TIMEZONE: { type: "text", value: "Europe/Helsinki" },
          },
        },
        ...(outbound ? { dev: { outboundService: { type: "fetcher", handler: outbound } } } : {}),
      },
    ],
    // The bundle's generated config plus test bindings; Miniflare validates it at startup.
  } as unknown as MiniflareOptions;
}

/** The R2 calls these tests make on Miniflare's bucket. */
interface TestBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string): Promise<unknown>;
  list(options: { prefix: string }): Promise<{ objects: { key: string }[] }>;
}

/** A Worker on the local runtime with persistent storage that survives restart(). */
class TestWorker {
  readonly directory = mkdtempSync(join(tmpdir(), "optchat-worker-"));
  private readonly outbound: Outbound | undefined;
  runtime: Miniflare;

  constructor(outbound?: Outbound) {
    this.outbound = outbound;
    this.runtime = new Miniflare(options(this.directory, outbound));
  }

  fetch(path: string, init?: RequestInit) {
    return this.runtime.dispatchFetch(`https://example.test${path}`, init as never);
  }

  /** An owner API call: a body makes it a POST unless another method is given. */
  request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    return this.fetch(path, {
      method,
      headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async json<T>(path: string, body?: unknown, method?: string): Promise<T> {
    return read<T>(await this.request(path, body, method));
  }

  async restart(): Promise<void> {
    await this.runtime.dispose();
    this.runtime = new Miniflare(options(this.directory, this.outbound));
  }

  /** Upload a small transcript through the resumable owner route, in one part. */
  async upload(session: string, text: string): Promise<void> {
    const route = `/api/transcript-upload?session=${session}`;
    assert.equal(
      (await this.json<{ complete: boolean }>(`${route}&action=start`, { parts: 1 })).complete,
      false,
    );
    const body = Buffer.from(text);
    const part = await this.fetch(`${route}&action=part&number=1`, {
      method: "PUT",
      headers: { authorization: `Bearer ${OWNER}`, "content-length": String(body.length) },
      body,
    });
    assert.equal(part.status, 200, await part.text());
    assert.equal(
      (await this.json<{ complete: boolean }>(`${route}&action=finish`, {})).complete,
      true,
    );
  }

  async bucket(): Promise<TestBucket> {
    return (await this.runtime.getR2Bucket("TRANSCRIPTS")) as unknown as TestBucket;
  }

  async dispose(): Promise<void> {
    await this.runtime.dispose();
    rmSync(this.directory, { recursive: true });
  }

  /** Import one short message; its free summary settles the view for spawn proposals. */
  async remember(text: string): Promise<void> {
    await this.request("/api/import", {
      messages: [{ kind: "user", text, session: "sample", index: 0 }],
      nodes: [{ level: 0, index: 0, text: `user: ${text}` }],
    });
  }

  async connectNode(key: string): Promise<NodeSocket> {
    const upgrade = await this.fetch("/node/ws", {
      headers: { upgrade: "websocket", "sec-websocket-protocol": `optchat, ${key}` },
    });
    assert.equal(upgrade.status, 101);
    const socket = upgrade.webSocket;
    assert.ok(socket);
    return new NodeSocket(socket);
  }
}

type Event = Record<string, unknown> & { type?: string };

/** The node side of the Master's WebSocket, read one message at a time. */
class NodeSocket {
  private readonly events: Event[] = [];
  private waiter: ((event: Event) => void) | null = null;
  readonly socket: WebSocket;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const value = JSON.parse(String(event.data)) as Event;
      const waiter = this.waiter;
      if (waiter) {
        this.waiter = null;
        waiter(value);
      } else this.events.push(value);
    });
    socket.accept();
  }

  next(): Promise<Event> {
    const event = this.events.shift();
    return event ? Promise.resolve(event) : new Promise((resolve) => (this.waiter = resolve));
  }

  send(value: unknown): void {
    this.socket.send(JSON.stringify(value));
  }

  close(): void {
    this.socket.close();
  }
}

async function withWorker(
  run: (worker: TestWorker) => Promise<void>,
  outbound?: Outbound,
): Promise<void> {
  const worker = new TestWorker(outbound);
  try {
    await run(worker);
  } finally {
    await worker.dispose();
  }
}

test("owner routes require authentication and SQLite and R2 data survive a restart", () =>
  withWorker(async (worker) => {
    assert.equal((await worker.fetch("/api/status")).status, 401);
    const login = await worker.fetch("/login", {
      method: "POST",
      body: new URLSearchParams({ key: OWNER }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie") ?? "";
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    assert.doesNotMatch(cookie, new RegExp(OWNER));
    const session = cookie.split(";")[0] ?? "";
    assert.equal((await worker.fetch("/api/status", { headers: { cookie: session } })).status, 200);
    assert.equal(
      (await worker.fetch("/api/status", { headers: { cookie: `owner=${OWNER}` } })).status,
      401,
    );
    const wrongKey = await worker.fetch("/login", {
      method: "POST",
      body: new URLSearchParams({ key: "guess" }),
    });
    assert.equal(wrongKey.status, 401);
    assert.equal(
      (await worker.fetch("/api/status", { headers: { authorization: "Bearer guess" } })).status,
      401,
    );
    const imported = await worker.request("/api/import", {
      messages: [{ kind: "user", text: "Remember the blue server", session: "sample", index: 0 }],
    });
    assert.equal(imported.status, 200);
    await worker.request("/api/import", {
      messages: [{ kind: "user", text: "duplicate", session: "sample", index: 0 }],
    });
    await worker.upload("sample", '{"text":"Stored transcript"}\n');

    const historical = "/api/transcript-upload?session=history-resume";
    const started = await worker.json<{ complete: boolean }>(`${historical}&action=start`, {
      parts: 2,
    });
    assert.equal(started.complete, false);
    const firstPart = Buffer.alloc(10 * 1024 * 1024, "x");
    firstPart.write("first source line\n");
    const part = await worker.fetch(`${historical}&action=part&number=1`, {
      method: "PUT",
      headers: { authorization: `Bearer ${OWNER}`, "content-length": String(firstPart.length) },
      body: firstPart,
    });
    assert.equal(part.status, 200, await part.text());
    const incomplete = await worker.json<{ error: string }>(`${historical}&action=finish`, {});
    assert.match(incomplete.error, /1 of 2 accepted parts/);

    await worker.restart();
    assert.equal((await worker.json<{ messages: number }>("/api/status")).messages, 1);
    const [first] = await worker.json<{ text: string }[]>("/api/messages");
    assert.equal(first?.text, "Remember the blue server");
    const bucket = await worker.bucket();
    assert.match(
      (await (await bucket.get("sessions/sample.jsonl"))?.text()) ?? "",
      /Stored transcript/,
    );

    const resumed = await worker.json<{ accepted: number[] }>(`${historical}&action=start`, {
      parts: 2,
    });
    assert.deepEqual(resumed.accepted, [1]);
    const ending = Buffer.from('\n{"line":3,"event":{"text":"Recovered source ending"}}\n');
    const finalPart = await worker.fetch(`${historical}&action=part&number=2`, {
      method: "PUT",
      headers: { authorization: `Bearer ${OWNER}`, "content-length": String(ending.length) },
      body: ending,
    });
    assert.equal(finalPart.status, 200, await finalPart.text());
    assert.equal(
      (await worker.json<{ complete: boolean }>(`${historical}&action=finish`, {})).complete,
      true,
    );
    assert.equal(
      (await worker.json<{ complete: boolean }>(`${historical}&action=finish`, {})).complete,
      true,
    );
    const excerpt = await worker.json<{ text: string }>(
      "/api/transcript?session=history-resume&start=3&count=1",
    );
    assert.match(excerpt.text, /Recovered source ending/);

    await bucket.put(
      "sessions/large.jsonl",
      "skip this line\n" + "X".repeat(80_000) + "☕ original ending\nthird line\n",
    );
    const selected = (
      await worker.json<{ text: string }>("/api/transcript?session=large&start=2&count=1")
    ).text;
    assert.ok(selected.length <= 30_000);
    assert.match(selected, /characters omitted/);
    assert.match(selected, /☕ original ending$/);
    assert.doesNotMatch(selected, /skip this line|third line/);
  }));

test("an unspecified spawn falls back to the Sandbox for owner approval", () =>
  withWorker(async (worker) => {
    await worker.remember("Remember the blue server");
    const fallback = await worker.request("/api/jobs", {
      task: "Work on the assistant repository",
    });
    const proposed = await read<{ id: string }>(fallback);
    assert.equal(fallback.status, 200, JSON.stringify(proposed));
    const jobs =
      await worker.json<{ id: string; machine: string; cwd: string; status: string }[]>(
        "/api/jobs",
      );
    const chosen = jobs.find((item) => item.id === proposed.id);
    assert.equal(chosen?.machine, "sandbox");
    assert.equal(chosen?.cwd, "/workspace/repo");
    assert.equal(chosen?.status, "approval");
    assert.equal((await worker.request("/api/codemode", { code: "async () => 1" })).status, 404);
  }));

/** A fake ChatGPT subscription: device login, then scripted master steps over SSE. */
function fakeSubscription(steps: object[][]) {
  const masterRequests: { input: object[] }[] = [];
  const compactRequests: { reasoning: unknown }[] = [];
  const claims = btoa(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }),
  );
  const accessToken = `header.${claims.replaceAll("=", "")}.signature`;
  const stream = (output: object[]) =>
    new WorkerResponse(
      `data: ${JSON.stringify({ type: "response.completed", response: { output, usage: { output_tokens: 1 } } })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  const outbound: Outbound = async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/accounts/deviceauth/usercode") {
      return WorkerResponse.json({ device_auth_id: "device", user_code: "CODE-1234", interval: 0 });
    }
    if (url.pathname === "/api/accounts/deviceauth/token") {
      return WorkerResponse.json({ authorization_code: "code", code_verifier: "verifier" });
    }
    if (url.pathname === "/oauth/token") {
      return WorkerResponse.json({
        access_token: accessToken,
        refresh_token: "refresh",
        expires_in: 3600,
      });
    }
    if (url.hostname === "chatgpt.com") {
      const body = (await request.json()) as {
        instructions: string;
        input: object[];
        reasoning: unknown;
      };
      if (JSON.stringify(body.input).includes("Compaction: ")) {
        compactRequests.push(body);
        return stream([
          { type: "message", content: [{ type: "output_text", text: "user: summary" }] },
        ]);
      }
      masterRequests.push(body);
      return stream(steps[masterRequests.length - 1] ?? []);
    }
    return new WorkerResponse("Not mocked", { status: 599 });
  };
  return { outbound, masterRequests, compactRequests };
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

// Longer than a line, so summarizing it needs the compactor's model.
const blueReply = "The blue server is in memory. ".repeat(20).trim();
const subscription = fakeSubscription([
  [
    codeCall(
      "search",
      "async () => { const hits = await codemode.search({query: 'blue server'}); return await codemode.zoom({id: hits[0].id, n: hits[0].n}); }",
    ),
  ],
  [codeCall("network", "async () => { return await fetch('https://example.com'); }")],
  [{ type: "message", content: [{ type: "output_text", text: blueReply }] }],
]);

test("a chat turn runs Code Mode over memory, without network access, and replies", () =>
  withWorker(async (worker) => {
    await worker.remember("Remember the blue server");
    await worker.request("/api/auth/start", {});
    const connected = Date.now() + 15_000;
    while (!(await worker.json<{ authenticated: boolean }>("/api/status")).authenticated) {
      assert.ok(Date.now() < connected, "The device login did not complete");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const { id } = await worker.json<{ id: number }>("/api/chat", {
      text: "Where is the blue server?",
    });
    const deadline = Date.now() + 15_000;
    let turn = await worker.json<{ status: string; text: string }>(`/api/turns/${id}`);
    while (turn.status === "pending") {
      assert.ok(Date.now() < deadline, "The turn did not finish");
      await new Promise((resolve) => setTimeout(resolve, 200));
      turn = await worker.json<{ status: string; text: string }>(`/api/turns/${id}`);
    }
    const { steps, ...reply } = turn as typeof turn & { steps: { kind: string }[] };
    assert.deepEqual(reply, { id, replyId: id, status: "done", text: blueReply });
    // Both Code Mode calls and their results come before the reply, for a client to show.
    assert.deepEqual(
      steps.map((step) => step.kind),
      ["tool", "echo", "tool", "echo", "talk"],
    );
    const [, second, third] = subscription.masterRequests;
    assert.match(toolOutput(second, "search"), /Remember the blue server/);
    assert.match(toolOutput(third, "network"), /network|fetch|outbound|connection/i);
    const usage = await worker.json<{ calls: { purpose: string }[] }>("/api/usage");
    assert.equal(usage.calls.filter((call) => call.purpose === "master").length, 3);
    // The compactor summarizes the turn's tool results beside the turn, not inside it.
    const settled = Date.now() + 15_000;
    while (!(await worker.json<{ settled: boolean }>("/api/status")).settled) {
      assert.ok(Date.now() < settled, "The turn's lines were not summarized");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(subscription.compactRequests.length > 0, "The turn's reply was not compacted");
    for (const compaction of subscription.compactRequests) {
      assert.deepEqual(compaction.reasoning, { effort: "high", summary: "auto" });
    }
  }, subscription.outbound));

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
    [{ type: "message", content: [{ type: "output_text", text: "A single red pixel." }] }],
  ]);
  return withWorker(async (worker) => {
    await worker.request("/api/auth/start", {});
    const connected = Date.now() + 15_000;
    while (!(await worker.json<{ authenticated: boolean }>("/api/status")).authenticated) {
      assert.ok(Date.now() < connected, "The device login did not complete");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const refused = await worker.request("/api/chat", {
      text: "And this?",
      images: [{ mimeType: "image/tiff", data: "AAAA" }],
    });
    assert.equal(refused.status, 400);
    const { id } = await worker.json<{ id: number }>("/api/chat", {
      text: "What is this?",
      images: [{ mimeType: "image/png", data: pixel }],
    });
    const deadline = Date.now() + 15_000;
    let turn = await worker.json<{ status: string; text: string }>(`/api/turns/${id}`);
    while (turn.status === "pending") {
      assert.ok(Date.now() < deadline, "The turn did not finish");
      await new Promise((resolve) => setTimeout(resolve, 200));
      turn = await worker.json<{ status: string; text: string }>(`/api/turns/${id}`);
    }
    assert.equal(turn.text, "A single red pixel.");
    assert.ok(await (await worker.bucket()).get(pixelKey), "The image was not stored");
    const sent = backend.masterRequests.map((request) => JSON.stringify(request.input));
    const seen = (text: string | undefined) =>
      (text ?? "").split(`data:image/png;base64,${pixel}`).length - 1;
    // With its message, then again after look, with the message resent.
    assert.deepEqual(sent.map(seen), [1, 2]);
    assert.ok(sent[0]?.includes(JSON.stringify(`What is this?\n[image ${pixelKey}]`).slice(1, -1)));
    // Turn state keeps only where each image is stored.
    assert.ok(!sent.some((text) => text.includes('"r2:')));
  }, backend.outbound);
});

test("a node runs an approved task through reviews, reconnects, recovery, and one report", () =>
  withWorker(async (worker) => {
    await worker.remember("Remember the blue server");
    const node = await worker.json<{ key: string }>("/api/nodes", {
      name: "test-node",
      roots: ["/tmp"],
      tools: ["read"],
    });
    const first = await worker.connectNode(node.key);
    assert.equal((await first.next()).type, "registered");
    const job = await worker.json<{ id: string; status: string }>("/api/jobs", {
      machine: "test-node",
      cwd: "/tmp",
      task: "Read a file",
    });
    assert.equal(job.status, "approval");
    assert.equal(
      (await worker.json<{ status: string }>(`/api/jobs/${job.id}/approve`, {})).status,
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
    const ledger = await worker.json<{
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
    const [review] = await worker.json<{ message: string }[]>("/api/permissions");
    assert.equal(review?.message, 'write /tmp/note.txt: "Reviewed note"');
    const nodeDecision = await worker.fetch(`/api/permissions/${job.id}/write-a-note`, {
      method: "POST",
      headers: { authorization: `Bearer ${node.key}`, "content-type": "application/json" },
      body: JSON.stringify({ allowed: true }),
    });
    assert.equal(nodeDecision.status, 401);
    const denied = await worker.json<{ allowed: boolean }>(
      `/api/permissions/${job.id}/write-a-note`,
      { allowed: false },
    );
    assert.equal(denied.allowed, false);
    assert.equal((await first.next())["allowed"], false);
    first.send({ type: "permission_received", job: job.id, id: "write-a-note" });
    const changed = await worker.json<{ allowed: boolean }>(
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
    await worker.request(`/api/permissions/${job.id}/write-a-plan`, { allowed: true });
    assert.equal((await first.next())["allowed"], true);
    first.close();

    const second = await worker.connectNode(node.key);
    assert.equal((await second.next()).type, "registered");
    second.send({ type: "node_ready" });
    let permission = await second.next();
    while (permission.type !== "permission") permission = await second.next();
    assert.equal(permission["id"], "write-a-plan");
    second.send({ type: "permission_received", job: job.id, id: "write-a-plan" });
    second.close();

    const third = await worker.connectNode(node.key);
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
    assert.equal((await worker.json<unknown[]>("/api/permissions")).length, 0);
    const expired = await worker.json<{ state: string }>(`/api/permissions/${job.id}/later-call`, {
      allowed: true,
    });
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
    const [fresh] = await worker.json<{ request: string }[]>("/api/permissions");
    assert.equal(fresh?.request, "fresh-call");

    third.send({ type: "report", id: job.id, status: "done", report: "Read the requested file." });
    third.send({ type: "report", id: job.id, status: "done", report: "Duplicate delivery" });
    assert.equal((await third.next()).type, "ack");
    assert.equal((await worker.json<unknown[]>("/api/permissions")).length, 0);
    assert.equal(
      (await worker.request(`/api/permissions/${job.id}/fresh-call`, { allowed: true })).status,
      400,
    );
    const bucket = await worker.bucket();
    const audits = await bucket.list({ prefix: `audit/${job.id}/` });
    const auditEvents = await Promise.all(
      audits.objects.map(
        async (object) =>
          JSON.parse((await (await bucket.get(object.key))?.text()) ?? "{}") as Event,
      ),
    );
    assert.ok(
      auditEvents.some(
        (event) =>
          event["action"] === "tool-denied" &&
          (event["message"] as Event | null)?.["request"] === "write-a-note",
      ),
    );
    assert.equal((await third.next()).type, "ack");
    assert.equal((await worker.json<{ pending: number }>("/api/status")).pending, 1);
    const overwrite = await worker.fetch("/node/transcript?session=someone-else", {
      method: "PUT",
      headers: { authorization: `Bearer ${node.key}` },
      body: "Cannot overwrite another session",
    });
    assert.equal(overwrite.status, 403);
    assert.equal((await worker.json<{ cancelled: number }>("/api/cancel", {})).cancelled, 1);
    const messages = await worker.json<{ text: string }[]>("/api/messages");
    assert.ok(messages.some((message) => message.text.includes("Read the requested file.")));
    third.close();
  }));

test("a scheduled prompt fires through the Durable Object alarm and queues one note", () =>
  withWorker(async (worker) => {
    const scheduled = await worker.json<{ id: number }>("/api/schedules", {
      prompt: "Review the open questions in memory.",
      at: new Date(Date.now() + 500).toISOString(),
      every_minutes: 0,
    });
    let fired: { id: number; last_fired: number | null; enabled: number } | undefined;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const schedules =
        await worker.json<{ id: number; last_fired: number | null; enabled: number }[]>(
          "/api/schedules",
        );
      fired = schedules.find((item) => item.id === scheduled.id);
      if (fired?.last_fired !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(
      fired && fired.last_fired !== null,
      "The native Durable Object alarm did not fire within five seconds",
    );
    assert.equal(fired.enabled, 0);
    assert.equal((await worker.json<{ pending: number }>("/api/status")).pending, 1);
    await worker.request("/api/cancel", {});
    const messages = await worker.json<{ text: string; kind: string }[]>("/api/messages");
    const note = messages.find((message) => message.text.includes(`[Scheduled ${scheduled.id},`));
    assert.equal(note?.kind, "note");
  }));

test("a node ingests its own hand-run recording once, after uploading the transcript", () =>
  withWorker(async (worker) => {
    const node = await worker.json<{ key: string }>("/api/nodes", {
      name: "test-node",
      roots: ["/tmp"],
      tools: ["read"],
    });
    const nodeRequest = (path: string, body: unknown) =>
      worker.fetch(path, {
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
    const transcript = await worker.fetch(
      "/node/transcript?session=live/test-node/codex/hand-run",
      {
        method: "PUT",
        headers: { authorization: `Bearer ${node.key}` },
        body: '{"line":1,"event":{"type":"session"}}\n{"line":8,"event":{"text":"Keep the source timestamps."}}\n{"line":12,"event":{"text":"Timestamps retained."}}\n',
      },
    );
    assert.equal(transcript.status, 200);
    assert.equal(
      (await read<{ appended: number }>(await nodeRequest("/node/ingest", body))).appended,
      2,
    );
    assert.equal(
      (await read<{ appended: number }>(await nodeRequest("/node/ingest", body))).appended,
      0,
    );
    const messages = await worker.json<{ text: string; date: string }[]>("/api/messages");
    const original = messages.find((message) => message.text === "Keep the source timestamps.");
    assert.equal(original?.date, "2026-10-01T10:00:00Z");
    const sourceText = (
      await worker.json<{ text: string }>("/api/transcript?session=codex/hand-run&start=8&count=5")
    ).text;
    assert.match(sourceText, /Keep the source timestamps/);
    assert.match(sourceText, /Timestamps retained/);
    assert.doesNotMatch(sourceText, /"type":"session"/);
  }));

test("a chat turn is private to the owner and reports its own status", () =>
  withWorker(async (worker) => {
    const chat = await worker.request("/api/chat", {
      text: "Keep this terminal message in its own turn.",
    });
    const queued = await read<{ id: number }>(chat);
    assert.equal(chat.status, 202);
    assert.deepEqual(await worker.json(`/api/turns/${queued.id}`), {
      id: queued.id,
      replyId: queued.id,
      status: "pending",
      text: "",
      steps: [],
    });
    assert.equal((await worker.fetch(`/api/turns/${queued.id}`)).status, 401);
    assert.equal((await worker.request("/api/turns/999999")).status, 404);
    // Imported history waits, so it never lands between the steps of a live turn.
    const history = {
      messages: [{ kind: "user", text: "An old message", session: "old", index: 0 }],
    };
    assert.equal((await worker.request("/api/import", history)).status, 409);
    await worker.request("/api/cancel", {});
    assert.equal(
      (await worker.json<{ status: string }>(`/api/turns/${queued.id}`)).status,
      "cancelled",
    );
    assert.equal((await worker.request("/api/import", history)).status, 200);
    const status = await worker.json<{ unsummarized: number }>("/api/status");
    assert.equal(typeof status.unsummarized, "number");
  }));

test("model calls go through a node the owner allowed, never from the cloud", () => {
  const backend = fakeSubscription([]);
  return withWorker(async (worker) => {
    // A node that only claims to serve models sees no prompts and writes no turns.
    const other = await worker.json<{ key: string }>("/api/nodes", {
      name: "other",
      roots: ["/tmp"],
    });
    const claimant = await worker.connectNode(other.key);
    assert.equal((await claimant.next()).type, "registered");
    claimant.send({ type: "node_ready", models: true });
    assert.equal((await claimant.next()).type, "ready");
    assert.equal(
      (await worker.request("/api/nodes/sandbox/models", { allowed: true })).status,
      400,
    );
    const { key } = await worker.json<{ key: string }>("/api/nodes", {
      name: "laptop",
      roots: ["/tmp"],
      tools: ["read"],
    });
    assert.equal((await worker.request("/api/nodes/laptop/models", { allowed: true })).status, 200);
    const node = await worker.connectNode(key);
    assert.equal((await node.next()).type, "registered");
    node.send({ type: "node_ready", models: true });
    assert.equal((await node.next()).type, "ready");
    const machines =
      await worker.json<{ name: string; models: boolean; serving: boolean }[]>("/api/nodes");
    const state = (name: string) => machines.find((machine) => machine.name === name);
    assert.deepEqual(
      [state("other")?.serving, state("laptop")?.models, state("laptop")?.serving],
      [false, true, true],
    );
    await worker.request("/api/auth/start", {});
    const connected = Date.now() + 15_000;
    while (!(await worker.json<{ authenticated: boolean }>("/api/status")).authenticated) {
      assert.ok(Date.now() < connected, "The device login did not complete");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await worker.request("/api/import", {
      messages: [{ kind: "user", text: "Keep the decision. ".repeat(60), session: "s", index: 1 }],
    });
    // A failed call waits for its retry, which comes back to the node by itself.
    const failed = await node.next();
    assert.equal(failed.type, "model_request");
    node.send({
      type: "model_result",
      id: failed["id"],
      error: "ChatGPT subscription request failed (429)",
    });
    const call = await node.next();
    assert.equal(call.type, "model_request");
    const request = call["request"] as { model: string; effort: string; cacheKey: string };
    assert.deepEqual(
      [request.model, request.effort, request.cacheKey],
      ["gpt-6-luna", "high", "optchat"],
    );
    const text = "user: Keep the decision";
    node.send({
      type: "model_result",
      id: call["id"],
      result: {
        text,
        output: [{ type: "message", content: [{ type: "output_text", text }] }],
        usage: { input_tokens: 10 },
        quota: { "x-codex-primary-used-percent": "19" },
      },
    });
    const settled = Date.now() + 15_000;
    while (!(await worker.json<{ settled: boolean }>("/api/status")).settled) {
      assert.ok(Date.now() < settled, "The relayed summary was not saved");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.match(
      (await worker.json<{ text: string }>("/api/view")).text,
      /0\+1\|user: Keep the decision/,
    );
    assert.equal(backend.compactRequests.length, 0);
    const usage = await worker.json<{
      calls: { purpose: string; source: string; quota: Record<string, string> }[];
    }>("/api/usage");
    assert.equal(usage.calls[0]?.purpose, "compact");
    assert.equal(usage.calls[0]?.source, "laptop");
    assert.equal(usage.calls[0]?.quota["x-codex-primary-used-percent"], "19");
    // Revoking takes effect at once, on the connected node too.
    assert.equal(
      (await worker.request("/api/nodes/laptop/models", { allowed: false })).status,
      200,
    );
    await worker.request("/api/import", {
      messages: [{ kind: "user", text: "A later decision. ".repeat(60), session: "s", index: 2 }],
    });
    const direct = Date.now() + 15_000;
    while (!(await worker.json<{ settled: boolean }>("/api/status")).settled) {
      assert.ok(Date.now() < direct, "The summary after revoking was not saved");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(backend.compactRequests.length, 1);
  }, backend.outbound);
});

test("a chat turn answers while the compactor is stuck, naming the line it could not read", () => {
  const backend = fakeSubscription([]);
  return withWorker(async (worker) => {
    const { key } = await worker.json<{ key: string }>("/api/nodes", {
      name: "laptop",
      roots: ["/tmp"],
      tools: ["read"],
    });
    await worker.request("/api/nodes/laptop/models", { allowed: true });
    const node = await worker.connectNode(key);
    assert.equal((await node.next()).type, "registered");
    node.send({ type: "node_ready", models: true });
    assert.equal((await node.next()).type, "ready");
    await worker.request("/api/auth/start", {});
    const connected = Date.now() + 15_000;
    while (!(await worker.json<{ authenticated: boolean }>("/api/status")).authenticated) {
      assert.ok(Date.now() < connected, "The device login did not complete");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await worker.request("/api/import", {
      messages: [{ kind: "note", text: "Keep the decision. ".repeat(60), session: "s", index: 1 }],
    });
    // The node takes the compaction and never answers it.
    const held = await node.next();
    assert.equal(held.type, "model_request");
    const asked = Date.now();
    const { id } = await worker.json<{ id: number }>("/api/chat", { text: "What did we decide?" });
    const call = await node.next();
    assert.equal(call.type, "model_request");
    assert.ok(Date.now() - asked < 15_000, "The turn waited past its bound");
    const request = call["request"] as { model: string; input: { content: { text: string }[] }[] };
    assert.equal(request.model, "gpt-6.1-sol");
    assert.match(
      request.input[0]?.content[0]?.text ?? "",
      /^<chat>\n0\+1\|\(not summarized yet: note, 1140 bytes; zoom\(0, 1\) reads it\)\n<\/chat>$/,
    );
    const text = "Opening line 0 would tell me.";
    node.send({
      type: "model_result",
      id: call["id"],
      result: {
        text,
        output: [{ type: "message", content: [{ type: "output_text", text }] }],
        usage: {},
        quota: {},
      },
    });
    const deadline = Date.now() + 15_000;
    let turn = await worker.json<{ status: string; text: string }>(`/api/turns/${id}`);
    while (turn.status === "pending") {
      assert.ok(Date.now() < deadline, "The turn did not finish");
      await new Promise((resolve) => setTimeout(resolve, 200));
      turn = await worker.json<{ status: string; text: string }>(`/api/turns/${id}`);
    }
    assert.deepEqual([turn.status, turn.text], ["done", text]);
    assert.equal(held["id"] === call["id"], false);
  }, backend.outbound);
});

/** A computer's T3 Code: its OAuth sign-in and the MCP tools the Master calls. */
function fakeT3() {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  let challenge = "";
  let launches = 0;
  const origin = "https://t3.example.test";
  const sse = (id: unknown, result: unknown, headers: Record<string, string> = {}) =>
    new WorkerResponse(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`,
      {
        headers: { "content-type": "text/event-stream", ...headers },
      },
    );
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
  const outbound = async (request: WorkerRequest): Promise<WorkerResponse> => {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return WorkerResponse.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return WorkerResponse.json({
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/mcp/authorize`,
        token_endpoint: `${origin}/oauth/mcp/token`,
        registration_endpoint: `${origin}/oauth/mcp/register`,
      });
    }
    if (url.pathname === "/oauth/mcp/register") {
      const body = (await request.json()) as { redirect_uris: string[] };
      assert.deepEqual(body.redirect_uris, ["https://example.test/oauth/t3/callback"]);
      return WorkerResponse.json({ client_id: "client-1", redirect_uris: body.redirect_uris });
    }
    if (url.pathname === "/oauth/mcp/token") {
      const form = new URLSearchParams(await request.text());
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(form.get("code_verifier") ?? ""),
      );
      const expected = Buffer.from(digest).toString("base64url");
      if (form.get("code") !== "approved" || expected !== challenge) {
        return WorkerResponse.json({ error: "invalid_grant" }, { status: 400 });
      }
      return WorkerResponse.json({ access_token: "t3-token", expires_in: 2_592_000 });
    }
    if (url.pathname === "/mcp") {
      if (request.headers.get("authorization") !== "Bearer t3-token") {
        return new WorkerResponse("{}", { status: 401 });
      }
      const message = (await request.json()) as {
        id?: string;
        method: string;
        params: { name: string; arguments: Record<string, unknown> };
      };
      if (message.method === "initialize") return sse(message.id, {}, { "mcp-session-id": "s1" });
      if (message.method.startsWith("notifications/"))
        return new WorkerResponse(null, { status: 202 });
      assert.equal(request.headers.get("mcp-session-id"), "s1");
      calls.push(message.params);
      const result = tool(message.params.name);
      return sse(message.id, { structuredContent: result, content: [] });
    }
    return new WorkerResponse("Not mocked", { status: 599 });
  };
  return {
    calls,
    outbound,
    approve: (authorize: string) => {
      challenge = new URL(authorize).searchParams.get("code_challenge") ?? "";
    },
  };
}

/** The owner signs the Master in to the laptop's T3 Code, as the callback page finishes it. */
async function signInT3(worker: TestWorker, t3: ReturnType<typeof fakeT3>): Promise<void> {
  const { authorize } = await worker.json<{ authorize: string }>("/api/computers", {
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
    ["client-1", "https://example.test/oauth/t3/callback", "S256"],
  );
  assert.equal(params.get("scope"), "orchestration:read orchestration:operate");
  t3.approve(authorize);
  const callback = `/oauth/t3/callback?code=approved&state=${params.get("state")}&iss=https://t3.example.test`;
  const signedIn = await worker.fetch(callback);
  assert.equal(signedIn.status, 200);
  assert.match(await signedIn.text(), /can now reach laptop/);
  // The state is single-use, and the route needs no owner key.
  assert.equal((await worker.fetch(callback)).status, 400);
  const [computer] = await worker.json<{ name: string; connected: boolean }[]>("/api/computers");
  assert.deepEqual([computer?.name, computer?.connected], ["laptop", true]);
}

/** The Master's own subscription login, against the fake backend. */
async function signInMaster(worker: TestWorker): Promise<void> {
  await worker.request("/api/auth/start", {});
  const connected = Date.now() + 15_000;
  while (!(await worker.json<{ authenticated: boolean }>("/api/status")).authenticated) {
    assert.ok(Date.now() < connected, "The device login did not complete");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
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
    [{ type: "message", content: [{ type: "output_text", text: "Started Fix tests on laptop." }] }],
    [
      {
        type: "message",
        content: [{ type: "output_text", text: "**Fix tests is done.**\nAll pass." }],
      },
    ],
    [{ type: "message", content: [{ type: "output_text", text: "QUIET" }] }],
  ]);
  const outbound: Outbound = (request) =>
    new URL(request.url).hostname === "t3.example.test"
      ? t3.outbound(request)
      : backend.outbound(request);
  return withWorker(async (worker) => {
    await signInT3(worker, t3);
    await worker.request("/api/instructions", { text: " Call me Sam. " }, "PUT");
    assert.deepEqual(await worker.json("/api/instructions"), { text: "Call me Sam." });

    await signInMaster(worker);
    const { id } = await worker.json<{ id: number }>("/api/chat", {
      text: "Fix the failing tests in optchat on my laptop",
    });
    const deadline = Date.now() + 20_000;
    while (backend.masterRequests.length < 3) {
      assert.ok(Date.now() < deadline, "The thread's report did not start a turn");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const turn = await worker.json<{ text: string; steps: { kind: string; text: string }[] }>(
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
    const messages = await worker.json<{ kind: string; text: string }[]>("/api/messages");
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
    while (posts().length < 1) {
      assert.ok(Date.now() < deadline, "The reply to the report was not posted");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
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
      (await worker.json<{ text: string }>(`/api/turns/${posted}`)).text,
      "**Fix tests is done.**\nAll pass.",
    );

    // A schedule's turn that needs nothing from the owner stays off the phone.
    await worker.request("/api/schedules", {
      prompt: "Check on the threads",
      at: new Date(Date.now() + 300).toISOString(),
    });
    while (
      backend.masterRequests.length < 4 ||
      (await worker.json<{ pending: number }>("/api/status")).pending
    ) {
      assert.ok(Date.now() < deadline, "The scheduled turn did not run");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(posts().length, 1);
    // The posted thread is not watched, so its end never comes back as a turn.
    assert.equal(backend.masterRequests.length, 4);
  }, outbound);
});

test("the Master hires a named helper and gives it jobs in its own thread", () => {
  const t3 = fakeT3();
  const call = (name: string, id: string, args: Record<string, unknown>) => [
    { type: "function_call", name, call_id: id, arguments: JSON.stringify(args) },
  ];
  const say = (text: string) => [{ type: "message", content: [{ type: "output_text", text }] }];
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
  const outbound: Outbound = (request) =>
    new URL(request.url).hostname === "t3.example.test"
      ? t3.outbound(request)
      : backend.outbound(request);
  return withWorker(async (worker) => {
    await signInT3(worker, t3);
    await signInMaster(worker);
    await worker.json("/api/chat", { text: "Hire a reviewer on my laptop and have it review." });
    const deadline = Date.now() + 20_000;
    // The helper's thread reports back as a turn of its own.
    while (backend.masterRequests.length < 4) {
      assert.ok(Date.now() < deadline, "The helper's report did not start a turn");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
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
      (await worker.json<{ name: string; thread: string; auto: boolean }[]>("/api/helpers")).map(
        ({ name, thread, auto }) => [name, thread, auto],
      ),
      [["reviewer", "th1", false]],
    );
    assert.match(
      JSON.stringify(backend.masterRequests[3]?.input),
      /\[laptop: Fix tests\] completed/,
    );

    // A fresh start begins a new thread from the helper's jobs and the report that came back.
    await worker.json("/api/chat", { text: "Give the reviewer a fresh start and review again." });
    const launches = () => t3.calls.filter((entry) => entry.name === "t3_thread_launch");
    while (launches().length < 2) {
      assert.ok(Date.now() < deadline, "The fresh thread did not start");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.match(
      String(launches()[1]?.arguments["message"]),
      /<history>\nJob: Review the last commit\.\nResult: \[laptop: Fix tests\] completed: All tests pass now\.\n<\/history>\n\nReview it again\.$/,
    );
  }, outbound);
});

test("the Master moves to a local Master with its memory, settings, schedules and transcripts", () =>
  withWorker(async (worker) => {
    await worker.remember("The owner keeps a lighthouse logbook");
    await worker.upload("moved-1", '{"line":1,"event":{"text":"from the cloud"}}\n');
    await worker.json("/api/instructions", { text: "Be brief." }, "PUT");
    await worker.json("/api/schedules", {
      prompt: "Check the logbook.",
      at: new Date(Date.now() + 86_400_000).toISOString(),
      every_minutes: 0,
    });
    assert.equal((await worker.fetch("/api/export/schema")).status, 401);

    assert.deepEqual(await worker.json("/api/export/park", {}), { moved: true });
    assert.equal((await worker.request("/api/status")).status, 410);
    const download = await worker.request("/api/export/object?key=sessions/moved-1.jsonl");
    assert.equal(download.headers.get("content-disposition"), "attachment");
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    await download.arrayBuffer();
    const target = join(worker.directory, "local");
    const lines: string[] = [];
    // Miniflare's responses carry the same fields the move reads from fetch's.
    const get = (path: string) => worker.request(path) as unknown as Promise<Response>;
    const moved = await moveToLaptop(get, target, (line) => lines.push(line));
    assert.equal(moved.objects, 1);
    assert.equal(moved.tables["messages"], 1);
    await assert.rejects(
      moveToLaptop(get, target, () => {}),
      /already exists/,
    );
    assert.deepEqual(await worker.json("/api/export/unpark", {}), { moved: false });
    assert.equal((await worker.request("/api/status")).status, 200);

    const local = await startMaster({
      directory: target,
      ownerKey: OWNER,
      port: 0,
      config: {
        masterModel: "gpt-6.1-sol",
        compactorModel: "gpt-6-luna",
        compactorEffort: "high",
        timezone: "Europe/Helsinki",
      },
      callModel: async () => modelReply("unused"),
    });
    try {
      const owner = { headers: { authorization: `Bearer ${OWNER}` } };
      const read = async <T>(path: string) =>
        (await (await fetch(local.url + path, owner)).json()) as T;
      assert.deepEqual(
        (await read<{ text: string }[]>("/api/messages")).map((message) => message.text),
        ["The owner keeps a lighthouse logbook"],
      );
      assert.equal((await read<unknown[]>("/api/search?q=lighthouse")).length, 1);
      assert.deepEqual(await read("/api/instructions"), { text: "Be brief." });
      assert.equal(
        (await read<{ prompt: string }[]>("/api/schedules"))[0]?.prompt,
        "Check the logbook.",
      );
      assert.match(
        (await read<{ text: string }>("/api/transcript?session=moved-1&start=1&count=1")).text,
        /from the cloud/,
      );
    } finally {
      await local.close();
    }
  }));

test("the inbox keeps the owner's messages until the local Master takes each one", () =>
  withWorker(async (worker) => {
    assert.equal((await worker.fetch("/api/inbox")).status, 401);
    assert.match(await (await worker.fetch("/")).text(), /OptChat inbox/);
    const away = await worker.json<{ id: string; connected: boolean }>("/api/inbox", {
      text: " Book the dentist. ",
    });
    assert.equal(away.connected, false);
    assert.equal((await worker.request("/api/inbox", { text: " " })).status, 400);

    const refused = await worker.fetch("/master/inbox", { headers: { upgrade: "websocket" } });
    assert.equal(refused.status, 401);
    const upgrade = await worker.fetch("/master/inbox", {
      headers: { upgrade: "websocket", authorization: `Bearer ${OWNER}` },
    });
    assert.equal(upgrade.status, 101);
    assert.ok(upgrade.webSocket);
    const frames: string[] = [];
    let arrived: (() => void) | null = null;
    upgrade.webSocket.addEventListener("message", (event) => {
      frames.push(String(event.data));
      arrived?.();
    });
    upgrade.webSocket.accept();
    const next = async (): Promise<string> => {
      while (!frames.length) await new Promise<void>((resolve) => (arrived = resolve));
      return frames.shift() ?? "";
    };
    const waiting = JSON.parse(await next()) as Record<string, unknown>;
    assert.deepEqual(
      { ...waiting, sent: typeof waiting["sent"] },
      { type: "message", id: away.id, text: "Book the dentist.", sent: "string" },
    );
    upgrade.webSocket.send("ping");
    assert.equal(await next(), "pong");
    upgrade.webSocket.send(JSON.stringify({ type: "delivered", id: away.id, turn: 7 }));

    // With the laptop connected, a new message goes straight to it.
    const live = await worker.json<{ id: string; connected: boolean }>("/api/inbox", {
      text: "And the vet.",
    });
    assert.equal(live.connected, true);
    assert.equal((JSON.parse(await next()) as { id: string }).id, live.id);
    const listed = await worker.json<{
      connected: boolean;
      messages: { id: string; turn: number | null; delivered: string | null }[];
    }>("/api/inbox");
    assert.equal(listed.connected, true);
    assert.deepEqual(
      listed.messages.map(({ id, turn, delivered }) => [id, turn, typeof delivered]),
      [
        [live.id, null, "object"],
        [away.id, 7, "string"],
      ],
    );
    upgrade.webSocket.close();
  }));

test("the local Master's backup goes to R2 whole or in parts, and only snapshots are deleted", () =>
  withWorker(async (worker) => {
    const put = (path: string, body: Buffer) =>
      worker.fetch(path, {
        method: "PUT",
        headers: { authorization: `Bearer ${OWNER}`, "content-length": String(body.length) },
        body,
      });
    assert.equal((await worker.fetch("/backup/list")).status, 401);
    assert.equal(
      (await put("/backup/object?key=sessions/a.jsonl", Buffer.from("one\n"))).status,
      200,
    );
    assert.equal((await put("/backup/object?key=../escape", Buffer.from("x"))).status, 400);

    const key = "snapshots/master-2026-10-24.sqlite.gz";
    const { upload } = await worker.json<{ upload: string }>(`/backup/multipart?key=${key}`, {});
    const first = Buffer.alloc(5 * 1024 * 1024, "a");
    const parts = [];
    for (const [number, body] of [first, Buffer.from("end")].entries()) {
      const response = await put(
        `/backup/part?key=${key}&upload=${encodeURIComponent(upload)}&number=${number + 1}`,
        body,
      );
      assert.equal(response.status, 200, await response.clone().text());
      parts.push(await read<{ partNumber: number; etag: string }>(response));
    }
    const done = await worker.json<{ size: number }>(
      `/backup/complete?key=${key}&upload=${encodeURIComponent(upload)}`,
      { parts },
    );
    assert.equal(done.size, first.length + 3);
    const listed = await worker.json<{ objects: { key: string; size: number }[] }>("/backup/list");
    assert.deepEqual(listed.objects, [
      { key: "sessions/a.jsonl", size: 4 },
      { key, size: first.length + 3 },
    ]);
    assert.equal(
      (await worker.request("/backup/object?key=sessions/a.jsonl", undefined, "DELETE")).status,
      400,
    );
    assert.equal(
      (await worker.request(`/backup/object?key=${key}`, undefined, "DELETE")).status,
      200,
    );
  }));

test("a message left in the Worker's inbox reaches the local Master when it connects", () =>
  withWorker(async (worker) => {
    const left = await worker.json<{ id: string }>("/api/inbox", { text: "Book the dentist." });
    const directory = join(worker.directory, "local");
    const local = await startMaster({
      directory,
      ownerKey: OWNER,
      port: 0,
      config: {
        masterModel: "gpt-6.1-sol",
        compactorModel: "gpt-6-luna",
        compactorEffort: "high",
        timezone: "Europe/Helsinki",
      },
      callModel: async () => modelReply("Booked for Monday."),
      inbox: {
        url: (await worker.runtime.ready).origin,
        headers: { authorization: `Bearer ${OWNER}` },
        log: () => {},
      },
    });
    try {
      const listed = () =>
        worker.json<{ connected: boolean; messages: { id: string; turn: number | null }[] }>(
          "/api/inbox",
        );
      const deadline = Date.now() + 10_000;
      let inbox = await listed();
      while (inbox.messages[0]?.turn == null) {
        assert.ok(Date.now() < deadline, "The local Master did not take the message");
        await new Promise((resolve) => setTimeout(resolve, 100));
        inbox = await listed();
      }
      assert.equal(inbox.connected, true);
      assert.equal(inbox.messages[0]?.id, left.id);
      const turn = inbox.messages[0].turn;
      const owner = { headers: { authorization: `Bearer ${OWNER}` } };
      let reply = { status: "pending", text: "" };
      while (reply.status === "pending") {
        assert.ok(Date.now() < deadline, "The turn did not finish");
        await new Promise((resolve) => setTimeout(resolve, 100));
        reply = (await (await fetch(`${local.url}/api/turns/${turn}`, owner)).json()) as {
          status: string;
          text: string;
        };
      }
      assert.equal(reply.text, "Booked for Monday.");
    } finally {
      await local.close();
    }
  }));

test("the local Master backs up a snapshot and its changed files to R2 through the Worker", () =>
  withWorker(async (worker) => {
    const directory = join(worker.directory, "local");
    const bucket = join(directory, "bucket");
    mkdirSync(join(bucket, "sessions"), { recursive: true });
    mkdirSync(join(bucket, ".uploads", "u1"), { recursive: true });
    writeFileSync(join(bucket, "sessions", "old.jsonl"), "moved\n");
    writeFileSync(join(bucket, "sessions", "new.jsonl"), "new\n");
    writeFileSync(join(bucket, "sessions", "big.jsonl"), Buffer.alloc(33 * 1024 * 1024, "b"));
    writeFileSync(join(bucket, ".uploads", "u1", "1"), "unfinished");
    writeFileSync(
      join(bucket, "sessions", "a.jsonl.0d9a6c1e-2b7f-4c1a-9e0b-6f2d3a4b5c6d.part"),
      "x",
    );
    const r2 = await worker.bucket();
    // Moved from the cloud already, at the same size.
    await r2.put("sessions/old.jsonl", "moved\n");
    for (const day of ["01", "02", "03", "04", "05", "06", "07", "08"]) {
      await r2.put(`snapshots/master-2026-10-${day}.sqlite.gz`, "old");
    }
    const database = openDatabase(join(directory, "master.sqlite"));
    database.exec("CREATE TABLE notes (text TEXT)");
    database.exec("INSERT INTO notes VALUES ('kept')");
    const remote = workerBucket((await worker.runtime.ready).origin, {
      authorization: `Bearer ${OWNER}`,
    });
    const options = {
      snapshot: (target: string) => database.exec("VACUUM INTO ?", target),
      bucket,
      directory,
      remote,
      log: () => {},
    };
    try {
      const first = await backUp({ ...options, date: "2026-10-24" });
      assert.deepEqual([first.files, first.bytes], [2, 4 + 33 * 1024 * 1024]);
      const keys = async () => (await r2.list({ prefix: "" })).objects.map(({ key }) => key);
      assert.deepEqual(await keys(), [
        "sessions/big.jsonl",
        "sessions/new.jsonl",
        "sessions/old.jsonl",
        "snapshots/master-2026-10-03.sqlite.gz",
        "snapshots/master-2026-10-04.sqlite.gz",
        "snapshots/master-2026-10-05.sqlite.gz",
        "snapshots/master-2026-10-06.sqlite.gz",
        "snapshots/master-2026-10-07.sqlite.gz",
        "snapshots/master-2026-10-08.sqlite.gz",
        "snapshots/master-2026-10-24.sqlite.gz",
      ]);
      // The snapshot restores to the database it was taken from.
      const packed = (await r2.get("snapshots/master-2026-10-24.sqlite.gz")) as unknown as {
        arrayBuffer(): Promise<ArrayBuffer>;
      };
      const restored = join(directory, "restored.sqlite");
      writeFileSync(restored, gunzipSync(Buffer.from(await packed.arrayBuffer())));
      const copy = openDatabase(restored);
      assert.deepEqual(
        copy.rows<{ text: string }>("SELECT text FROM notes").map((row) => row.text),
        ["kept"],
      );
      copy.close();
      const big = await r2.get("sessions/big.jsonl");
      assert.equal((await big?.text())?.length, 33 * 1024 * 1024);

      writeFileSync(join(bucket, "sessions", "new.jsonl"), "new, and longer\n");
      const second = await backUp({ ...options, date: "2026-10-25" });
      assert.deepEqual([second.files, second.bytes], [1, 16]);
      assert.equal(await (await r2.get("sessions/new.jsonl"))?.text(), "new, and longer\n");
    } finally {
      database.close();
    }
  }));
