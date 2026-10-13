import type { SqlDatabase } from "./database.ts";

export const NODE_BYTES = 512;
/** The chat's view grows to this size, then one batch merges it down to half. */
export const VIEW_BYTES = 128_000;
/** The compactions' view: the chat's view merged further, with the same sawtooth. */
export const CONTEXT_BYTES = 32_000;
/** Longer text is logged as several messages in a row; tool output is clipped to this instead. */
export const MESSAGE_CHARS = 30_000;
export const MESSAGE_KINDS = ["user", "talk", "tool", "echo", "note", "work"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** Tree node `(level, index)`: covers messages [index·2^level, (index+1)·2^level). */
export interface Part {
  level: number;
  index: number;
}

export interface NewMessage {
  kind: MessageKind;
  text: string;
  timestamp?: string;
  session?: string | null;
  index?: number | null;
}

export interface StoredMessage {
  id: number;
  kind: MessageKind;
  text: string;
  date: string;
  session: string | null;
  source_index: number | null;
}

export interface SearchHit {
  id: number;
  n: number;
  text: string;
}

export const bytes = (text: string): number => new TextEncoder().encode(text).length;
export const isMessageKind = (value: unknown): value is MessageKind =>
  MESSAGE_KINDS.some((kind) => kind === value);
const key = (level: number, index: number): string => `${level}:${index}`;
const start = ({ level, index }: Part): number => index * 2 ** level;
const end = (part: Part): number => start(part) + 2 ** part.level;
const flat = (text: string): string => text.replace(/[\r\n]+/g, " ");
const placeholder = "(not summarized yet: zoom it)";

/** Pages of at most `limit` characters, each ending at a line break when one is near its end. */
export function pages(text: string, limit = MESSAGE_CHARS): string[] {
  const result: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit - 1) + 1;
    if (cut < limit * 0.8) cut = limit;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--; // never split a surrogate pair
    result.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  result.push(rest);
  return result;
}

/**
 * Merge the most due sibling pairs whose parent is built until the view is at most `target`
 * bytes. A pair is due by how long ago it ended, in its own line size: `(T - last) / 2^l`, the
 * oldest of equal pairs first. This makes exactly the merges of Taelin's rollback push.
 */
export function fold(
  view: readonly Part[],
  count: number,
  target: number,
  { size, built }: { size: (part: Part) => number; built: (part: Part) => boolean },
): { view: Part[]; size: number } {
  const folded = [...view];
  let total = folded.reduce((sum, part) => sum + size(part), 0);
  while (total > target) {
    let best: { position: number; parent: Part; due: number } | null = null;
    for (let position = 0; position + 1 < folded.length; position++) {
      const a = folded[position];
      const b = folded[position + 1];
      if (!a || !b) continue;
      const parent = { level: a.level + 1, index: a.index / 2 };
      if (a.level !== b.level || a.index % 2 || b.index !== a.index + 1 || !built(parent)) continue;
      const due = (count - (end(b) - 1)) / 2 ** a.level;
      if (best === null || due > best.due) best = { position, parent, due };
    }
    if (best === null) break;
    const [a, b] = folded.splice(best.position, 2, best.parent);
    if (!a || !b) break;
    total += size(best.parent) - size(a) - size(b);
  }
  return { view: folded, size: total };
}

// The adapter supplies synchronous SQL and an atomic transaction on either host.
export class Memory {
  readonly database: SqlDatabase;
  readonly viewBytes: number;
  readonly contextBytes: number;
  count: number;
  nodeCount: number;
  view: Part[];
  /** The compactions' coarser view of the same chat. */
  contextView: Part[];
  /** A batch that could not reach half the view yet goes on at each change. */
  private merging: boolean;
  private viewText = new Map<string, string>();
  private readonly folding = {
    size: (part: Part) => this.lineBytes(part),
    built: (part: Part) => this.built(part),
  };

  constructor(
    database: SqlDatabase,
    {
      viewBytes = VIEW_BYTES,
      contextBytes = CONTEXT_BYTES,
    }: { viewBytes?: number; contextBytes?: number } = {},
  ) {
    this.database = database;
    this.viewBytes = viewBytes;
    this.contextBytes = contextBytes;
    const queued = database.rows(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='compaction_queue'",
    ).length;
    for (const query of [
      `CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL,
        date TEXT NOT NULL, session TEXT, source_index INTEGER,
        UNIQUE(session, source_index))`,
      `CREATE TABLE IF NOT EXISTS nodes (
        level INTEGER NOT NULL, idx INTEGER NOT NULL, text TEXT NOT NULL,
        PRIMARY KEY(level, idx))`,
      "CREATE VIRTUAL TABLE IF NOT EXISTS node_search USING fts5(text, level UNINDEXED, idx UNINDEXED)",
      "CREATE TABLE IF NOT EXISTS memory_view (position INTEGER PRIMARY KEY, level INTEGER NOT NULL, idx INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS node_failures (level INTEGER, idx INTEGER, retry_at INTEGER, error TEXT, PRIMARY KEY(level, idx))",
      "CREATE TABLE IF NOT EXISTS context_view (position INTEGER PRIMARY KEY, level INTEGER NOT NULL, idx INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS memory_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL)",
      // Nodes ready to build: unbuilt leaves, and unbuilt parents of two built halves.
      "CREATE TABLE IF NOT EXISTS compaction_queue (level INTEGER NOT NULL, idx INTEGER NOT NULL, PRIMARY KEY(level, idx))",
    ])
      database.exec(query);
    if (!queued) {
      database.exec(`INSERT INTO compaction_queue SELECT 0, m.id FROM messages m
        WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.level=0 AND n.idx=m.id)`);
      database.exec(`INSERT OR IGNORE INTO compaction_queue SELECT a.level+1, a.idx/2 FROM nodes a
        JOIN nodes b ON b.level=a.level AND b.idx=a.idx+1
        LEFT JOIN nodes parent ON parent.level=a.level+1 AND parent.idx=a.idx/2
        WHERE a.idx%2=0 AND parent.idx IS NULL`);
    }
    this.count = this.scalar("SELECT COUNT(*) AS value FROM messages");
    this.nodeCount = this.scalar("SELECT COUNT(*) AS value FROM nodes");
    this.merging = this.scalar("SELECT value FROM memory_state WHERE key='merging'") === 1;
    this.view = database.rows<Part>(
      "SELECT level, idx AS 'index' FROM memory_view ORDER BY position",
    );
    this.contextView = database.rows<Part>(
      "SELECT level, idx AS 'index' FROM context_view ORDER BY position",
    );
    this.cacheView();
    if (this.contextView.length === 0 && this.view.length > 0) this.refold();
  }

  private scalar(query: string): number {
    const [row] = this.database.rows<{ value: number }>(query);
    return row?.value ?? 0;
  }

  append({
    kind,
    text,
    timestamp = new Date().toISOString(),
    session = null,
    index = null,
  }: NewMessage): number {
    if (!isMessageKind(kind) || typeof text !== "string") {
      throw new Error("A message needs a known kind and text");
    }
    if (session !== null && index !== null) {
      const [existing] = this.database.rows<{ id: number }>(
        "SELECT id FROM messages WHERE session=? AND source_index=?",
        session,
        index,
      );
      if (existing) return existing.id;
    }
    // A long text becomes consecutive messages; only the first keeps the source line, so a
    // re-import finds it and skips them all.
    const split = pages(text);
    const texts =
      split.length === 1
        ? split
        : split.map((page, number) => `[part ${number + 1}/${split.length}] ${page}`);
    const first = this.count;
    this.database.transaction(() => {
      texts.forEach((page, number) => {
        const id = first + number;
        this.database.exec(
          "INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)",
          id,
          kind,
          page,
          timestamp,
          session,
          number === 0 ? index : null,
        );
        this.database.exec(
          "INSERT INTO memory_view VALUES (?, ?, ?)",
          this.view.length + number,
          0,
          id,
        );
        this.database.exec(
          "INSERT INTO context_view VALUES (?, ?, ?)",
          this.contextView.length + number,
          0,
          id,
        );
        this.database.exec("INSERT INTO compaction_queue VALUES (0, ?)", id);
      });
    });
    for (let number = 0; number < texts.length; number++) {
      const part = { level: 0, index: first + number };
      this.view.push(part);
      this.contextView.push(part);
    }
    this.count += texts.length;
    this.fit();
    return first;
  }

  saveNode(part: Part, text: string): void {
    if (
      !Number.isSafeInteger(part.level) ||
      part.level < 0 ||
      !Number.isSafeInteger(part.index) ||
      part.index < 0 ||
      end(part) > this.count
    ) {
      throw new Error("A summary must cover existing messages");
    }
    if (part.level > 0 && !this.children(part).every((child) => this.built(child))) {
      throw new Error("Build both children before saving a parent summary");
    }
    if (!text.trim()) throw new Error(`Empty summary for ${key(part.level, part.index)}`);
    if (this.built(part)) return;
    this.database.transaction(() => {
      this.database.exec("INSERT INTO nodes VALUES (?, ?, ?)", part.level, part.index, text);
      this.database.exec(
        "INSERT INTO node_search(text, level, idx) VALUES (?, ?, ?)",
        text,
        part.level,
        part.index,
      );
      this.database.exec(
        "DELETE FROM node_failures WHERE level=? AND idx=?",
        part.level,
        part.index,
      );
      this.database.exec(
        "DELETE FROM compaction_queue WHERE level=? AND idx=?",
        part.level,
        part.index,
      );
      const sibling = { level: part.level, index: part.index ^ 1 };
      const parent = { level: part.level + 1, index: part.index >> 1 };
      if (this.built(sibling) && !this.built(parent)) {
        this.database.exec(
          "INSERT OR IGNORE INTO compaction_queue VALUES (?, ?)",
          parent.level,
          parent.index,
        );
      }
    });
    this.nodeCount++;
    const shown = (line: Part) => line.level === part.level && line.index === part.index;
    if (this.view.some(shown) || this.contextView.some(shown)) {
      this.viewText.set(key(part.level, part.index), text);
    }
    this.fit();
  }

  private cacheView(): void {
    const rows = this.database.rows<{ level: number; idx: number; text: string }>(
      `SELECT v.level, v.idx, n.text FROM (
        SELECT level, idx FROM memory_view UNION SELECT level, idx FROM context_view) v
      JOIN nodes n ON n.level=v.level AND n.idx=v.idx`,
    );
    this.viewText = new Map(rows.map((row) => [key(row.level, row.idx), row.text]));
  }

  built(part: Part): boolean {
    return (
      this.viewText.has(key(part.level, part.index)) ||
      this.database.rows("SELECT 1 FROM nodes WHERE level=? AND idx=?", part.level, part.index)
        .length > 0
    );
  }

  text(part: Part): string {
    return (
      this.viewText.get(key(part.level, part.index)) ??
      this.database.rows<{ text: string }>(
        "SELECT text FROM nodes WHERE level=? AND idx=?",
        part.level,
        part.index,
      )[0]?.text ??
      placeholder
    );
  }

  settled(): boolean {
    return this.view.every((part) => this.viewText.has(key(part.level, part.index)));
  }

  /** Nodes whose last build failed, and the latest error, for the operator. */
  failures(): { failing: number; lastFailure: string | null } {
    const [latest] = this.database.rows<{ error: string }>(
      "SELECT error FROM node_failures ORDER BY retry_at DESC LIMIT 1",
    );
    return {
      failing: this.scalar("SELECT COUNT(*) AS value FROM node_failures"),
      lastFailure: latest?.error ?? null,
    };
  }

  /** When the earliest failed node may be tried again, or null when none failed. */
  nextRetry(): number | null {
    const [row] = this.database.rows<{ at: number | null }>(
      "SELECT MIN(retry_at) AS at FROM node_failures",
    );
    return row?.at ?? null;
  }

  /** Messages not summarized yet. */
  unsummarized(): number {
    return this.scalar("SELECT COUNT(*) AS value FROM compaction_queue WHERE level=0");
  }

  /** A view's size; a line not summarized yet takes no space, since no call ever sees it. */
  size(view: readonly Part[] = this.view): number {
    return view.reduce((sum, part) => sum + this.lineBytes(part), 0);
  }

  private lineBytes(part: Part): number {
    return this.built(part) ? bytes(this.text(part)) : 0;
  }

  /**
   * The chat's view only grows at its end until it passes `viewBytes`; then one batch merges it
   * to half. The compactions' view merges to half of `contextBytes` once it passes it, and again
   * whenever the chat's view merges.
   */
  private fit(): void {
    if (this.merging || this.size() > this.viewBytes) {
      const folded = fold(this.view, this.count, this.viewBytes / 2, this.folding);
      const merging = folded.size > this.viewBytes / 2;
      if (merging !== this.merging) {
        this.database.exec(
          "INSERT INTO memory_state VALUES ('merging', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          merging ? 1 : 0,
        );
        this.merging = merging;
      }
      if (folded.view.length < this.view.length) {
        this.view = folded.view;
        this.store("memory_view", this.view);
        this.refold();
        return;
      }
    }
    if (this.size(this.contextView) > this.contextBytes) {
      const folded = fold(this.contextView, this.count, this.contextBytes / 2, this.folding);
      if (folded.view.length < this.contextView.length) {
        this.contextView = folded.view;
        this.store("context_view", this.contextView);
        this.cacheView();
      }
    }
  }

  /** Derive the compactions' view from the chat's view. */
  private refold(): void {
    this.contextView = fold(this.view, this.count, this.contextBytes / 2, this.folding).view;
    this.store("context_view", this.contextView);
    this.cacheView();
  }

  private store(table: "memory_view" | "context_view", view: readonly Part[]): void {
    this.database.transaction(() => {
      this.database.exec(`DELETE FROM ${table}`);
      view.forEach((part, position) =>
        this.database.exec(
          `INSERT INTO ${table} VALUES (?, ?, ?)`,
          position,
          part.level,
          part.index,
        ),
      );
    });
  }

  /**
   * Nodes the compactor may start now: every merge whose halves are built, earliest-ending first,
   * then each of the first 8 unbuilt leaves. Merges go first because only built parents let the
   * views shrink. Ready nodes come from a queue, never a tree scan.
   */
  ready(busy: ReadonlySet<string> = new Set(), now = Date.now(), jobs = 8): Part[] {
    const due = `LEFT JOIN node_failures f ON f.level=q.level AND f.idx=q.idx
      WHERE (f.retry_at IS NULL OR f.retry_at<=?)`;
    const leaves = this.database
      .rows<{ index: number; retry_at: number | null }>(
        "SELECT q.idx AS 'index', f.retry_at FROM compaction_queue q LEFT JOIN node_failures f ON f.level=0 AND f.idx=q.idx WHERE q.level=0 ORDER BY q.idx LIMIT ?",
        jobs,
      )
      .filter((leaf) => leaf.retry_at === null || leaf.retry_at <= now)
      .map(({ index }) => ({ level: 0, index }));
    const merges = this.database.rows<Part>(
      `SELECT q.level, q.idx AS 'index' FROM compaction_queue q ${due} AND q.level>0
      ORDER BY (q.idx+1) << q.level, q.level LIMIT ?`,
      now,
      jobs + busy.size,
    );
    return [...merges, ...leaves].filter((part) => !busy.has(key(part.level, part.index)));
  }

  children({ level, index }: Part): [Part, Part] {
    return [
      { level: level - 1, index: 2 * index },
      { level: level - 1, index: 2 * index + 1 },
    ];
  }

  source(part: Part): string {
    if (part.level === 0) {
      const message = this.requireMessage(part.index);
      return `${message.kind}: ${message.text}`;
    }
    return this.children(part)
      .map((child) => this.text(child))
      .join("\n");
  }

  /**
   * A compaction's view: the compactions' view up to the message, or for a merge up to its last
   * message, stopping at the first line not summarized yet.
   */
  context(part: Part): string {
    const limit = part.level === 0 ? start(part) : end(part);
    const lines: string[] = [];
    for (const line of this.contextView) {
      if (end(line) > limit || !this.viewText.has(key(line.level, line.index))) break;
      lines.push(this.line(line));
    }
    return lines.join("\n");
  }

  /**
   * The chat's view. Lines not summarized yet name what they hold instead of quoting it, so a turn
   * never waits on the compactor and never sees half a message. A run of them is one line, so a
   * backlog of any length costs one line.
   */
  render(): string {
    const lines: string[] = [];
    for (let position = 0; position < this.view.length;) {
      const part = this.view[position];
      if (!part) break;
      let last = position;
      while (this.missing(this.view[last + 1])) last++;
      if (!this.missing(part) || last === position) {
        lines.push(this.line(part));
        position++;
        continue;
      }
      lines.push(this.missingRun(part.index, this.view[last]?.index ?? part.index));
      position = last + 1;
    }
    return `<chat>\n${lines.join("\n")}\n</chat>`;
  }

  /** A leaf of the view not summarized yet; higher lines are always built before they show. */
  private missing(part: Part | undefined): boolean {
    return part !== undefined && part.level === 0 && !this.built(part);
  }

  line(part: Part): string {
    const head = `${start(part)}+${2 ** part.level}|`;
    if (!this.missing(part)) return head + flat(this.text(part));
    return `${head}(not summarized yet: ${this.missingRun(part.index, part.index, false)})`;
  }

  /** Messages first..last, not summarized yet: their kinds and size, or the whole marker line. */
  private missingRun(first: number, last: number, whole = true): string {
    const kinds = this.database.rows<{ kind: string; count: number; size: number }>(
      `SELECT kind, COUNT(*) AS count, SUM(length(CAST(text AS BLOB))) AS size FROM messages
      WHERE id BETWEEN ? AND ? GROUP BY kind ORDER BY MIN(id)`,
      first,
      last,
    );
    const size = kinds.reduce((sum, kind) => sum + kind.size, 0);
    if (!whole) return `${kinds[0]?.kind ?? "message"}, ${size} bytes; zoom(${first}, 1) reads it`;
    const counts = kinds.map((kind) => `${kind.count} ${kind.kind}`).join(", ");
    return `${first}..${last}|(${last - first + 1} messages not summarized yet: ${counts}, ${size} bytes; zoom(id, 1) reads one)`;
  }

  zoom(id: number, count: number): string {
    if (
      !Number.isSafeInteger(id) ||
      id < 0 ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      !Number.isInteger(Math.log2(count)) ||
      id % count ||
      id + count > this.count
    ) {
      throw new Error(`No line ${id}+${count}`);
    }
    if (count === 1) {
      const message = this.requireMessage(id);
      return `${id}+0|${message.kind}: ${message.text}`;
    }
    const children = this.children({ level: Math.log2(count), index: id / count });
    if (!children.every((part) => this.built(part))) {
      throw new Error(`Line ${id}+${count} is not summarized yet`);
    }
    return children.map((part) => this.line(part)).join("\n");
  }

  date(id: number, timeZone = "Europe/Helsinki"): string {
    const message = this.requireMessage(id);
    return new Intl.DateTimeFormat("en-GB", {
      dateStyle: "full",
      timeStyle: "long",
      timeZone,
    }).format(new Date(message.date));
  }

  message(id: number): StoredMessage | undefined {
    return this.database.rows<StoredMessage>("SELECT * FROM messages WHERE id=?", id)[0];
  }

  requireMessage(id: number): StoredMessage {
    const message = this.message(id);
    if (!message) throw new Error(`No message ${id}`);
    return message;
  }

  recent(limit = 30): StoredMessage[] {
    return this.database
      .rows<StoredMessage>("SELECT * FROM messages ORDER BY id DESC LIMIT ?", limit)
      .reverse();
  }

  search(query: string, limit = 10): SearchHit[] {
    if (!query.trim()) return [];
    // Quote user terms: punctuation is text, rather than FTS query syntax.
    const terms = query
      .trim()
      .split(/\s+/)
      .map((term) => `"${term.replaceAll('"', '""')}"`)
      .join(" AND ");
    return this.database
      .rows<Part & { text: string }>(
        "SELECT level, idx AS 'index', text FROM node_search WHERE node_search MATCH ? ORDER BY rank LIMIT ?",
        terms,
        Math.max(1, Math.min(30, limit)),
      )
      .map((part) => ({ id: start(part), n: 2 ** part.level, text: part.text }));
  }

  /** Record a failed build; true when this is the node's first failure. */
  fail(part: Part, error: unknown, now = Date.now()): boolean {
    const [previous] = this.database.rows<{ error: string }>(
      "SELECT error FROM node_failures WHERE level=? AND idx=?",
      part.level,
      part.index,
    );
    this.database.exec(
      "INSERT INTO node_failures VALUES (?, ?, ?, ?) ON CONFLICT(level, idx) DO UPDATE SET retry_at=excluded.retry_at, error=excluded.error",
      part.level,
      part.index,
      now + 10_000,
      error instanceof Error ? error.message : String(error),
    );
    return previous === undefined;
  }
}
