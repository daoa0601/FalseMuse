import { DurableObject } from "cloudflare:workers";
import { Files, DirectoryBackup, type DirectoryBackupRecord } from "@cloudflare/sandbox";
import { errorMessage, isRecord, parseJson } from "./json.ts";
import {
  startDeviceLogin,
  pollDeviceLogin,
  pollDelay,
  refreshLogin,
  type DeviceLogin,
  type OAuthCredential,
} from "./oauth.ts";
import type { DaemonStatus } from "./protocol.ts";
import type { SandboxNodeConfig } from "./host.ts";

const DAEMON_STATES = ["missing", "stopped", "starting", "running", "stopping"] as const;

function daemonStatus(output: string): DaemonStatus {
  const value = parseJson(output);
  const state = isRecord(value) ? value["state"] : undefined;
  if (!isRecord(value) || !DAEMON_STATES.some((known) => known === state)) {
    throw new Error("The Sandbox daemon reported an unknown state");
  }
  return {
    state: DAEMON_STATES.find((known) => known === state) ?? "missing",
    ...(typeof value["pid"] === "number" ? { pid: value["pid"] } : {}),
    ...(typeof value["jobs"] === "number" || value["jobs"] === null ? { jobs: value["jobs"] } : {}),
  };
}

const INACTIVITY_MS = 10 * 60_000;
const IDLE_SAVE_MS = 2 * 60_000;

export class Sandbox extends DurableObject<Env> {
  private readonly container: Container;
  private readonly files: Files;
  private readonly backups: DirectoryBackup;
  private refreshing: Promise<OAuthCredential> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (!ctx.container) throw new Error("The Sandbox Durable Object needs its container");
    this.container = ctx.container;
    this.files = new Files(this.container);
    this.backups = new DirectoryBackup(this.container, ctx.exports.DirectoryBackupGateway, {
      binding: "TRANSCRIPTS",
      prefix: "backups/sandbox/",
    });
    if (this.container.running) {
      void ctx.blockConcurrencyWhile(() => this.container.setInactivityTimeout(INACTIVITY_MS));
    }
  }

  private master() {
    return this.ctx.exports.Master.getByName("owner");
  }

  async start(configuration: SandboxNodeConfig): Promise<DaemonStatus> {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!this.container.running) {
        const image = this.container.images["pi"];
        if (!image) throw new Error("The Sandbox image is not configured");
        this.container.start({ image, instance: "standard-1", enableInternet: true });
        await this.container.setInactivityTimeout(INACTIVITY_MS);
        const backup = await this.ctx.storage.get<DirectoryBackupRecord>("workspace");
        if (backup) await this.backups.restore(backup);
      }
      await this.container.setInactivityTimeout(INACTIVITY_MS);
      await this.files.mkdir("/workspace/node", { recursive: true });
      await this.files.writeFile("/workspace/node/config.json", JSON.stringify(configuration));
      await this.run(["chmod", "600", "/workspace/node/config.json"]);
      const daemon = daemonStatus(await this.run(["node", "node/container.ts", "start"]));
      await this.ctx.storage.put("lastActivity", Date.now());
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
      return daemon;
    });
  }

  async status() {
    const authenticated = Boolean(await this.ctx.storage.get("oauth"));
    const error = (await this.ctx.storage.get<string>("error")) ?? null;
    if (!this.container.running) {
      const saved = Boolean(await this.ctx.storage.get("workspace"));
      return { state: "stopped" as const, authenticated, error, saved };
    }
    const daemon = daemonStatus(await this.run(["node", "node/container.ts", "status"]));
    const repository = await this.run(["git", "-C", "/workspace/repo", "log", "-1", "--format=%s"]);
    return { ...daemon, authenticated, error, repository: repository.trim() };
  }

  async save() {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!this.container.running)
        return { saved: Boolean(await this.ctx.storage.get("workspace")) };
      if (await this.master().sandboxBusy()) {
        throw new Error("Finish or abort the Sandbox's tasks before saving it");
      }
      await this.run(["node", "node/container.ts", "stop"]);
      const deadline = Date.now() + 5_000;
      let state: DaemonStatus["state"];
      do {
        state = daemonStatus(await this.run(["node", "node/container.ts", "status"])).state;
        if (state === "missing" || state === "stopped") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      if (state !== "missing" && state !== "stopped") {
        throw new Error(
          "The Sandbox daemon is still stopping; inspect its current state before retrying",
        );
      }
      const previous = await this.ctx.storage.get<DirectoryBackupRecord>("workspace");
      const backup = await this.backups.backup({ dir: "/workspace", name: "Pi workspace" });
      await this.ctx.storage.put("workspace", backup);
      await this.container.destroy();
      if (previous) await this.backups.delete(previous);
      return { saved: true, size: backup.size };
    });
  }

  async startLogin() {
    const device = await startDeviceLogin();
    await this.ctx.storage.put("device", device);
    await this.ctx.storage.delete("error");
    await this.ctx.storage.setAlarm(Date.now() + 5_000);
    return {
      code: device.user_code,
      url: "https://auth.openai.com/codex/device",
      expires: device.expires,
    };
  }

  /** An access-only credential; this identity's rotating refresh token stays here. */
  async credential(): Promise<OAuthCredential> {
    this.refreshing ??= (async () => {
      let credential = await this.ctx.storage.get<OAuthCredential>("oauth");
      if (!credential)
        throw new Error("Connect the Sandbox's own ChatGPT subscription in the web chat");
      if (credential.expires < Date.now() + 60_000) {
        credential = await refreshLogin(credential);
        await this.ctx.storage.put("oauth", credential);
      }
      return {
        access: credential.access,
        expires: credential.expires,
        accountId: credential.accountId,
        refresh: "",
      };
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  override async alarm(): Promise<void> {
    try {
      const device = await this.ctx.storage.get<DeviceLogin>("device");
      if (device) {
        if (device.expires <= Date.now()) {
          await this.ctx.storage.delete("device");
          await this.ctx.storage.put(
            "error",
            "The Sandbox device code expired; start its login again",
          );
        } else {
          const credential = await pollDeviceLogin(device);
          if (credential) {
            await this.ctx.storage.put("oauth", credential);
            await this.ctx.storage.delete("device");
          } else await this.ctx.storage.setAlarm(Date.now() + pollDelay(device));
        }
      }
      if (!this.container.running) return;
      const daemon = await this.status();
      const jobs = "jobs" in daemon ? daemon.jobs : undefined;
      const busy = await this.master().sandboxBusy();
      if (jobs || busy) await this.ctx.storage.put("lastActivity", Date.now());
      const lastActivity = (await this.ctx.storage.get<number>("lastActivity")) ?? 0;
      if (jobs === 0 && !busy && Date.now() - lastActivity >= IDLE_SAVE_MS) {
        await this.save();
        return;
      }
      await this.ctx.storage.setAlarm(Date.now() + (device ? 5_000 : 30_000));
    } catch (error) {
      await this.ctx.storage.put("error", errorMessage(error));
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
  }

  private async run(command: string[]): Promise<string> {
    const process = await this.container.exec(command, { cwd: "/opt/optchat" });
    const result = await process.output();
    if (result.exitCode !== 0) {
      throw new Error(
        `Sandbox ${command[0]} failed (${result.exitCode}); inspect the container's current state`,
      );
    }
    return new TextDecoder().decode(result.stdout);
  }
}
