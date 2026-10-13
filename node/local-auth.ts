import { execFileSync } from "node:child_process";
import { realpathSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import type { Credential } from "../src/codex.ts";
import { accountIdOf } from "../src/oauth.ts";
import { isRecord } from "../src/json.ts";

type CredentialSource = () => Promise<Credential>;

function codexTokens(path: string): { access: string; accountId: string } | null {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  const tokens = isRecord(value) ? value["tokens"] : undefined;
  if (!isRecord(tokens) || typeof tokens["access_token"] !== "string") return null;
  const accountId = tokens["account_id"];
  return {
    access: tokens["access_token"],
    accountId: typeof accountId === "string" ? accountId : accountIdOf(tokens["access_token"]),
  };
}

function expiresAt(access: string): number {
  const payload: unknown = JSON.parse(
    Buffer.from(access.split(".")[1] ?? "", "base64url").toString(),
  );
  return isRecord(payload) && typeof payload["exp"] === "number" ? payload["exp"] * 1_000 : 0;
}

/** The laptop's subscription credential: Codex's current token, else Pi's login. Never rotates either. */
export async function localAuth(): Promise<CredentialSource> {
  const codexPath = resolve(homedir(), ".codex/auth.json");
  const codex = codexTokens(codexPath);
  if (codex && expiresAt(codex.access) > Date.now() + 300_000) {
    // Read the CLI-owned access token; never rotate or copy its refresh token.
    return async () => {
      const current = codexTokens(codexPath);
      if (!current) throw new Error("The Codex CLI login no longer has an access token");
      return current;
    };
  }
  const executable = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
  const entry = resolve(dirname(executable), "../index.js");
  const pi: unknown = await import(pathToFileURL(entry).href);
  const ModelRuntime = isRecord(pi) ? pi["ModelRuntime"] : undefined;
  if (!isRecord(ModelRuntime) && typeof ModelRuntime !== "function") {
    throw new Error("The installed Pi does not export ModelRuntime");
  }
  // The installed Pi CLI, not this project's devDependency, owns the subscription login.
  const runtime = await (
    ModelRuntime as typeof import("@earendil-works/pi-coding-agent").ModelRuntime
  ).create();
  if (!runtime.isUsingSubscription("openai-codex")) {
    throw new Error("Log in to pi with the openai-codex subscription provider first");
  }
  return async () => {
    const result = await runtime.getAuth("openai-codex");
    const access = result?.auth?.apiKey;
    if (!access) throw new Error("Pi could not refresh its subscription login");
    return { access, accountId: accountIdOf(access) };
  };
}
