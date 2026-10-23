import test from "node:test";
import assert from "node:assert/strict";
import { runCode } from "../node/code-runner.ts";

test("a Code Mode script calls tools in order, logs, and returns its value", async () => {
  const calls: [string, unknown, number][] = [];
  const result = await runCode(
    `async () => {
      console.log("looking", { id: 1 });
      const first = await codemode.zoom({ id: 1, n: 1 });
      return [first, await codemode.date({ id: 2 })];
    }`,
    async (name, input, step) => {
      calls.push([name, input, step]);
      return `${name}:${step}`;
    },
  );
  assert.deepEqual(result, { result: ["zoom:0", "date:1"], logs: ['looking {"id":1}'] });
  assert.deepEqual(calls, [
    ["zoom", { id: 1, n: 1 }, 0],
    ["date", { id: 2 }, 1],
  ]);
});

test("a Code Mode script reaches no network, files, processes or environment", async () => {
  const result = await runCode(
    `async () => {
      const reached = [];
      const attempt = async (name, action) => {
        try { await action(); reached.push(name); } catch {}
      };
      await attempt("network", () => fetch("https://example.com"));
      await attempt("files", async () => (await import("node:fs")).readFileSync("/etc/hosts"));
      await attempt("processes", async () => (await import("node:child_process")).execSync("true"));
      await attempt("signals", () => process.kill(process.ppid, 0));
      if (Object.keys(process.env).length) reached.push("environment");
      return reached;
    }`,
    async () => null,
  );
  assert.deepEqual(result, { result: [] });
});

test("a Code Mode script is stopped at its time limit, and unknown tools fail", async () => {
  const stuck = await runCode("async () => new Promise(() => {})", async () => null, 300);
  assert.deepEqual(stuck, { result: undefined, error: "The script ran past 0.3 seconds" });
  const unknown = await runCode("async () => codemode.codemode({})", async () => null);
  assert.match(unknown.error ?? "", /codemode\.codemode is not a function/);
});

test("a Code Mode script that floods its output is stopped", async () => {
  const flood = await runCode(
    `async () => { process.stdout.write("x".repeat(40 * 1024 * 1024)); await new Promise(() => {}); }`,
    async () => null,
  );
  assert.deepEqual(flood, { result: undefined, error: "The script wrote more than 32 MiB" });
});
