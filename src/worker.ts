import { DurableObject } from "cloudflare:workers";
import type { SqlDatabase, SqlValue } from "./database.ts";
import { executeCode } from "./codemode.ts";
import * as core from "./master.ts";
import { requireString } from "./json.ts";
export { Sandbox } from "./sandbox.ts";
export { DirectoryBackupGateway } from "@cloudflare/sandbox";

export default {
  fetch: (request, env, ctx) =>
    core.serve(request, env.OWNER_KEY, ctx.exports.Master.getByName("owner")),
} satisfies ExportedHandler<Env>;

/** The Master on Cloudflare: one Durable Object holds its SQLite, alarm and node sockets. */
export class Master extends DurableObject<Env> {
  private readonly master: core.Master;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql: SqlDatabase = {
      rows: <Row extends object>(query: string, ...bindings: SqlValue[]) =>
        // Each query names the columns its caller reads.
        ctx.storage.sql.exec(query, ...bindings).toArray() as unknown as Row[],
      exec: (query, ...bindings) => {
        ctx.storage.sql.exec(query, ...bindings);
      },
      transaction: (action) => ctx.storage.transactionSync(action),
    };
    const sandbox = () => ctx.exports.Sandbox.getByName("owner");
    this.master = new core.Master({
      sql,
      storage: {
        get: <T>(key: string) => ctx.storage.get<T>(key),
        put: (key, value) => ctx.storage.put(key, value),
        delete: (key) => ctx.storage.delete(key),
        getAlarm: () => ctx.storage.getAlarm(),
        setAlarm: (time) => ctx.storage.setAlarm(time),
      },
      bucket: env.TRANSCRIPTS,
      sockets: ctx,
      waitUntil: (work) => ctx.waitUntil(work),
      config: {
        masterModel: env.MASTER_MODEL,
        compactorModel: env.COMPACTOR_MODEL,
        compactorEffort: env.COMPACTOR_EFFORT,
        timezone: env.OWNER_TIMEZONE,
      },
      runCode: (code, invoke) => executeCode(env.LOADER, code, invoke),
      sandbox: {
        status: () => sandbox().status(),
        start: (config) => sandbox().start(config),
        save: () => sandbox().save(),
        startLogin: () => sandbox().startLogin(),
        credential: () => sandbox().credential(),
      },
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // The Worker has already authenticated the owner for /api routes.
    if (url.pathname.startsWith("/api/export/")) {
      try {
        return await this.export(url, request.method);
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    }
    if (await this.ctx.storage.get("moved")) {
      return Response.json(
        { error: "The Master has moved to the laptop; this copy only answers /api/export/" },
        { status: 410 },
      );
    }
    if (url.pathname !== "/node/ws") return this.master.fetch(request);
    const machine = this.master.nodeMachine(request);
    if (typeof machine !== "string") return machine;
    const { 0: client, 1: server } = new WebSocketPair();
    this.master.connectNode(machine, () => {
      this.ctx.acceptWebSocket(server, [machine]);
      return server;
    });
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": "optchat" },
    });
  }

  /**
   * Hand the Master's state to the owner for its move to the laptop: each table's schema and rows
   * in rowid order, the owner's instructions, and the bucket's objects.
   */
  private async export(url: URL, method: string): Promise<Response> {
    const sql = this.ctx.storage.sql;
    const query = url.searchParams;
    // Park this copy before exporting, so it stops changing and stops acting for the owner.
    if (url.pathname === "/api/export/park" && method === "POST") {
      await this.ctx.storage.put("moved", true);
      await this.ctx.storage.deleteAlarm();
      for (const socket of this.ctx.getWebSockets()) socket.close(1001, "The Master has moved");
      return Response.json({ moved: true });
    }
    if (url.pathname === "/api/export/unpark" && method === "POST") {
      await this.ctx.storage.delete("moved");
      await this.master.wake();
      return Response.json({ moved: false });
    }
    // Durable Object internals and SQLite's own tables stay; a full-text table's rows are exported
    // and its shadow tables rebuilt from them.
    const tables = sql
      .exec<{ type: string; name: string; sql: string }>(
        "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY rowid",
      )
      .toArray();
    const virtual = tables.filter((table) => /^CREATE VIRTUAL TABLE/i.test(table.sql));
    const exported = tables.filter(
      (table) =>
        table.type === "table" && !virtual.some((owner) => table.name.startsWith(`${owner.name}_`)),
    );
    switch (url.pathname) {
      case "/api/export/schema":
        return Response.json({
          tables: exported.map(({ name, sql: create }) => ({
            name,
            sql: create,
            rows: sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM "${name}"`).one()
              .count,
          })),
          indexes: tables.filter((table) => table.type === "index").map((index) => index.sql),
          instructions: (await this.ctx.storage.get<string>("instructions")) ?? null,
        });
      case "/api/export/rows": {
        const name = requireString(query.get("table"), "Name a table");
        if (!exported.some((table) => table.name === name)) throw new Error("No such table");
        const cursor = sql.exec(
          `SELECT rowid AS "rowid", * FROM "${name}" WHERE rowid > ? ORDER BY rowid LIMIT ?`,
          // Message ids start at 0, so the first page has no lower bound.
          Number(query.get("after") ?? Number.MIN_SAFE_INTEGER),
          Math.min(Number(query.get("limit") ?? 200), 1000),
        );
        const rows = [...cursor.raw()];
        if (rows.some((row) => row.some((value) => value instanceof ArrayBuffer))) {
          throw new Error(`${name} holds binary values, which this export does not carry`);
        }
        return Response.json({ columns: cursor.columnNames, rows });
      }
      case "/api/export/objects": {
        const cursor = query.get("cursor");
        const listed = await this.env.TRANSCRIPTS.list({
          limit: 1000,
          ...(cursor ? { cursor } : {}),
        });
        return Response.json({
          objects: listed.objects.map(({ key, size }) => ({ key, size })),
          cursor: listed.truncated ? listed.cursor : null,
        });
      }
      case "/api/export/object": {
        const object = await this.env.TRANSCRIPTS.get(
          requireString(query.get("key"), "Name a key"),
        );
        if (!object) return Response.json({ error: "No such object" }, { status: 404 });
        return new Response(object.body, {
          headers: { "content-length": String(object.size) },
        });
      }
      default:
        return Response.json({ error: "No such export" }, { status: 404 });
    }
  }

  override async alarm(): Promise<void> {
    if (await this.ctx.storage.get("moved")) return;
    return this.master.alarm();
  }

  /** Called by the Sandbox before it saves and stops. */
  sandboxBusy(): boolean {
    return this.master.sandboxBusy();
  }

  override async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (await this.ctx.storage.get("moved")) {
      socket.close(1001, "The Master has moved");
      return;
    }
    return this.master.webSocketMessage(socket, raw);
  }

  override webSocketClose(socket: WebSocket): void {
    this.master.webSocketClose(socket);
  }

  override webSocketError(socket: WebSocket): void {
    this.master.webSocketError(socket);
  }
}
