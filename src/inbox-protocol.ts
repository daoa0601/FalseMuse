import { isRecord, parseJson } from "./json.ts";

/**
 * Messages on the socket between the Worker's Inbox and the local Master. The Inbox sends each
 * undelivered message; the Master answers once it has queued the message as a turn. Plain "ping"
 * and "pong" frames keep the socket alive without waking the Inbox.
 */
export interface InboxMessage {
  type: "message";
  id: string;
  text: string;
  /** When the owner sent it, as an ISO time. */
  sent: string;
}

export interface InboxDelivered {
  type: "delivered";
  id: string;
  turn: number;
}

export const INBOX_PING = "ping";
export const INBOX_PONG = "pong";
/** The longest message the inbox takes, as the Master's own instructions. */
export const INBOX_TEXT_CHARS = 20_000;

const ID = /^[0-9a-f-]{36}$/;

export function parseInboxMessage(raw: string): InboxMessage {
  const value = parseJson(raw);
  if (
    !isRecord(value) ||
    value["type"] !== "message" ||
    typeof value["id"] !== "string" ||
    !ID.test(value["id"]) ||
    typeof value["text"] !== "string" ||
    !value["text"] ||
    value["text"].length > INBOX_TEXT_CHARS ||
    typeof value["sent"] !== "string" ||
    !Number.isFinite(Date.parse(value["sent"]))
  ) {
    throw new Error("The inbox sent a message this Master cannot read");
  }
  return { type: "message", id: value["id"], text: value["text"], sent: value["sent"] };
}

export function parseInboxDelivered(raw: string): InboxDelivered {
  const value = parseJson(raw);
  if (
    !isRecord(value) ||
    value["type"] !== "delivered" ||
    typeof value["id"] !== "string" ||
    !ID.test(value["id"]) ||
    typeof value["turn"] !== "number" ||
    !Number.isSafeInteger(value["turn"])
  ) {
    throw new Error("The Master sent an acknowledgement the inbox cannot read");
  }
  return { type: "delivered", id: value["id"], turn: value["turn"] };
}
