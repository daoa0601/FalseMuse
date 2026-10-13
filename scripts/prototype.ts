import { readFileSync, mkdirSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../node/sqlite.ts";
import { Memory, isMessageKind, type NewMessage } from "../src/memory.ts";
import { pump } from "../src/compact.ts";
import { codexCall, isReasoningEffort, type Credential } from "../src/codex.ts";
import { allowsCompaction, quotaHeaders, type Quota } from "../src/usage.ts";
import { errorMessage, isRecord } from "../src/json.ts";
import { localAuth } from "../node/local-auth.ts";
import { cloudClient } from "./cloud-client.ts";

const [month = "2026-09", model = "gpt-6-luna", callLimit = "30", quotaSource = "local", label] =
  process.argv.slice(2);
if (quotaSource !== "local" && quotaSource !== "cloud") {
  throw new Error("Use cloud to start from the deployed ledger's quota, or local");
}
if (label !== undefined && !/^[\w-]+$/.test(label)) throw new Error("A run label is a word");
const effort = process.env["COMPACTOR_EFFORT"] ?? "high";
if (!isReasoningEffort(effort)) throw new Error("COMPACTOR_EFFORT is low, medium, high or xhigh");
const maxPaidNodes = Number(callLimit);
if (!Number.isSafeInteger(maxPaidNodes) || maxPaidNodes < 0) {
  throw new Error("The paid-node limit must be a nonnegative integer");
}

/** One line of the Phase 1 scope-A export. */
type ExportedMessage = NewMessage & { session: string; timestamp: string };

function exportedMessage(line: string): ExportedMessage {
  const value: unknown = JSON.parse(line);
  if (
    !isRecord(value) ||
    !isMessageKind(value["kind"]) ||
    typeof value["text"] !== "string" ||
    typeof value["session"] !== "string" ||
    typeof value["timestamp"] !== "string"
  ) {
    throw new Error("The Phase 1 import has a malformed message");
  }
  const index = value["index"];
  return {
    kind: value["kind"],
    text: value["text"],
    session: value["session"],
    timestamp: value["timestamp"],
    ...(typeof index === "number" ? { index } : {}),
  };
}

/** The quota recorded by the last logged call, so a restart resumes its guard. */
function lastLoggedQuota(log: string): Quota {
  if (!existsSync(log)) return {};
  const last = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).at(-1);
  if (!last) return {};
  const entry: unknown = JSON.parse(last);
  const attempts = isRecord(entry) ? entry["attempts"] : undefined;
  const attempt: unknown = Array.isArray(attempts) ? attempts.at(-1) : undefined;
  return isRecord(attempt) ? quotaHeaders(attempt["quota"]) : {};
}

const directory = join("data", `prototype-${month}-${model}${label ? `-${label}` : ""}`);
mkdirSync(directory, { recursive: true });
const database = openDatabase(join(directory, "memory.sqlite"));
const memory = new Memory(database);
const messages = readFileSync("data/phase1-2026-10-05/import.jsonl", "utf8")
  .trim()
  .split("\n")
  .map(exportedMessage);
const sessions = new Set(
  messages
    .filter((message) => message.timestamp.startsWith(month))
    .map((message) => message.session),
);
for (const message of messages.filter((item) => sessions.has(item.session))) memory.append(message);
const log = join(directory, "calls.jsonl");
let quota = lastLoggedQuota(log);
if (quotaSource === "cloud") {
  const observation = await cloudClient().request("/api/usage");
  quota = quotaHeaders(observation["quota"]);
  writeFileSync(
    join(directory, "initial-quota.json"),
    JSON.stringify({
      observedAt: new Date().toISOString(),
      source: "deployed-usage-ledger",
      quota,
    }),
    { mode: 0o600 },
  );
}
let credentials: (() => Promise<Credential>) | undefined;
console.log(
  JSON.stringify({
    month,
    model,
    effort,
    messages: memory.count,
    nodes: memory.nodeCount,
    maxPaidNodes,
  }),
);
// A pump round ends when every remaining node waits to retry (for example after 429s); wait for
// the retries, and give up after five minutes without progress.
const result = { built: 0, paidNodes: 0, calls: 0, settled: false };
for (let idle = 0; idle < 30 && !result.settled;) {
  const round = await pump(
    memory,
    async (request) => {
      credentials ??= await localAuth();
      return codexCall(await credentials(), {
        ...request,
        model,
        cacheKey: `optchat-compact-${month}-${model}`,
        effort,
        signal: AbortSignal.timeout(180_000),
      });
    },
    {
      maxPaidNodes: maxPaidNodes - result.paidNodes,
      canBuildPaidNode: () => allowsCompaction(quota),
      onResult(part, compressed) {
        const last = compressed.attempts.at(-1);
        if (!last) return;
        quota = last.quota;
        appendFileSync(
          log,
          JSON.stringify({ date: new Date().toISOString(), ...part, ...compressed }) + "\n",
        );
        console.log(
          JSON.stringify({ ...part, attempts: compressed.attempts.length, bytes: last.bytes }),
        );
      },
      onError(error, part) {
        console.error(JSON.stringify({ ...part, error: errorMessage(error) }));
      },
    },
  );
  result.built += round.built;
  result.paidNodes += round.paidNodes;
  result.calls += round.calls;
  result.settled = round.settled;
  if (result.paidNodes >= maxPaidNodes || !allowsCompaction(quota)) break;
  idle = round.built > 0 ? 0 : idle + 1;
  if (!round.settled) await new Promise((resolve) => setTimeout(resolve, 10_000));
}
writeFileSync(join(directory, "view.txt"), memory.render());
console.log(
  JSON.stringify({
    ...result,
    quotaPaused: !allowsCompaction(quota),
    nodes: memory.nodeCount,
    viewBytes: memory.size(),
    contextBytes: memory.size(memory.contextView),
  }),
);
database.close();
