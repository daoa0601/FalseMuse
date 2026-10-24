import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { PiRpc, type PiEvent } from "./pi-rpc.ts";
import { JobJournal, prepareSession, type JobSnapshot } from "./jobs.ts";
import { processHandle, processRunning } from "./process.ts";
import type { NodeConfig } from "./config.ts";
import { errorMessage, isRecord } from "../src/json.ts";
import { quotaHeaders } from "../src/usage.ts";
import type { NodeMessage, PermissionRequest, SpawnCommand } from "../src/protocol.ts";

interface RunningJob {
  snapshot: JobSnapshot;
  rpc: PiRpc | null;
  finished: boolean;
  permissions: Map<string, PermissionRequest>;
}

const RESUME_PROMPT =
  "The node daemon restarted. Continue the original task using this session's recorded results. Inspect current state before repeating an operation whose result is uncertain. Every new bash, edit, or write still needs owner approval.";

/** Runs approved tasks as Pi RPC sessions and publishes their scanned transcripts and reports. */
export class TaskRunner {
  readonly journal: JobJournal;
  private readonly config: NodeConfig;
  private readonly send: (message: NodeMessage) => void;
  private readonly roots: string[];
  private readonly directory: string;
  private readonly sessions: string;
  private readonly profile: string;
  private readonly jobs = new Map<string, RunningJob>();

  constructor(config: NodeConfig, send: (message: NodeMessage) => void) {
    this.config = config;
    this.send = send;
    this.roots = config.roots.map((root) => realpathSync(root));
    this.directory = resolve(config.directory ?? "data");
    this.sessions = join(this.directory, "node-sessions");
    this.profile = join(this.directory, "node-agent");
    this.journal = new JobJournal(join(this.directory, "node-jobs"));
    mkdirSync(this.sessions, { recursive: true, mode: 0o700 });
    this.saveRuntime();
  }

  private saveRuntime(): void {
    writeFileSync(
      join(this.directory, "runtime.json"),
      JSON.stringify({ pid: process.pid, jobs: this.jobs.size }),
      { mode: 0o600 },
    );
  }

  replay(): void {
    for (const saved of this.journal.all()) {
      if (saved.state === "settled") void this.spawn(saved.command);
    }
    for (const job of this.jobs.values()) {
      for (const permission of job.permissions.values()) this.send(permission);
    }
  }

  async spawn(command: SpawnCommand): Promise<void> {
    if (
      this.jobs.has(command.id) ||
      existsSync(join(this.directory, "node-outbox", command.id + ".json"))
    ) {
      return;
    }
    const saved = this.journal.get(command.id);
    const directory = join(this.sessions, command.id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const snapshot: JobSnapshot = saved ?? {
      command,
      sessionFile: join(directory, "session.jsonl"),
      state: "starting",
      actor: null,
      report: "",
      failure: null,
      aborted: false,
      steering: [],
    };
    const job: RunningJob = { snapshot, rpc: null, finished: false, permissions: new Map() };
    this.jobs.set(command.id, job);
    this.journal.save(snapshot);
    this.saveRuntime();
    try {
      while (processRunning(snapshot.actor)) await new Promise((wait) => setTimeout(wait, 500));
      prepareSession(snapshot.sessionFile);
      if (snapshot.state === "settled" || snapshot.aborted) {
        snapshot.state = "settled";
        this.journal.save(snapshot);
        await this.publish(command.id);
        return;
      }
      await this.authenticate();
      if (snapshot.aborted) {
        await this.finish(command.id);
        return;
      }
      const cwd = realpathSync(command.cwd);
      if (!this.roots.some((root) => cwd === root || cwd.startsWith(root + "/"))) {
        throw new Error("Working directory is outside this node's allowed roots");
      }
      const resumed = Boolean(saved || command.resume);
      if (resumed) this.send({ type: "resume_job", id: crypto.randomUUID(), job: command.id });
      if (!existsSync(snapshot.sessionFile)) {
        writeFileSync(snapshot.sessionFile, "", { mode: 0o600, flush: true });
      }
      const rpc = new PiRpc({
        cwd,
        sessionDirectory: directory,
        sessionFile: snapshot.sessionFile,
        tools: this.config.tools,
        agentDirectory: this.profile,
      });
      job.rpc = rpc;
      rpc.on("fault", (error) => {
        snapshot.failure = error.message;
        void this.finish(command.id);
      });
      rpc.on("exit", (code) => {
        if (!job.finished) {
          snapshot.failure = `Pi exited before settling (${code})`;
          void this.finish(command.id);
        }
      });
      rpc.on("event", (event) => this.event(command.id, event));
      await rpc.ready;
      if (snapshot.aborted) {
        await this.finish(command.id);
        return;
      }
      if (rpc.child.pid === undefined) throw new Error("Pi exited before the task could start");
      snapshot.actor = processHandle(rpc.child.pid);
      if (!snapshot.actor) throw new Error("Pi exited before the task could start");
      snapshot.state = "running";
      snapshot.failure = null;
      snapshot.report = "";
      this.journal.save(snapshot);
      const message = resumed
        ? `${RESUME_PROMPT}\n\nOriginal task:\n${command.task}\n\nAdditional instructions:\n${snapshot.steering.join("\n")}`
        : `${command.view}\n\nTask:\n${command.task}\n\nWork within the allowed directory. Report the result, what changed, and any limits.`;
      const result = await rpc.command("prompt", { message });
      if (isRecord(result) && result["disposition"] === "handled") {
        snapshot.failure = "Pi handled the input without starting a task";
        await this.finish(command.id);
      }
    } catch (error) {
      snapshot.failure = errorMessage(error);
      await this.finish(command.id);
    }
  }

  private async authenticate(): Promise<void> {
    const file = join(this.profile, "auth.json");
    if (!existsSync(file)) {
      throw new Error(
        "This node needs its own subscription login. Run node node/login.ts in the OptChat repository.",
      );
    }
  }

  private event(id: string, event: PiEvent): void {
    const job = this.jobs.get(id);
    if (!job || job.finished) return;
    const snapshot = job.snapshot;
    if (event.type === "optchat_model_call") {
      const { id: callId, model, date, usage, quota } = event;
      if (typeof callId === "string" && typeof model === "string" && typeof date === "string") {
        this.send({
          type: "model_call",
          id: callId,
          job: id,
          date,
          model,
          usage,
          quota: quotaHeaders(quota),
        });
      }
    }
    if (
      event.type === "extension_ui_request" &&
      event["method"] === "confirm" &&
      typeof event["id"] === "string"
    ) {
      const permission: PermissionRequest = {
        type: "permission_request",
        job: id,
        id: event["id"],
        title: String(event["title"] ?? ""),
        message: String(event["message"] ?? ""),
      };
      job.permissions.set(permission.id, permission);
      this.send(permission);
    }
    const message = event["message"];
    if (event.type === "message_end" && isRecord(message) && message["role"] === "assistant") {
      const stopReason = message["stopReason"];
      if (stopReason === "error") {
        snapshot.failure =
          typeof message["errorMessage"] === "string"
            ? message["errorMessage"]
            : "Pi model call failed";
      } else if (stopReason === "aborted") snapshot.aborted = true;
      else snapshot.failure = null;
      if (stopReason === "stop" && Array.isArray(message["content"])) {
        snapshot.report = message["content"]
          .filter(
            (part): part is { type: "text"; text: string } =>
              isRecord(part) && part["type"] === "text" && typeof part["text"] === "string",
          )
          .map((part) => part.text)
          .join("\n");
      }
      this.journal.save(snapshot);
    }
    if (event.type === "agent_settled") void this.finish(id);
  }

  permission(command: { job: string; id: string; allowed: boolean }): void {
    const job = this.jobs.get(command.job);
    if (!job?.rpc || !job.permissions.has(command.id)) return;
    job.rpc.permission(command.id, command.allowed);
    job.permissions.delete(command.id);
    this.send({ type: "permission_received", job: command.job, id: command.id });
  }

  async steer(id: string, message: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) throw new Error("That task is not running on this node");
    job.snapshot.steering.push(message);
    this.journal.save(job.snapshot);
    if (job.rpc) await job.rpc.command("steer", { message });
  }

  async abort(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) throw new Error("That task is not running on this node");
    job.snapshot.aborted = true;
    this.journal.save(job.snapshot);
    if (job.rpc) await job.rpc.command("abort");
    else if (job.snapshot.actor && processRunning(job.snapshot.actor)) {
      process.kill(job.snapshot.actor.pid, "SIGTERM");
    }
  }

  private async finish(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job || job.finished) return;
    job.finished = true;
    job.snapshot.state = "settled";
    if (!job.snapshot.aborted && !job.snapshot.failure && !job.snapshot.report.trim()) {
      job.snapshot.failure = "Pi settled without a final text report";
    }
    this.journal.save(job.snapshot);
    if (job.rpc) {
      job.rpc.close();
      await job.rpc.exited;
    }
    try {
      prepareSession(job.snapshot.sessionFile);
    } catch (error) {
      job.snapshot.failure = errorMessage(error);
      job.snapshot.unreadableTranscript = true;
      this.journal.save(job.snapshot);
    }
    await this.publish(id);
  }

  /** Scan and upload the transcript, then send the report; retried until it succeeds. */
  private async publish(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    const snapshot = job.snapshot;
    try {
      const directory = join(this.sessions, id);
      const reportFile = join(directory, "report.txt");
      writeFileSync(
        reportFile,
        snapshot.aborted ? "This task was aborted." : (snapshot.failure ?? snapshot.report),
        { mode: 0o600 },
      );
      const output = join(directory, "redacted");
      execFileSync(
        "python3",
        [
          "-m",
          "node.redact",
          snapshot.sessionFile,
          reportFile,
          output,
          ...(snapshot.unreadableTranscript ? ["--report-only"] : []),
        ],
        { cwd: resolve("."), stdio: ["ignore", "ignore", "pipe"] },
      );
      const transcript = join(output, "transcript.jsonl");
      if (existsSync(transcript)) {
        const response = await fetch(
          this.config.url + "/node/transcript?session=" + encodeURIComponent(id),
          {
            method: "PUT",
            headers: { authorization: `Bearer ${this.config.key}` },
            body: readFileSync(transcript),
          },
        );
        if (!response.ok) throw new Error(`Transcript upload failed (${response.status})`);
      }
      const scanned: unknown = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
      const text = isRecord(scanned) ? scanned["text"] : undefined;
      const report =
        typeof text === "string"
          ? text
          : "The local secret scanner withheld this report. Inspect the node's private session before retrying the task.";
      const status = snapshot.aborted
        ? "aborted"
        : snapshot.failure || typeof text !== "string"
          ? "failed"
          : "done";
      this.send({ type: "report", id, report, status });
      this.jobs.delete(id);
      this.saveRuntime();
    } catch (error) {
      console.error(`Task ${id} remains ready to publish: ${errorMessage(error)}`);
      setTimeout(() => void this.publish(id), 10_000);
    }
  }

  acknowledge(id: string): void {
    this.journal.remove(id);
  }
}
