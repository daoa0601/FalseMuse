import test from "node:test";
import assert from "node:assert/strict";
import { codexCall, user } from "../src/codex.ts";

test("a completed subscription stream uses its finished output items when the completion omits them", async (context) => {
  const output = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Remember café ☕" }],
  };
  const events = [
    { type: "response.output_item.done", output_index: 0, item: output },
    { type: "response.completed", response: { output: [], usage: { output_tokens: 8 } } },
  ];
  const data = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""),
  );
  context.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    const request: unknown = JSON.parse(String(options.body));
    assert.ok(typeof request === "object" && request !== null);
    assert.equal("store" in request && request.store, false);
    assert.equal("instructions" in request && request.instructions, "Summarize");
    return new Response(
      new ReadableStream({
        start(controller) {
          for (let offset = 0; offset < data.length; offset += 7)
            controller.enqueue(data.slice(offset, offset + 7));
          controller.close();
        },
      }),
      { headers: { "x-codex-primary-used-percent": "82", "x-codex-turn-state": "private state" } },
    );
  });
  const result = await codexCall(
    { access: "test", accountId: "test" },
    { model: "test", system: "Summarize", input: [user(["A fact"])], cacheKey: "test" },
  );
  assert.equal(result.text, "Remember café ☕");
  assert.deepEqual(result.usage, { output_tokens: 8 });
  assert.equal(result.quota["x-codex-primary-used-percent"], "82");
  assert.equal(result.quota["x-codex-turn-state"], undefined);
});

test("a subscription request names its cache session in the header the backend caches by", async (context) => {
  const completed = `data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`;
  const fetch = context.mock.method(
    globalThis,
    "fetch",
    async () => new Response(completed, { headers: { "content-type": "text/event-stream" } }),
  );
  await codexCall(
    { access: "test", accountId: "test" },
    { model: "test", system: "Summarize", input: [user(["A fact"])], cacheKey: "compact-2026-09" },
  );
  const [, options] = fetch.mock.calls[0]?.arguments ?? [];
  const headers = new Headers(options?.headers);
  assert.equal(headers.get("session-id"), "compact-2026-09");
  const request: unknown = JSON.parse(String(options?.body));
  assert.ok(typeof request === "object" && request !== null);
  assert.equal("prompt_cache_key" in request && request.prompt_cache_key, "compact-2026-09");
  assert.deepEqual("reasoning" in request && request.reasoning, { effort: "low", summary: "auto" });
});

test("a subscription request carries the reasoning effort it asks for", async (context) => {
  const completed = `data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`;
  const fetch = context.mock.method(globalThis, "fetch", async () => new Response(completed));
  await codexCall(
    { access: "test", accountId: "test" },
    { model: "test", system: "Summarize", input: [], cacheKey: "test", effort: "xhigh" },
  );
  const request: unknown = JSON.parse(String(fetch.mock.calls[0]?.arguments[1]?.body));
  assert.ok(typeof request === "object" && request !== null);
  assert.deepEqual("reasoning" in request && request.reasoning, {
    effort: "xhigh",
    summary: "auto",
  });
});
