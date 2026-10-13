import { DatabaseSync } from "node:sqlite";
import type { SqlDatabase } from "../src/database.ts";

export function openDatabase(path: string): SqlDatabase & { close(): void } {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
  return {
    rows: <Row extends object>(query: string, ...bindings: (string | number | null)[]) =>
      // Each query names the columns its caller reads.
      database.prepare(query).all(...bindings) as unknown as Row[],
    exec: (query, ...bindings) => {
      database.prepare(query).run(...bindings);
    },
    transaction<T>(action: () => T): T {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = action();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => database.close(),
  };
}
