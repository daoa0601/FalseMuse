import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { startDeviceLogin, pollDeviceLogin, pollDelay } from "../src/oauth.ts";

const directory = resolve("data/node-agent");
mkdirSync(directory, { recursive: true });
const device = await startDeviceLogin();
console.log(`Open https://auth.openai.com/codex/device and enter ${device.user_code}`);
console.log("This login is for Pi tasks on this node.");
while (true) {
  const credential = await pollDeviceLogin(device);
  if (credential) {
    writeFileSync(
      join(directory, "auth.json"),
      JSON.stringify({ "openai-codex": { type: "oauth", ...credential } }),
      { mode: 0o600, flush: true },
    );
    console.log("Node subscription login saved.");
    break;
  }
  await new Promise((wait) => setTimeout(wait, pollDelay(device)));
}
