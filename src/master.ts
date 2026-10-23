import type { SqlDatabase } from "./database.ts";
import { hasColumn } from "./database.ts";
import { Memory, isMessageKind, type NewMessage, type Part } from "./memory.ts";
import { pump, type PumpResult } from "./compact.ts";
import {
  codexCall,
  functionCall,
  isReasoningEffort,
  messageText,
  user,
  type FunctionCallOutput,
  type InputItem,
  type ModelRequest,
  type ModelResult,
  type RelayedRequest,
  type ResponseItem,
} from "./codex.ts";
import {
  startDeviceLogin,
  pollDeviceLogin,
  pollDelay,
  refreshLogin,
  type DeviceLogin,
  type OAuthCredential,
} from "./oauth.ts";
import { QUIET, SYSTEM } from "./prompts.ts";
import { isImageKey, loadImages, markedImages, saveImages, storedImage } from "./images.ts";
import { TOOLS, cap } from "./tools.ts";
import { PAGE } from "./page.ts";
import { Nodes, send } from "./nodes.ts";
import { readTranscript } from "./transcript.ts";
import { Schedules, localTime } from "./schedules.ts";
import { Recordings } from "./recordings.ts";
import { Permissions } from "./permissions.ts";
import { UsageLedger, allowsCompaction } from "./usage.ts";
import { TranscriptUploads, transcriptKey } from "./uploads.ts";
import { ModelRelay } from "./relay.ts";
import { Computers } from "./t3.ts";
import { Helpers } from "./helpers.ts";
import { UPLOAD_PART_BYTES, parseNodeMessage } from "./protocol.ts";
import { isOwner, isOwnerKey, sessionCookie, sessionToken } from "./owner.ts";
import type { MasterHost, NodeSocket } from "./host.ts";
import {
  errorMessage,
  isRecord,
  optionalString,
  parseJson,
  requireInteger,
  requireRecord,
  requireString,
} from "./json.ts";

const json = (value: unknown, status = 200): Response => Response.json(value, { status });
/** How long a new turn waits for the compactor to summarize the newest lines of its view. */
const TURN_WAIT_MS = 10_000;
/** How often watched T3 Code threads are checked. */
const POLL_MS = 30_000;
/** The owner's own instructions, read at the start of each turn. */
const INSTRUCTION_CHARS = 20_000;

/**
 * Serve the page, sign the owner in, and pass owner and node requests to the Master. Node routes
 * check their own keys.
 */
export async function serve(
  request: Request,
  ownerKey: string,
  master: { fetch(request: Request): Promise<Response> },
): Promise<Response> {
  {
    const path = new URL(request.url).pathname;
    // The OAuth redirect from a computer's T3 Code; its single-use state stands in for the owner.
    if (path.startsWith("/node/") || path === "/oauth/t3/callback") return master.fetch(request);
    if (path === "/") {
      return new Response(PAGE, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (path === "/login" && request.method === "POST") {
      const key = (await request.formData()).get("key");
      if (!(await isOwnerKey(key, ownerKey))) return json({ error: "Unauthorized" }, 401);
      return Response.json(
        { ok: true },
        { headers: { "set-cookie": sessionCookie(await sessionToken(ownerKey)) } },
      );
    }
    if (!(await isOwner(request, ownerKey))) return json({ error: "Unauthorized" }, 401);
    return master.fetch(request);
  }
}

type TurnKind = "user" | "note" | "work";

/**
 * A turn's text as the model reads it. Work reports quote what an agent or a T3 Code thread
 * wrote, so they arrive as one JSON string the system prompt treats as data.
 */
const delivered = ({ kind, text }: { kind: TurnKind; text: string }): string =>
  kind === "note" ? `note: ${text}` : kind === "work" ? `work: ${JSON.stringify(text)}` : text;

/** A reply's first line without Markdown marks, short enough for a notification's title. */
function headline(reply: string): string {
  const line =
    reply
      .split("\n")
      .map((text) =>
        text
          .replace(/^[\s#>*-]+/, "")
          .replace(/[*`]/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .find(Boolean) ?? "OptChat";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** The images the owner sent with a message; reports and notes carry none. */
const ownImages = ({ kind, text }: { kind: TurnKind; text: string }) =>
  kind === "user" ? markedImages(text) : [];

/** The image a look result attached, if it succeeded. */
function attachedImage(result: string): string[] {
  try {
    const value = parseJson(result);
    return isRecord(value) && isImageKey(value["attached"]) ? [value["attached"]] : [];
  } catch {
    return [];
  }
}

interface Turn {
  id: number;
  text: string;
  state: string | null;
  status: "pending" | "done" | "cancelled" | "injected";
  kind: TurnKind;
  reply_to: number | null;
}

/** A turn's durable progress: resent input, the current step's output, and tool results so far. */
interface TurnState {
  input: InputItem[];
  step: number;
  output: ResponseItem[] | null;
  cursor: number;
  results: FunctionCallOutput[];
}

function loadTurnState(text: string): TurnState {
  const value = parseJson(text);
  if (
    !isRecord(value) ||
    !Array.isArray(value["input"]) ||
    typeof value["step"] !== "number" ||
    typeof value["cursor"] !== "number" ||
    !Array.isArray(value["results"]) ||
    (value["output"] !== null && !Array.isArray(value["output"]))
  ) {
    throw new Error("A saved turn has an unreadable state");
  }
  // The Master wrote this state itself, in the shape above.
  return value as unknown as TurnState;
}

function importedMessage(value: unknown): NewMessage {
  const message = requireRecord(value, "Each imported message must be an object");
  const kind = message["kind"];
  if (!isMessageKind(kind)) throw new Error("A message needs a known kind and text");
  const session = message["session"];
  const index = message["index"];
  const timestamp = optionalString(message["timestamp"], "A message timestamp must be text");
  return {
    kind,
    text: requireString(message["text"], "A message needs a known kind and text"),
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(typeof session === "string" ? { session } : {}),
    ...(typeof index === "number" ? { index } : {}),
  };
}

function importedNode(value: unknown): Part & { text: string } {
  const node = requireRecord(value, "Each imported node must be an object");
  return {
    level: requireInteger(node["level"], "A node needs its level"),
    index: requireInteger(node["index"], "A node needs its index"),
    text: requireString(node["text"], "A node needs its text"),
  };
}

type Route = (request: Request, match: RegExpMatchArray) => Promise<Response> | Response;

/** The owner's assistant: memory, turns, nodes and computers, on whatever host runs it. */
export class Master {
  private readonly host: MasterHost;
  private readonly sql: SqlDatabase;
  private readonly memory: Memory;
  private readonly nodes: Nodes;
  private readonly permissions: Permissions;
  private readonly recordings: Recordings;
  private readonly schedules: Schedules;
  private readonly usage: UsageLedger;
  private readonly uploads: TranscriptUploads;
  private readonly relay: ModelRelay;
  private readonly computers: Computers;
  private readonly helpers: Helpers;
  private readonly routes: [string, RegExp, Route][];
  private working: Promise<void> | null = null;
  private refreshing: Promise<OAuthCredential> | null = null;
  private compacting: Promise<PumpResult> | null = null;
  private callController: AbortController | null = null;
  /** Set while a new turn waits for its view; the compactor holds merges back meanwhile. */
  private waitingTurn = false;
  /** Ends a running alarm's wait on the compactor, so new work starts at once. */
  private interrupt: (() => void) | null = null;
  private polling: Promise<void> | null = null;
  private nextPoll = 0;
  private posting: Promise<void> | null = null;

  constructor(host: MasterHost) {
    this.host = host;
    const database = host.sql;
    this.sql = database;
    this.memory = new Memory(database);
    this.nodes = new Nodes(host.sockets, database, host.bucket);
    if (host.sandbox && !this.nodes.machine("sandbox")) {
      this.nodes.register({
        name: "sandbox",
        roots: ["/workspace/repo"],
        tools: ["read", "bash", "edit", "write"],
      });
    }
    this.permissions = new Permissions(database, this.nodes);
    this.recordings = new Recordings(database, this.memory);
    database.exec(
      "CREATE TABLE IF NOT EXISTS turns (id INTEGER PRIMARY KEY, text TEXT NOT NULL, state TEXT, status TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'user', reply_to INTEGER)",
    );
    if (!hasColumn(database, "turns", "kind")) {
      database.exec("ALTER TABLE turns ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'");
    }
    if (!hasColumn(database, "turns", "reply_to")) {
      database.exec("ALTER TABLE turns ADD COLUMN reply_to INTEGER");
    }
    this.schedules = new Schedules(database);
    this.usage = new UsageLedger(database);
    this.uploads = new TranscriptUploads(database, host.bucket);
    this.relay = new ModelRelay(host.sockets, (machine) => this.nodes.servesModels(machine));
    this.computers = new Computers(database);
    this.helpers = new Helpers(database, this.computers);
    database.exec(
      "CREATE TABLE IF NOT EXISTS code_steps (call_id TEXT, step INTEGER, result TEXT, PRIMARY KEY(call_id, step))",
    );
    database.exec(
      "CREATE TABLE IF NOT EXISTS job_resumes (id TEXT PRIMARY KEY, job TEXT NOT NULL)",
    );
    this.routes = this.ownerRoutes();
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/oauth/t3/callback") return await this.finishSignIn(request);
      if (path.startsWith("/node/")) return await this.nodeRoute(request, path);
      for (const [method, pattern, route] of this.routes) {
        const match = path.match(pattern);
        if (match && (method === "*" || method === request.method))
          return await route(request, match);
      }
      return json({ error: "No such route" }, 404);
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }

  /**
   * The machine a node connection belongs to, or the response refusing it. The host upgrades the
   * request and passes the socket to `connectNode`.
   */
  nodeMachine(request: Request): string | Response {
    const machine = this.nodes.authenticate(request);
    if (!machine) return json({ error: "Invalid node key" }, 401);
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }
    return machine.name;
  }

  /** Replace the machine's connection with the one `accept` opens. */
  connectNode(machine: string, accept: () => NodeSocket): void {
    this.nodes.connect(machine, accept);
  }

  private sandbox() {
    if (!this.host.sandbox) throw new Error("This Master has no cloud Sandbox");
    return this.host.sandbox;
  }

  /** Owner routes; the Worker has already authenticated the owner. First match wins. */
  private ownerRoutes(): [string, RegExp, Route][] {
    const query = (request: Request) => new URL(request.url).searchParams;
    const body = async (request: Request) =>
      requireRecord(await request.json(), "Send a JSON object");
    return [
      ["GET", /^\/api\/sandbox$/, async () => json(await this.sandbox().status())],
      [
        "POST",
        /^\/api\/sandbox\/start$/,
        async (request) => json(await this.startSandbox(new URL(request.url).origin)),
      ],
      ["POST", /^\/api\/sandbox\/save$/, async () => json(await this.sandbox().save())],
      [
        "POST",
        /^\/api\/sandbox\/auth\/start$/,
        async () => json(await this.sandbox().startLogin()),
      ],
      [
        "POST",
        /^\/api\/schedules$/,
        async (request) => {
          const schedule = this.schedules.create(await request.json());
          await this.wake(Math.max(100, schedule.at - Date.now()));
          return json(schedule);
        },
      ],
      ["GET", /^\/api\/schedules$/, () => json(this.schedules.list())],
      [
        "POST",
        /^\/api\/schedules\/(\d+)\/cancel$/,
        (_request, match) => json(this.schedules.cancel(Number(match[1]))),
      ],
      [
        "POST",
        /^\/api\/nodes$/,
        async (request) => json(this.nodes.register(await request.json())),
      ],
      ["GET", /^\/api\/nodes$/, () => json(this.nodes.list())],
      ["GET", /^\/api\/computers$/, () => json(this.computers.list())],
      ["GET", /^\/api\/posts$/, () => json(this.computers.posts())],
      ["GET", /^\/api\/helpers$/, () => json(this.helpers.list())],
      [
        "POST",
        /^\/api\/computers$/,
        async (request) => {
          const input = await body(request);
          const redirect = `${new URL(request.url).origin}/oauth/t3/callback`;
          return json(await this.computers.connect(input["name"], input["url"], redirect));
        },
      ],
      [
        "POST",
        /^\/api\/nodes\/([\w-]+)\/models$/,
        async (request, match) =>
          json(this.nodes.allowModels(match[1] ?? "", (await body(request))["allowed"])),
      ],
      [
        "POST",
        /^\/api\/jobs$/,
        async (request) =>
          json(await this.nodes.propose(await request.json(), this.memory.render())),
      ],
      ["GET", /^\/api\/jobs$/, () => json(this.nodes.recent())],
      [
        "GET",
        /^\/api\/usage$/,
        () => json({ quota: this.usage.latestQuota(), calls: this.usage.recent() }),
      ],
      ["GET", /^\/api\/permissions$/, () => json(this.permissions.list())],
      [
        "POST",
        /^\/api\/permissions\/([^/]+)\/([^/]+)$/,
        async (request, match) =>
          json(
            await this.permissions.decide(
              match[1] ?? "",
              match[2] ?? "",
              (await body(request))["allowed"],
            ),
          ),
      ],
      [
        "POST",
        /^\/api\/jobs\/([^/]+)\/approve$/,
        async (request, match) =>
          json(
            await this.nodes.approve(match[1] ?? "", () =>
              this.startSandbox(new URL(request.url).origin),
            ),
          ),
      ],
      [
        "POST",
        /^\/api\/jobs\/([^/]+)\/(tell|abort)$/,
        async (request, match) =>
          json(
            await this.nodes.control(
              match[1],
              match[2] === "tell" ? "tell" : "abort",
              (await body(request))["message"],
            ),
          ),
      ],
      ["GET", /^\/api\/status$/, async () => json(await this.status())],
      [
        "GET",
        /^\/api\/instructions$/,
        async () => json({ text: (await this.host.storage.get<string>("instructions")) ?? "" }),
      ],
      [
        "PUT",
        /^\/api\/instructions$/,
        async (request) => {
          const text = (await body(request))["text"];
          if (typeof text !== "string" || text.length > INSTRUCTION_CHARS) {
            return json(
              { error: "Send the instructions as text of at most 20,000 characters" },
              400,
            );
          }
          if (text.trim()) await this.host.storage.put("instructions", text.trim());
          else await this.host.storage.delete("instructions");
          return json({ text: text.trim() });
        },
      ],
      [
        "GET",
        /^\/api\/messages$/,
        () =>
          json(
            this.memory
              .recent()
              .filter((message) => ["user", "talk", "work", "note"].includes(message.kind)),
          ),
      ],
      ["GET", /^\/api\/view$/, () => json({ text: this.memory.render() })],
      [
        "POST",
        /^\/api\/auth\/start$/,
        async () => {
          const device = await startDeviceLogin();
          await this.host.storage.put("device", device);
          await this.host.storage.delete("error");
          await this.wake(5_000);
          return json({
            code: device.user_code,
            url: "https://auth.openai.com/codex/device",
            expires: device.expires,
          });
        },
      ],
      [
        "POST",
        /^\/api\/import$/,
        async (request) => {
          const input = await body(request);
          const messages = input["messages"];
          const nodes = input["nodes"] ?? [];
          if (!Array.isArray(messages) || messages.length > 100 || !Array.isArray(nodes)) {
            return json({ error: "Import at most 100 messages at a time" }, 400);
          }
          if (this.pendingTurns()) {
            return json({ error: "A chat turn is running; import after it ends" }, 409);
          }
          for (const message of messages) this.memory.append(importedMessage(message));
          for (const value of nodes) {
            const node = importedNode(value);
            this.memory.saveNode(node, node.text);
          }
          await this.wake();
          return json({ messages: this.memory.count, nodes: this.memory.nodeCount });
        },
      ],
      [
        "*",
        /^\/api\/transcript-upload$/,
        async (request) => {
          const session = query(request).get("session") ?? "";
          const action = query(request).get("action");
          if (action === "start" && request.method === "POST") {
            return json(await this.uploads.start(session, (await body(request))["parts"]));
          }
          if (action === "part" && request.method === "PUT") {
            const size = Number(request.headers.get("content-length"));
            if (!Number.isSafeInteger(size) || size < 1 || size > UPLOAD_PART_BYTES) {
              return json({ error: "Send a transcript part of 1–10 MiB with Content-Length" }, 400);
            }
            return json(
              await this.uploads.put(session, Number(query(request).get("number")), request.body),
            );
          }
          if (action === "finish" && request.method === "POST")
            return json(await this.uploads.finish(session));
          return json({ error: "Use start, part, or finish for transcript uploads" }, 400);
        },
      ],
      [
        "GET",
        /^\/api\/transcript$/,
        async (request) => {
          const session = query(request).get("session") ?? "";
          const text = await readTranscript(
            this.host.bucket,
            this.recordings.get(session)?.transcript ?? session,
            Number(query(request).get("start") ?? 1),
            Number(query(request).get("count") ?? 20),
          );
          return json({ text });
        },
      ],
      [
        "POST",
        /^\/api\/chat$/,
        async (request) => {
          const input = await body(request);
          const words = typeof input["text"] === "string" ? input["text"].trim() : "";
          const images = await saveImages(this.host.bucket, input["images"]);
          const text = [words, ...images].filter(Boolean).join("\n");
          if (!text) return json({ error: "Write a message" }, 400);
          this.sql.exec("INSERT INTO turns(text, status) VALUES (?, 'pending')", text);
          const [{ id } = { id: 0 }] = this.sql.rows<{ id: number }>(
            "SELECT last_insert_rowid() AS id",
          );
          await this.wake();
          return json({ queued: true, id }, 202);
        },
      ],
      ["GET", /^\/api\/turns\/(\d+)$/, (_request, match) => this.turnReply(Number(match[1]))],
      ["POST", /^\/api\/cancel$/, () => json(this.cancel())],
      [
        "GET",
        /^\/api\/search$/,
        (request) => json(this.memory.search(query(request).get("q") ?? "")),
      ],
    ];
  }

  /** Routes for registered nodes, authenticated by their own keys. */
  private async nodeRoute(request: Request, path: string): Promise<Response> {
    const machine = this.nodes.authenticate(request);
    if (!machine) return json({ error: "Invalid node key" }, 401);
    if (path === "/node/subscription" && request.method === "POST") {
      if (machine.name !== "sandbox") {
        return json({ error: "This route belongs to the Sandbox's own subscription" }, 403);
      }
      return json(await this.sandbox().credential());
    }
    if (path === "/node/recordings" && request.method === "POST") {
      return json(this.recordings.register(machine.name, await request.json()));
    }
    if (path === "/node/ingest" && request.method === "POST") {
      const input: unknown = await request.json();
      const recording = this.recordings.get(isRecord(input) ? input["session"] : undefined);
      if (!recording || recording.machine !== machine.name) {
        return json({ error: "Register this recording on its node first" }, 403);
      }
      if (!(await this.host.bucket.head(transcriptKey(recording.transcript)))) {
        return json({ error: "Upload the redacted transcript before its messages" }, 409);
      }
      const result = this.recordings.append(machine.name, input);
      await this.wake();
      return json(result);
    }
    if (path !== "/node/transcript" || request.method !== "PUT") {
      return json({ error: "No such node route" }, 404);
    }
    const session = new URL(request.url).searchParams.get("session") ?? "";
    const job = this.nodes.job(session);
    if (
      (!job || job.machine !== machine.name) &&
      !this.recordings.ownsTranscript(machine.name, session)
    ) {
      return json({ error: "That session does not belong to this node" }, 403);
    }
    await this.host.bucket.put(transcriptKey(session), request.body);
    return json({ ok: true });
  }

  /** The browser lands here after the owner approves the Master in a computer's T3 Code. */
  private async finishSignIn(request: Request): Promise<Response> {
    const page = (text: string, status: number) =>
      new Response(`<!doctype html><meta charset="utf-8"><title>OptChat</title><p>${text}</p>`, {
        status,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    try {
      const name = await this.computers.finish(new URL(request.url).searchParams);
      return page(`OptChat can now reach ${name}. You can close this tab.`, 200);
    } catch (error) {
      const text = errorMessage(error).replace(/[<>&]/g, "");
      return page(`OptChat was not connected: ${text}`, 400);
    }
  }

  /** Queue a thread's report as a work message, which starts a turn like any other message. */
  private queueWork(text: string): void {
    this.sql.exec("INSERT INTO turns(text, status, kind) VALUES (?, 'pending', 'work')", text);
    this.host.waitUntil(this.wake());
  }

  /**
   * Check watched threads in the background, POLL_MS after the last check ended, so neither a turn
   * nor the loop waits on a slow computer.
   */
  private pollThreads(): void {
    if (this.polling || !this.computers.watching() || Date.now() < this.nextPoll) return;
    this.polling = this.computers
      .poll((text, finished) => {
        // A helper's thread keeps its results, for the next thread if this one goes.
        if (finished) this.helpers.record(finished, text);
        this.queueWork(text);
      })
      .catch((error: unknown) => this.host.storage.put("error", errorMessage(error)))
      .finally(() => {
        this.polling = null;
        this.nextPoll = Date.now() + POLL_MS;
        if (this.computers.watching()) this.host.waitUntil(this.wake(POLL_MS));
      });
  }

  /**
   * Post finished turns nobody prompted for to T3 Code in the background, so the owner's phone is
   * notified; a post that fails is tried again later.
   */
  private postTurns(): void {
    const due = this.computers.nextPost();
    if (this.posting || due === null || due > Date.now()) return;
    this.posting = this.computers
      .post()
      .then(async (errors) => {
        if (errors.length) await this.host.storage.put("error", errors.join("\n"));
      })
      .catch((error: unknown) => this.host.storage.put("error", errorMessage(error)))
      .finally(() => {
        this.posting = null;
        const next = this.computers.nextPost();
        if (next !== null) this.host.waitUntil(this.wake(Math.max(100, next - Date.now())));
      });
    this.host.waitUntil(this.posting);
  }

  /**
   * The title to post a finished turn under: a reply to a report or a schedule, unless the owner
   * wrote during the turn and so reads it already, or the Master chose to stay quiet.
   */
  private postTitle(turn: Turn): string | null {
    if (turn.kind === "user") return null;
    if (this.sql.rows("SELECT 1 FROM turns WHERE reply_to=? AND kind='user'", turn.id).length) {
      return null;
    }
    const reply = this.sql
      .rows<{ text: string }>(
        "SELECT text FROM messages WHERE session=? AND kind='talk' ORDER BY source_index",
        `turn:${turn.id}`,
      )
      .map((message) => message.text)
      .join("\n")
      .trim();
    return reply && reply !== QUIET ? headline(reply) : null;
  }

  /** The next time the loop must run on its own: a due schedule, thread check or post. */
  private nextCheck(): number | null {
    const times = [
      this.schedules.nextWake(),
      // A check or post in progress sets the next one when it ends.
      !this.polling && this.computers.watching() ? this.nextPoll : null,
      this.posting ? null : this.computers.nextPost(),
    ].filter((time): time is number => time !== null);
    return times.length ? Math.min(...times) : null;
  }

  private async status() {
    return {
      messages: this.memory.count,
      nodes: this.memory.nodeCount,
      settled: this.memory.settled(),
      unsummarized: this.memory.unsummarized(),
      ...this.memory.failures(),
      authenticated: await this.authenticated(),
      error: (await this.host.storage.get<string>("error")) ?? null,
      pending: this.pendingTurns(),
    };
  }

  private pendingTurns(): number {
    return (
      this.sql.rows<{ count: number }>(
        "SELECT COUNT(*) AS count FROM turns WHERE status='pending'",
      )[0]?.count ?? 0
    );
  }

  private turnReply(id: number): Response {
    const [turn] = this.sql.rows<Pick<Turn, "status" | "reply_to">>(
      "SELECT status, reply_to FROM turns WHERE id=?",
      id,
    );
    if (!turn) return json({ error: "No chat turn with that id" }, 404);
    const replyId = turn.reply_to ?? id;
    const [reply] = this.sql.rows<Pick<Turn, "status">>(
      "SELECT status FROM turns WHERE id=?",
      replyId,
    );
    // Each reply, tool call and tool result in order, so a client can show the turn as it runs.
    const steps = this.sql.rows<{ index: number; kind: string; text: string }>(
      `SELECT source_index AS "index", kind, text FROM messages
        WHERE session=? AND kind IN ('talk', 'tool', 'echo') ORDER BY source_index`,
      `turn:${replyId}`,
    );
    return json({
      id,
      replyId,
      status: reply?.status,
      text: steps
        .filter((step) => step.kind === "talk")
        .map((step) => step.text)
        .join("\n\n"),
      steps,
    });
  }

  /** Stop the current reply; queued messages stay in the log, unanswered. */
  private cancel() {
    const turns = this.sql.rows<Pick<Turn, "id" | "text" | "kind">>(
      "SELECT id, text, kind FROM turns WHERE status='pending'",
    );
    for (const turn of turns) {
      this.memory.append({
        kind: turn.kind,
        text: turn.text,
        session: `turn:${turn.id}`,
        index: 0,
      });
    }
    this.sql.exec("UPDATE turns SET status='cancelled', state=NULL WHERE status='pending'");
    this.callController?.abort();
    return { cancelled: turns.length };
  }

  /** Run the loop within `delay`; an alarm already waiting on the compactor looks again now. */
  async wake(delay = 100): Promise<void> {
    this.interrupt?.();
    this.interrupt = null;
    const current = await this.host.storage.getAlarm();
    const target = Date.now() + delay;
    if (current === null || target < current) await this.host.storage.setAlarm(target);
  }

  /** Called by the Sandbox before it saves and stops. */
  sandboxBusy(): boolean {
    return this.nodes.busy("sandbox");
  }

  private async startSandbox(url: string) {
    const sandbox = this.sandbox();
    const machine = this.nodes.machine("sandbox");
    if (!machine) throw new Error("The Sandbox machine is not registered");
    const list = (text: string) => {
      const value = parseJson(text);
      return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
    };
    return sandbox.start({
      name: "sandbox",
      key: machine.key,
      roots: list(machine.roots),
      tools: list(machine.tools),
      url,
      directory: "/workspace/node",
      subscription: "cloud",
    });
  }

  async alarm(): Promise<void> {
    this.working ??= this.run()
      .catch(async (error: unknown) => {
        await this.host.storage.put("error", errorMessage(error));
        await this.wake(10_000);
      })
      .finally(() => {
        this.working = null;
      });
    return this.working;
  }

  private async run(): Promise<void> {
    this.schedules.fireDue();
    this.pollThreads();
    this.postTurns();
    const next = this.nextCheck();
    if (next !== null) await this.wake(Math.max(100, next - Date.now()));
    const authenticated = await this.authenticated();
    // The compactor runs beside turns: a turn never waits behind a merge batch or the backlog of
    // an import or another node's log.
    const compaction = this.startCompaction(authenticated);
    const device = await this.host.storage.get<DeviceLogin>("device");
    if (device) {
      if (device.expires <= Date.now()) {
        await this.host.storage.delete("device");
        await this.host.storage.put(
          "error",
          "The device code expired. Connect the ChatGPT subscription again.",
        );
        return;
      }
      const credential = await pollDeviceLogin(device);
      if (!credential) {
        await this.wake(pollDelay(device));
        return;
      }
      await this.host.storage.put("oauth", credential);
      await this.host.storage.delete("device");
      await this.host.storage.delete("error");
      await this.wake();
      return;
    }
    if (!authenticated) {
      await compaction;
      return;
    }
    const [turn] = this.sql.rows<Turn>(
      "SELECT * FROM turns WHERE status='pending' ORDER BY id LIMIT 1",
    );
    if (turn) {
      if (!turn.state) await this.waitForView();
      await this.turn(turn);
      await this.wake();
      return;
    }
    // No other alarm runs while this one waits, so it also stops for queued turns, schedules and
    // thread checks.
    const due = this.nextCheck();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const round = await Promise.race([
      compaction,
      new Promise<null>((resolve) => {
        this.interrupt = () => resolve(null);
        if (due !== null) timer = setTimeout(() => resolve(null), Math.max(0, due - Date.now()));
      }),
    ]);
    if (timer !== null) clearTimeout(timer);
    this.interrupt = null;
    if (round === null) {
      await this.wake();
      return;
    }
    // Past the quota guard, check back later; due retries wait too, or they would wake at once.
    if (!allowsCompaction(this.usage.latestQuota())) {
      if (this.memory.ready().length || this.memory.nextRetry() !== null) {
        await this.wake(300_000);
      }
      return;
    }
    // Go on at once while the compactor makes progress.
    if (this.memory.ready().length) await this.wake(round.built > 0 ? 100 : 10_000);
    // Failed nodes are not ready until their retry time, so wake for the earliest one.
    const retry = this.memory.nextRetry();
    if (retry !== null) await this.wake(Math.max(100, retry - Date.now()));
  }

  /** One compaction round at a time, shared by every caller until it ends. */
  private startCompaction(authenticated: boolean): Promise<PumpResult> {
    this.compacting ??= pump(
      this.memory,
      (request) => this.call("compact", this.host.config.compactorModel, request),
      {
        maxPaidNodes: authenticated ? 64 : 0,
        // A waiting turn may summarize the lines it needs past the quota guard.
        canBuildPaidNode: () => this.waitingTurn || allowsCompaction(this.usage.latestQuota()),
        canMerge: () => !this.waitingTurn,
        onError: (error) =>
          this.host.waitUntil(this.host.storage.put("error", errorMessage(error))),
      },
    ).finally(() => {
      this.compacting = null;
    });
    return this.compacting;
  }

  /**
   * A new turn waits up to TURN_WAIT_MS for the lines of its view to be summarized, with merges
   * held back; the lines still missing then show as markers the model can zoom into.
   */
  private async waitForView(): Promise<void> {
    this.waitingTurn = true;
    try {
      const deadline = Date.now() + TURN_WAIT_MS;
      while (!this.memory.settled() && Date.now() < deadline) {
        if (!this.compacting) {
          // A round that ended with leaves left was out of budget; failed ones wait for retry.
          if (!this.memory.ready().some((part) => part.level === 0)) return;
          this.startCompaction(true);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      this.waitingTurn = false;
    }
  }

  /** The host's own login counts; otherwise the Master needs its device login. */
  private async authenticated(): Promise<boolean> {
    return Boolean(this.host.callModel) || Boolean(await this.host.storage.get("oauth"));
  }

  private async credentials(): Promise<OAuthCredential> {
    const credential = await this.host.storage.get<OAuthCredential>("oauth");
    if (!credential) throw new Error("Connect the ChatGPT subscription before calling a model");
    if (credential.expires > Date.now() + 300_000) return credential;
    this.refreshing ??= refreshLogin(credential)
      .then(async (fresh) => {
        await this.host.storage.put("oauth", fresh);
        return fresh;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  private async call(
    purpose: "master" | "compact",
    model: string,
    request: ModelRequest,
  ): Promise<ModelResult> {
    const controller = new AbortController();
    if (purpose === "master") this.callController = controller;
    const effort = purpose === "compact" ? this.host.config.compactorEffort : "low";
    if (!isReasoningEffort(effort))
      throw new Error("COMPACTOR_EFFORT is low, medium, high or xhigh");
    // Turns and compactions share one cache session: they share the system prompt and tools.
    const relayed: RelayedRequest = {
      ...request,
      input: await loadImages(this.host.bucket, request.input),
      model,
      effort,
      cacheKey: "optchat",
    };
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
    const node = this.relay.node();
    let result: ModelResult;
    if (node) result = await this.relay.call(node.socket, relayed, signal);
    else if (this.host.callModel) result = await this.host.callModel({ ...relayed, signal });
    else result = await codexCall(await this.credentials(), { ...relayed, signal });
    this.usage.record({
      date: new Date().toISOString(),
      purpose,
      model,
      usage: result.usage,
      quota: result.quota,
      ...(node ? { source: node.machine } : {}),
    });
    await this.host.storage.delete("error");
    return result;
  }

  private turnStatus(id: number): Turn["status"] | undefined {
    return this.sql.rows<Pick<Turn, "status">>("SELECT status FROM turns WHERE id=?", id)[0]
      ?.status;
  }

  private async turn(turn: Turn): Promise<void> {
    const instructions = await this.host.storage.get<string>("instructions");
    let state: TurnState = turn.state
      ? loadTurnState(turn.state)
      : {
          // The owner's instructions change rarely, so they lead and stay in the cached prefix.
          input: [
            user(
              [
                ...(instructions ? [`<instructions>\n${instructions}\n</instructions>`] : []),
                this.memory.render(),
                `It is ${localTime(Date.now(), this.host.config.timezone)}.`,
                delivered(turn),
              ],
              ownImages(turn),
            ),
          ],
          step: 0,
          output: null,
          cursor: 0,
          results: [],
        };
    if (!turn.state) {
      this.memory.append({
        kind: turn.kind,
        text: turn.text,
        session: `turn:${turn.id}`,
        index: 0,
      });
      this.saveTurn(turn.id, state);
    }
    for (let calls = 0; calls < 6; calls++) {
      // A long turn must not hold back thread reports.
      this.pollThreads();
      if (!state.output) {
        const result = await this.call("master", this.host.config.masterModel, {
          system: SYSTEM,
          input: state.input,
          tools: [...TOOLS],
        });
        if (this.turnStatus(turn.id) !== "pending") return;
        state = { ...state, output: result.output, cursor: 0, results: [] };
        this.saveTurn(turn.id, state);
      }
      const output = state.output ?? [];
      while (state.cursor < output.length) {
        const item = output[state.cursor];
        if (!item) break;
        const reply = messageText(item);
        if (item.type === "message") {
          if (reply)
            this.memory.append({
              kind: "talk",
              text: reply,
              session: `turn:${turn.id}`,
              index: state.step + 1,
            });
          state.step++;
        }
        const call = functionCall(item);
        if (call) {
          this.memory.append({
            kind: "tool",
            text: `${call.name} ${call.arguments}`,
            session: `turn:${turn.id}`,
            index: state.step + 1,
          });
          this.pollThreads();
          let result: unknown;
          try {
            result = await this.tool(call.name, parseJson(call.arguments), call.callId);
          } catch (error) {
            result = { error: errorMessage(error) };
          }
          const echo = cap(typeof result === "string" ? result : JSON.stringify(result));
          this.memory.append({
            kind: "echo",
            text: echo,
            session: `turn:${turn.id}`,
            index: state.step + 2,
          });
          state.results.push({ type: "function_call_output", call_id: call.callId, output: echo });
          state.step += 2;
        }
        state.cursor++;
        this.saveTurn(turn.id, state);
      }
      if (!output.some((item) => item.type === "function_call")) {
        const title = this.postTitle(turn);
        this.sql.transaction(() => {
          this.sql.exec("UPDATE turns SET status='done', state=NULL WHERE id=?", turn.id);
          if (title !== null) this.computers.queuePost(turn.id, title);
        });
        this.postTurns();
        return;
      }
      // Responses outputs, including encrypted reasoning, precede their tool results.
      state.input.push(...output, ...state.results);
      // An image opened with look follows its result, since tool results are text.
      const looked = output.flatMap((item) => {
        const call = functionCall(item);
        const result = state.results.find((entry) => entry.call_id === call?.callId)?.output;
        return call?.name === "look" && result ? attachedImage(result) : [];
      });
      if (looked.length) {
        state.input.push(
          user([`The images you opened with look: ${looked.join(", ")}`], looked.map(storedImage)),
        );
      }
      state.output = null;
      const incoming = this.sql.rows<Pick<Turn, "id" | "text" | "kind">>(
        "SELECT id, text, kind FROM turns WHERE status='pending' AND state IS NULL AND id<>? ORDER BY id",
        turn.id,
      );
      for (const message of incoming) {
        this.memory.append({
          kind: message.kind,
          text: message.text,
          session: `turn:${message.id}`,
          index: 0,
        });
        state.input.push(user([delivered(message)], ownImages(message)));
      }
      const saved = state;
      this.sql.transaction(() => {
        for (const message of incoming) {
          this.sql.exec(
            "UPDATE turns SET status='injected', reply_to=? WHERE id=?",
            turn.id,
            message.id,
          );
        }
        this.saveTurn(turn.id, saved);
      });
    }
    await this.wake();
  }

  private saveTurn(id: number, state: TurnState): void {
    this.sql.exec("UPDATE turns SET state=? WHERE id=?", JSON.stringify(state), id);
  }

  private async tool(name: string, input: unknown, callId: string): Promise<unknown> {
    // Code Mode scripts may call a tool without arguments.
    const args = requireRecord(input ?? {}, "Tool input must be an object");
    const integer = (field: string) =>
      requireInteger(args[field], `${name} needs an integer ${field}`);
    switch (name) {
      case "schedules":
        return this.schedules.list();
      case "cancel_schedule":
        return this.schedules.cancel(args["id"]);
      case "schedule": {
        const schedule = this.schedules.create(args);
        await this.wake(Math.max(100, schedule.at - Date.now()));
        return schedule;
      }
      case "look": {
        const key = args["image"];
        if (!isImageKey(key) || !(await this.host.bucket.head(key))) {
          throw new Error("No such image; name one from an [image ...] marker");
        }
        return { attached: key };
      }
      case "codemode": {
        const code = requireString(args["code"], "Code mode needs JavaScript source");
        if (!this.host.runCode) throw new Error("Code Mode is not available on this host");
        return this.host.runCode(code, (tool, toolInput, step) =>
          this.codeStep(callId, step, tool, toolInput),
        );
      }
      case "zoom":
        return this.memory.zoom(integer("id"), integer("n"));
      case "date":
        return this.memory.date(integer("id"));
      case "search":
        return this.memory.search(requireString(args["query"], "search needs a query"));
      case "machines":
        return this.nodes.list();
      case "computers":
        return this.computers.overview();
      case "launch":
        return this.computers.launch(
          requireString(args["computer"], "launch needs a computer"),
          args["project"],
          requireString(args["title"], "launch needs a title"),
          requireString(args["task"], "launch needs a task"),
          callId,
        );
      case "threads":
        return this.computers.threads(
          requireString(args["computer"], "threads needs a computer"),
          args["project"],
        );
      case "read_thread":
        return this.computers.read(
          requireString(args["computer"], "read_thread needs a computer"),
          requireString(args["thread"], "read_thread needs a thread"),
          args["after"] === undefined ? undefined : integer("after"),
        );
      case "send":
        return this.computers.send(
          requireString(args["computer"], "send needs a computer"),
          requireString(args["thread"], "send needs a thread"),
          requireString(args["message"], "send needs a message"),
          args["mode"],
          callId,
        );
      case "interrupt":
        return this.computers.interrupt(
          requireString(args["computer"], "interrupt needs a computer"),
          requireString(args["thread"], "interrupt needs a thread"),
          callId,
        );
      case "helpers":
        return this.helpers.list();
      case "hire":
        return this.helpers.hire(args);
      case "delegate":
        return this.helpers.delegate(
          args["helper"],
          requireString(args["task"], "delegate needs a task"),
          callId,
        );
      case "retire":
        return this.helpers.retire(args["name"]);
      case "spawn":
        return this.nodes.propose(args, this.memory.render(), callId);
      case "tell":
      case "abort":
        return this.nodes.control(args["id"], name, args["message"]);
      case "session": {
        const message = this.memory.requireMessage(integer("id"));
        return { session: message.session, source_line: message.source_index, date: message.date };
      }
      case "transcript": {
        const session = requireString(args["session"], "transcript needs a session");
        return readTranscript(
          this.host.bucket,
          this.recordings.get(session)?.transcript ?? session,
          integer("start"),
          integer("count"),
        );
      }
      default:
        throw new Error(`Unknown tool ${name}`);
    }
  }

  /** One Code Mode tool call; completed results replay so a resumed script repeats nothing. */
  private async codeStep(
    callId: string,
    step: number,
    name: string,
    input: unknown,
  ): Promise<unknown> {
    const [saved] = this.sql.rows<{ result: string }>(
      "SELECT result FROM code_steps WHERE call_id=? AND step=?",
      callId,
      step,
    );
    if (saved) return parseJson(saved.result);
    this.memory.append({
      kind: "tool",
      text: `${name} ${JSON.stringify(input)}`,
      session: `code-tool:${callId}`,
      index: 2 * step,
    });
    let result: unknown;
    try {
      result = await this.tool(name, input, `${callId}-${step}`);
    } catch (error) {
      result = { error: errorMessage(error) };
    }
    const text = cap(typeof result === "string" ? result : JSON.stringify(result));
    let bounded = result;
    if (typeof result === "string") bounded = text;
    else if (JSON.stringify(result).length > 30_000) bounded = { truncated: true, text };
    this.memory.append({ kind: "echo", text, session: `code-tool:${callId}`, index: 2 * step + 1 });
    this.sql.exec("INSERT INTO code_steps VALUES (?, ?, ?)", callId, step, JSON.stringify(bounded));
    return bounded;
  }

  async webSocketMessage(socket: NodeSocket, raw: string | ArrayBuffer): Promise<void> {
    try {
      const attachment: unknown = socket.deserializeAttachment();
      const machine = isRecord(attachment) ? attachment["machine"] : undefined;
      if (typeof machine !== "string") throw new Error("This connection has no machine");
      const event = parseNodeMessage(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      switch (event.type) {
        case "node_ready": {
          const models = event.models === true && this.nodes.servesModels(machine);
          socket.serializeAttachment({ machine, ...(models ? { models: true } : {}) });
          this.permissions.reconnect(machine, socket);
          send(socket, { type: "ready", jobs: this.nodes.replay(machine, socket) });
          return;
        }
        case "resume_job": {
          const job = this.nodes.job(event.job);
          if (!job || job.machine !== machine || job.status === "approval") {
            throw new Error("That recovery does not belong to an approved task on this node");
          }
          this.sql.transaction(() => {
            if (this.sql.rows("SELECT id FROM job_resumes WHERE id=?", event.id).length) return;
            if (job.status === "running") this.permissions.expire(machine, event.job);
            this.sql.exec("INSERT INTO job_resumes VALUES (?, ?)", event.id, event.job);
          });
          await this.nodes.audit(event.job, "resume-delivered", { delivery: event.id });
          send(socket, { type: "ack", id: event.id });
          return;
        }
        case "permission_request": {
          const permission = await this.permissions.request(machine, event);
          send(socket, { type: "permission_pending", job: event.job, id: event.id });
          this.permissions.deliver(socket, permission);
          return;
        }
        case "permission_received":
          this.permissions.receive(machine, event);
          return;
        case "model_call": {
          const job = this.nodes.job(event.job);
          if (!job || job.machine !== machine || job.status === "approval") {
            throw new Error("That model call does not belong to an approved task on this node");
          }
          this.usage.record({ ...event, purpose: "pi", source: machine, job: event.job });
          send(socket, { type: "ack", id: event.id });
          return;
        }
        case "model_result":
          this.relay.answer(event);
          return;
        case "report": {
          await this.nodes.report(machine, event, (text) =>
            this.sql.exec(
              "INSERT INTO turns(text, status, kind) VALUES (?, 'pending', 'work')",
              text,
            ),
          );
          if (this.pendingTurns()) await this.wake();
          send(socket, { type: "ack", id: event.id });
          return;
        }
      }
    } catch (error) {
      send(socket, { type: "error", error: errorMessage(error) });
    }
  }

  webSocketClose(socket: NodeSocket): void {
    this.relay.drop(socket);
    socket.close();
  }

  webSocketError(socket: NodeSocket): void {
    this.relay.drop(socket);
    socket.close();
  }
}
