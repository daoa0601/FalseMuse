import { isRecord, parseJson } from "./json.ts";
import { quotaHeaders, type Quota } from "./usage.ts";

const BASE = "https://chatgpt.com/backend-api/codex/responses";

export interface InputText {
  type: "input_text";
  text: string;
}

/** An image the model sees: a data URL, or until the call is made, where the Master stored it. */
export interface InputImage {
  type: "input_image";
  image_url: string;
}

export interface UserInput {
  role: "user";
  content: (InputText | InputImage)[];
}

/** An output item from the Responses stream, resent verbatim on the next step. */
export interface ResponseItem {
  readonly type: string;
  readonly [field: string]: unknown;
}

export interface FunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export type InputItem = UserInput | ResponseItem | FunctionCallOutput;

export interface FunctionCall {
  name: string;
  arguments: string;
  callId: string;
}

export interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string }>;
    required: string[];
    additionalProperties: false;
  };
}

export interface ModelRequest {
  system: string;
  input: InputItem[];
  tools?: ToolDefinition[];
}

export interface ModelResult {
  text: string;
  output: ResponseItem[];
  usage: unknown;
  quota: Quota;
}

export type ModelCall = (request: ModelRequest) => Promise<ModelResult>;
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  value === "low" || value === "medium" || value === "high" || value === "xhigh";

/** A model call as the Master hands it to its host: everything but the credential and signal. */
export type BackendRequest = ModelRequest & {
  model: string;
  cacheKey: string;
  effort: ReasoningEffort;
};

export interface Credential {
  access: string;
  accountId: string;
}

export function user(texts: string[], images: InputImage[] = []): UserInput {
  return {
    role: "user",
    content: [...texts.map((text): InputText => ({ type: "input_text", text })), ...images],
  };
}

function isResponseItem(value: unknown): value is ResponseItem {
  return isRecord(value) && typeof value["type"] === "string";
}

/** The text of an assistant message item, or null for any other item. */
export function messageText(item: ResponseItem): string | null {
  if (item.type !== "message" || !Array.isArray(item["content"])) return null;
  const parts = item["content"].filter(
    (part): part is { type: "output_text"; text: string } =>
      isRecord(part) && part["type"] === "output_text" && typeof part["text"] === "string",
  );
  return parts.length ? parts.map((part) => part.text).join("\n") : null;
}

export function functionCall(item: ResponseItem): FunctionCall | null {
  const { name, arguments: input, call_id: callId } = item;
  if (item.type !== "function_call") return null;
  if (typeof name !== "string" || typeof input !== "string" || typeof callId !== "string") {
    throw new Error("The model returned an incomplete function call");
  }
  return { name, arguments: input, callId };
}

export async function codexCall(
  { access, accountId }: Credential,
  {
    model,
    system,
    input,
    tools = [],
    cacheKey,
    effort = "low",
    signal,
  }: ModelRequest & {
    model: string;
    cacheKey: string;
    effort?: ReasoningEffort;
    signal?: AbortSignal;
  },
): Promise<ModelResult> {
  const response = await fetch(BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access}`,
      "chatgpt-account-id": accountId,
      originator: "pi",
      "OpenAI-Beta": "responses=experimental",
      accept: "text/event-stream",
      "content-type": "application/json",
      // The backend caches prefixes per session-id; prompt_cache_key alone cached nothing (probed).
      "session-id": cacheKey,
    },
    body: JSON.stringify({
      model,
      instructions: system,
      input,
      tools,
      tool_choice: "auto",
      parallel_tool_calls: true,
      store: false,
      stream: true,
      text: { verbosity: "low" },
      include: ["reasoning.encrypted_content"],
      reasoning: { effort, summary: "auto" },
      prompt_cache_key: cacheKey,
    }),
    ...(signal ? { signal } : {}),
  });
  const quota = quotaHeaders(Object.fromEntries(response.headers));
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    const message =
      isRecord(error) && isRecord(error["error"]) && typeof error["error"]["message"] === "string"
        ? error["error"]["message"]
        : response.statusText;
    throw new Error(`ChatGPT subscription request failed (${response.status}): ${message}`);
  }
  if (!response.body) throw new Error("The subscription response had no body");
  let buffer = "";
  let completed: Record<string, unknown> | null = null;
  const items = new Map<number, ResponseItem>();
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replaceAll("\r\n", "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      const value = parseJson(data);
      if (!isRecord(value)) continue;
      const type = value["type"];
      if (
        type === "response.output_item.done" &&
        typeof value["output_index"] === "number" &&
        isResponseItem(value["item"])
      ) {
        items.set(value["output_index"], value["item"]);
      }
      if (type === "response.completed" && isRecord(value["response"])) {
        completed = value["response"];
      }
      if (type === "response.failed" || type === "error") throw new Error(failureMessage(value));
    }
  }
  if (!completed) throw new Error("Subscription stream ended before response.completed");
  const finished = Array.isArray(completed["output"])
    ? completed["output"].filter(isResponseItem)
    : [];
  const output = finished.length
    ? finished
    : [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
  const text = output
    .map(messageText)
    .filter((part): part is string => part !== null)
    .join("\n");
  return { text, output, usage: completed["usage"], quota };
}

function failureMessage(event: Record<string, unknown>): string {
  const response = event["response"];
  if (isRecord(response) && isRecord(response["error"])) {
    const message = response["error"]["message"];
    if (typeof message === "string") return message;
  }
  return typeof event["message"] === "string" ? event["message"] : "Subscription response failed";
}
