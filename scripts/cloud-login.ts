import { cloudClient } from "./cloud-client.ts";

const login = await cloudClient().request("/api/auth/start", {});
console.log(`Open ${String(login["url"])} and enter ${String(login["code"])}`);
console.log(
  `Code expires at ${new Date(Number(login["expires"])).toLocaleString()}. The cloud finishes login automatically.`,
);
