import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { callTool, McpUnauthorized } from "../src/mcp.ts";

test("an MCP call starts a session once, renews a forgotten one, and surfaces failures", async () => {
  const sessions = new Set<string>();
  const methods: string[] = [];
  let started = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      const message = JSON.parse(body) as {
        id?: string;
        method: string;
        params?: { name: string; arguments: Record<string, unknown> };
      };
      methods.push(message.method);
      if (request.headers.authorization !== "Bearer good") {
        response.writeHead(401).end();
        return;
      }
      const reply = (result: unknown, headers: Record<string, string> = {}) =>
        response
          .writeHead(200, { "content-type": "application/json", ...headers })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      if (message.method === "initialize") {
        const session = `s${++started}`;
        sessions.add(session);
        reply({}, { "mcp-session-id": session });
        return;
      }
      if (message.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      if (!sessions.has(String(request.headers["mcp-session-id"]))) {
        response.writeHead(404).end();
        return;
      }
      if (message.params?.name === "broken") {
        reply({
          isError: true,
          content: [
            { type: "text", text: JSON.stringify({ code: "denied", message: "Not allowed" }) },
          ],
        });
        return;
      }
      reply({
        content: [{ type: "text", text: JSON.stringify({ echo: message.params?.arguments }) }],
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  try {
    const first = await callTool({ url, token: "good", session: null }, "echo", { a: 1 });
    assert.deepEqual(first, { result: { echo: { a: 1 } }, session: "s1" });
    const again = await callTool({ url, token: "good", session: "s1" }, "echo", { a: 2 });
    assert.equal(again.session, "s1");
    // A session the server forgot is started again, once.
    sessions.clear();
    const renewed = await callTool({ url, token: "good", session: "s1" }, "echo", { a: 3 });
    assert.deepEqual(renewed, { result: { echo: { a: 3 } }, session: "s2" });
    await assert.rejects(
      callTool({ url, token: "good", session: "s2" }, "broken", {}),
      /broken failed: Not allowed/,
    );
    await assert.rejects(
      callTool({ url, token: "bad", session: null }, "echo", {}),
      (error) => error instanceof McpUnauthorized,
    );
    assert.equal(methods.filter((method) => method === "initialize").length, 3);
  } finally {
    server.close();
  }
});
