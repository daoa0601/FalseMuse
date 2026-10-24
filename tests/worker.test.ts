import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { Miniflare, type MiniflareOptions } from "miniflare";

import { startMaster } from "../node/local-master.ts";
import { runCode } from "../node/code-runner.ts";
import { backUp, workerBucket } from "../node/backup.ts";
import { openDatabase } from "../node/sqlite.ts";
import { modelReply } from "./support.ts";

const OWNER = "test-owner";

/** Test responses are JSON from our own Worker; assertions check the fields they read. */
async function read<T>(response: Response | { json(): Promise<unknown> }): Promise<T> {
  return (await response.json()) as T;
}

function options(directory: string): MiniflareOptions {
  const built: unknown = JSON.parse(
    readFileSync(".cloudflare/output/v0/workers/default/worker.config.json", "utf8"),
  );
  return {
    resourcePersistencePath: directory,
    workers: [
      {
        config: {
          ...(built as object),
          exports: { Inbox: { type: "durable-object", storage: "sqlite" } },
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
            TRANSCRIPTS: { type: "r2", name: "transcripts" },
            OWNER_KEY: { type: "text", value: OWNER },
          },
        },
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

/** The Worker on the local runtime with persistent storage. */
class TestWorker {
  readonly directory = mkdtempSync(join(tmpdir(), "optchat-worker-"));
  readonly runtime = new Miniflare(options(this.directory));

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

  async bucket(): Promise<TestBucket> {
    return (await this.runtime.getR2Bucket("TRANSCRIPTS")) as unknown as TestBucket;
  }

  async dispose(): Promise<void> {
    await this.runtime.dispose();
    rmSync(this.directory, { recursive: true });
  }
}

async function withWorker(run: (worker: TestWorker) => Promise<void>): Promise<void> {
  const worker = new TestWorker();
  try {
    await run(worker);
  } finally {
    await worker.dispose();
  }
}

test("the Worker signs the owner in to its inbox page and serves nothing of the old Master", () =>
  withWorker(async (worker) => {
    const wrongKey = await worker.fetch("/login", {
      method: "POST",
      body: new URLSearchParams({ key: "guess" }),
    });
    assert.equal(wrongKey.status, 401);
    const login = await worker.fetch("/login", {
      method: "POST",
      body: new URLSearchParams({ key: OWNER }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie") ?? "";
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    assert.doesNotMatch(cookie, new RegExp(OWNER));
    const session = { headers: { cookie: cookie.split(";")[0] ?? "" } };
    assert.equal((await worker.fetch("/api/inbox", session)).status, 200);
    assert.equal(
      (await worker.fetch("/api/inbox", { headers: { cookie: `owner=${OWNER}` } })).status,
      401,
    );
    for (const path of ["/api/status", "/api/chat", "/node/ws", "/oauth/t3/callback"]) {
      assert.equal((await worker.request(path)).status, 404, path);
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
      runCode,
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
