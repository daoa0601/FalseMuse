import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** A process identity that survives PID reuse: its start time and the boot it ran in. */
export interface ProcessHandle {
  pid: number;
  state: string;
  started: string;
  boot: string;
}

export function processHandle(pid: number): ProcessHandle | null {
  if (process.platform === "linux") {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return {
      pid,
      state: fields[0] ?? "",
      started: fields[19] ?? "",
      boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    };
  }
  if (process.platform === "darwin") {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "stat=,lstart="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    }).trim();
    if (!output) return null;
    const [state = "", ...started] = output.split(/\s+/);
    return {
      pid,
      state,
      started: started.join(" "),
      boot: execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
        encoding: "utf8",
      }).trim(),
    };
  }
  throw new Error("Task recovery currently requires macOS or Linux process status");
}

export function processRunning(handle: ProcessHandle | null): boolean {
  if (!handle) return false;
  try {
    process.kill(handle.pid, 0);
    const current = processHandle(handle.pid);
    return Boolean(
      current &&
      !current.state.startsWith("Z") &&
      current.started === handle.started &&
      current.boot === handle.boot,
    );
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    const status = error instanceof Error && "status" in error ? error.status : undefined;
    if (code === "ENOENT" || code === "ESRCH" || status === 1) return false;
    throw error;
  }
}
