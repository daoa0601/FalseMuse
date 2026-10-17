import type { SqlDatabase } from "./database.ts";
import { isRecord } from "./json.ts";
import { Computers, SignInNeeded, type ModelSelection } from "./t3.ts";

/** T3 Code's own limit on a thread's writing instructions. */
const INSTRUCTION_CHARS = 4_000;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const SELECT =
  "SELECT name, instructions, computer, project, provider, model, auto, thread, briefed FROM helpers";
/** Log entries kept per helper, and how many of them a new thread is given. */
const LOG_KEPT = 20;
const HANDOFF_ENTRIES = 8;
const HANDOFF_CHARS = 1_000;

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

const selection = (row: Pick<Row, "provider" | "model">): ModelSelection | undefined =>
  row.provider && row.model ? { instanceId: row.provider, model: row.model } : undefined;

/**
 * Named helpers the owner hires: each has standing instructions, a model, and one long-lived T3
 * Code thread in a project on one of their computers, titled `Helper: <name>`. Jobs queue in that
 * thread, so it keeps its context between them, and each is watched like a launched thread until
 * it reports back. The owner can open the thread and talk to the helper directly. Each helper's
 * recent jobs and results are kept, so a thread that replaces a lost one starts from them.
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
    // A job is logged once per tool call id, so a resumed turn's repeat adds nothing.
    database.exec(`CREATE TABLE IF NOT EXISTS helper_log (
      id INTEGER PRIMARY KEY, helper TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
      request TEXT UNIQUE)`);
  }

  list(): Helper[] {
    return this.database.rows<Row>(`${SELECT} ORDER BY name`).map(helper);
  }

  private find(name: string): Row | undefined {
    return this.database.rows<Row>(`${SELECT} WHERE name=?`, name)[0];
  }

  private row(name: unknown): Row {
    const row = typeof name === "string" ? this.find(name) : undefined;
    if (!row) throw new Error(`No helper named ${String(name)}; see helpers`);
    return row;
  }

  /**
   * Hire a helper, or change one: fields left out keep their values, and an empty provider and
   * model return it to the project's default. The project is checked on the computer and kept by
   * id. A model is checked against what the computer offers, and switches the helper's thread in
   * place. A new computer or project, or `fresh`, starts a new thread at the next job; new
   * instructions go with the next job.
   */
  async hire(input: unknown): Promise<Helper> {
    if (!isRecord(input)) throw new Error("hire needs a helper's name and instructions");
    const name = optional(input, "name") ?? "";
    if (!NAME.test(name)) {
      throw new Error(
        "Name a helper with up to 32 lowercase letters, digits or -, starting with a letter",
      );
    }
    const earlier = this.find(name);
    const instructions = optional(input, "instructions") ?? earlier?.instructions ?? "";
    if (!instructions) throw new Error(`${name} needs instructions`);
    if (instructions.length > INSTRUCTION_CHARS) {
      throw new Error("Keep a helper's instructions to 4,000 characters");
    }
    const computer = optional(input, "computer") ?? earlier?.computer ?? "";
    if (!this.computers.list().some((entry) => entry.name === computer)) {
      throw new Error(`No computer named ${computer}; see computers`);
    }
    const named = optional(input, "project") ?? earlier?.project ?? "";
    if (!named) throw new Error(`${name} needs a project on ${computer}`);
    // Kept by id, so another name for the same project keeps the thread.
    const project =
      earlier?.computer === computer && named === earlier.project
        ? named
        : await this.computers.project(computer, named);
    // Empty text clears the model back to the project's default; leaving it out keeps it.
    const chosen = (field: "provider" | "model") => {
      const value = optional(input, field);
      return value === undefined ? (earlier?.[field] ?? null) : value || null;
    };
    const provider = chosen("provider");
    const model = chosen("model");
    if (!provider !== !model) {
      throw new Error("Give both a provider and a model, or neither for the project's default");
    }
    const placed = earlier?.computer === computer && earlier.project === project;
    const sameModel = earlier?.provider === provider && earlier.model === model;
    if (provider && model && !(placed && sameModel)) await this.offered(computer, provider, model);
    let thread = placed && input["fresh"] !== true ? (earlier.thread ?? null) : null;
    const wanted = selection({ provider, model });
    if (thread && !sameModel) {
      if (wanted) {
        try {
          await this.computers.configure(computer, thread, wanted);
        } catch (error) {
          if (error instanceof SignInNeeded) throw error;
          // A thread that cannot switch is replaced at the next job.
          thread = null;
        }
      } else {
        // T3 Code takes no selection back to the project's default: start again on it.
        thread = null;
      }
    }
    const briefed = thread && earlier?.instructions === instructions ? earlier.briefed : 0;
    const auto = typeof input["auto"] === "boolean" ? input["auto"] : earlier?.auto === 1;
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

  /** Refuse a provider instance or model the computer does not offer, naming what it does. */
  private async offered(computer: string, provider: string, model: string): Promise<void> {
    const providers = await this.computers.models(computer);
    const entry = providers.find((candidate) => candidate.provider === provider);
    if (!entry) {
      throw new Error(
        `${computer} has no provider ${provider}; it has ${providers.map((candidate) => candidate.provider).join(", ")}`,
      );
    }
    if (!entry.models.includes(model)) {
      throw new Error(
        `${provider} on ${computer} has no model ${model}; it has ${entry.models.join(", ")}`,
      );
    }
  }

  /** The first message of a job in a thread that has not seen the helper's current instructions. */
  private brief(row: Row, task: string, history: string | null): string {
    const handoff = history
      ? `This is a new thread. Your recent jobs and their results, oldest first:\n<history>\n${history}\n</history>\n\n`
      : "";
    return `You are ${row.name}, a helper the owner's chief of staff (OptChat) gives jobs to. Your standing instructions:\n<instructions>\n${row.instructions}\n</instructions>\n\n${handoff}${task}`;
  }

  /** The helper's most recent jobs and results, for a thread that starts without them. */
  private history(name: string): string | null {
    const entries = this.database.rows<{ kind: string; text: string }>(
      "SELECT kind, text FROM helper_log WHERE helper=? ORDER BY id DESC LIMIT ?",
      name,
      HANDOFF_ENTRIES,
    );
    if (!entries.length) return null;
    return entries
      .reverse()
      .map(
        ({ kind, text }) =>
          `${kind === "job" ? "Job" : "Result"}: ${text.replace(/\s+/g, " ").slice(0, HANDOFF_CHARS)}`,
      )
      .join("\n");
  }

  private log(name: string, kind: "job" | "result", text: string, request: string | null): void {
    this.database.exec(
      "INSERT INTO helper_log(helper, kind, text, request) VALUES (?, ?, ?, ?) ON CONFLICT(request) DO NOTHING",
      name,
      kind,
      text,
      request,
    );
    this.database.exec(
      "DELETE FROM helper_log WHERE helper=? AND id NOT IN (SELECT id FROM helper_log WHERE helper=? ORDER BY id DESC LIMIT ?)",
      name,
      name,
      LOG_KEPT,
    );
  }

  /** Keep a finished thread's report if it is a helper's current thread. */
  record(finished: { computer: string; thread: string }, report: string): void {
    const [row] = this.database.rows<{ name: string }>(
      "SELECT name FROM helpers WHERE computer=? AND thread=?",
      finished.computer,
      finished.thread,
    );
    if (row) this.log(row.name, "result", report, null);
  }

  /**
   * Give a helper a job. It queues in the helper's thread, or starts the thread if there is none or
   * the old one is gone; `request` is the tool call's id, so a resumed turn's repeat is a no-op.
   */
  async delegate(name: unknown, task: string, request: string) {
    const row = this.row(name);
    if (!task.trim()) throw new Error("delegate needs a task");
    // A repeat of a call that started the thread gets that launch back, not a second copy of the job.
    if (row.thread && !this.computers.launched(request)) {
      try {
        const job = row.briefed ? task : this.brief(row, task, null);
        await this.computers.send(row.computer, row.thread, job, "queue", request);
        this.database.exec(
          "UPDATE helpers SET briefed=1 WHERE name=? AND thread=?",
          row.name,
          row.thread,
        );
        this.log(row.name, "job", task, request);
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
    const result = await this.computers.launch(
      row.computer,
      row.project,
      `Helper: ${row.name}`,
      this.brief(row, task, this.history(row.name)),
      request,
      selection(row),
    );
    const thread = isRecord(result) ? result["threadId"] : undefined;
    if (typeof thread !== "string") throw new Error("t3_thread_launch returned no threadId");
    this.database.exec("UPDATE helpers SET thread=?, briefed=1 WHERE name=?", thread, row.name);
    this.log(row.name, "job", task, request);
    return { helper: row.name, thread, started: true };
  }

  /** Forget a helper and its log; its thread stays in T3 Code. */
  retire(name: unknown): { retired: string } {
    const row = this.row(name);
    this.database.transaction(() => {
      this.database.exec("DELETE FROM helpers WHERE name=?", row.name);
      this.database.exec("DELETE FROM helper_log WHERE helper=?", row.name);
    });
    return { retired: row.name };
  }
}
