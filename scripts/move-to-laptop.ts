import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDatabase } from "../node/sqlite.ts";
import { DirectoryBucket } from "../node/bucket.ts";
import { settingsTable } from "../node/local-master.ts";
import type { SqlValue } from "../src/database.ts";
import { isRecord, parseJson, requireString } from "../src/json.ts";

/** Fetch an owner export route of the cloud Master; the caller adds authentication. */
export type ExportGet = (path: string) => Promise<Response>;

export interface Moved {
  tables: Record<string, number>;
  objects: number;
  bytes: number;
}

const PAGE_ROWS = 200;
const DOWNLOADS = 8;
/** The cloud Sandbox's workspace backup; the local Master has no Sandbox. */
const SKIPPED = /^backups\//;

async function exported(get: ExportGet, path: string): Promise<Record<string, unknown>> {
  const response = await get(path);
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 200)}`);
  const value = parseJson(text);
  if (!isRecord(value)) throw new Error(`${path} did not answer with an object`);
  return value;
}

function sqlValue(value: unknown): SqlValue {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  throw new Error("An exported row holds a value that is not text, a number or null");
}

/**
 * Copy the cloud Master's tables, instructions and bucket into `directory` for the local Master.
 * Work happens in `<directory>.moving`: the database is rebuilt on each run, objects already there
 * at their full size are kept, and the directory gets its name only once every count matches.
 */
export async function moveToLaptop(
  get: ExportGet,
  directory: string,
  log: (line: string) => void = console.log,
): Promise<Moved> {
  if (existsSync(directory)) throw new Error(`${directory} already exists; move into a new one`);
  const staging = `${directory}.moving`;
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  for (const file of ["master.sqlite", "master.sqlite-wal", "master.sqlite-shm"]) {
    rmSync(join(staging, file), { force: true });
  }

  const schema = await exported(get, "/api/export/schema");
  const tables = Array.isArray(schema["tables"]) ? schema["tables"].filter(isRecord) : [];
  const indexes = Array.isArray(schema["indexes"]) ? schema["indexes"] : [];
  const sql = openDatabase(join(staging, "master.sqlite"));
  const counts: Record<string, number> = {};
  try {
    for (const table of tables) sql.exec(requireString(table["sql"], "A table needs its SQL"));
    for (const index of indexes) sql.exec(requireString(index, "An index needs its SQL"));
    for (const table of tables) {
      const name = requireString(table["name"], "A table needs its name");
      let after: number | null = null;
      let copied = 0;
      for (;;) {
        const page = await exported(
          get,
          `/api/export/rows?table=${encodeURIComponent(name)}&limit=${PAGE_ROWS}${after === null ? "" : `&after=${after}`}`,
        );
        const columns = Array.isArray(page["columns"]) ? page["columns"].map(String) : [];
        const rows = Array.isArray(page["rows"]) ? page["rows"].filter(Array.isArray) : [];
        if (columns[0] !== "rowid") throw new Error(`${name}: the export lost its rowids`);
        const insert = `INSERT INTO "${name}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
        sql.transaction(() => {
          for (const row of rows) sql.exec(insert, ...row.map(sqlValue));
        });
        copied += rows.length;
        const last: unknown = rows.at(-1)?.[0];
        if (rows.length < PAGE_ROWS || typeof last !== "number") break;
        after = last;
      }
      if (copied !== table["rows"]) {
        throw new Error(`${name}: copied ${copied} rows of ${String(table["rows"])}`);
      }
      counts[name] = copied;
      log(`${name}: ${copied} rows`);
    }
    if (typeof schema["instructions"] === "string") {
      await settingsTable(sql).put("instructions", schema["instructions"]);
    }
  } finally {
    sql.close();
  }

  const bucket = new DirectoryBucket(join(staging, "bucket"));
  const objects: { key: string; size: number }[] = [];
  let cursor: string | null = null;
  do {
    const page = await exported(
      get,
      `/api/export/objects${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    for (const item of Array.isArray(page["objects"]) ? page["objects"].filter(isRecord) : []) {
      const key = requireString(item["key"], "An object needs its key");
      const size = item["size"];
      if (typeof size !== "number") throw new Error(`${key} has no size`);
      if (!SKIPPED.test(key)) objects.push({ key, size });
    }
    cursor = typeof page["cursor"] === "string" ? page["cursor"] : null;
  } while (cursor);

  let next = 0;
  let done = 0;
  let bytes = 0;
  const download = async (): Promise<void> => {
    for (let item = objects[next++]; item; item = objects[next++]) {
      const { key, size } = item;
      const present = (await bucket.head(key))?.size;
      for (let attempt = 1; present !== size; attempt++) {
        try {
          const response = await get(`/api/export/object?key=${encodeURIComponent(key)}`);
          if (!response.ok || !response.body) throw new Error(`${response.status}`);
          if ((await bucket.put(key, response.body)).size !== size) throw new Error("short read");
          break;
        } catch (error) {
          if (attempt === 3) throw new Error(`${key}: ${String(error)}`);
        }
      }
      bytes += size;
      if (++done % 500 === 0 || done === objects.length) {
        log(`objects: ${done}/${objects.length}, ${(bytes / 1e9).toFixed(2)} GB`);
      }
    }
  };
  await Promise.all(Array.from({ length: DOWNLOADS }, download));
  for (const { key, size } of objects) {
    if (statSync(join(staging, "bucket", key)).size !== size) throw new Error(`${key} differs`);
  }
  renameSync(staging, directory);
  return { tables: counts, objects: objects.length, bytes };
}

if (import.meta.filename === resolve(process.argv[1] ?? "")) {
  const { cloudClient } = await import("./cloud-client.ts");
  const moved = await moveToLaptop(cloudClient().get, resolve(process.argv[2] ?? "data/master"));
  console.log(`Moved ${Object.keys(moved.tables).length} tables and ${moved.objects} objects.`);
}
