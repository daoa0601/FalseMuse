import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { errorMessage, isRecord } from "../src/json.ts";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const REVIEWED_TOOLS = ["bash", "edit", "write"];

/** Pi extension: every bash, edit, or write waits for the owner after a local secret scan. */
export default function permissions(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => ctx.ui.setStatus("optchat_permissions", "ready"));
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "read") return undefined;
    if (!REVIEWED_TOOLS.includes(event.toolName)) {
      return { block: true, reason: "This node only supports read, bash, edit, and write" };
    }
    if (!ctx.hasUI) return { block: true, reason: "Owner approval is unavailable" };
    try {
      const message = await review(
        { tool: event.toolName, cwd: ctx.cwd, input: event.input },
        ctx.signal,
      );
      const approved = await ctx.ui.confirm(
        `Allow Pi ${event.toolName}?`,
        message,
        ctx.signal ? { signal: ctx.signal } : {},
      );
      if (!approved) return { block: true, reason: "The owner did not approve this tool call" };
      return undefined;
    } catch (error) {
      return { block: true, reason: errorMessage(error) };
    }
  });
}

function review(proposal: unknown, signal: AbortSignal | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "python3",
      ["-m", "node.review"],
      { cwd: repository, ...(signal ? { signal } : {}), timeout: 30_000, maxBuffer: 256_000 },
      (error, stdout) => {
        let value: unknown;
        try {
          value = JSON.parse(stdout);
        } catch (cause) {
          reject(
            new Error(
              "The local scanner could not prepare this proposal; check Python and Gitleaks on the node",
              {
                cause: error ?? cause,
              },
            ),
          );
          return;
        }
        const failure = isRecord(value) ? value["error"] : undefined;
        const text = isRecord(value) ? value["text"] : undefined;
        if (error || typeof failure === "string") {
          reject(
            new Error(typeof failure === "string" ? failure : "The local scanner failed", {
              cause: error,
            }),
          );
        } else if (typeof text === "string") resolve(text);
        else reject(new Error("The local scanner returned no review text"));
      },
    );
    child.stdin?.on("error", (cause) =>
      reject(new Error("The local scanner did not accept the proposal", { cause })),
    );
    child.stdin?.end(JSON.stringify(proposal));
  });
}
