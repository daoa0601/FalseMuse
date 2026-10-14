import type { SqlDatabase } from "./database.ts";
import { isRecord } from "./json.ts";
import { Computers, SignInNeeded, type ModelSelection } from "./t3.ts";

/** T3 Code's own limit on a thread's writing instructions. */
const INSTRUCTION_CHARS = 4_000;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const SELECT =
  "SELECT name, instructions, computer, project, provider, model, auto, thread, briefed FROM helpers";

export interface Helper {
  name: string;
  instructions: string;
  computer: string;
  project: string;
  provider: string | null;
  model: string | null;
  /** The Master may give it jobs the owner did not ask for. */
  auto: boolean;
  thread: string | null;
}

interface Row extends Omit<Helper, "auto"> {
  auto: number;
  /** Its thread has seen the current instructions. */
  briefed: number;
}

const helper = ({ briefed: _briefed, auto, ...row }: Row): Helper => ({ ...row, auto: auto === 1 });

function optional(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`A helper's ${field} must be text`);
  return value.trim();
}

/** The first message of a job in a thread that has not seen the helper's current instructions. */
function brief(name: string, instructions: string, task: string): string {
  return `You are ${name}, a helper the owner's chief of staff (OptChat) gives jobs to. Your standing instructions:\n<instructions>\n${instructions}\n</instructions>\n\n${task}`;
}

/**
 * Named helpers the owner hires: each has standing instructions, a model, and one long-lived T3
 * Code thread in a project on one of their computers, titled `Helper: <name>`. Jobs queue in that
 * thread, so it keeps its context between them, and each is watched like a launched thread until
 * it reports back. The owner can open the thread and talk to the helper directly.
 */
export class Helpers {
  private readonly database: SqlDatabase;
  private readonly computers: Computers;

  constructor(database: SqlDatabase, computers: Computers) {
    this.database = database;
    this.computers = computers;
    database.exec(`CREATE TABLE IF NOT EXISTS helpers (
      name TEXT PRIMARY KEY, instructions TEXT NOT NULL, computer TEXT NOT NULL,
      project TEXT NOT NULL, provider TEXT, model TEXT, auto INTEGER NOT NULL,
      thread TEXT, briefed INTEGER NOT NULL)`);
  }

  list(): Helper[] {
    return this.database.rows<Row>(`${SELECT} ORDER BY name`).map(helper);
  }

  private row(name: unknown): Row {
    const [row] = this.database.rows<Row>(
      `${SELECT} WHERE name=?`,
      typeof name === "string" ? name : "",
    );
    if (!row) throw new Error(`No helper named ${String(name)}; see helpers`);
    return row;
  }

  /**
   * Hire a helper, or change one: fields left out keep their values. A new computer, project or
   * model starts a new thread at the next job; new instructions go with the next job.
   */
  hire(input: unknown): Helper {
    if (!isRecord(input)) throw new Error("hire needs a helper's name and instructions");
    const name = optional(input, "name") ?? "";
    if (!NAME.test(name)) {
      throw new Error(
        "Name a helper with up to 32 lowercase letters, digits or -, starting with a letter",
      );
    }
    const [earlier] = this.database.rows<Row>(`${SELECT} WHERE name=?`, name);
    const instructions = optional(input, "instructions") ?? earlier?.instructions ?? "";
    if (!instructions) throw new Error(`${name} needs instructions`);
    if (instructions.length > INSTRUCTION_CHARS) {
      throw new Error("Keep a helper's instructions to 4,000 characters");
    }
    const computer = optional(input, "computer") ?? earlier?.computer ?? "";
    if (!this.computers.list().some((entry) => entry.name === computer)) {
      throw new Error(`No computer named ${computer}; see computers`);
    }
    const project = optional(input, "project") ?? earlier?.project ?? "";
    if (!project) throw new Error(`${name} needs a project on ${computer}`);
    const provider = optional(input, "provider") ?? earlier?.provider ?? null;
    const model = optional(input, "model") ?? earlier?.model ?? null;
    if (!provider !== !model) {
      throw new Error("Give both a provider and a model, or neither for the project's default");
    }
    const auto = typeof input["auto"] === "boolean" ? input["auto"] : earlier?.auto === 1;
    const moved =
      !earlier ||
      earlier.computer !== computer ||
      earlier.project !== project ||
      earlier.provider !== provider ||
      earlier.model !== model;
    const thread = moved ? null : (earlier?.thread ?? null);
    const briefed = moved || earlier?.instructions !== instructions ? 0 : (earlier?.briefed ?? 0);
    this.database.exec(
      `INSERT INTO helpers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET
        instructions=excluded.instructions, computer=excluded.computer, project=excluded.project,
        provider=excluded.provider, model=excluded.model, auto=excluded.auto,
        thread=excluded.thread, briefed=excluded.briefed`,
      name,
      instructions,
      computer,
      project,
      provider,
      model,
      auto ? 1 : 0,
      thread,
      briefed,
    );
    return helper(this.row(name));
  }

  /**
   * Give a helper a job. It queues in the helper's thread, or starts the thread if there is none or
   * the old one is gone; `request` is the tool call's id, so a resumed turn's repeat is a no-op.
   */
  async delegate(name: unknown, task: string, request: string) {
    const row = this.row(name);
    if (!task.trim()) throw new Error("delegate needs a task");
    const job = row.briefed ? task : brief(row.name, row.instructions, task);
    if (row.thread) {
      try {
        await this.computers.send(row.computer, row.thread, job, "queue", request);
        this.database.exec(
          "UPDATE helpers SET briefed=1 WHERE name=? AND thread=?",
          row.name,
          row.thread,
        );
        return { helper: row.name, thread: row.thread, started: false };
      } catch (error) {
        if (error instanceof SignInNeeded) throw error;
        // Only a thread the computer can no longer read is replaced; other failures are reported.
        const readable = await this.computers.read(row.computer, row.thread, undefined, 1).then(
          () => true,
          (readError: unknown) => {
            if (readError instanceof SignInNeeded) throw readError;
            return false;
          },
        );
        if (readable) throw error;
      }
    }
    const modelSelection: ModelSelection | undefined =
      row.provider && row.model ? { instanceId: row.provider, model: row.model } : undefined;
    const result = await this.computers.launch(
      row.computer,
      row.project,
      `Helper: ${row.name}`,
      brief(row.name, row.instructions, task),
      request,
      modelSelection,
    );
    const thread = isRecord(result) ? result["threadId"] : undefined;
    if (typeof thread !== "string") throw new Error("t3_thread_launch returned no threadId");
    this.database.exec("UPDATE helpers SET thread=?, briefed=1 WHERE name=?", thread, row.name);
    return { helper: row.name, thread, started: true };
  }

  /** Forget a helper; its thread stays in T3 Code. */
  retire(name: unknown): { retired: string } {
    const row = this.row(name);
    this.database.exec("DELETE FROM helpers WHERE name=?", row.name);
    return { retired: row.name };
  }
}
