import type { SqlDatabase } from "./database.ts";
import { isRecord } from "./json.ts";
import type { Memory } from "./memory.ts";

export interface Recording {
  session: string;
  machine: string;
  transcript: string;
  kind: "main" | "subagent" | "harness";
}

const RECORDING_KINDS = ["main", "subagent", "harness"] as const;
const LIVE_KINDS = ["user", "talk", "work"] as const;
type LiveKind = (typeof LIVE_KINDS)[number];
const isLiveKind = (value: unknown): value is LiveKind => LIVE_KINDS.some((kind) => kind === value);

interface LiveMessage {
  kind: LiveKind;
  text: string;
  line: number;
  timestamp: string;
}

function liveMessages(value: unknown): LiveMessage[] {
  if (!Array.isArray(value) || value.length > 1000) {
    throw new Error("Send at most 1000 completed messages in one batch");
  }
  let previous = 0;
  return value.map((message: unknown) => {
    const kind = isRecord(message) ? message["kind"] : undefined;
    if (
      !isRecord(message) ||
      !isLiveKind(kind) ||
      typeof message["text"] !== "string" ||
      typeof message["line"] !== "number" ||
      !Number.isSafeInteger(message["line"]) ||
      message["line"] <= previous ||
      typeof message["timestamp"] !== "string" ||
      !Number.isFinite(Date.parse(message["timestamp"]))
    ) {
      throw new Error(
        "Send complete messages in source-line order, with their original timestamps",
      );
    }
    previous = message["line"];
    return {
      kind,
      text: message["text"],
      line: message["line"],
      timestamp: message["timestamp"],
    };
  });
}

/** Hand-run sessions that nodes upload; each belongs to the node that registered it. */
export class Recordings {
  private readonly database: SqlDatabase;
  private readonly memory: Memory;

  constructor(database: SqlDatabase, memory: Memory) {
    this.database = database;
    this.memory = memory;
    database.exec(
      "CREATE TABLE IF NOT EXISTS recordings (session TEXT PRIMARY KEY, machine TEXT NOT NULL, transcript TEXT NOT NULL, kind TEXT NOT NULL)",
    );
  }

  register(machine: string, input: unknown): Recording {
    const session = isRecord(input) ? input["session"] : undefined;
    const kind = isRecord(input) ? input["kind"] : undefined;
    if (
      typeof session !== "string" ||
      !/^(codex|claude|prime|pi)\/[\w.-]+$/.test(session) ||
      session.includes("..")
    ) {
      throw new Error("Use a native source and session ID");
    }
    if (!RECORDING_KINDS.some((known) => known === kind)) throw new Error("Unknown recording kind");
    const existing = this.get(session);
    if (existing) {
      if (existing.machine !== machine) throw new Error("That recording belongs to another node");
      return existing;
    }
    const transcript = `live/${machine}/${session}`;
    this.database.exec(
      "INSERT INTO recordings VALUES (?, ?, ?, ?)",
      session,
      machine,
      transcript,
      String(kind),
    );
    const created = this.get(session);
    if (!created) throw new Error("The recording was not stored");
    return created;
  }

  get(session: unknown): Recording | undefined {
    if (typeof session !== "string") return undefined;
    return this.database.rows<Recording>("SELECT * FROM recordings WHERE session=?", session)[0];
  }

  ownsTranscript(machine: string, key: string): boolean {
    return (
      this.database.rows("SELECT 1 FROM recordings WHERE machine=? AND transcript=?", machine, key)
        .length > 0
    );
  }

  append(machine: string, input: unknown): { appended: number; messages: number } {
    const session = isRecord(input) ? input["session"] : undefined;
    const recording = this.get(session);
    if (!recording || recording.machine !== machine) {
      throw new Error("Register this recording on its node first");
    }
    const messages = liveMessages(isRecord(input) ? input["messages"] : undefined);
    if (recording.kind !== "main" && messages.length) {
      throw new Error("Only main recordings enter memory");
    }
    const before = this.memory.count;
    // This synchronous append has no await where another session can interleave.
    for (const message of messages) {
      this.memory.append({
        kind: message.kind,
        text: message.text,
        timestamp: message.timestamp,
        session: recording.session,
        index: message.line,
      });
    }
    return { appended: this.memory.count - before, messages: this.memory.count };
  }
}
