import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { installService } from "./launchd.ts";

if (!existsSync(resolve("data/master/master.sqlite"))) {
  throw new Error("Move the Master into data/master before installing its service");
}
installService("com.anhdao.optchat-master", "node/master.ts", process.argv.slice(2), "master");
