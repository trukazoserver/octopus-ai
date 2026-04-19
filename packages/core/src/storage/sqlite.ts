import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Database, SqlJsStatic, Statement } from "sql.js";
import { expandTildePath } from "../utils/helpers.js";
import type { DatabaseAdapter } from "./database.js";
import { migrations } from "./migrations/index.js";

let initSqlJsFn: (() => Promise<SqlJsStatic>) | null = null;
let staticInstance: SqlJsStatic | null = null;

try {
	const mod = await import("sql.js");
	initSqlJsFn = mod.default;
} catch {
	console.warn(
		"sql.js not found or failed to load. Operating in volatile mode without DB.",
	);
}

export class SqliteDatabase implements DatabaseAdapter {
	private db: Database | null = null;
	private dbPath: string;
	private dirty = false;
	private persistTimer: ReturnType<typeof setInterval> | null = null;

	constructor(path: string) {
		this.dbPath = path === ":memory:" ? path : expandTildePath(path);
	}

	async initialize(): Promise<void> {
		if (!initSqlJsFn) return;

		try {
			staticInstance = await initSqlJsFn();

			if (this.dbPath !== ":memory:") {
				const dir = dirname(this.dbPath);
				mkdirSync(dir, { recursive: true });
			}

			if (this.dbPath === ":memory:") {
				this.db = new staticInstance.Database();
			} else {
				try {
					const buffer = readFileSync(this.dbPath);
					this.db = new staticInstance.Database(buffer);
				} catch {
					this.db = new staticInstance.Database();
				}
			}

			this.db.run("PRAGMA foreign_keys = ON;");

			await this.runMigrations();

			if (this.dbPath !== ":memory:") {
				this.persistTimer = setInterval(() => this.persist(), 30_000);
			}
		} catch (e) {
			console.warn(
				"Failed to initialize SQLite database. Operating without persistence.",
				e instanceof Error ? e.message : e,
			);
			this.db = null;
		}
	}

	async close(): Promise<void> {
		if (this.persistTimer) {
			clearInterval(this.persistTimer);
			this.persistTimer = null;
		}
		if (this.db) {
			this.persist();
			this.db.close();
			this.db = null;
		}
	}

	async run(sql: string, params?: unknown[]): Promise<void> {
		if (!this.db) return;
		this.db.run(sql, params ?? []);
		this.dirty = true;
	}

	async get<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
		if (!this.db) return undefined;
		const stmt: Statement = this.db.prepare(sql);
		if (params && params.length > 0) stmt.bind(params);
		if (stmt.step()) {
			const row = stmt.getAsObject() as T;
			stmt.free();
			return row;
		}
		stmt.free();
		return undefined;
	}

	async all<T>(sql: string, params?: unknown[]): Promise<T[]> {
		if (!this.db) return [];
		const stmt: Statement = this.db.prepare(sql);
		if (params && params.length > 0) stmt.bind(params);
		const results: T[] = [];
		while (stmt.step()) {
			results.push(stmt.getAsObject() as T);
		}
		stmt.free();
		return results;
	}

	async transaction<T>(fn: () => Promise<T>): Promise<T> {
		if (!this.db) return await fn();
		this.db.run("BEGIN TRANSACTION");
		try {
			const result = await fn();
			this.db.run("COMMIT");
			this.dirty = true;
			return result;
		} catch (e) {
			this.db.run("ROLLBACK");
			throw e;
		}
	}

	private ensureOpen(): void {
		if (!this.db) {
			throw new Error("Database is not initialized. Call initialize() first.");
		}
	}

	private async runMigrations(): Promise<void> {
		this.ensureOpen();

		this.db?.exec(`
			CREATE TABLE IF NOT EXISTS _migrations (
				version INTEGER PRIMARY KEY,
				applied_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);

		const applied = await this.all<{ version: number }>(
			"SELECT version FROM _migrations",
		);
		const appliedVersions = new Set(applied.map((r) => r.version));

		for (const migration of migrations) {
			if (!appliedVersions.has(migration.version)) {
				await migration.up(this);
				await this.run("INSERT INTO _migrations (version) VALUES (?)", [
					migration.version,
				]);
			}
		}

		this.persist();
	}

	private persist(): void {
		if (!this.db || this.dbPath === ":memory:") return;
		if (!this.dirty) return;
		try {
			const data = this.db.export();
			const buffer = Buffer.from(data);
			writeFileSync(this.dbPath, buffer);
			this.dirty = false;
		} catch (e) {
			console.warn("Failed to persist SQLite database:", e);
		}
	}
}
