import { readFileSync } from "node:fs";
import { cloudClient } from "./cloud-client.ts";

// Print the owner's instructions to the Master, or replace them with a file's text; an empty file
// clears them. The Master reads them at the start of each turn.
const [file] = process.argv.slice(2);
const client = cloudClient();
const result =
  file === undefined
    ? await client.request("/api/instructions")
    : await client.request("/api/instructions", { text: readFileSync(file, "utf8") }, "PUT");
const text = result["text"];
console.log(typeof text === "string" && text ? text : "(no instructions)");
