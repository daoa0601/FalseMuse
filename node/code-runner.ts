import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { CODE_TOOLS } from "../src/tools.ts";
import type { CodeInvoke } from "../src/host.ts";
import { errorMessage, isRecord, parseJson } from "../src/json.ts";

/** What a Code Mode script returned, in the shape Cloudflare's executor reports it. */
export interface CodeResult {
  result: unknown;
  error?: string;
  logs?: string[];
}

/**
 * Runs inside the child. Node's permission model already denies it files, network, DNS, child
 * processes, workers, WASI and the inspector, and its environment is empty; this removes signals
 * to other processes, then runs the script with `codemode.<tool>()` calls sent to the parent.
 */
const RUNNER = `
import { createInterface } from "node:readline";
delete process._kill;
process.kill = undefined;
// macOS adds a variable even to an empty environment.
for (const name of Object.keys(process.env)) delete process.env[name];
const write = process.stdout.write.bind(process.stdout);
const send = (message) => write(JSON.stringify(message) + "\\n");
const logs = [];
const log = (...values) =>
  logs.push(values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
for (const level of ["log", "info", "warn", "error", "debug"]) console[level] = log;
const waiting = new Map();
let next = 0;
let start;
const started = new Promise((resolve) => (start = resolve));
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "start") return start(message);
  const call = waiting.get(message.id);
  waiting.delete(message.id);
  if ("error" in message) call?.reject(new Error(message.error));
  else call?.resolve(message.value);
});
const { code, tools } = await started;
globalThis.codemode = Object.fromEntries(
  tools.map((name) => [
    name,
    (input) =>
      new Promise((resolve, reject) => {
        const id = next++;
        waiting.set(id, { resolve, reject });
        send({ type: "call", id, name, input });
      }),
  ]),
);
try {
  const result = await (0, eval)("(" + code + ")")();
  send({ type: "done", result, logs });
} catch (error) {
  send({ type: "done", error: error instanceof Error ? error.message : String(error), logs });
}
process.exit(0);
`;

/**
 * Run a Code Mode script, an async arrow function, in a locked-down Node process. Its tool calls
 * reach `invoke` in the order it makes them, numbered from 0.
 */
export function runCode(code: string, invoke: CodeInvoke, timeout = 20_000): Promise<CodeResult> {
  const child = spawn(
    process.execPath,
    ["--permission", "--max-old-space-size=128", "--input-type=module", "-e", RUNNER],
    { env: {}, stdio: ["pipe", "pipe", "ignore"] },
  );
  let step = 0;
  return new Promise<CodeResult>((resolve) => {
    let settled = false;
    const finish = (result: CodeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ result: undefined, error: `The script ran past ${timeout / 1000} seconds` }),
      timeout,
    );
    const reply = (message: unknown) => {
      if (child.stdin.writable) child.stdin.write(JSON.stringify(message) + "\n");
    };
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message: unknown;
      try {
        message = parseJson(line);
      } catch {
        return; // the script wrote to stdout itself
      }
      if (!isRecord(message)) return;
      if (message["type"] === "done") {
        const logs = Array.isArray(message["logs"])
          ? message["logs"].filter((item): item is string => typeof item === "string")
          : [];
        const error = message["error"];
        finish({
          result: message["result"],
          ...(typeof error === "string" ? { error } : {}),
          ...(logs.length ? { logs } : {}),
        });
        return;
      }
      const { id, name, input } = message;
      if (message["type"] !== "call" || typeof id !== "number") return;
      if (typeof name !== "string" || !CODE_TOOLS.includes(name)) {
        reply({ type: "result", id, error: `Unknown tool ${String(name)}` });
        return;
      }
      invoke(name, input, step++).then(
        (value) => reply({ type: "result", id, value }),
        (error: unknown) => reply({ type: "result", id, error: errorMessage(error) }),
      );
    });
    child.on("error", (error) => finish({ result: undefined, error: errorMessage(error) }));
    child.on("exit", () =>
      finish({ result: undefined, error: "The script stopped without a result" }),
    );
    reply({ type: "start", code, tools: CODE_TOOLS });
  });
}
