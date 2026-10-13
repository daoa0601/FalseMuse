import { bytes, NODE_BYTES, type Memory, type Part } from "./memory.ts";
import { user, type InputItem, type ModelCall, type ModelResult } from "./codex.ts";
import { SYSTEM } from "./prompts.ts";
import { TOOLS } from "./tools.ts";

// Models can't count bytes, so the task shows the limit as a ruler.
const ruler = "-".repeat(NODE_BYTES);
const name = (part: Part) => `${part.index * 2 ** part.level}+${2 ** part.level}`;

/** The compaction task, verbatim from the specification (gist revision 3c190e0, section 4). */
function task(memory: Memory, part: Part): string {
  const limit = `into one line of at most\n512 bytes (about 70 words), the length of this ruler:\n${ruler}`;
  if (part.level === 0) {
    return `Compaction: compress message ${part.index} ${limit}\n<input>\n${memory.source(part)}\n</input>`;
  }
  const [a, b] = memory.children(part);
  const first = part.index * 2 ** part.level;
  return `Compaction: merge lines ${name(a)} and ${name(b)}, adjacent, ${limit}
<chat> may hold their messages, ${first} to ${first + 2 ** part.level - 1}, in more detail: take details
of them from there too.
<input>
${[a, b].map((child) => memory.text(child).replace(/[\r\n]+/g, " ")).join("\n")}
</input>`;
}

export interface Attempt {
  text: string;
  bytes: number;
  usage: ModelResult["usage"];
  quota: ModelResult["quota"];
}

export interface Compression {
  text: string;
  attempts: Attempt[];
}

export async function compress(memory: Memory, part: Part, call: ModelCall): Promise<Compression> {
  const source = memory.source(part);
  if (bytes(source) <= NODE_BYTES) return { text: source, attempts: [] };
  // The same system prompt and tools as a turn, so a compaction reads the turns' cache entry.
  const input: InputItem[] = [
    user([`<chat>\n${memory.context(part)}\n</chat>`, task(memory, part)]),
  ];
  const attempts: Attempt[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await call({ system: SYSTEM, input, tools: [...TOOLS] });
    const text = result.text.trim().replace(/^\d+\+\d+\|/, "");
    if (!text) throw new Error("The compactor returned an empty summary");
    attempts.push({ text, bytes: bytes(text), usage: result.usage, quota: result.quota });
    if (bytes(text) <= NODE_BYTES) break;
    input.push(...result.output);
    const cut = new TextDecoder()
      .decode(new TextEncoder().encode(text).slice(0, NODE_BYTES))
      .replace(/�$/, "");
    input.push(
      user([
        `Too long: your line is ${bytes(text)} bytes, over the 512-byte limit. Write
the whole line again for the same <input>, cutting just enough of the
least valuable items to fit before this cut:
${cut}| ← LIMIT`,
      ]),
    );
  }
  const shortest = attempts.reduce<Attempt | undefined>(
    (best, line) => (best === undefined || line.bytes < best.bytes ? line : best),
    undefined,
  );
  if (!shortest) throw new Error("The compactor made no attempt");
  return { text: shortest.text, attempts };
}

export interface PumpOptions {
  jobs?: number;
  maxPaidNodes?: number;
  canBuildPaidNode?: () => boolean;
  /** False holds merges back, so every free slot goes to leaves a waiting turn needs. */
  canMerge?: () => boolean;
  onResult?: (part: Part, result: Compression) => void;
  onError?: (error: unknown, part: Part) => void;
}

export interface PumpResult {
  built: number;
  paidNodes: number;
  calls: number;
  settled: boolean;
}

// A paid node may need several model calls to meet the summary target.
export async function pump(
  memory: Memory,
  call: ModelCall,
  {
    jobs = 8,
    maxPaidNodes = Infinity,
    canBuildPaidNode = () => true,
    canMerge = () => true,
    onResult = () => {},
    onError = console.error,
  }: PumpOptions = {},
): Promise<PumpResult> {
  const busy = new Map<string, Promise<void>>();
  let calls = 0;
  let paidNodes = 0;
  let built = 0;
  while (true) {
    const candidates = memory.ready(new Set(busy.keys()), Date.now(), jobs);
    for (const part of candidates) {
      if (busy.size >= jobs) break;
      if (part.level > 0 && !canMerge()) continue;
      const paid = bytes(memory.source(part)) > NODE_BYTES;
      if (paid && (paidNodes >= maxPaidNodes || !canBuildPaidNode())) continue;
      if (paid) paidNodes++;
      const id = `${part.level}:${part.index}`;
      const task = compress(memory, part, (request) => {
        calls++;
        return call(request);
      })
        .then((result) => {
          memory.saveNode(part, result.text);
          built++;
          onResult(part, result);
        })
        .catch((error: unknown) => {
          if (memory.fail(part, error)) onError(error, part);
        })
        .finally(() => busy.delete(id));
      busy.set(id, task);
    }
    if (busy.size === 0) break;
    await Promise.race(busy.values());
  }
  return { built, paidNodes, calls, settled: memory.settled() };
}
