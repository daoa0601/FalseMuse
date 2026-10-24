import { WebSocket, type RawData } from "ws";
import { errorMessage } from "../src/json.ts";
import {
  INBOX_PING,
  INBOX_PONG,
  parseInboxMessage,
  type InboxDelivered,
  type InboxMessage,
} from "../src/inbox-protocol.ts";

export interface InboxLinkOptions {
  /** The Worker's origin. */
  url: string;
  /** The owner's key, and Cloudflare Access's service token where Access guards the Worker. */
  headers: Record<string, string>;
  /** Queue the message as a turn and give its id; the same message may come again. */
  deliver(message: InboxMessage): Promise<number>;
  log?: (line: string) => void;
  /** How often to check that the connection is alive; a missed answer reconnects. */
  pingMs?: number;
  /** The first and the longest wait before reconnecting. */
  retryMs?: [number, number];
}

export interface InboxLink {
  connected(): boolean;
  close(): void;
}

const text = (data: RawData): string =>
  (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(new Uint8Array(data))).toString("utf8");

/**
 * Keep a connection out to the Worker's inbox, so messages the owner left while the laptop was
 * away arrive when it wakes, and later ones at once. Each is acknowledged after it is queued.
 */
export function linkInbox(options: InboxLinkOptions): InboxLink {
  const log = options.log ?? console.log;
  const pingMs = options.pingMs ?? 30_000;
  const [first, longest] = options.retryMs ?? [1_000, 300_000];
  const address = `${options.url.replace(/^http/, "ws")}/master/inbox`;
  let socket: WebSocket | null = null;
  let open = false;
  let stopped = false;
  let wait = first;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let lastError = "";

  const connect = () => {
    const current = new WebSocket(address, { headers: options.headers });
    socket = current;
    let pinger: ReturnType<typeof setInterval> | undefined;
    let answered = true;
    current.on("open", () => {
      open = true;
      wait = first;
      lastError = "";
      log("Connected to the inbox");
      pinger = setInterval(() => {
        // A laptop that slept leaves a socket that looks open; one unanswered ping replaces it.
        if (!answered) current.terminate();
        answered = false;
        current.send(INBOX_PING);
      }, pingMs);
    });
    current.on("message", (data) => {
      const frame = text(data);
      if (frame === INBOX_PONG) {
        answered = true;
        return;
      }
      let message: InboxMessage;
      try {
        message = parseInboxMessage(frame);
      } catch (error) {
        log(errorMessage(error));
        return;
      }
      options
        .deliver(message)
        .then((turn) => {
          const delivered: InboxDelivered = { type: "delivered", id: message.id, turn };
          if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify(delivered));
        })
        .catch((error: unknown) => log(`Inbox message ${message.id}: ${errorMessage(error)}`));
    });
    current.on("error", (error) => {
      // Said once until the link recovers, so a long absence does not fill the log.
      if (error.message !== lastError) log(`Inbox connection: ${error.message}`);
      lastError = error.message;
    });
    current.on("close", () => {
      clearInterval(pinger);
      if (open) log("Disconnected from the inbox");
      open = false;
      if (socket === current) socket = null;
      if (stopped) return;
      retry = setTimeout(connect, wait);
      wait = Math.min(wait * 2, longest);
    });
  };

  connect();
  return {
    connected: () => open,
    close() {
      stopped = true;
      clearTimeout(retry);
      socket?.close(1000, "The Master is stopping");
    },
  };
}
