import { isRecord } from "./json.ts";
import { send } from "./nodes.ts";
import type { ModelResult, RelayedRequest } from "./codex.ts";
import type { ModelAnswer } from "./protocol.ts";
import type { MasterHost, NodeSocket } from "./host.ts";

interface Waiting {
  socket: NodeSocket;
  resolve: (result: ModelResult) => void;
  reject: (error: Error) => void;
}

/**
 * Model calls the Master makes through a connected node. The backend refuses bulk calls from
 * Cloudflare's network (403), so a node that serves models calls it from its own machine.
 */
export class ModelRelay {
  private readonly sockets: MasterHost["sockets"];
  private readonly allowed: (machine: string) => boolean;
  private readonly waiting = new Map<string, Waiting>();

  constructor(sockets: MasterHost["sockets"], allowed: (machine: string) => boolean) {
    this.sockets = sockets;
    this.allowed = allowed;
  }

  /**
   * An online node that announced it serves model calls and is still allowed to: the grant is
   * checked on every call, so revoking it applies to a connected node at once.
   */
  node(): { socket: NodeSocket; machine: string } | undefined {
    for (const socket of this.sockets.getWebSockets()) {
      const attachment: unknown = socket.deserializeAttachment();
      const machine = isRecord(attachment) ? attachment["machine"] : undefined;
      if (
        isRecord(attachment) &&
        attachment["models"] === true &&
        typeof machine === "string" &&
        this.allowed(machine)
      ) {
        return { socket, machine };
      }
    }
    return undefined;
  }

  call(socket: NodeSocket, request: RelayedRequest, signal: AbortSignal): Promise<ModelResult> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("The model call was cancelled"));
        return;
      }
      this.waiting.set(id, { socket, resolve, reject });
      signal.addEventListener("abort", () => this.fail(id, "The relayed model call timed out"), {
        once: true,
      });
      send(socket, { type: "model_request", id, request });
    });
  }

  /** Settle a waiting call; an answer for a call this instance no longer waits for is dropped. */
  answer(answer: ModelAnswer): void {
    const waiting = this.waiting.get(answer.id);
    if (!waiting) return;
    this.waiting.delete(answer.id);
    if ("error" in answer) waiting.reject(new Error(answer.error));
    else waiting.resolve(answer.result);
  }

  /** Fail every call waiting on a node that disconnected. */
  drop(socket: NodeSocket): void {
    for (const [id, waiting] of this.waiting) {
      if (waiting.socket === socket) this.fail(id, "The model node disconnected");
    }
  }

  private fail(id: string, message: string): void {
    const waiting = this.waiting.get(id);
    if (!waiting) return;
    this.waiting.delete(id);
    waiting.reject(new Error(message));
  }
}
