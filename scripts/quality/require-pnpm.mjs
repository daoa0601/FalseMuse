import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const initialDirectory = path.resolve(process.env.INIT_CWD ?? process.cwd());

if (initialDirectory !== repositoryRoot) process.exit(0);

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);
const expected = packageJson.packageManager;
const userAgent = process.env.npm_config_user_agent ?? "";
const match = /^pnpm\/([^\s]+)/u.exec(userAgent);

if (typeof expected !== "string" || !expected.startsWith("pnpm@")) {
  console.error("package.json must pin an exact pnpm version in packageManager.");
  process.exit(1);
}
if (match === null) {
  console.error(`This repository requires ${expected}. Install with pnpm, not npm, yarn, or bun.`);
  process.exit(1);
}
const actual = `pnpm@${match[1]}`;
if (actual !== expected) {
  console.error(`This repository requires ${expected}; received ${actual}.`);
  process.exit(1);
}
