// Phase 2 retrieval check: ask each prepared question in a fresh turn over a prototype tree, with the
// agent's memory tools, then grade the answer against the expected one.
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../node/sqlite.ts";
import { Memory } from "../src/memory.ts";
import { SYSTEM } from "../src/prompts.ts";
import { TOOLS } from "../src/tools.ts";
import {
  codexCall,
  functionCall,
  messageText,
  user,
  type Credential,
  type InputItem,
} from "../src/codex.ts";
import { errorMessage, isRecord, parseJson } from "../src/json.ts";
import { localAuth } from "../node/local-auth.ts";

const [tree, model = "gpt-6.1-sol", grader = "gpt-6.1-sol"] = process.argv.slice(2);
if (!tree || !/^[\w.-]+$/.test(tree)) {
  throw new Error("Name a prototype tree, for example 2026-09-gpt-6-luna-v3");
}

interface Question {
  name: string;
  question: string;
  expectedAnswer: string;
  sources: { id: number }[];
}

function questions(path: string): Question[] {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  const list = isRecord(value) ? value["questions"] : undefined;
  if (!Array.isArray(list)) throw new Error("The question file has no questions");
  return list.map((item: unknown) => {
    if (
      !isRecord(item) ||
      typeof item["name"] !== "string" ||
      typeof item["question"] !== "string" ||
      typeof item["expectedAnswer"] !== "string" ||
      !Array.isArray(item["sources"])
    ) {
      throw new Error("A retrieval question is malformed");
    }
    return {
      name: item["name"],
      question: item["question"],
      expectedAnswer: item["expectedAnswer"],
      sources: item["sources"].map((source: unknown) => ({
        id: isRecord(source) && typeof source["id"] === "number" ? source["id"] : -1,
      })),
    };
  });
}

// Opening a tree migrates its schema, so evaluate a copy and leave the prototype's own file alone.
const output = join("data", "eval", tree);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const copy = join(output, "memory.sqlite");
copyFileSync(join("data", `prototype-${tree}`, "memory.sqlite"), copy);
const database = openDatabase(copy);
const memory = new Memory(database);
const view = memory.render();
const memoryTools = TOOLS.filter((tool) => ["zoom", "date", "search"].includes(tool.name));
let credentials: (() => Promise<Credential>) | undefined;
async function call(request: Parameters<typeof codexCall>[1]) {
  credentials ??= await localAuth();
  for (let attempt = 0; ; attempt++) {
    try {
      return await codexCall(await credentials(), request);
    } catch (error) {
      if (attempt >= 5 || !/\((429|5\d\d)\)|terminated|fetch failed/.test(errorMessage(error))) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000 * (attempt + 1)));
    }
  }
}

function runTool(name: string, args: unknown): string {
  const input = isRecord(args) ? args : {};
  try {
    if (name === "zoom") return memory.zoom(Number(input["id"]), Number(input["n"]));
    if (name === "date") return memory.date(Number(input["id"]));
    if (name === "search") return JSON.stringify(memory.search(String(input["query"] ?? "")));
    return `No tool ${name}`;
  } catch (error) {
    return JSON.stringify({ error: errorMessage(error) });
  }
}

const results = [];
for (const item of questions("data/retrieval-questions.json")) {
  const input: InputItem[] = [user([view, item.question])];
  const tools: string[] = [];
  const opened = new Set<number>();
  let answer = "";
  let requests = 0;
  let inputTokens = 0;
  let cachedTokens = 0;
  for (let step = 0; step < 16 && !answer; step++) {
    const result = await call({
      model,
      system: SYSTEM,
      input,
      tools: memoryTools,
      cacheKey: `optchat-eval-${tree}`,
      signal: AbortSignal.timeout(180_000),
    });
    requests++;
    const usage = isRecord(result.usage) ? result.usage : {};
    const details = isRecord(usage["input_tokens_details"]) ? usage["input_tokens_details"] : {};
    inputTokens += typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : 0;
    cachedTokens += typeof details["cached_tokens"] === "number" ? details["cached_tokens"] : 0;
    input.push(...result.output);
    const calls = result.output.map(functionCall).filter((entry) => entry !== null);
    for (const entry of calls) {
      const args = parseJson(entry.arguments);
      tools.push(`${entry.name}(${entry.arguments})`);
      if (entry.name === "zoom" && isRecord(args) && args["n"] === 1)
        opened.add(Number(args["id"]));
      input.push({
        type: "function_call_output",
        call_id: entry.callId,
        output: runTool(entry.name, args),
      });
    }
    if (calls.length === 0) {
      answer = result.output.map(messageText).filter(Boolean).join("\n").trim() || "(no answer)";
    }
  }
  const grade = await call({
    model: grader,
    system:
      'You grade answers from a memory system against the expected answer. Score 1 if the answer states the expected facts (wording may differ), 0.5 if it states some of them or adds a wrong claim beside them, 0 if it misses them or contradicts them. Reply with JSON only: {"score": 0 | 0.5 | 1, "reason": "one sentence"}.',
    input: [
      user([
        `Question: ${item.question}\nExpected answer: ${item.expectedAnswer}\nAnswer to grade: ${answer}`,
      ]),
    ],
    cacheKey: "optchat-eval-grader",
    signal: AbortSignal.timeout(180_000),
  });
  const verdict = parseJson(grade.text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  const result = {
    name: item.name,
    score: isRecord(verdict) && typeof verdict["score"] === "number" ? verdict["score"] : null,
    reason: isRecord(verdict) ? verdict["reason"] : grade.text,
    openedSource: item.sources.some((source) => opened.has(source.id)),
    toolCalls: tools.length,
    requests,
    inputTokens,
    cached: inputTokens ? Math.round((100 * cachedTokens) / inputTokens) : 0,
    answer,
    tools,
  };
  results.push(result);
  appendFileSync(join(output, "results.jsonl"), JSON.stringify(result) + "\n");
  console.log(
    JSON.stringify({ name: result.name, score: result.score, openedSource: result.openedSource }),
  );
}
const scored = results.filter((result) => result.score !== null);
console.log(
  JSON.stringify({
    tree,
    model,
    score: scored.reduce((sum, result) => sum + (result.score ?? 0), 0),
    of: results.length,
    openedSource: results.filter((result) => result.openedSource).length,
    toolCalls: results.reduce((sum, result) => sum + result.toolCalls, 0),
    viewBytes: memory.size(),
  }),
);
database.close();
