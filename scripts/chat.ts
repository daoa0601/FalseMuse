import { cloudClient } from "./cloud-client.ts";

const message = process.argv.slice(2).join(" ").trim();
if (!message) throw new Error('Write a message: node scripts/chat.ts "Your message"');
const client = cloudClient();
const { id } = await client.request("/api/chat", { text: message });
if (typeof id !== "number") throw new Error("The Master did not queue the message");
console.error(`Waiting for chat turn ${id}. Ctrl-C leaves the turn running.`);
let reportedError: unknown = null;
while (true) {
  const turn = await client.request(`/api/turns/${id}`);
  if (turn["status"] !== "pending") {
    if (typeof turn["text"] === "string" && turn["text"]) console.log(turn["text"]);
    if (turn["status"] !== "done")
      throw new Error(`Chat turn ${id} ended with status ${String(turn["status"])}`);
    break;
  }
  const status = await client.request("/api/status");
  if (status["error"] && status["error"] !== reportedError) {
    console.error(`The turn is still pending and will retry: ${String(status["error"])}`);
  }
  reportedError = status["error"];
  await new Promise((wait) => setTimeout(wait, 2000));
}
