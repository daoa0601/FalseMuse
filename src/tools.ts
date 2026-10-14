import type { ToolDefinition } from "./codex.ts";

const tool = (
  name: string,
  description: string,
  properties: Record<string, { type: string }>,
  required = Object.keys(properties),
): ToolDefinition => ({
  type: "function",
  name,
  description,
  parameters: { type: "object", properties, required, additionalProperties: false },
});
const integer = { type: "integer" };
const string = { type: "string" };
const boolean = { type: "boolean" };

const MASTER_TOOLS = [
  tool(
    "zoom",
    "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.",
    { id: integer, n: integer },
  ),
  tool("date", "The date and time of message id.", { id: integer }),
  tool(
    "session",
    "Find the source recording and source line for message id, so its full transcript can be opened.",
    { id: integer },
  ),
  tool(
    "search",
    "Search memory summaries. Open matching lines with zoom before relying on details.",
    { query: string },
  ),
  tool(
    "transcript",
    "Read 1–100 source lines from a stored session transcript, starting at a one-based line number.",
    { session: string, start: integer, count: integer },
  ),
  tool("machines", "List the connected machines and allowed working directories.", {}),
  tool(
    "spawn",
    "Propose a Pi task for owner approval. Omit machine to choose an online node, or the Sandbox when all nodes are offline. Omit cwd to use its first allowed root.",
    { task: string, machine: string, cwd: string },
    ["task"],
  ),
  tool(
    "computers",
    "List the user's computers running T3 Code, whether each is signed in, and its projects.",
    {},
  ),
  tool(
    "launch",
    "Start a T3 Code thread in a project on a computer, with task as its first message. It runs with the access the user approved for you there, and asks the user in T3 Code before going beyond it. Its result comes back as a message starting [computer: title].",
    { computer: string, project: string, title: string, task: string },
  ),
  tool("threads", "List the 20 newest T3 Code threads of a project on a computer.", {
    computer: string,
    project: string,
  }),
  tool(
    "read_thread",
    "Read a T3 Code thread's status and up to 20 of its messages after position after (omit after for the first ones).",
    { computer: string, thread: string, after: integer },
    ["computer", "thread"],
  ),
  tool(
    "send",
    "Send a message to a T3 Code thread. mode auto (default) starts an idle thread or steers a running one; queue waits for the current turn; restart interrupts and restarts it.",
    { computer: string, thread: string, message: string, mode: string },
    ["computer", "thread", "message"],
  ),
  tool("interrupt", "Stop the running turn of a T3 Code thread.", {
    computer: string,
    thread: string,
  }),
  tool(
    "helpers",
    "List the user's named helpers: each one's instructions, computer, project, model, whether you may use it unasked (auto), and its T3 Code thread.",
    {},
  ),
  tool(
    "hire",
    "Hire a named helper, or change one, only when the user asks. Its instructions (up to 4,000 characters) go with its next job; provider and model name a provider instance and model that computers lists for its computer, or omit both for the project's default. fresh starts it in a new thread, given its recent jobs and results. Fields left out keep their values.",
    {
      name: string,
      instructions: string,
      computer: string,
      project: string,
      provider: string,
      model: string,
      auto: boolean,
      fresh: boolean,
    },
    ["name"],
  ),
  tool(
    "delegate",
    "Give a helper a job. It queues in the helper's own T3 Code thread, which keeps its context between jobs, and its result comes back as a message starting [computer: Helper: name].",
    { helper: string, task: string },
  ),
  tool("retire", "Forget a helper when the user asks; its thread stays in T3 Code.", {
    name: string,
  }),
  tool("tell", "Steer a running Pi session with another instruction.", {
    id: string,
    message: string,
  }),
  tool("abort", "Stop a running Pi session.", { id: string }),
  tool(
    "schedule",
    "Schedule a future prompt only when the user asks. Use an ISO timestamp with a timezone; every_minutes=0 runs once.",
    { prompt: string, at: string, every_minutes: integer },
  ),
  tool("schedules", "List scheduled prompts and their next times.", {}),
  tool(
    "cancel_schedule",
    "Cancel future runs of a schedule when the user asks. Already queued messages remain in the chat.",
    { id: integer },
  ),
];

/** The tools Code Mode scripts may call; everything except Code Mode itself. */
export const CODE_TOOLS: readonly string[] = MASTER_TOOLS.map((definition) => definition.name);

const codeMethods = MASTER_TOOLS.map(
  (definition) =>
    `codemode.${definition.name}({${Object.keys(definition.parameters.properties).join(", ")}})`,
).join("\n");

export const TOOLS: readonly ToolDefinition[] = [
  ...MASTER_TOOLS,
  tool(
    "codemode",
    `Run an async JavaScript arrow function, for example async () => { return await codemode.machines({}); }.
The sandbox has no network or credentials. These methods call the same tools, with the same approval rules:
${codeMethods}`,
    { code: string },
  ),
  tool(
    "look",
    "See an image the user sent again, named by its [image ...] marker, for example images/<hash>.png.",
    { image: string },
  ),
];

/** Keep the head and tail of long text, noting how much was cut. */
export function cap(text: string, limit = 30_000): string {
  if (text.length <= limit) return text;
  const notice = `\n[${text.length - limit} characters omitted]\n`;
  const half = Math.floor((limit - notice.length) / 2);
  return text.slice(0, half) + notice + text.slice(-half);
}
