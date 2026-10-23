import { DurableObject } from "cloudflare:workers";
import type { SqlDatabase, SqlValue } from "./database.ts";
import { executeCode } from "./codemode.ts";
import * as core from "./master.ts";
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
    if (new URL(request.url).pathname !== "/node/ws") return this.master.fetch(request);
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

  override alarm(): Promise<void> {
    return this.master.alarm();
  }

  /** Called by the Sandbox before it saves and stops. */
  sandboxBusy(): boolean {
    return this.master.sandboxBusy();
  }

  override webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    return this.master.webSocketMessage(socket, raw);
  }

  override webSocketClose(socket: WebSocket): void {
    this.master.webSocketClose(socket);
  }

  override webSocketError(socket: WebSocket): void {
    this.master.webSocketError(socket);
  }
}
