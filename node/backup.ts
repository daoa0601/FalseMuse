import { createReadStream, createWriteStream } from "node:fs";
import { open, readdir, rm, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { BACKUP_PART_BYTES, SNAPSHOT_PREFIX } from "../src/backup-protocol.ts";
import { errorMessage, isRecord, parseJson } from "../src/json.ts";
import { openDatabase } from "./sqlite.ts";

/** The Worker's backup routes over R2, as the laptop reaches them. */
export interface RemoteBucket {
  list(prefix?: string): Promise<{ key: string; size: number }[]>;
  /** Upload a file whole, or in parts when it is larger than one request carries. */
  upload(key: string, path: string, size: number): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface BackupOptions {
  /** Write a consistent copy of the Master's database to `target`. */
  snapshot(target: string): void;
  /** The Master's bucket directory. */
  bucket: string;
  /** Holds the backup's own record and temporary files; kept out of the snapshot. */
  directory: string;
  remote: RemoteBucket;
  /** The owner's local date, which names the snapshot. */
  date: string;
  keep?: number;
  /** Checked between files, so a stopping Master does not wait for the whole bucket. */
  stopped?: () => boolean;
  log?: (line: string) => void;
}

export interface BackupResult {
  snapshot: string;
  files: number;
  bytes: number;
}

const UPLOADS = 4;
const SNAPSHOT = /^snapshots\/master-\d{4}-\d{2}-\d{2}\.sqlite\.gz$/;

const ATTEMPTS = 4;

/** Why a request failed; fetch hides the network's reason in `cause`. */
function failure(error: unknown): string {
  const cause = isRecord(error) ? error["cause"] : undefined;
  return cause === undefined
    ? errorMessage(error)
    : `${errorMessage(error)} (${errorMessage(cause)})`;
}

/**
 * One backup request, tried again after a network failure or a server error with waits doubling
 * from `retryMs`; a refusal (4xx) is final.
 */
async function request(
  url: string,
  init: RequestInit,
  what: string,
  retryMs: number,
): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    let response: Response | null = null;
    let text = "";
    let problem: string;
    try {
      const answer = await fetch(url, { ...init, redirect: "manual" });
      text = await answer.text();
      response = answer;
      problem = `${what} answered ${answer.status} ${text.slice(0, 200)}`;
    } catch (error) {
      problem = `${what} failed: ${failure(error)}`;
    }
    if (response?.ok) return parseJson(text);
    if ((response && response.status < 500) || attempt === ATTEMPTS) throw new Error(problem);
    await new Promise((resolve) => setTimeout(resolve, retryMs * 2 ** (attempt - 1)));
  }
}

/** The Worker's /backup routes, with the owner key and any Access token in `headers`. */
export function workerBucket(
  url: string,
  headers: Record<string, string>,
  { retryMs = 2_000 }: { retryMs?: number } = {},
): RemoteBucket {
  const route = (path: string, query: Record<string, string>) =>
    `${url}/backup/${path}?${new URLSearchParams(query)}`;
  const put = async (path: string, query: Record<string, string>, body: Buffer) =>
    request(
      route(path, query),
      {
        method: "PUT",
        headers: { ...headers, "content-length": String(body.length) },
        body: new Uint8Array(body),
      },
      `Backup of ${query["key"]}`,
      retryMs,
    );
  return {
    async list(prefix = "") {
      const objects: { key: string; size: number }[] = [];
      let cursor: string | null = null;
      do {
        const page = await request(
          route("list", { prefix, ...(cursor ? { cursor } : {}) }),
          { headers },
          "The backup listing",
          retryMs,
        );
        if (!isRecord(page) || !Array.isArray(page["objects"])) {
          throw new Error("The backup listing has no objects");
        }
        for (const item of page["objects"]) {
          if (isRecord(item) && typeof item["key"] === "string" && typeof item["size"] === "number")
            objects.push({ key: item["key"], size: item["size"] });
        }
        cursor = typeof page["cursor"] === "string" ? page["cursor"] : null;
      } while (cursor);
      return objects;
    },
    async upload(key, path, size) {
      const handle = await open(path);
      try {
        const read = async (offset: number) => {
          const buffer = Buffer.alloc(Math.min(BACKUP_PART_BYTES, size - offset));
          await handle.read(buffer, 0, buffer.length, offset);
          return buffer;
        };
        if (size <= BACKUP_PART_BYTES) {
          await put("object", { key }, await read(0));
          return;
        }
        const started = await request(
          route("multipart", { key }),
          {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: "{}",
          },
          `Backup of ${key}`,
          retryMs,
        );
        const upload = isRecord(started) ? started["upload"] : undefined;
        if (typeof upload !== "string") throw new Error(`Backup of ${key} started no upload`);
        const parts: unknown[] = [];
        for (let offset = 0, number = 1; offset < size; offset += BACKUP_PART_BYTES, number++) {
          parts.push(
            await put("part", { key, upload, number: String(number) }, await read(offset)),
          );
        }
        await request(
          route("complete", { key, upload }),
          {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ parts }),
          },
          `Backup of ${key}`,
          retryMs,
        );
      } finally {
        await handle.close();
      }
    },
    async remove(key) {
      await request(
        route("object", { key }),
        { method: "DELETE", headers },
        `Removing ${key}`,
        retryMs,
      );
    },
  };
}

/** Every file the bucket holds, by key; unfinished writes and uploads are not files yet. */
async function bucketFiles(root: string): Promise<{ key: string; path: string }[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(
    (error: unknown) => {
      if (isRecord(error) && error["code"] === "ENOENT") return [];
      throw error;
    },
  );
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return { key: relative(root, path).split(sep).join("/"), path };
    })
    .filter(({ key }) => !key.startsWith(".uploads/") && !/\.[0-9a-f-]{36}\.part$/.test(key));
}

/**
 * Copy the Master to R2: a gzipped snapshot of its database under the owner's date, the
 * snapshots beyond `keep` removed, then every bucket file that changed since its last upload. The
 * first run counts files R2 already holds at the same size as uploaded.
 */
export async function backUp(options: BackupOptions): Promise<BackupResult> {
  const log = options.log ?? console.log;
  const state = openDatabase(join(options.directory, "backup.sqlite"));
  try {
    state.exec(
      "CREATE TABLE IF NOT EXISTS uploaded (key TEXT PRIMARY KEY, size INTEGER NOT NULL, modified INTEGER NOT NULL)",
    );
    state.exec("CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)");

    const copy = join(options.directory, ".snapshot.sqlite");
    const packed = `${copy}.gz`;
    const snapshot = `${SNAPSHOT_PREFIX}master-${options.date}.sqlite.gz`;
    try {
      await rm(copy, { force: true });
      options.snapshot(copy);
      await pipeline(createReadStream(copy), createGzip(), createWriteStream(packed));
      await options.remote.upload(snapshot, packed, (await stat(packed)).size);
    } finally {
      await rm(copy, { force: true });
      await rm(packed, { force: true });
    }
    const snapshots = (await options.remote.list(SNAPSHOT_PREFIX))
      .map(({ key }) => key)
      .filter((key) => SNAPSHOT.test(key))
      .sort();
    for (const key of snapshots.slice(0, Math.max(0, snapshots.length - (options.keep ?? 7)))) {
      await options.remote.remove(key);
    }

    const files = await bucketFiles(options.bucket);
    const sizes = new Map<string, number>();
    if (!state.rows("SELECT 1 FROM settings WHERE name='seeded'").length) {
      for (const { key, size } of await options.remote.list()) sizes.set(key, size);
    }
    const uploaded = new Map(
      state
        .rows<{ key: string; size: number; modified: number }>("SELECT * FROM uploaded")
        .map((row) => [row.key, row]),
    );
    const changed: { key: string; path: string; size: number; modified: number }[] = [];
    for (const { key, path } of files) {
      const info = await stat(path);
      const modified = Math.trunc(info.mtimeMs);
      const earlier = uploaded.get(key);
      if (earlier?.size === info.size && earlier.modified === modified) continue;
      if (!earlier && sizes.get(key) === info.size) {
        state.exec("INSERT INTO uploaded VALUES (?, ?, ?)", key, info.size, modified);
        continue;
      }
      changed.push({ key, path, size: info.size, modified });
    }
    state.exec("INSERT OR IGNORE INTO settings VALUES ('seeded', '1')");

    let next = 0;
    let bytes = 0;
    let count = 0;
    const work = async () => {
      for (let file = changed[next++]; file; file = changed[next++]) {
        if (options.stopped?.()) return;
        await options.remote.upload(file.key, file.path, file.size);
        state.exec(
          "INSERT INTO uploaded VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET size=excluded.size, modified=excluded.modified",
          file.key,
          file.size,
          file.modified,
        );
        bytes += file.size;
        count++;
      }
    };
    await Promise.all(Array.from({ length: UPLOADS }, work));
    if (!options.stopped?.()) {
      state.exec(
        "INSERT INTO settings VALUES ('last', ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
        options.date,
      );
    }
    log(`Backed up ${snapshot} and ${count} changed files (${(bytes / 1e6).toFixed(1)} MB)`);
    return { snapshot, files: count, bytes };
  } finally {
    state.close();
  }
}

/** The owner's local date and hour in `timezone`. */
export function localDay(now: number, timezone: string): { date: string; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts["year"]}-${parts["month"]}-${parts["day"]}`,
    hour: Number(parts["hour"]),
  };
}

/** The owner's date of the last complete backup in `directory`, if any. */
export function lastBackup(directory: string): string | null {
  const state = openDatabase(join(directory, "backup.sqlite"));
  try {
    state.exec("CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
    return (
      state.rows<{ value: string }>("SELECT value FROM settings WHERE name='last'")[0]?.value ??
      null
    );
  } finally {
    state.close();
  }
}

export interface BackupSchedule {
  stop(): Promise<void>;
}

/**
 * Back up once a day at the first check from `hour` on in the owner's time zone, so a laptop
 * asleep at that hour backs up when it wakes. A failed backup is tried again at the next check.
 */
export function scheduleBackups(
  options: Omit<BackupOptions, "date" | "stopped"> & {
    timezone: string;
    hour?: number;
    checkMs?: number;
  },
): BackupSchedule {
  const log = options.log ?? console.log;
  let stopped = false;
  let running: Promise<void> | null = null;
  let last = lastBackup(options.directory);
  const check = () => {
    if (running || stopped) return;
    const { date, hour } = localDay(Date.now(), options.timezone);
    if (hour < (options.hour ?? 3) || date === last) return;
    running = backUp({ ...options, date, stopped: () => stopped })
      .then(() => {
        last = date;
      })
      .catch((error: unknown) => log(`Backup failed: ${errorMessage(error)}`))
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(check, options.checkMs ?? 60 * 60 * 1000);
  const first = setTimeout(check, Math.min(options.checkMs ?? 60_000, 60_000));
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(first);
      await running;
    },
  };
}
