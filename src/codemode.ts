import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { CODE_TOOLS } from "./tools.ts";

export type CodeInvoke = (name: string, input: unknown, step: number) => Promise<unknown>;

export async function executeCode(loader: WorkerLoader, code: string, invoke: CodeInvoke) {
  let step = 0;
  const functions = Object.fromEntries(
    CODE_TOOLS.map((name) => [name, (input: unknown) => invoke(name, input, step++)]),
  );
  const executor = new DynamicWorkerExecutor({ loader, timeout: 20_000, globalOutbound: null });
  return executor.execute(code, [{ name: "codemode", fns: functions }]);
}
