// Phase 3 history import: append the Phase 1 scope-A export to the deployed Master in order, one
// batch at a time, sending the next batch only when the previous one is summarized and no chat turn
// is waiting. Resumable: the progress file counts accepted messages, and the Master skips any it
// already holds (by session and source line).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cloudClient } from "./cloud-client.ts";
import { errorMessage, isRecord } from "../src/json.ts";

const [exportDirectory = "data/phase1-2026-10-05", batchSize = "50"] = process.argv.slice(2);
const size = Number(batchSize);
if (!Number.isSafeInteger(size) || size < 1 || size > 100) {
  throw new Error("A batch holds 1–100 messages");
}
const lines = readFileSync(join(exportDirectory, "import.jsonl"), "utf8").trim().split("\n");
const progressFile = "data/import-progress.json";
const progress: unknown = existsSync(progressFile)
  ? JSON.parse(readFileSync(progressFile, "utf8"))
  : null;
let sent = 0;
if (progress !== null) {
  if (
    typeof progress !== "object" ||
    !("export" in progress) ||
    progress.export !== exportDirectory ||
    !("sent" in progress) ||
    typeof progress.sent !== "number"
  ) {
    throw new Error(`${progressFile} belongs to another export; move it aside to start over`);
  }
  sent = progress.sent;
}

const client = cloudClient();
const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const started = Date.now();
let waitingSince = Date.now();

while (sent < lines.length) {
  let status: Record<string, unknown>;
  try {
    status = await client.request("/api/status");
  } catch (error) {
    console.error(JSON.stringify({ sent, error: errorMessage(error) }));
    await pause(60_000);
    continue;
  }
  if (status["unsummarized"] !== 0 || status["pending"] !== 0) {
    if (Date.now() - waitingSince > 600_000) {
      console.log(JSON.stringify({ sent, waiting: status }));
      waitingSince = Date.now();
    }
    await pause(10_000);
    continue;
  }
  // The Master keys a message by its session and transcript line, as live ingest does, so the
  // session tool can open the transcript where the message is. Phase 1's index is its ordinal.
  const messages = lines.slice(sent, sent + size).map((line) => {
    const message: unknown = JSON.parse(line);
    if (!isRecord(message) || typeof message["line"] !== "number") {
      throw new Error("A Phase 1 message has no transcript line");
    }
    return { ...message, index: message["line"] };
  });
  try {
    const result = await client.request("/api/import", { messages });
    sent += messages.length;
    writeFileSync(progressFile, JSON.stringify({ export: exportDirectory, sent }));
    waitingSince = Date.now();
    console.log(
      JSON.stringify({
        sent,
        of: lines.length,
        messages: result["messages"],
        nodes: result["nodes"],
        hours: +((Date.now() - started) / 3_600_000).toFixed(2),
      }),
    );
  } catch (error) {
    // A turn that started since the status check refuses the batch (409); try again shortly.
    console.error(JSON.stringify({ sent, error: errorMessage(error) }));
    await pause(10_000);
  }
}
console.log(JSON.stringify({ done: true, sent }));
