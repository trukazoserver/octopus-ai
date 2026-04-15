import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { expandTildePath } from "../utils/helpers.js";
import type { DatabaseAdapter } from "./database.js";
import { migrations } from "./migrations/index.js";

export class SqliteDatabase implements DatabaseAdapter {
  private db: BetterSqlite3.Database | null = null;
  private dbPath: string;

  constructor(path: string) {
    this.dbPath = path === ":memory:" ? path : expandTildePath(path);
  }

  async initialize(): Promise<void> {
    if (this.dbPath !== ":memory:") {
      const dir = dirname(this.dbPath);
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    await this.runMigrations();
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  async run(sql: string, params?: unknown[]): Promise<void> {
    this.ensureOpen();
    const stmt = this.db!.prepare(sql);
    stmt.run(...(params ?? []));
  }

  async get<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
    this.ensureOpen();
    const stmt = this.db!.prepare(sql);
    return stmt.get(...(params ?? [])) as T | undefined;
  }

  async all<T>(sql: string, params?: unknown[]): Promise<T[]> {
    this.ensureOpen();
    const stmt = this.db!.prepare(sql);
    return stmt.all(...(params ?? [])) as T[];
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.ensureOpen();
    const wrapped = this.db!.transaction(async () => {
      return await fn();
    });
    return wrapped();
  }

  private ensureOpen(): void {
    if (!this.db) {
      throw new Error("Database is not initialized. Call initialize() first.");
    }
  }

  private async runMigrations(): Promise<void> {
    this.ensureOpen();

    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    const applied = this.db!
      .prepare("SELECT version FROM _migrations")
      .all() as Array<{ version: number }>;

    const appliedVersions = new Set(applied.map((r) => r.version));

    for (const migration of migrations) {
      if (!appliedVersions.has(migration.version)) {
        await migration.up(this);
        this.db!
          .prepare("INSERT INTO _migrations (version) VALUES (?)")
          .run(migration.version);
      }
    }
  }
}
