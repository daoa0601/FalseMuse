import { readFileSync, writeFileSync, mkdirSync, openSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import type { DaemonStatus } from "../src/protocol.ts";

const directory = "/workspace/node";
const handleFile = `${directory}/daemon.json`;
const bootId = () => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();

function processState(pid: number): { state: string; started: string } {
  // The start time distinguishes a daemon from a later process that reused its PID.
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { state: fields[0] ?? "", started: fields[19] ?? "" };
}

function status(): DaemonStatus {
  if (!existsSync(handleFile)) return { state: "missing" };
  // container.ts wrote this handle when it started the daemon.
  const handle = JSON.parse(readFileSync(handleFile, "utf8")) as {
    pid: number;
    boot: string;
    started: string;
  };
  try {
    process.kill(handle.pid, 0);
    const current = processState(handle.pid);
    if (current.state === "Z" || handle.boot !== bootId() || handle.started !== current.started) {
      return { state: "stopped" };
    }
    const runtime = JSON.parse(readFileSync(`${directory}/runtime.json`, "utf8")) as {
      pid: number;
      jobs: number;
    };
    return {
      state: "running",
      pid: handle.pid,
      jobs: runtime.pid === handle.pid ? runtime.jobs : null,
    };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT" && existsSync(`/proc/${handle.pid}`))
      return { state: "starting", pid: handle.pid };
    if (code === "ENOENT" || code === "ESRCH") return { state: "stopped" };
    throw error;
  }
}

const action = process.argv[2];
let result = status();
if (action === "start" && (result.state === "missing" || result.state === "stopped")) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const log = openSync(`${directory}/daemon.log`, "a", 0o600);
  const child = spawn(
    process.execPath,
    ["/opt/optchat/node/daemon.ts", `${directory}/config.json`],
    {
      cwd: "/opt/optchat",
      detached: true,
      stdio: ["ignore", log, log],
    },
  );
  child.unref();
  if (child.pid === undefined) throw new Error("The Sandbox daemon did not start");
  writeFileSync(
    handleFile,
    JSON.stringify({ pid: child.pid, boot: bootId(), started: processState(child.pid).started }),
    { mode: 0o600, flush: true },
  );
  result = { state: "starting", pid: child.pid };
}
if (action === "stop" && result.state === "running" && result.pid !== undefined) {
  if (result.jobs !== 0)
    throw new Error("Finish or abort the Sandbox's running Pi tasks before saving it");
  process.kill(-result.pid, "SIGTERM");
  result = { state: "stopping", pid: result.pid };
}
console.log(JSON.stringify(result));
