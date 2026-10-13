// Upload every main and subagent transcript of a Phase 1 export to R2, for the session and
// transcript tools. Restartable: a finished session answers complete, and a started one resumes
// from its accepted parts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cloudClient } from "./cloud-client.ts";
import { uploadTranscript } from "./upload-transcript.ts";
import { errorMessage, isRecord } from "../src/json.ts";

const [exportDirectory = "data/phase1-2026-10-05"] = process.argv.slice(2);
const sessions = readFileSync(join(exportDirectory, "manifest.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line): unknown => JSON.parse(line))
  .filter(
    (entry): entry is { session: string; kind: string; transcript: string } =>
      isRecord(entry) &&
      typeof entry["session"] === "string" &&
      typeof entry["transcript"] === "string" &&
      entry["kind"] !== "harness",
  );
const client = cloudClient();
let done = 0;
let failed = 0;
for (const { session, transcript } of sessions) {
  for (let attempt = 0; ; attempt++) {
    try {
      await uploadTranscript(client, join(exportDirectory, transcript), session);
      break;
    } catch (error) {
      if (attempt >= 3) {
        failed++;
        console.error(JSON.stringify({ session, error: errorMessage(error) }));
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 30_000 * (attempt + 1)));
    }
  }
  if (++done % 100 === 0 || done === sessions.length) {
    console.log(JSON.stringify({ done, of: sessions.length, failed }));
  }
}
