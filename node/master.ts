import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { codexCall, type Credential } from "../src/codex.ts";
import type { MasterConfig } from "../src/host.ts";
import { isRecord, parseJson } from "../src/json.ts";
import { runCode } from "./code-runner.ts";
import { localAuth } from "./local-auth.ts";
import { startMaster } from "./local-master.ts";

/**
 * Run the Master on this machine: `node node/master.ts [data/master.json]`. The file may set
 * `port`, `directory` and the MasterConfig fields; the owner key is OWNER_KEY in
 * data/owner-secrets.json, as for the cloud.
 */
const DEFAULTS = {
  port: 8790,
  directory: "data/master",
  masterModel: "gpt-6.1-sol",
  compactorModel: "gpt-6-luna",
  compactorEffort: "high",
  timezone: "Europe/Helsinki",
};

function readObject(path: string): Record<string, unknown> {
  const value = parseJson(readFileSync(path, "utf8"));
  if (!isRecord(value)) throw new Error(`${path} must hold a JSON object`);
  return value;
}

const path = resolve(process.argv[2] ?? "data/master.json");
const file = existsSync(path) ? readObject(path) : {};
const setting = <Key extends keyof typeof DEFAULTS>(key: Key): (typeof DEFAULTS)[Key] => {
  const value = file[key];
  if (value === undefined) return DEFAULTS[key];
  if (typeof value !== typeof DEFAULTS[key]) throw new Error(`${path}: ${key} has the wrong type`);
  // Checked against the default's type just above.
  return value as (typeof DEFAULTS)[Key];
};
const ownerKey = readObject("data/owner-secrets.json")["OWNER_KEY"];
if (typeof ownerKey !== "string" || !ownerKey) {
  throw new Error("data/owner-secrets.json needs OWNER_KEY");
}
const config: MasterConfig = {
  masterModel: setting("masterModel"),
  compactorModel: setting("compactorModel"),
  compactorEffort: setting("compactorEffort"),
  timezone: setting("timezone"),
};

let login: Promise<() => Promise<Credential>> | undefined;
const master = await startMaster({
  directory: resolve(setting("directory")),
  ownerKey,
  port: setting("port"),
  config,
  async callModel(request) {
    login ??= localAuth();
    let credential: () => Promise<Credential>;
    try {
      credential = await login;
    } catch (error) {
      login = undefined; // try the login again on the next call
      throw error;
    }
    return codexCall(await credential(), request);
  },
  runCode,
});
console.log(`The Master is listening on ${master.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log("Stopping the Master");
    void master.close().then(() => process.exit(0));
  });
}
