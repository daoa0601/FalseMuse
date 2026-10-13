import test from "node:test";
import assert from "node:assert/strict";
import { answerModelRequest } from "../node/models.ts";
import { parseCloudMessage, parseNodeMessage } from "../src/protocol.ts";
import { user, type RelayedRequest } from "../src/codex.ts";
import { modelReply } from "./support.ts";

const request: RelayedRequest = {
  model: "gpt-6-luna",
  system: "Summarize",
  input: [user(["A fact"])],
  cacheKey: "optchat",
  effort: "high",
};
const credentials = async () => ({ access: "token", accountId: "account" });

test("a node answers a relayed model call with its own login, or with the failure", async () => {
  const seen: unknown[] = [];
  const answer = await answerModelRequest(
    "call-1",
    request,
    credentials,
    async (credential, call) => {
      seen.push(credential, call.effort, call.cacheKey, call.signal instanceof AbortSignal);
      return modelReply("user: A fact");
    },
  );
  assert.deepEqual(seen, [{ access: "token", accountId: "account" }, "high", "optchat", true]);
  assert.ok("result" in answer);
  assert.equal(answer.result.text, "user: A fact");
  const failed = await answerModelRequest("call-2", request, credentials, async () => {
    throw new Error("ChatGPT subscription request failed (429): Too Many Requests");
  });
  assert.deepEqual(failed, {
    type: "model_result",
    id: "call-2",
    error: "ChatGPT subscription request failed (429): Too Many Requests",
  });
});

test("relayed model messages round-trip, and a malformed result is rejected", () => {
  const command = parseCloudMessage(
    JSON.stringify({ type: "model_request", id: "call-1", request }),
  );
  assert.deepEqual(command, { type: "model_request", id: "call-1", request });
  assert.throws(
    () =>
      parseCloudMessage(
        JSON.stringify({ type: "model_request", id: "x", request: { ...request, effort: "max" } }),
      ),
    /incomplete/,
  );
  const result = modelReply("user: A fact");
  assert.deepEqual(
    parseNodeMessage(JSON.stringify({ type: "model_result", id: "call-1", result })).type,
    "model_result",
  );
  assert.throws(
    () =>
      parseNodeMessage(
        JSON.stringify({ type: "model_result", id: "call-1", result: { text: 1, output: [] } }),
      ),
    /incomplete model result/,
  );
  assert.deepEqual(parseNodeMessage(JSON.stringify({ type: "node_ready", models: true })), {
    type: "node_ready",
    models: true,
  });
});
