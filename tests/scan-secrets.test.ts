import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const scanner = resolve("scripts/quality/scan-secrets.ts");
// Assembled from pieces so this test file does not trip the scan of this repository.
const token = ["gh", "p_", "a".repeat(36)].join("");
const fineGrained = ["github", "_pat_", "b".repeat(30)].join("");
// A hook exports GIT_DIR and friends; the fixture repositories must not inherit them.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
);

function scan(setup: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "optchat-secrets-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: directory, env });
    writeFileSync(join(directory, ".gitignore"), "ignored/\n");
    setup(directory);
    const result = spawnSync(process.execPath, [scanner], {
      cwd: directory,
      encoding: "utf8",
      env,
    });
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the secret scan passes a clean repository and skips ignored files", () => {
  const result = scan((directory) => {
    writeFileSync(join(directory, "notes.md"), "No secrets here.\n");
    writeFileSync(join(directory, "config.json"), JSON.stringify({ API_KEY: "your-key" }));
    mkdirSync(join(directory, "ignored"));
    writeFileSync(join(directory, "ignored/token.txt"), token);
  });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Secret scan passed \(3 repository files inspected\)/);
});

test("the secret scan reports tokens, staged secrets, real config values, and secret filenames", () => {
  const result = scan((directory) => {
    writeFileSync(join(directory, "untracked.ts"), `const key = "${token}";\n`);
    writeFileSync(join(directory, "with\ttab.md"), `${fineGrained}\n`);
    execFileSync("git", ["add", "with\ttab.md"], { cwd: directory, env });
    writeFileSync(join(directory, "staged.md"), `first\n${token}\n`);
    execFileSync("git", ["add", "staged.md"], { cwd: directory, env });
    writeFileSync(join(directory, "staged.md"), "cleaned in the working tree only\n");
    writeFileSync(join(directory, "settings.yaml"), "PASSWORD: hunter22\n");
    writeFileSync(join(directory, ".env"), "\n");
  });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /untracked\.ts:1: GitHub secret token/);
  assert.match(result.output, /with\\ttab\.md:1: GitHub fine-grained token/);
  assert.match(result.output, /staged\.md:2: GitHub secret token/);
  assert.match(result.output, /settings\.yaml:1: non-placeholder secret assignment/);
  assert.match(result.output, /\.env:1: secret-bearing filename must not be committed/);
});
