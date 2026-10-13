export type SqlValue = string | number | null;

/**
 * Synchronous SQL over either Durable Object storage or node:sqlite.
 * `rows` trusts the caller's row shape: each query names the columns it reads.
 */
export interface SqlDatabase {
  rows<Row extends object>(query: string, ...bindings: SqlValue[]): Row[];
  exec(query: string, ...bindings: SqlValue[]): void;
  transaction<T>(action: () => T): T;
}

export function hasColumn(database: SqlDatabase, table: string, column: string): boolean {
  return database
    .rows<{ name: string }>(`PRAGMA table_info(${table})`)
    .some((row) => row.name === column);
}
