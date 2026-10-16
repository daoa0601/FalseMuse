// Scans tracked and unignored files, staged and working-tree content, for committed secrets.
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { basename, join } from "node:path";

const maxFileBytes = 8 * 1024 * 1024;

const git = (args: string[], cwd: string): Buffer =>
  execFileSync("git", args, { cwd, maxBuffer: maxFileBytes + 1024 * 1024, stdio: "pipe" });

const list = (args: string[], cwd: string): string[] =>
  git(args, cwd).toString("utf8").split("\0").filter(Boolean);

// The patterns are assembled from pieces so this file does not match itself.
const patterns: ReadonlyArray<{ kind: string; regex: RegExp }> = [
  {
    kind: "private key material",
    regex: new RegExp(["-----BEGIN ", "(?:RSA |EC |OPENSSH )?", "PRIVATE KEY-----"].join(""), "gu"),
  },
  {
    kind: "OpenAI-style secret token",
    regex: new RegExp(["sk-", "(?:proj-)?", "[A-Za-z0-9_-]{20,}"].join(""), "gu"),
  },
  {
    kind: "GitHub secret token",
    regex: new RegExp(["gh", "[pousr]_", "[A-Za-z0-9]{30,}"].join(""), "gu"),
  },
  {
    kind: "GitHub fine-grained token",
    regex: new RegExp(["github", "_pat_", "[A-Za-z0-9_]{20,}"].join(""), "gu"),
  },
  { kind: "AWS access key", regex: new RegExp(["AK", "IA", "[0-9A-Z]{16}"].join(""), "gu") },
];
const configFile = /(?:^|\/)(?:\.env[^/]*|[^/]+\.(?:json|ya?ml|toml|ini|properties))$/iu;
const assignment =
  /\b(?:PRIVATE_KEY|SECRET|PASSWORD|API_KEY|TOKEN|CLIENT_SECRET)\b["']?\s*[:=]\s*([^\s,;}]+)/giu;

function forbiddenName(file: string): boolean {
  const base = basename(file).toLowerCase();
  return (
    base === ".env" ||
    base === "credentials.json" ||
    [".pem", ".key", ".p12", ".pfx"].some((extension) => base.endsWith(extension))
  );
}

function placeholder(raw: string): boolean {
  const value = raw.replace(/^["']|["']$/gu, "");
  return (
    value.length === 0 ||
    /^(?:replace-|your-|example|dummy|test-|not-needed|redacted|undefined|null|none|false|true|<)/iu.test(
      value,
    ) ||
    value.startsWith("$") ||
    value.startsWith("process.env") ||
    /^[A-Z][A-Z0-9_]+$/u.test(value)
  );
}

function inspect(file: string, content: Buffer, report: (line: number, kind: string) => void) {
  if (content.includes(0)) return;
  const source = content.toString("utf8");
  const newlines: number[] = [];
  for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1))
    newlines.push(index);
  // 1 + the number of newlines before index, by binary search.
  const line = (index: number) => {
    let [low, high] = [0, newlines.length];
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((newlines[middle] ?? Infinity) < index) low = middle + 1;
      else high = middle;
    }
    return low + 1;
  };
  for (const { kind, regex } of patterns)
    for (const match of source.matchAll(regex)) report(line(match.index), kind);
  if (!configFile.test(file)) return;
  for (const match of source.matchAll(assignment))
    if (!placeholder(match[1] ?? ""))
      report(line(match.index), "non-placeholder secret assignment");
}

function worktree(root: string, file: string): Buffer | string | undefined {
  let metadata;
  try {
    metadata = lstatSync(join(root, file));
  } catch {
    return undefined;
  }
  if (metadata.isSymbolicLink()) return Buffer.from(readlinkSync(join(root, file)));
  if (!metadata.isFile()) return undefined;
  if (metadata.size > maxFileBytes) return `working-tree file exceeds ${maxFileBytes} bytes`;
  return readFileSync(join(root, file));
}

const root = git(["rev-parse", "--show-toplevel"], process.cwd()).toString("utf8").trim();
const tracked = new Set(
  list(["ls-files", "--cached", "--stage", "-z"], root)
    // "<mode> <object> <stage>\t<path>"; the path itself may contain tabs.
    .filter((entry) => !entry.startsWith("160000 "))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1)),
);
const untracked = list(["ls-files", "--others", "--exclude-standard", "-z"], root);
const files = [...new Set([...tracked, ...untracked])].sort();
const findings = new Set<string>();

for (const file of files) {
  const report = (line: number, kind: string) =>
    findings.add(`${JSON.stringify(file).slice(1, -1)}:${line}: ${kind}`);
  if (forbiddenName(file)) report(1, "secret-bearing filename must not be committed");
  let staged: Buffer | undefined;
  if (tracked.has(file)) {
    try {
      const size = Number(
        git(["cat-file", "-s", `:0:${file}`], root)
          .toString("utf8")
          .trim(),
      );
      if (size > maxFileBytes) report(1, `staged file exceeds ${maxFileBytes} bytes`);
      else staged = git(["cat-file", "-p", `:0:${file}`], root);
    } catch {
      report(1, "unable to inspect staged content");
    }
    if (staged) inspect(file, staged, report);
  }
  const current = worktree(root, file);
  if (typeof current === "string") report(1, current);
  else if (current !== undefined && !(staged?.equals(current) ?? false))
    inspect(file, current, report);
}

if (findings.size > 0) {
  console.error("Secret scan failed:");
  for (const finding of [...findings].sort()) console.error(`- ${finding}`);
  process.exit(1);
}
console.log(`Secret scan passed (${files.length} repository files inspected).`);
