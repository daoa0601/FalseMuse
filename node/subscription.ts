import { readNodeConfig, type NodeConfig } from "./config.ts";
import { isRecord } from "../src/json.ts";

/** The Sandbox's access-only credential, issued by its own Durable Object. */
// A type alias, so Pi's index-signature OAuth credential type accepts it.
export type SandboxCredential = {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
};

export async function sandboxSubscription(
  configuration: string | NodeConfig,
  signal?: AbortSignal,
): Promise<SandboxCredential> {
  const config = typeof configuration === "string" ? readNodeConfig(configuration) : configuration;
  const response = await fetch(config.url + "/node/subscription", {
    method: "POST",
    headers: { authorization: `Bearer ${config.key}` },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(
      `Sandbox subscription is unavailable (${response.status}); connect it in the owner web chat`,
    );
  }
  const value: unknown = await response.json();
  if (
    !isRecord(value) ||
    typeof value["access"] !== "string" ||
    typeof value["expires"] !== "number" ||
    typeof value["accountId"] !== "string"
  ) {
    throw new Error("The Sandbox subscription broker returned an incomplete credential");
  }
  return {
    access: value["access"],
    refresh: "",
    expires: value["expires"],
    accountId: value["accountId"],
  };
}
