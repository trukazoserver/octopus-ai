import { SqliteDatabase } from "./sqlite.js";

export interface DatabaseAdapter {
  initialize(): Promise<void>;
  close(): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<void>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

export function createDatabaseAdapter(
  backend: string,
  config: { path?: string; connectionString?: string }
): DatabaseAdapter {
  if (backend === "sqlite") {
    return new SqliteDatabase(config.path ?? ":memory:");
  }
  throw new Error("Not implemented");
}
