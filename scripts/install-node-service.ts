import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { installService } from "./launchd.ts";

const configuration = resolve(process.argv[2] ?? "data/laptop-node.json");
if (!existsSync(configuration)) throw new Error("Register this node before installing its service");
installService("com.anhdao.optchat-memory", "node/daemon.ts", [configuration], "node-daemon");
