import { cloudClient } from "./cloud-client.ts";

const [name, url] = process.argv.slice(2);
if (!name || !url) {
  console.error("Usage: node scripts/connect-computer.ts <name> <T3 Code MCP URL>");
  process.exit(1);
}
const { authorize } = await cloudClient().request("/api/computers", { name, url });
console.log("Open this page, enter a pairing code from T3 Code, and choose the access to grant:");
console.log(String(authorize));
