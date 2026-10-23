import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WebSocketServer, WebSocket } from "ws";
import { Master, serve } from "../src/master.ts";
import type { MasterConfig, MasterHost, NodeSocket, Settings } from "../src/host.ts";
import { errorMessage, parseJson } from "../src/json.ts";
import { openDatabase } from "./sqlite.ts";
import { DirectoryBucket } from "./bucket.ts";

/** A relayed model request may carry 20 MiB of images; the cloud allowed 32 MiB messages. */
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

export interface LocalMasterOptions {
  /** Holds `master.sqlite` and the bucket's files. */
  directory: string;
  ownerKey: string;
  /** 0 picks a free port. The Master listens on 127.0.0.1 only. */
  port: number;
  config: MasterConfig;
  callModel: NonNullable<MasterHost["callModel"]>;
  runCode?: MasterHost["runCode"];
}

export interface LocalMaster {
  url: string;
  close(): Promise<void>;
}

/** A node's connection; the attachment lives as long as the connection, as on Cloudflare. */
class LocalSocket implements NodeSocket {
  private attachment: unknown = null;
  private readonly socket: WebSocket;
  private readonly onClose: () => void;

  constructor(socket: WebSocket, onClose: () => void) {
    this.socket = socket;
    this.onClose = onClose;
  }

  send(message: string): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(message);
  }

  close(code?: number, reason?: string): void {
    this.onClose();
    this.socket.close(code, reason);
  }

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }
}

function toRequest(message: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      headers.append(name, item);
    }
  }
  const method = message.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? {} : { body: Readable.toWeb(message) };
  return new Request(`http://${message.headers.host ?? "127.0.0.1"}${message.url ?? "/"}`, {
    method,
    headers,
    ...body,
    duplex: "half",
  });
}

async function respond(response: Response, output: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = Object.fromEntries(response.headers);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  output.writeHead(response.status, headers);
  if (response.body) await pipeline(Readable.fromWeb(response.body), output);
  else output.end();
}

/**
 * Run the Master on this machine: SQLite and files in one directory, a timer for its alarm, and
 * the owner API, page and node WebSocket on 127.0.0.1.
 */
export async function startMaster(options: LocalMasterOptions): Promise<LocalMaster> {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const sql = openDatabase(join(options.directory, "master.sqlite"));
  sql.exec("CREATE TABLE IF NOT EXISTS host_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

  let alarm: { time: number; timer: ReturnType<typeof setTimeout> } | null = null;
  let running: Promise<void> | null = null;
  let due = false;
  let closed = false;
  // Like a Durable Object alarm: one at a time, and one that falls due meanwhile runs after it.
  const fire = (): void => {
    alarm = null;
    if (closed) return;
    if (running) {
      due = true;
      return;
    }
    running = master
      .alarm()
      .catch((error: unknown) => console.error(errorMessage(error)))
      .finally(() => {
        running = null;
        if (due) {
          due = false;
          fire();
        }
      });
  };
  const storage: Settings = {
    async get<T>(key: string) {
      const [row] = sql.rows<{ value: string }>("SELECT value FROM host_settings WHERE key=?", key);
      // The host wrote this value itself, from what the Master put.
      return row ? (parseJson(row.value) as T) : undefined;
    },
    async put(key, value) {
      sql.exec(
        "INSERT INTO host_settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        key,
        JSON.stringify(value),
      );
    },
    async delete(key) {
      sql.exec("DELETE FROM host_settings WHERE key=?", key);
    },
    async getAlarm() {
      return alarm?.time ?? null;
    },
    async setAlarm(time) {
      if (alarm) clearTimeout(alarm.timer);
      alarm = { time, timer: setTimeout(fire, Math.max(0, time - Date.now())) };
    },
  };

  const sockets = new Map<LocalSocket, string>();
  const master = new Master({
    sql,
    storage,
    bucket: new DirectoryBucket(join(options.directory, "bucket")),
    sockets: {
      getWebSockets: (machine) =>
        [...sockets].filter(([, name]) => !machine || name === machine).map(([socket]) => socket),
    },
    waitUntil: (work) => {
      work.catch((error: unknown) => console.error(errorMessage(error)));
    },
    config: options.config,
    callModel: options.callModel,
    ...(options.runCode ? { runCode: options.runCode } : {}),
  });

  const nodes = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    handleProtocols: (protocols) => (protocols.has("optchat") ? "optchat" : false),
  });
  const server = createServer((message, output) => {
    serve(toRequest(message), options.ownerKey, master)
      .catch((error: unknown) => Response.json({ error: errorMessage(error) }, { status: 500 }))
      .then((response) => respond(response, output))
      .catch((error: unknown) => {
        console.error(errorMessage(error));
        output.destroy();
      });
  });
  server.on("upgrade", (message: IncomingMessage, stream, head: Buffer) => {
    const request = toRequest(message);
    const machine =
      new URL(request.url).pathname === "/node/ws"
        ? master.nodeMachine(request)
        : new Response(null, { status: 404 });
    if (typeof machine !== "string") {
      stream.end(`HTTP/1.1 ${machine.status} ${STATUS_CODES[machine.status] ?? ""}\r\n\r\n`);
      return;
    }
    nodes.handleUpgrade(message, stream, head, (socket) => {
      master.connectNode(machine, () => {
        const local: LocalSocket = new LocalSocket(socket, () => sockets.delete(local));
        sockets.set(local, machine);
        socket.on("message", (data) => {
          const bytes = Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(new Uint8Array(data));
          void master.webSocketMessage(local, bytes.toString("utf8"));
        });
        socket.on("close", () => {
          if (sockets.delete(local)) master.webSocketClose(local);
        });
        socket.on("error", () => master.webSocketError(local));
        return local;
      });
    });
  });

  server.listen(options.port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The Master has no TCP port");
  // A restart resumes pending turns, schedules and the compactor at once.
  await storage.setAlarm(Date.now());

  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      closed = true;
      if (alarm) clearTimeout(alarm.timer);
      for (const socket of sockets.keys()) socket.close(1001, "The Master is stopping");
      nodes.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await running;
      sql.close();
    },
  };
}
