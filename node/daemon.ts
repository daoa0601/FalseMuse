import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { TaskRunner } from "./runner.ts";
import { readNodeConfig } from "./config.ts";
import { errorMessage, isRecord } from "../src/json.ts";
import { parseCloudMessage, type CloudMessage, type NodeMessage } from "../src/protocol.ts";

const configuration = resolve(process.argv[2] ?? "data/node.json");
const config = readNodeConfig(configuration);
const outbox = join(resolve(config.directory ?? "data"), "node-outbox");
mkdirSync(outbox, { recursive: true, mode: 0o700 });
let socket: WebSocket | undefined;
const runner = new TaskRunner(config, send);

/** Reports, usage, and recovery notices stay in the outbox until the cloud acknowledges them. */
function send(value: NodeMessage): void {
  if (value.type === "report" || value.type === "model_call" || value.type === "resume_job") {
    writeFileSync(join(outbox, value.id + ".json"), JSON.stringify(value), {
      flush: true,
      mode: 0o600,
    });
  }
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function resend(file: string): void {
  // The outbox holds messages this daemon serialized with send().
  const message = JSON.parse(readFileSync(join(outbox, file), "utf8")) as NodeMessage;
  send(message);
}

function connect(): void {
  socket = new WebSocket(config.url.replace(/^http/, "ws") + "/node/ws", ["optchat", config.key]);
  socket.onopen = () => {
    console.log(`Connected ${config.name}`);
    for (const file of readdirSync(outbox)) resend(file);
    runner.replay();
  };
  socket.onmessage = (event: MessageEvent) => {
    Promise.resolve()
      .then(() => handle(parseCloudMessage(String(event.data))))
      .catch((error: unknown) => console.error(errorMessage(error)));
  };
  socket.onerror = () => {};
  socket.onclose = () => {
    console.log("Disconnected; reconnecting in 10 seconds");
    setTimeout(connect, 10_000);
  };
}

async function handle(command: CloudMessage | null): Promise<void> {
  if (!command) return;
  switch (command.type) {
    case "registered":
      send({ type: "node_ready" });
      return;
    case "permission":
      runner.permission(command);
      return;
    case "ack": {
      if (!/^[\w-]+$/.test(command.id)) return;
      const file = join(outbox, command.id + ".json");
      if (!existsSync(file)) return;
      const message: unknown = JSON.parse(readFileSync(file, "utf8"));
      unlinkSync(file);
      if (isRecord(message) && message["type"] === "report") runner.acknowledge(command.id);
      return;
    }
    case "spawn":
      await runner.spawn(command);
      return;
    case "tell":
      await runner.steer(command.id, command.message ?? "");
      return;
    case "abort":
      await runner.abort(command.id);
      return;
    default:
      return;
  }
}

connect();

if (config.ingest) {
  const args = ["-m", "optchat_memory.live", "--config", configuration, "--watch"];
  if (config.ingest.baseline) args.push("--baseline", resolve(config.ingest.baseline));
  const ingest = spawn("python3", args, {
    cwd: resolve("."),
    stdio: ["ignore", "inherit", "inherit"],
  });
  ingest.on("exit", (code) =>
    console.error(`Live ingest stopped (${code}); restart the node after checking its logs`),
  );
}
