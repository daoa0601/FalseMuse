import { writeFileSync, existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { cloudClient } from "./cloud-client.ts";

const [name = "laptop", ...directories] = process.argv.slice(2);
const file = `data/${name}-node.json`;
if (existsSync(file)) {
  throw new Error(
    `Node configuration already exists at ${file}; use it instead of issuing another key`,
  );
}
const roots = (directories.length ? directories : [resolve(".")]).map((directory) =>
  realpathSync(directory),
);
const client = cloudClient();
const node = await client.request("/api/nodes", { name, roots, tools: ["read"] });
writeFileSync(file, JSON.stringify({ ...node, url: client.url }, null, 2), {
  mode: 0o600,
  flush: true,
});
console.log(`Registered ${name}. Start with: node node/daemon.ts ${file}`);
