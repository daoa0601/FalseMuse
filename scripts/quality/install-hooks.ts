// Copies .githooks/* into this repository's Git hooks directory, leaving other hooks alone and
// refusing to replace a hook this script did not write.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const git = (...args: string[]): string | undefined => {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    return undefined;
  }
};
if (
  git("config", "--get", "core.hooksPath") &&
  !git("config", "--local", "--get", "core.hooksPath")
)
  throw new Error(
    "core.hooksPath is set outside this repository; set a repository-local one first",
  );
// Honors a repository-local core.hooksPath.
const hooksPath = git("rev-parse", "--git-path", "hooks");
if (!hooksPath) throw new Error("Run this inside the repository's Git checkout");
const target = resolve(hooksPath);
const source = resolve(import.meta.dirname, "../../.githooks");
const hooks = readdirSync(source);
for (const hook of hooks) {
  const destination = join(target, hook);
  let metadata;
  try {
    metadata = lstatSync(destination);
  } catch {
    continue;
  }
  if (!metadata.isFile() || !readFileSync(destination).equals(readFileSync(join(source, hook))))
    throw new Error(`${destination} already exists; merge it with .githooks/${hook} by hand`);
}
mkdirSync(target, { recursive: true });
for (const hook of hooks) {
  copyFileSync(join(source, hook), join(target, hook));
  chmodSync(join(target, hook), 0o755);
}
console.log(`Installed ${hooks.join(", ")} in ${target}`);
