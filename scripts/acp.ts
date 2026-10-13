/**
 * OptChat as an Agent Client Protocol (v1) agent on stdio, so T3 Code lists it as a provider
 * ("Local command") on this computer and on the phones and computers that reach it through T3
 * Connect. Each prompt becomes a chat turn of the deployed Master, and the Master's tool calls and
 * replies stream back as session updates. The Master has one conversation, so every T3 Code
 * thread with OptChat shares it. A turn nobody prompted for, such as the reply to a thread's report,
 * arrives as a new thread the Master starts with the prompt "OptChat turn <id>": that prompt shows
 * the turn rather than starting one, and T3 Code notifies the owner's phones when it ends. Run from
 * the repository root, as bin/optchat-acp does.
 */
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { errorMessage, isRecord, parseJson, requireInteger } from "../src/json.ts";
import { cloudClient } from "./cloud-client.ts";

const POLL_MS = 500;
/** Polls that may fail in a row, about half a minute, before the prompt gives up. */
const POLL_FAILURES = 60;
const RESULT_CHARS = 2000;
/**
 * T3 Code's own context for coding agents, as its 0.0.46 ACP adapter writes it: the first prompt of
 * a session, and one after a mode change, wraps the owner's words in its instructions, and every
 * prompt ends with a block about the runtime. The Master has its own prompt and tools.
 */
const T3_WRAPPED =
  /^<t3_code_instructions>\n[\s\S]*?\n<\/t3_code_instructions>\n\n<user_request>\n([\s\S]*)\n<\/user_request>$/;
const T3_RUNTIME = "<runtime_info>";
/** The prompt of a thread the Master starts to show one of its turns. */
const POSTED_TURN = /^OptChat turn (\d+)$/;

interface Step {
  index: number;
  kind: string;
  text: string;
}

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const master = cloudClient();
const sessions = new Set<string>();
/** Sessions showing a posted turn: stopping one must not stop the Master's current reply. */
const showing = new Set<string>();

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function update(sessionId: string, change: Record<string, unknown>): void {
  send({ method: "session/update", params: { sessionId, update: change } });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One text block as the Master reads it, without T3 Code's context; a link is kept as its URI. */
function blockText(block: Record<string, unknown>): string {
  const { type, text, uri } = block;
  if (type === "text" && typeof text === "string") {
    return text.startsWith(T3_RUNTIME) ? "" : (T3_WRAPPED.exec(text)?.[1] ?? text);
  }
  if (type === "resource_link" && typeof uri === "string") return uri;
  return "";
}

/** The owner's words in a prompt, and the images they attached, which the Master stores. */
function promptInput(prompt: unknown): {
  text: string;
  images: { mimeType: string; data: string }[];
} {
  if (!Array.isArray(prompt)) throw new RpcError(-32602, "session/prompt needs a prompt array");
  const blocks = prompt.filter(isRecord);
  return {
    text: blocks.map(blockText).filter(Boolean).join("\n").trim(),
    images: blocks.flatMap(({ type, mimeType, data }) =>
      type === "image" && typeof mimeType === "string" && typeof data === "string"
        ? [{ mimeType, data }]
        : [],
    ),
  };
}

function steps(turn: Record<string, unknown>): Step[] {
  const list = Array.isArray(turn["steps"]) ? turn["steps"] : [];
  return list.flatMap((step) =>
    isRecord(step) &&
    typeof step["index"] === "number" &&
    typeof step["kind"] === "string" &&
    typeof step["text"] === "string"
      ? [{ index: step["index"], kind: step["kind"], text: step["text"] }]
      : [],
  );
}

/** Show one step of the Master's turn: a reply, a tool call, or the result of the call before. */
function show(sessionId: string, turn: number, step: Step): void {
  if (step.kind === "talk") {
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `${step.text}\n\n` },
    });
    return;
  }
  if (step.kind === "tool") {
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: `${turn}-${step.index}`,
      title: step.text.length > 120 ? `${step.text.slice(0, 119)}…` : step.text,
      // T3 Code labels "read" and "search" calls as file reads and code searches; the Master's
      // calls go as "other", which it labels with the title.
      kind: "other",
      status: "in_progress",
    });
    return;
  }
  // The Master stores each result right after its call.
  update(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: `${turn}-${step.index - 1}`,
    status: failed(step.text) ? "failed" : "completed",
    content: [
      { type: "content", content: { type: "text", text: step.text.slice(0, RESULT_CHARS) } },
    ],
  });
}

/** A tool result the Master recorded as `{"error": ...}`; a truncated result is plain text. */
function failed(result: string): boolean {
  try {
    const value = parseJson(result);
    return isRecord(value) && "error" in value;
  } catch {
    return false;
  }
}

async function prompt(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sessionId = params["sessionId"];
  if (typeof sessionId !== "string" || !sessions.has(sessionId)) {
    throw new RpcError(-32602, "Unknown session; start one with session/new");
  }
  const { text, images } = promptInput(params["prompt"]);
  if (!text && !images.length) throw new RpcError(-32602, "The prompt is empty");
  const posted = POSTED_TURN.exec(text);
  if (posted) showing.add(sessionId);
  else showing.delete(sessionId);
  const id = posted
    ? Number(posted[1])
    : requireInteger(
        (await master.request("/api/chat", images.length ? { text, images } : { text }))["id"],
        "The Master did not queue the message",
      );
  const shown = new Set<number>();
  let failures = 0;
  while (true) {
    let turn: Record<string, unknown>;
    try {
      turn = await master.request(`/api/turns/${id}`);
      failures = 0;
    } catch (error) {
      if (++failures >= POLL_FAILURES) throw error;
      await sleep(POLL_MS);
      continue;
    }
    for (const step of steps(turn)) {
      if (shown.has(step.index)) continue;
      shown.add(step.index);
      show(sessionId, id, step);
    }
    if (turn["status"] !== "pending") {
      // A Master deployed before steps existed sends only the finished reply's text.
      if (!Array.isArray(turn["steps"]) && typeof turn["text"] === "string" && turn["text"]) {
        show(sessionId, id, { index: 0, kind: "talk", text: turn["text"] });
      }
      return { stopReason: turn["status"] === "cancelled" ? "cancelled" : "end_turn" };
    }
    await sleep(POLL_MS);
  }
}

async function call(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: true, audio: false, embeddedContext: false },
          // T3 Code reopens each thread's session in a new agent process, after a restart.
          sessionCapabilities: { resume: {} },
        },
        authMethods: [],
        agentInfo: { name: "optchat", title: "OptChat", version: "1" },
      };
    case "session/new": {
      const sessionId = randomUUID();
      sessions.add(sessionId);
      return { sessionId };
    }
    case "session/resume": {
      // A session holds nothing but its id: the conversation is the Master's.
      const sessionId = params["sessionId"];
      if (typeof sessionId !== "string" || !sessionId) {
        throw new RpcError(-32602, "session/resume needs a sessionId");
      }
      sessions.add(sessionId);
      return {};
    }
    case "session/prompt":
      return prompt(params);
    default:
      throw new RpcError(-32601, `OptChat does not support ${method}`);
  }
}

async function receive(line: string): Promise<void> {
  let message: unknown;
  try {
    message = parseJson(line);
  } catch {
    send({ id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (!isRecord(message) || typeof message["method"] !== "string") return;
  const params = isRecord(message["params"]) ? message["params"] : {};
  if (!("id" in message)) {
    // Stopping the Master's reply stops its whole chat, which every OptChat thread shares.
    if (message["method"] === "session/cancel" && !showing.has(String(params["sessionId"]))) {
      await master.request("/api/cancel", {}).catch((error: unknown) => {
        process.stderr.write(`Cancel failed: ${errorMessage(error)}\n`);
      });
    }
    return;
  }
  try {
    send({ id: message["id"], result: await call(message["method"], params) });
  } catch (error) {
    send({
      id: message["id"],
      error: {
        code: error instanceof RpcError ? error.code : -32603,
        message: errorMessage(error),
      },
    });
  }
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (line.trim()) void receive(line);
});
