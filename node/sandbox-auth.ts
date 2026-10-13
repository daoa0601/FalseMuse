import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sandboxSubscription } from "./subscription.ts";

/** Pi extension: Sandbox nodes refresh through their own identity's broker, never a stored refresh token. */
export default function sandboxAuth(pi: ExtensionAPI): void {
  const configuration = process.env["OPTCHAT_NODE_CONFIG"];
  pi.registerProvider("openai-codex", {
    oauth: {
      name: "ChatGPT Sandbox subscription",
      isSubscription: true,
      login: async () => {
        throw new Error("Connect the Sandbox subscription in the owner web chat");
      },
      refreshToken: (_credential, signal) => {
        if (!configuration) throw new Error("OPTCHAT_NODE_CONFIG is not set for this Sandbox node");
        return sandboxSubscription(configuration, signal);
      },
      getApiKey: (credential) => credential.access,
    },
  });
  pi.on("session_start", (_event, ctx) => ctx.ui.setStatus("optchat_subscription", "ready"));
}
