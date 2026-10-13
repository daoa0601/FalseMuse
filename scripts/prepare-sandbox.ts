import { mkdirSync, copyFileSync, cpSync, existsSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";

// The image's build context holds only what the container runs, never node_modules or data/.
const context = ".sandbox-build";
rmSync(context, { recursive: true, force: true });
mkdirSync(context, { recursive: true, mode: 0o700 });
const branch = execFileSync("git", ["symbolic-ref", "HEAD"], { encoding: "utf8" }).trim();
execFileSync("git", ["bundle", "create", `${context}/repository.bundle`, branch, "HEAD"], {
  stdio: "inherit",
});
const instructions = resolve("../AGENTS.md");
if (!existsSync(instructions)) {
  throw new Error("The workspace AGENTS.md is missing; restore it before preparing this image");
}
copyFileSync(instructions, `${context}/AGENTS.md`);
const source = (path: string) => !path.includes("__pycache__") && !basename(path).endsWith(".pyc");
for (const directory of ["node", "src", "optchat_memory"]) {
  cpSync(directory, `${context}/${directory}`, { recursive: true, filter: source });
}
copyFileSync("gitleaks.toml", `${context}/gitleaks.toml`);
console.log(
  "Prepared the Sandbox image context from the working tree and the committed repository.",
);
