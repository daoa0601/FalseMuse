import { isRecord, parseJson } from "./json.ts";

const PROTOCOL = "2025-06-18";

const tryJson = (text: string): unknown => {
  try {
    return parseJson(text);
  } catch {
    return undefined;
  }
};

/** The server refused the access token: the owner must sign in again. */
export class McpUnauthorized extends Error {}

export interface McpConnection {
  url: string;
  token: string;
  /** The server's `Mcp-Session-Id`, or null before the first initialize. */
  session: string | null;
}

/**
 * Call one tool on a Streamable HTTP MCP server, initializing a session first when there is none
 * or the server forgot it. Returns the tool's structured result and the session to keep.
 */
export async function callTool(
  connection: McpConnection,
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: unknown; session: string }> {
  let session = connection.session ?? (await initialize(connection));
  let response = await post(connection, session, "tools/call", { name, arguments: args });
  if (response.status === 404) {
    session = await initialize(connection);
    response = await post(connection, session, "tools/call", { name, arguments: args });
  }
  return { result: toolResult(name, await reply(response)), session };
}

async function initialize(connection: McpConnection): Promise<string> {
  const response = await post(connection, null, "initialize", {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: "OptChat", version: "1" },
  });
  await reply(response);
  const session = response.headers.get("mcp-session-id");
  if (!session) throw new Error("The MCP server started no session");
  await post(connection, session, "notifications/initialized");
  return session;
}

function post(
  { url, token }: McpConnection,
  session: string | null,
  method: string,
  params?: Record<string, unknown>,
): Promise<Response> {
  const notification = method.startsWith("notifications/");
  return fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": PROTOCOL,
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method,
      ...(notification ? {} : { id: crypto.randomUUID() }),
      ...(params ? { params } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  });
}

/** The JSON-RPC result of a response, sent as JSON or as one server-sent event. */
async function reply(response: Response): Promise<unknown> {
  if (response.status === 401) throw new McpUnauthorized("The MCP server refused the sign-in");
  const text = await response.text();
  if (!response.ok) throw new Error(`The MCP server answered ${response.status}: ${text}`);
  const body = response.headers.get("content-type")?.includes("text/event-stream")
    ? text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => tryJson(line.slice(5).trim()))
        .find((message) => isRecord(message) && ("result" in message || "error" in message))
    : tryJson(text);
  if (!isRecord(body)) throw new Error("The MCP server sent no JSON-RPC reply");
  if (isRecord(body["error"])) {
    const message = body["error"]["message"];
    throw new Error(`MCP error: ${typeof message === "string" ? message : "unknown"}`);
  }
  return body["result"];
}

/** A tool's structured result; a tool failure becomes an error with the server's message. */
function toolResult(name: string, result: unknown): unknown {
  if (!isRecord(result)) throw new Error(`${name} returned no result`);
  const content = Array.isArray(result["content"]) ? result["content"] : [];
  const text = content
    .map((part) => (isRecord(part) && typeof part["text"] === "string" ? part["text"] : ""))
    .join("\n");
  if (result["isError"] === true) {
    const failure = tryJson(text);
    const message = isRecord(failure) ? failure["message"] : undefined;
    throw new Error(`${name} failed: ${typeof message === "string" ? message : text}`);
  }
  return result["structuredContent"] ?? parseJson(text);
}
