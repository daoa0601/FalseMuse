import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openDatabase } from "../node/sqlite.ts";
import { Memory, bytes, fold, type Part } from "../src/memory.ts";
import { compress, pump } from "../src/compact.ts";
import type { ModelRequest, ModelResult } from "../src/codex.ts";
import { SYSTEM } from "../src/prompts.ts";
import { TOOLS } from "../src/tools.ts";
import { inputText, modelReply } from "./support.ts";

const forbidden = (): Promise<ModelResult> => {
  throw new Error("Short messages must not call a model");
};

test("short messages stay verbatim and zoom opens originals after a restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "optchat-"));
  let database = openDatabase(join(directory, "memory.sqlite"));
  try {
    const memory = new Memory(database, { viewBytes: 30 });
    memory.append({
      kind: "user",
      text: "Remember café ☕",
      timestamp: "2026-09-02T10:00:00Z",
      session: "a",
      index: 1,
    });
    memory.append({ kind: "talk", text: "I will remember." });
    await pump(memory, forbidden);
    assert.equal(memory.view.length, 1);
    assert.match(memory.zoom(0, 2), /0\+1\|user: Remember café ☕/);
    database.close();
    database = openDatabase(join(directory, "memory.sqlite"));
    const restored = new Memory(database, { viewBytes: 30 });
    assert.equal(restored.zoom(0, 1), "0+0|user: Remember café ☕");
    assert.equal(restored.view.length, 1);
    assert.equal(
      restored.append({ kind: "user", text: "already imported", session: "a", index: 1 }),
      0,
    );
    assert.equal(restored.count, 2);
    assert.match(restored.date(0), /2 September 2026/);
  } finally {
    database.close();
    rmSync(directory, { recursive: true });
  }
});

test("leaves compact in parallel, and a compaction's view stops at the first unsummarized line", async () => {
  const database = openDatabase(":memory:");
  try {
    const memory = new Memory(database);
    memory.append({ kind: "user", text: "First decision. ".repeat(50) });
    memory.append({ kind: "user", text: "Second decision. ".repeat(50) });
    // A turn can render before the compactor runs: missing lines name themselves, unquoted.
    assert.equal(
      memory.render(),
      "<chat>\n0..1|(2 messages not summarized yet: 2 user, 1650 bytes; zoom(id, 1) reads one)\n</chat>",
    );
    const contexts: string[] = [];
    let running = 0;
    let parallel = 0;
    const call = async ({ input }: ModelRequest) => {
      contexts.push(inputText(input[0]));
      parallel = Math.max(parallel, ++running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return modelReply(`user: Keep decision ${contexts.length}`);
    };
    await pump(memory, call);
    assert.equal(parallel, 2);
    assert.deepEqual(contexts, ["<chat>\n\n</chat>", "<chat>\n\n</chat>"]);
    memory.append({ kind: "user", text: "Third decision. ".repeat(50) });
    await pump(memory, call);
    assert.match(
      contexts[2] ?? "",
      /^<chat>\n0\+1\|user: Keep decision \d\n1\+1\|user: Keep decision \d\n<\/chat>$/,
    );
    assert.doesNotMatch(contexts.join(""), /not summarized/);
    assert.ok(memory.settled());
    memory.append({ kind: "echo", text: "Tool output. ".repeat(60) });
    assert.match(
      memory.render(),
      /\n3\+1\|\(not summarized yet: echo, 780 bytes; zoom\(3, 1\) reads it\)\n<\/chat>$/,
    );
  } finally {
    database.close();
  }
});

test("a compaction sends the turns' system prompt and tools, and its task carries the ruler", async () => {
  const database = openDatabase(":memory:");
  try {
    const memory = new Memory(database);
    memory.append({ kind: "user", text: "A decision. ".repeat(50) });
    const requests: ModelRequest[] = [];
    const result = await compress(memory, { level: 0, index: 0 }, async (request) => {
      requests.push(request);
      return modelReply("0+1|user: Keep the decision");
    });
    const [request] = requests;
    assert.equal(request?.system, SYSTEM);
    assert.deepEqual(request?.tools, [...TOOLS]);
    const task = inputText(request?.input[0], 1);
    assert.match(task, /^Compaction: compress message 0 into one line of at most\n512 bytes/);
    assert.match(task, new RegExp(`\n-{512}\n<input>\nuser: A decision\\. `));
    assert.equal(result.text, "user: Keep the decision");
  } finally {
    database.close();
  }
});

test("a quota pause keeps the completed summary and does not start the next paid leaf", async () => {
  const database = openDatabase(":memory:");
  try {
    const memory = new Memory(database);
    memory.append({ kind: "user", text: "First decision. ".repeat(50) });
    memory.append({ kind: "user", text: "Second decision. ".repeat(50) });
    let allowed = true;
    let calls = 0;
    await pump(
      memory,
      async () => {
        calls++;
        return modelReply("user: Keep the first decision");
      },
      {
        jobs: 1,
        canBuildPaidNode: () => allowed,
        onResult: () => {
          allowed = false;
        },
      },
    );
    assert.equal(calls, 1);
    assert.match(memory.search("first decision")[0]?.text ?? "", /Keep the first decision/);
    assert.match(memory.zoom(1, 1), /Second decision/);
    assert.equal(memory.settled(), false);
  } finally {
    database.close();
  }
});

/** Taelin's rollback push, from the specification: the starts of the view's lines, oldest first. */
function pushStarts(count: number): number[] {
  type States = { keep: number; state: number; older: States | null } | null;
  const push = (state: number, states: States): States => {
    if (states === null) return { keep: 0, state, older: null };
    if (states.keep === 0) return { ...states, keep: 1 };
    return { keep: 0, state, older: push(states.state, states.older) };
  };
  let states: States = null;
  for (let tick = 0; tick < count; tick++) states = push(tick, states);
  const starts: number[] = [];
  for (let entry = states; entry; entry = entry.older) starts.push(entry.state);
  return starts.reverse();
}

test("the fold merges the most due pairs exactly as Taelin's push does", () => {
  let view: Part[] = [];
  for (let count = 1; count <= 3000; count++) {
    view.push({ level: 0, index: count - 1 });
    const want = pushStarts(count);
    view = fold(view, count, want.length, { size: () => 1, built: () => true }).view;
    assert.deepEqual(
      view.map((part) => part.index * 2 ** part.level),
      want,
      `after ${count} messages`,
    );
  }
});

test("the view grows only at its end, then one batch merges it to half", async () => {
  const database = openDatabase(":memory:");
  try {
    const memory = new Memory(database, { viewBytes: 30_000, contextBytes: 6_000 });
    // Every summary is 300 bytes, so each merge of two lines is a paid call.
    const summarize = async () => modelReply(`user: ${"x".repeat(294)}`);
    let previous = "";
    let batches = 0;
    for (let index = 0; index < 400; index++) {
      memory.append({ kind: "user", text: `Fact ${index}. `.repeat(60) });
      await pump(memory, summarize);
      const view = memory.render();
      if (!view.startsWith(previous.replace(/<\/chat>$/, ""))) {
        batches++;
        assert.ok(memory.size() <= 15_000, `a batch left ${memory.size()} bytes`);
      }
      assert.ok(memory.size() <= 30_000);
      assert.ok(memory.size(memory.contextView) <= 6_000);
      previous = view;
    }
    assert.ok(batches >= 3 && batches <= 12, `${batches} batches`);
  } finally {
    database.close();
  }
});

test("a bulk import keeps both views within budget as its messages are summarized", async () => {
  const database = openDatabase(":memory:");
  try {
    const memory = new Memory(database, { viewBytes: 30_000, contextBytes: 6_000 });
    for (let index = 0; index < 400; index++)
      memory.append({ kind: "user", text: `Fact ${index}. `.repeat(60) });
    // Placeholders are for display only: they take no space in either view.
    assert.equal(memory.size(), 0);
    await pump(memory, async () => modelReply(`user: ${"x".repeat(294)}`));
    assert.ok(memory.settled());
    assert.ok(memory.size() <= 30_000, `${memory.size()} bytes`);
    assert.ok(memory.size(memory.contextView) <= 6_000, `${memory.size(memory.contextView)} bytes`);
  } finally {
    database.close();
  }
});

test("merges are ready before leaves, and a database from before the queue reopens with them", async () => {
  const database = openDatabase(":memory:");
  try {
    const memory = new Memory(database);
    for (let index = 0; index < 12; index++)
      memory.append({ kind: "user", text: `Decision ${index}. `.repeat(50) });
    memory.saveNode({ level: 0, index: 0 }, "user: decision 0");
    memory.saveNode({ level: 0, index: 1 }, "user: decision 1");
    const ready = (from: Memory) => from.ready().map((part) => `${part.level}:${part.index}`);
    // Merges keep the views within budget, so they never wait behind the stream of leaves.
    assert.deepEqual(ready(memory), [
      "1:0",
      "0:2",
      "0:3",
      "0:4",
      "0:5",
      "0:6",
      "0:7",
      "0:8",
      "0:9",
    ]);
    database.exec("DROP TABLE compaction_queue");
    database.exec("DROP TABLE context_view");
    assert.deepEqual(ready(new Memory(database)), ready(memory));
  } finally {
    database.close();
  }
});

test("a waiting turn holds merges back so the compactor builds only leaves", async () => {
  const database = openDatabase(":memory:");
  try {
    const memory = new Memory(database);
    for (let index = 0; index < 3; index++)
      memory.append({ kind: "user", text: `Decision ${index}. `.repeat(50) });
    memory.saveNode({ level: 0, index: 0 }, "user: decision 0");
    memory.saveNode({ level: 0, index: 1 }, "user: decision 1");
    const built: string[] = [];
    let waiting = true;
    await pump(memory, async () => modelReply("user: a summary"), {
      canMerge: () => !waiting,
      onResult: (part) => built.push(`${part.level}:${part.index}`),
    });
    assert.deepEqual(built, ["0:2"]);
    waiting = false;
    await pump(memory, async () => modelReply("user: a summary"), {
      canMerge: () => !waiting,
      onResult: (part) => built.push(`${part.level}:${part.index}`),
    });
    assert.deepEqual(built, ["0:2", "1:0"]);
  } finally {
    database.close();
  }
});

test("a long text is logged as several messages in a row, once", () => {
  const database = openDatabase(":memory:");
  try {
    const memory = new Memory(database);
    const line = "A pasted log line with café ☕ in it.\n";
    const text = line.repeat(2_000);
    const id = memory.append({ kind: "user", text, session: "a", index: 3 });
    assert.equal(id, 0);
    assert.equal(memory.count, 3);
    const parts = [0, 1, 2].map((part) => memory.requireMessage(part));
    assert.deepEqual(
      parts.map((part) => part.text.match(/^\[part \d\/3\] /)?.[0]),
      ["[part 1/3] ", "[part 2/3] ", "[part 3/3] "],
    );
    for (const part of parts) {
      assert.equal(part.kind, "user");
      assert.ok(part.text.length <= 30_000 + "[part 1/3] ".length);
    }
    // Pages end at line breaks, and together they are the text.
    assert.ok(parts.slice(0, 2).every((part) => part.text.endsWith("\n")));
    assert.equal(parts.map((part) => part.text.replace(/^\[part \d\/3\] /, "")).join(""), text);
    assert.equal(memory.append({ kind: "user", text, session: "a", index: 3 }), 0);
    assert.equal(memory.count, 3);
    assert.equal(memory.ready().filter((part) => part.level === 0).length, 3);
    assert.equal(memory.unsummarized(), 3);
  } finally {
    database.close();
  }
});

test("the size retry retains the shortest complete reply without truncating it", async () => {
  const database = openDatabase(":memory:");
  try {
    const memory = new Memory(database);
    memory.append({ kind: "user", text: "長".repeat(400) });
    const replies = [
      "長".repeat(200),
      "長".repeat(180),
      "長".repeat(190),
      "長".repeat(175),
      "長".repeat(185),
    ];
    let calls = 0;
    const result = await compress(memory, { level: 0, index: 0 }, async ({ input }) => {
      if (calls > 0) {
        assert.match(inputText(input.at(-1)), /← LIMIT/);
        assert.doesNotMatch(inputText(input.at(-1)), /\uFFFD/);
      }
      return modelReply(replies[calls++] ?? "");
    });
    assert.equal(calls, 5);
    assert.equal(result.text, replies[3]);
    assert.ok(bytes(result.text) > 512);
  } finally {
    database.close();
  }
});

test("failed nodes wait ten seconds while the original remains readable", async () => {
  const database = openDatabase(":memory:");
  try {
    const memory = new Memory(database);
    memory.append({ kind: "user", text: "Full original" });
    memory.fail({ level: 0, index: 0 }, new Error("quota exhausted"), 1_000);
    assert.deepEqual(memory.failures(), { failing: 1, lastFailure: "quota exhausted" });
    assert.equal(memory.nextRetry(), 11_000);
    assert.equal(memory.ready(new Set(), 10_999).length, 0);
    assert.equal(memory.ready(new Set(), 11_000).length, 1);
    assert.match(memory.zoom(0, 1), /Full original/);
  } finally {
    database.close();
  }
});

test("search finds summarized facts and rejects invalid zoom ranges", async () => {
  const database = openDatabase(":memory:");
  try {
    const memory = new Memory(database);
    memory.append({ kind: "note", text: "The observer uses call_id for Responses tools." });
    await pump(memory, forbidden);
    const [hit] = memory.search("observer call_id");
    assert.ok(hit);
    assert.equal(hit.id, 0);
    assert.match(memory.zoom(hit.id, hit.n), /Responses tools/);
    assert.throws(() => memory.zoom(0, 3), /No line/);
    assert.throws(() => memory.zoom(1, 2), /No line/);
  } finally {
    database.close();
  }
});

test("a large archive opens under a small heap and still exposes an original message", () => {
  const directory = mkdtempSync(join(tmpdir(), "optchat-archive-"));
  const path = join(directory, "memory.sqlite");
  let database: ReturnType<typeof openDatabase> | null = openDatabase(path);
  try {
    const memory = new Memory(database);
    const body = "Archive content. ".repeat(65_000);
    for (let index = 0; index < 64; index++)
      memory.append({ kind: "note", text: body + `original ending ${index}` });
    // Each 1.1 MB note is logged as about 37 messages.
    const count = memory.count;
    assert.ok(count > 64 * 30);
    database.close();
    database = null;
    execFileSync(
      process.execPath,
      [
        "--max-old-space-size=32",
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      import { Memory } from "./src/memory.ts";
      import { openDatabase } from "./node/sqlite.ts";
      const database = openDatabase(process.argv[1]);
      const memory = new Memory(database);
      assert.equal(memory.count, Number(process.argv[2]));
      assert.match(memory.zoom(memory.count - 1, 1), /original ending 63$/);
      assert.match(memory.render(), /^<chat>\\n0\\.\\.\\d+\\|\\(\\d+ messages not summarized yet: \\d+ note, \\d+ bytes; zoom\\(id, 1\\) reads one\\)\\n<\\/chat>$/);
      database.close();
    `,
        path,
        String(count),
      ],
      { stdio: "pipe" },
    );
  } finally {
    database?.close();
    rmSync(directory, { recursive: true });
  }
});
