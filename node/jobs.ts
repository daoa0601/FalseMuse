import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  unlinkSync,
  existsSync,
  truncateSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import type { SpawnCommand } from "../src/protocol.ts";
import type { ProcessHandle } from "./process.ts";

/** A task's durable state on its node, so a restarted daemon resumes or republishes it. */
export interface JobSnapshot {
  command: SpawnCommand;
  sessionFile: string;
  state: "starting" | "running" | "settled";
  actor: ProcessHandle | null;
  report: string;
  failure: string | null;
  aborted: boolean;
  steering: string[];
  unreadableTranscript?: boolean;
}

export class JobJournal {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  private file(id: string): string {
    if (!/^[\w-]{1,200}$/.test(id)) throw new Error("Invalid task ID");
    return join(this.directory, id + ".json");
  }

  private read(file: string): JobSnapshot {
    // The daemon wrote this snapshot itself with save().
    return JSON.parse(readFileSync(file, "utf8")) as JobSnapshot;
  }

  get(id: string): JobSnapshot | null {
    return existsSync(this.file(id)) ? this.read(this.file(id)) : null;
  }

  all(): JobSnapshot[] {
    return readdirSync(this.directory)
      .filter((file) => file.endsWith(".json"))
      .map((file) => this.read(join(this.directory, file)));
  }

  save(job: JobSnapshot): void {
    const temporary = this.file(job.command.id) + ".tmp";
    writeFileSync(temporary, JSON.stringify(job), { mode: 0o600, flush: true });
    renameSync(temporary, this.file(job.command.id));
  }

  remove(id: string): void {
    try {
      unlinkSync(this.file(id));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
}

/** Keep complete JSONL records; set an unfinished last record aside before Pi reopens the file. */
export function prepareSession(file: string): void {
  if (!existsSync(file)) return;
  const source = readFileSync(file);
  const boundary = source.lastIndexOf(10) + 1;
  const complete = source.subarray(0, boundary).toString("utf8").split("\n").filter(Boolean);
  complete.forEach((line, index) => {
    try {
      JSON.parse(line);
    } catch (cause) {
      throw new Error(
        `Pi session ${file}:${index + 1} contains an invalid complete record; repair it before resuming`,
        { cause },
      );
    }
  });
  if (boundary === source.length) return;
  try {
    JSON.parse(source.subarray(boundary).toString("utf8"));
    appendFileSync(file, "\n", { flush: true });
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    writeFileSync(
      file + ".interrupted-" + crypto.randomUUID() + ".tail",
      source.subarray(boundary),
      {
        mode: 0o600,
        flush: true,
        flag: "wx",
      },
    );
    truncateSync(file, boundary);
  }
}
