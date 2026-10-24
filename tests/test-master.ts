import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startMaster, type LocalMaster, type LocalMasterOptions } from "../node/local-master.ts";
import { DirectoryBucket } from "../node/bucket.ts";
import { runCode } from "../node/code-runner.ts";
import type { ModelResult, BackendRequest } from "../src/codex.ts";
import { modelReply } from "./support.ts";

export const OWNER = "test-owner";
export const REPLY = "Answered on the laptop.";

/** Test responses are JSON from the Master itself; assertions check the fields they read. */
export async function read<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

type Extra = Pick<LocalMasterOptions, "inbox">;
export type Event = Record<string, unknown> & { type?: string };

/** The node side of the Master's WebSocket, read one message at a time. */
export class NodeSocket {
  private readonly events: Event[] = [];
  private waiter: ((event: Event) => void) | null = null;
  readonly socket: WebSocket;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      // Messages the Master wrote; the tests check the fields they read.
      const value = JSON.parse(String(event.data)) as Event;
      const waiter = this.waiter;
      if (waiter) {
        this.waiter = null;
        waiter(value);
      } else this.events.push(value);
    });
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

/**
 * A local Master in a temporary directory with the local Code Mode runner. Model calls get
 * `answer`'s result, REPLY when it has none; an answer still waiting fails when the call is
 * cancelled, as a request to the backend would.
 */
export class TestMaster {
  readonly directory = mkdtempSync(join(tmpdir(), "optchat-master-"));
  readonly calls: BackendRequest[] = [];
  answer: (
    request: BackendRequest & { signal: AbortSignal },
  ) => ModelResult | Promise<ModelResult> | undefined = () => undefined;
  master: LocalMaster | undefined;
  private extra: Extra = {};

  async start(extra: Extra = this.extra): Promise<void> {
    this.extra = extra;
    this.master = await startMaster({
      ...extra,
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
        const aborted = new Promise<never>((_, reject) => {
          const fail = () => reject(new Error("The model call was cancelled"));
          if (request.signal.aborted) fail();
          request.signal.addEventListener("abort", fail, { once: true });
        });
        return (await Promise.race([this.answer(request), aborted])) ?? modelReply(REPLY);
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

  /** An owner API call: a body makes it a POST unless another method is given. */
  request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    return this.fetch(path, {
      method,
      headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** An owner API call that must succeed. */
  async json<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const response = await this.request(path, body, method);
    assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
    return read<T>(response);
  }

  /** Poll until `done` holds, failing after `seconds`. */
  async until(done: () => boolean | Promise<boolean>, what: string, seconds = 5): Promise<void> {
    const deadline = Date.now() + seconds * 1000;
    while (!(await done())) {
      assert.ok(Date.now() < deadline, what);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Poll a turn until it leaves pending. */
  async finished(id: number): Promise<{ status: string; text: string; steps: unknown[] }> {
    let turn: { status: string; text: string; steps: unknown[] } | undefined;
    await this.until(async () => {
      turn = await this.json(`/api/turns/${id}`);
      return turn?.status !== "pending";
    }, `Turn ${id} did not finish within five seconds`);
    if (!turn) throw new Error(`Turn ${id} was never read`);
    return turn;
  }

  /** Wait until every summary the memory needs is written. */
  settled(seconds = 5): Promise<void> {
    return this.until(
      async () => (await this.json<{ settled: boolean }>("/api/status")).settled,
      "The memory was not summarized",
      seconds,
    );
  }

  async stop(): Promise<void> {
    await this.master?.close();
    this.master = undefined;
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
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

  /** The Master's bucket, read and written beside it as the tests need. */
  bucket() {
    const root = join(this.directory, "bucket");
    const files = new DirectoryBucket(root);
    return {
      async text(key: string): Promise<string | null> {
        const object = await files.get(key);
        return object ? Buffer.from(await object.arrayBuffer()).toString("utf8") : null;
      },
      put: (key: string, value: string) => files.put(key, value),
      /** The keys under a directory-like prefix such as `audit/<job>/`. */
      keys(prefix: string): string[] {
        return readdirSync(join(root, prefix), { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
          .sort();
      },
    };
  }

  /** Import one short message; its free summary settles the view for spawn proposals. */
  async remember(text: string): Promise<void> {
    await this.json("/api/import", {
      messages: [{ kind: "user", text, session: "sample", index: 0 }],
      nodes: [{ level: 0, index: 0, text: `user: ${text}` }],
    });
  }

  async connectNode(key: string): Promise<NodeSocket> {
    const socket = new WebSocket(this.url.replace(/^http/, "ws") + "/node/ws", ["optchat", key]);
    const node = new NodeSocket(socket);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return node;
  }
}

export async function withMaster(
  run: (master: TestMaster) => Promise<void>,
  extra: Extra = {},
): Promise<void> {
  const master = new TestMaster();
  await master.start(extra);
  try {
    await run(master);
  } finally {
    await master.stop();
    rmSync(master.directory, { recursive: true, force: true });
  }
}
