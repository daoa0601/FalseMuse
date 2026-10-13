import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { quotaHeaders, type Quota } from "../src/usage.ts";

/** Pi extension: relay each subscription response's usage and quota headers to the daemon. */
export default function usage(pi: ExtensionAPI): void {
  let response: { date: string; quota: Quota } | null = null;
  pi.on("session_start", (_event, ctx) => {
    const provider = ctx.modelRegistry.getProvider("openai-codex");
    const configuration = ctx.modelRegistry.getRegisteredProviderConfig("openai-codex");
    if (!provider || !configuration) throw new Error("Pi has no openai-codex provider to observe");
    // Pi's WebSocket transport does not expose quota headers. Keep its provider and OAuth,
    // but use the HTTP stream whose response headers the subscription ledger can observe.
    pi.registerProvider("openai-codex", {
      // Pi returns its registered input config; its optional fields predate exactOptionalPropertyTypes.
      ...(configuration as ProviderConfig),
      api: "openai-codex-responses",
      streamSimple: (model, context, options) =>
        provider.streamSimple(model, context, { ...options, transport: "sse" }),
    });
    ctx.ui.setStatus("optchat_usage", "ready");
  });
  pi.on("before_provider_request", () => {
    response = null;
  });
  pi.on("after_provider_response", (event) => {
    response = { date: new Date().toISOString(), quota: quotaHeaders(event.headers) };
  });
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant" || message.provider !== "openai-codex" || !response) return;
    // RPC owns stdout. Its status channel carries the observation without prompt or response text.
    ctx.ui.setStatus(
      "optchat_model_call",
      JSON.stringify({
        type: "optchat_model_call",
        id: crypto.randomUUID(),
        model: message.model,
        usage: message.usage,
        ...response,
      }),
    );
    response = null;
  });
}
