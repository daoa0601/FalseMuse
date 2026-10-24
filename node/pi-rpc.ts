import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";
import type { RpcCommand } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../src/json.ts";

/** One stdout record from `pi --mode rpc`, or the usage observation our extension relays. */
export interface PiEvent {
  readonly type: string;
  readonly [field: string]: unknown;
}

export interface PiRpcOptions {
  cwd: string;
  sessionDirectory: string;
  sessionFile?: string;
  tools: string[];
  agentDirectory: string;
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface PiRpcEvents {
  event: [PiEvent];
  fault: [Error];
  exit: [number | null];
}

const extension = (name: string) => fileURLToPath(new URL(`./${name}`, import.meta.url));

/**
 * A Pi RPC child that receives no prompt until our permission and usage extensions confirm
 * startup. Any extension failure stops the child.
 */
export class PiRpc extends EventEmitter<PiRpcEvents> {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<void>;
  readonly exited: Promise<unknown>;
  private readonly pending = new Map<string, Pending>();
  private readonly requiredExtensions: Set<string>;
  private readonly startupTimeout: NodeJS.Timeout;
  private resolveReady: () => void = () => {};
  private rejectReady: (error: Error) => void = () => {};
  private failure: Error | null = null;

  constructor({ cwd, sessionDirectory, sessionFile, tools, agentDirectory }: PiRpcOptions) {
    super();
    this.requiredExtensions = new Set(["optchat_permissions", "optchat_usage"]);
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => {});
    this.startupTimeout = setTimeout(
      () =>
        this.fail(
          new Error(
            `Pi startup did not confirm ${[...this.requiredExtensions].join(", ")} within 30 seconds; no task was sent`,
          ),
        ),
      30_000,
    );
    this.child = spawn(
      "pi",
      [
        "--mode",
        "rpc",
        "--provider",
        "openai-codex",
        "--model",
        "gpt-6.1-sol",
        "--session-dir",
        sessionDirectory,
        "--no-extensions",
        "--extension",
        extension("permissions.ts"),
        ...(sessionFile ? ["--session", sessionFile] : []),
        "--extension",
        extension("usage.ts"),
        "--no-skills",
        "--no-prompt-templates",
        "--tools",
        tools.join(","),
      ],
      {
        cwd,
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let boundary;
      while ((boundary = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, boundary).replace(/\r$/, "");
        buffer = buffer.slice(boundary + 1);
        if (!line) continue;
        if (this.failure) return;
        this.receiveLine(line);
      }
    });
    // Drain stderr without placing credential-bearing diagnostics in the cloud log.
    this.child.stderr.on("data", () => {});
    this.child.stdin.on("error", (cause) =>
      this.fail(new Error("Pi stopped accepting RPC commands", { cause })),
    );
    this.child.on("error", (cause) =>
      this.fail(
        new Error("Pi could not start; check its installation and the node PATH", { cause }),
      ),
    );
    this.exited = new Promise((resolve) => this.child.once("close", resolve));
    this.child.on("exit", (code, signal) => {
      clearTimeout(this.startupTimeout);
      this.failure ??= this.requiredExtensions.size
        ? new Error(
            `Pi exited during startup (${signal ?? code}); required extensions were not ready: ${[...this.requiredExtensions].join(", ")}. Check the node installation.`,
          )
        : new Error(`Pi exited (${signal ?? code})`);
      this.rejectReady(this.failure);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(this.failure);
      }
      this.pending.clear();
      this.emit("exit", code);
    });
  }

  private receiveLine(line: string): void {
    let event: PiEvent;
    try {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value) || typeof value["type"] !== "string")
        throw new Error("Missing RPC event type");
      event = { ...value, type: value["type"] };
      if (
        event.type === "extension_ui_request" &&
        event["method"] === "setStatus" &&
        event["statusKey"] === "optchat_model_call"
      ) {
        const relayed: unknown = JSON.parse(String(event["statusText"]));
        if (!isRecord(relayed) || relayed["type"] !== "optchat_model_call") {
          throw new Error("Invalid model usage event");
        }
        event = { ...relayed, type: "optchat_model_call" };
      }
    } catch (cause) {
      this.fail(new Error("Pi emitted invalid JSONL; the task was stopped", { cause }));
      return;
    }
    if (event.type === "extension_error") {
      const path = event["extensionPath"];
      const name = basename(typeof path === "string" ? path : "extension");
      const phase = typeof event["event"] === "string" ? event["event"] : "startup";
      this.fail(
        new Error(`Pi ${name} failed during ${phase}; the task was stopped`, {
          cause: new Error(String(event["error"])),
        }),
      );
      return;
    }
    if (
      event.type === "extension_ui_request" &&
      event["method"] === "setStatus" &&
      event["statusText"] === "ready" &&
      typeof event["statusKey"] === "string"
    ) {
      this.requiredExtensions.delete(event["statusKey"]);
      if (!this.requiredExtensions.size) {
        clearTimeout(this.startupTimeout);
        this.resolveReady();
      }
    }
    const id = event["id"];
    const pending = typeof id === "string" ? this.pending.get(id) : undefined;
    if (event.type === "response" && typeof id === "string" && pending) {
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      if (event["success"]) pending.resolve(event["data"]);
      else {
        const message =
          typeof event["error"] === "string"
            ? event["error"]
            : `Pi rejected ${String(event["command"])}`;
        pending.reject(new Error(message));
      }
    }
    this.emit("event", event);
  }

  async command(type: RpcCommand["type"], fields: Record<string, unknown> = {}): Promise<unknown> {
    if (type === "abort" && this.requiredExtensions.size) {
      this.fail(new Error("Pi task was aborted before startup finished; no task was sent"));
      return undefined;
    }
    if (type === "prompt" || type === "steer" || type === "follow_up") await this.ready;
    if (this.failure) throw this.failure;
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi did not acknowledge ${type} within 30 seconds`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.child.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n");
    });
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    clearTimeout(this.startupTimeout);
    this.rejectReady(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.child.kill("SIGTERM");
    this.emit("fault", error);
  }

  permission(id: string, confirmed: boolean): void {
    this.child.stdin.write(JSON.stringify({ type: "extension_ui_response", id, confirmed }) + "\n");
  }

  close(): void {
    this.child.stdin.end();
  }
}
