import { hasColumn, type SqlDatabase } from "./database.ts";
import { isRecord, parseJson } from "./json.ts";
import type { CloudMessage, Job, ReportMessage } from "./protocol.ts";

export const PI_TOOLS = ["read", "bash", "edit", "write"] as const;

export interface Machine {
  name: string;
  key: string;
  roots: string;
  tools: string;
}

export interface MachineStatus {
  name: string;
  roots: string[];
  tools: string[];
  online: boolean;
  /** The owner allowed this machine to serve model calls. */
  models: boolean;
  /** It is connected and announced that it serves them. */
  serving: boolean;
}

export interface Registration {
  name: string;
  key: string;
  roots: string[];
  tools: string[];
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export function send(socket: WebSocket, message: CloudMessage): void {
  socket.send(JSON.stringify(message));
}

/** Registered machines, their WebSocket connections, and the Pi tasks proposed to them. */
export class Nodes {
  readonly ctx: DurableObjectState;
  private readonly database: SqlDatabase;
  private readonly transcripts: R2Bucket;

  constructor(ctx: DurableObjectState, database: SqlDatabase, transcripts: R2Bucket) {
    this.ctx = ctx;
    this.database = database;
    this.transcripts = transcripts;
    database.exec(
      "CREATE TABLE IF NOT EXISTS machines (name TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, roots TEXT NOT NULL, tools TEXT NOT NULL)",
    );
    // Serving model calls is the owner's grant: a model node reads memory and writes turns.
    if (!hasColumn(database, "machines", "models")) {
      database.exec("ALTER TABLE machines ADD COLUMN models INTEGER NOT NULL DEFAULT 0");
    }
    database.exec(
      "CREATE TABLE IF NOT EXISTS spawns (id TEXT PRIMARY KEY, machine TEXT, cwd TEXT, task TEXT, view TEXT, status TEXT, report TEXT)",
    );
  }

  register(input: unknown): Registration {
    const name = isRecord(input) ? input["name"] : undefined;
    const roots = isRecord(input) ? input["roots"] : undefined;
    const tools = isRecord(input) ? (input["tools"] ?? ["read"]) : undefined;
    if (
      typeof name !== "string" ||
      !/^[\w-]{1,60}$/.test(name) ||
      !Array.isArray(roots) ||
      !roots.length ||
      !roots.every((root) => typeof root === "string" && root.startsWith("/"))
    ) {
      throw new Error("A machine needs a name and absolute allowed roots");
    }
    if (!Array.isArray(tools) || !tools.every((tool) => PI_TOOLS.some((known) => known === tool))) {
      throw new Error("Unknown Pi tool");
    }
    const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    this.database.exec(
      "INSERT INTO machines(name, key, roots, tools) VALUES (?, ?, ?, ?)",
      name,
      key,
      JSON.stringify(roots),
      JSON.stringify(tools),
    );
    return { name, key, roots: stringList(roots), tools: stringList(tools) };
  }

  /** Let a machine serve the Master's model calls. The Sandbox never may: it runs Pi with bash. */
  allowModels(name: string, allowed: unknown): { name: string; models: boolean } {
    if (typeof allowed !== "boolean") throw new Error("Send allowed: true or false");
    if (name === "sandbox") throw new Error("The Sandbox cannot serve model calls");
    if (!this.machine(name)) throw new Error(`No machine ${name}`);
    this.database.exec("UPDATE machines SET models=? WHERE name=?", allowed ? 1 : 0, name);
    return { name, models: allowed };
  }

  servesModels(name: string): boolean {
    return this.database.rows("SELECT 1 FROM machines WHERE name=? AND models=1", name).length > 0;
  }

  machine(name: string): Machine | undefined {
    return this.database.rows<Machine>("SELECT * FROM machines WHERE name=?", name)[0];
  }

  authenticate(request: Request): Machine | undefined {
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "");
    const protocols = request.headers
      .get("sec-websocket-protocol")
      ?.split(",")
      .map((part) => part.trim());
    const key = bearer ?? protocols?.[1] ?? "";
    return this.database.rows<Machine>("SELECT * FROM machines WHERE key=?", key)[0];
  }

  connect(request: Request): Response {
    const machine = this.authenticate(request);
    if (!machine) return Response.json({ error: "Invalid node key" }, { status: 401 });
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }
    for (const old of this.ctx.getWebSockets(machine.name)) old.close(1000, "Reconnected");
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [machine.name]);
    server.serializeAttachment({ machine: machine.name });
    send(server, { type: "registered", name: machine.name });
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": "optchat" },
    });
  }

  replay(machine: string, socket: WebSocket): number {
    const jobs = this.database.rows<Job>(
      "SELECT * FROM spawns WHERE machine=? AND status='running'",
      machine,
    );
    for (const job of jobs) send(socket, { type: "spawn", ...job, resume: true });
    return jobs.length;
  }

  list(): MachineStatus[] {
    return this.database
      .rows<Omit<Machine, "key"> & { models: number }>(
        "SELECT name, roots, tools, models FROM machines",
      )
      .map((machine) => {
        const sockets = this.ctx.getWebSockets(machine.name);
        return {
          name: machine.name,
          roots: stringList(parseJson(machine.roots)),
          tools: stringList(parseJson(machine.tools)),
          online: sockets.length > 0,
          models: machine.models === 1,
          serving:
            machine.models === 1 &&
            sockets.some((socket) => {
              const attachment: unknown = socket.deserializeAttachment();
              return isRecord(attachment) && attachment["models"] === true;
            }),
        };
      });
  }

  job(id: string): Job | undefined {
    return this.database.rows<Job>("SELECT * FROM spawns WHERE id=?", id)[0];
  }

  recent(): Omit<Job, "view">[] {
    return this.database.rows(
      "SELECT id, machine, cwd, task, status, report FROM spawns ORDER BY rowid DESC LIMIT 20",
    );
  }

  busy(machine: string): boolean {
    return (
      this.database.rows("SELECT 1 FROM spawns WHERE machine=? AND status='running'", machine)
        .length > 0
    );
  }

  async propose(input: unknown, view: string, id: string = crypto.randomUUID()) {
    const existing = this.job(id);
    if (existing) return { id, status: existing.status };
    const requested = isRecord(input) ? input : {};
    const machines = this.list();
    const named = requested["machine"];
    const target =
      typeof named === "string" && named
        ? machines.find((item) => item.name === named)
        : (machines.find((item) => item.online) ??
          machines.find((item) => item.name === "sandbox"));
    const cwd = typeof requested["cwd"] === "string" ? requested["cwd"] : target?.roots[0];
    if (
      !target ||
      typeof cwd !== "string" ||
      cwd.split("/").includes("..") ||
      !target.roots.some((root) => cwd === root || cwd.startsWith(`${root.replace(/\/$/, "")}/`))
    ) {
      throw new Error("Choose a registered machine and an allowed working directory");
    }
    const task = requested["task"];
    if (typeof task !== "string" || !task.trim()) throw new Error("A Pi session needs a task");
    this.database.exec(
      "INSERT INTO spawns VALUES (?, ?, ?, ?, ?, 'approval', NULL)",
      id,
      target.name,
      cwd,
      task,
      view,
    );
    await this.audit(id, "proposed");
    return { id, status: "approval", message: "The owner must approve this task in the web chat" };
  }

  async approve(id: string, startSandbox?: () => Promise<unknown>) {
    const job = this.job(id);
    if (!job || job.status !== "approval") throw new Error("No pending task with that id");
    if (job.machine === "sandbox" && !this.ctx.getWebSockets(job.machine).length && startSandbox) {
      await startSandbox();
      const deadline = Date.now() + 10_000;
      while (!this.ctx.getWebSockets(job.machine).length && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const [socket] = this.ctx.getWebSockets(job.machine);
    if (!socket) throw new Error(`Machine ${job.machine} is offline`);
    await this.audit(id, "approved");
    if (this.job(id)?.status !== "approval") throw new Error("That task was already approved");
    this.database.exec("UPDATE spawns SET status='running' WHERE id=?", id);
    send(socket, { type: "spawn", ...job });
    return { id, status: "running" };
  }

  async control(id: unknown, type: "tell" | "abort", message?: unknown) {
    const job = typeof id === "string" ? this.job(id) : undefined;
    if (!job || job.status !== "running") throw new Error("That Pi session is not running");
    const [socket] = this.ctx.getWebSockets(job.machine);
    if (!socket) throw new Error(`Machine ${job.machine} is offline`);
    const text = typeof message === "string" ? message : undefined;
    await this.audit(job.id, type, text ?? null);
    send(socket, { type, id: job.id, ...(text === undefined ? {} : { message: text }) });
    return { sent: true };
  }

  /** Store a report once; the callback queues it as a master turn in the same transaction. */
  async report(
    machine: string,
    { id, report, status }: ReportMessage,
    onReport: (text: string) => void,
  ) {
    const [job] = this.database.rows<Job>(
      "SELECT * FROM spawns WHERE id=? AND machine=?",
      id,
      machine,
    );
    if (!job || job.report !== null) return false;
    if (job.status !== "running") throw new Error("That Pi task has not been approved");
    await this.audit(id, status);
    return this.database.transaction(() => {
      // Another delivery may have completed while R2 was writing the audit.
      if (this.job(id)?.report !== null) return false;
      this.database.exec("UPDATE spawns SET status=?, report=? WHERE id=?", status, report, id);
      onReport(`[${id}] ${report}`);
      return true;
    });
  }

  async audit(id: string, action: string, message: unknown = null): Promise<void> {
    const [job] = this.database.rows<Pick<Job, "id" | "machine" | "cwd" | "task">>(
      "SELECT id, machine, cwd, task FROM spawns WHERE id=?",
      id,
    );
    await this.transcripts.put(
      `audit/${id}/${crypto.randomUUID()}.json`,
      JSON.stringify({ date: new Date().toISOString(), action, ...job, message }),
    );
  }
}
