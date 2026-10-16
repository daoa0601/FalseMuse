import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";

if (process.platform !== "darwin")
  throw new Error("This installer is for the laptop's macOS launchd service");
const configuration = resolve(process.argv[2] ?? "data/laptop-node.json");
if (!existsSync(configuration)) throw new Error("Register this node before installing its service");
const label = "com.anhdao.optchat-memory";
const directory = join(homedir(), "Library/LaunchAgents");
const file = join(directory, `${label}.plist`);
// Any label counts, including earlier ones: a second KeepAlive daemon would fight over the node.
const existing = existsSync(directory)
  ? readdirSync(directory).find((name) => name.endsWith(".optchat-memory.plist"))
  : undefined;
if (existing)
  throw new Error(
    `A service already exists at ${join(directory, existing)}; preserve it and inspect it before replacing it`,
  );
mkdirSync(directory, { recursive: true });
const escape = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const root = resolve(".");
const out = join(root, "data/node-daemon.log");
const err = join(root, "data/node-daemon-error.log");
for (const log of [out, err]) writeFileSync(log, "", { mode: 0o600 });
writeFileSync(
  file,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${escape(process.execPath)}</string><string>${escape(join(root, "node/daemon.ts"))}</string><string>${escape(configuration)}</string></array>
<key>WorkingDirectory</key><string>${escape(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape(process.env["PATH"] ?? "")}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${escape(out)}</string>
<key>StandardErrorPath</key><string>${escape(err)}</string>
</dict></plist>`,
  { mode: 0o600 },
);
if (!process.getuid) throw new Error("launchd needs the current user ID");
execFileSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, file]);
console.log(`Installed ${label}. Logs: ${out}`);
