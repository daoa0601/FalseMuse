import { DurableObject } from "cloudflare:workers";
import {
  INBOX_PING,
  INBOX_PONG,
  INBOX_TEXT_CHARS,
  parseInboxDelivered,
  type InboxMessage,
} from "./inbox-protocol.ts";
import { isRecord } from "./json.ts";

/** Messages waiting for the laptop; more are refused until it takes some. */
const WAITING_LIMIT = 100;
/** Delivered messages are listed for a month. */
const KEPT_MS = 30 * 24 * 60 * 60 * 1000;
const MASTER_TAG = "master";

type Row = {
  id: string;
  text: string;
  sent: string;
  delivered: string | null;
  turn: number | null;
};

const json = (value: unknown, status = 200): Response => Response.json(value, { status });

/**
 * The owner's messages while the Master runs on the laptop: kept here until the local Master,
 * connected out to /master/inbox, has queued each one as a turn. The Worker authenticates the
 * owner before any request arrives.
 */
export class Inbox extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, text TEXT NOT NULL, sent TEXT NOT NULL, delivered TEXT, turn INTEGER)",
    );
    // Answered by the runtime, so a keepalive never wakes the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(INBOX_PING, INBOX_PONG));
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/master/inbox") return this.acceptMaster(request);
    if (path !== "/api/inbox") return json({ error: "No such route" }, 404);
    if (request.method === "GET") return json(this.list());
    if (request.method !== "POST") return json({ error: "Use GET or POST" }, 405);
    const input: unknown = await request.json().catch(() => null);
    const text = isRecord(input) && typeof input["text"] === "string" ? input["text"].trim() : "";
    if (!text || text.length > INBOX_TEXT_CHARS) {
      return json({ error: "Write a message of at most 20,000 characters" }, 400);
    }
    if (this.waiting() >= WAITING_LIMIT) {
      return json({ error: `${WAITING_LIMIT} messages already wait for the laptop` }, 429);
    }
    const message: InboxMessage = {
      type: "message",
      id: crypto.randomUUID(),
      text,
      sent: new Date().toISOString(),
    };
    this.sql.exec(
      "DELETE FROM inbox WHERE delivered IS NOT NULL AND delivered < ?",
      new Date(Date.now() - KEPT_MS).toISOString(),
    );
    this.sql.exec(
      "INSERT INTO inbox (id, text, sent) VALUES (?, ?, ?)",
      message.id,
      message.text,
      message.sent,
    );
    for (const socket of this.masters()) socket.send(JSON.stringify(message));
    return json({ id: message.id, connected: this.masters().length > 0 }, 202);
  }

  /** The local Master's connection: it replaces any earlier one and gets every waiting message. */
  private acceptMaster(request: Request): Response {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }
    for (const socket of this.masters()) socket.close(1000, "Replaced by a new connection");
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [MASTER_TAG]);
    for (const row of this.sql
      .exec<{ id: string; text: string; sent: string }>(
        "SELECT id, text, sent FROM inbox WHERE delivered IS NULL ORDER BY sent",
      )
      .toArray()) {
      server.send(JSON.stringify({ type: "message", ...row } satisfies InboxMessage));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): void {
    try {
      if (typeof raw !== "string") throw new Error("Send text frames");
      const { id, turn } = parseInboxDelivered(raw);
      this.sql.exec(
        "UPDATE inbox SET delivered=?, turn=? WHERE id=? AND delivered IS NULL",
        new Date().toISOString(),
        turn,
        id,
      );
    } catch (error) {
      socket.close(1008, String(error).slice(0, 120));
    }
  }

  override webSocketClose(socket: WebSocket, code: number): void {
    // 1005 and 1006 report a close without a code, which close() may not send back.
    socket.close(code === 1005 || code === 1006 ? 1000 : code);
  }

  private masters(): WebSocket[] {
    return this.ctx.getWebSockets(MASTER_TAG);
  }

  private waiting(): number {
    return this.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM inbox WHERE delivered IS NULL")
      .one().count;
  }

  private list(): { connected: boolean; messages: Row[] } {
    return {
      connected: this.masters().length > 0,
      messages: this.sql
        .exec<Row>("SELECT id, text, sent, delivered, turn FROM inbox ORDER BY sent DESC LIMIT 20")
        .toArray(),
    };
  }
}

export const INBOX_PAGE: string = String.raw`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>OptChat inbox</title><style>
body{font:16px system-ui;margin:40px auto;padding:0 20px;max-width:850px;color:#e3e7ef;background:#15181d}
button,input,textarea{font:inherit;padding:10px;border:1px solid #49515e;background:#252a33;color:inherit}
textarea{width:100%;box-sizing:border-box;min-height:100px}button{cursor:pointer;margin:8px 8px 8px 0}
pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5}small{color:#aab3c2}article{border-top:1px solid #39404a;padding:12px 0}
</style><h1>OptChat inbox</h1>
<p>OptChat runs on the laptop. A message left here reaches it as soon as the laptop is online, and
the reply arrives in T3 Code.</p>
<form id="login"><input name="key" type="password" placeholder="Owner key" required><button>Sign in</button></form>
<main hidden>
  <small id="status"></small>
  <form id="send"><textarea name="text" placeholder="Your message" required maxlength="20000"></textarea>
    <button>Leave message</button></form>
  <section id="messages"></section>
</main>
<p id="error" role="alert"></p><script>
const select = (selector) => document.querySelector(selector);

async function api(body) {
  const response = await fetch('/api/inbox', {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  if (!response.ok) {
    const error = new Error(value.error || response.statusText);
    error.status = response.status;
    throw error;
  }
  return value;
}

async function refresh() {
  try {
    const { connected, messages } = await api();
    select('#login').hidden = true;
    select('main').hidden = false;
    select('#status').textContent = connected
      ? 'The laptop is connected: a message reaches OptChat at once.'
      : 'The laptop is offline: messages wait here until it connects.';
    select('#messages').replaceChildren(...messages.map((message) => {
      const article = document.createElement('article');
      const label = document.createElement('small');
      label.textContent = new Date(message.sent).toLocaleString() + ' · ' + (message.delivered
        ? 'delivered as turn ' + message.turn + ' at ' + new Date(message.delivered).toLocaleString()
        : 'waiting for the laptop');
      const text = document.createElement('pre');
      text.textContent = message.text;
      article.append(label, text);
      return article;
    }));
    select('#error').textContent = '';
  } catch (error) {
    if (error.status === 401) {
      select('#login').hidden = false;
      select('main').hidden = true;
    } else select('#error').textContent = error.message;
  }
}

select('#login').onsubmit = async (event) => {
  event.preventDefault();
  const response = await fetch('/login', { method: 'POST', body: new FormData(event.target) });
  if (!response.ok) select('#error').textContent = 'That key was not accepted';
  else await refresh();
};

select('#send').onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api({ text: event.target.text.value });
    event.target.reset();
    await refresh();
  } catch (error) {
    select('#error').textContent = error.message;
  }
};

refresh();
setInterval(refresh, 10000);
</script>`;
