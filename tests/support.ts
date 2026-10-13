import { once } from "node:events";
import type { Server } from "node:http";
import type { ModelResult } from "../src/codex.ts";
import type { SpawnCommand } from "../src/protocol.ts";

/** Listen on an ephemeral local port and return its base URL. */
export async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test server has no TCP port");
  return `http://127.0.0.1:${address.port}`;
}

export function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

export function spawnCommand(
  fields: Partial<SpawnCommand> & Pick<SpawnCommand, "id">,
): SpawnCommand {
  return {
    type: "spawn",
    machine: "test-node",
    cwd: "/tmp",
    task: "",
    view: "",
    status: "running",
    report: null,
    ...fields,
  };
}

export function modelReply(text: string): ModelResult {
  return {
    text,
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    usage: null,
    quota: {},
  };
}

/** The text blocks of the first input item, which compress() builds as one user message. */
export function inputText(item: unknown, block = 0): string {
  if (
    typeof item !== "object" ||
    item === null ||
    !("content" in item) ||
    !Array.isArray(item.content)
  ) {
    throw new Error("Expected a user input message");
  }
  const part: unknown = item.content[block];
  if (
    typeof part !== "object" ||
    part === null ||
    !("text" in part) ||
    typeof part.text !== "string"
  ) {
    throw new Error("Expected an input text block");
  }
  return part.text;
}
