import test from "node:test";
import assert from "node:assert/strict";
import permissions from "../node/permissions.ts";
import { isRecord } from "../src/json.ts";

test("a failed owner review channel blocks the tool after the local scanner prepares it", async () => {
  type Handler = (
    event: unknown,
    ctx: unknown,
  ) => Promise<{ block: boolean; reason: string } | undefined>;
  const handlers = new Map<string, Handler>();
  // The extension only registers handlers; this records them without a Pi runtime.
  const pi = { on: (name: string, handler: Handler) => handlers.set(name, handler) };
  permissions(pi as unknown as Parameters<typeof permissions>[0]);
  let prepared: unknown;
  const toolCall = handlers.get("tool_call");
  assert.ok(toolCall);
  const result = await toolCall(
    { toolName: "write", input: { path: "/tmp/note.txt", content: "Reviewed note" } },
    {
      cwd: "/tmp",
      hasUI: true,
      ui: {
        async confirm(_title: string, message: string) {
          prepared = JSON.parse(message);
          throw new Error("The owner review channel is unavailable");
        },
      },
    },
  );
  assert.ok(isRecord(prepared));
  assert.equal(prepared["tool"], "write");
  const input = prepared["input"];
  assert.ok(isRecord(input));
  assert.equal(input["path"], "/tmp/note.txt");
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /owner review channel is unavailable/);
});
