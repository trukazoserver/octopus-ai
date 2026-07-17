import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database, SqlJsStatic, Statement } from "sql.js";
import { createLogger } from "../utils/logger.js";
import { expandTildePath } from "../utils/helpers.js";
import type { DatabaseAdapter } from "./database.js";
import { migrations } from "./migrations/index.js";

const logger = createLogger("sqlite");

let initSqlJsFn: (() => Promise<SqlJsStatic>) | null = null;
let staticInstance: SqlJsStatic | null = null;

const WASM_FILENAME = "sql-wasm-fts5.wasm";

/**
 * Resolve the path to the custom FTS5-enabled WASM binary.
 * This WASM was compiled from sql.js 1.12.0 source with -DSQLITE_ENABLE_FTS5
 * using Emscripten 3.1.64 (matching the npm package's build toolchain).
 *
 * Search order:
 *   1. dist/assets/  — production (this file compiled at dist/storage/sqlite.js)
 *   2. src/assets/   — development / tests / REPL
 *
 * Falls back to the default sql.js WASM if the custom binary is not found.
 */
function locateCustomWasm(): string | undefined {
	try {
		const thisFile = fileURLToPath(import.meta.url);
		const thisDir = dirname(thisFile);

		const candidates = [
			// Production: dist/storage/sqlite.js → dist/assets/
			resolve(thisDir, "..", "assets", WASM_FILENAME),
			// Development: dist/storage/ → src/assets/
			resolve(thisDir, "..", "..", "src", "assets", WASM_FILENAME),
			// Running from package root (tests, REPL): packages/core/src/assets/
			resolve(thisDir, "src", "assets", WASM_FILENAME),
			// Monorepo root or other: try absolute sibling
			resolve(thisDir, "..", "src", "assets", WASM_FILENAME),
		];

		for (const candidate of candidates) {
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	} catch {
		// import.meta.url unavailable
	}
	return undefined;
}

try {
	const mod = await import("sql.js");
	initSqlJsFn = async () => {
		const customWasmPath = locateCustomWasm();
		const config: { locateFile?: (file: string) => string } = {};

		if (customWasmPath) {
			config.locateFile = () => customWasmPath;
			logger.info("Loading FTS5-enabled WASM from %s", customWasmPath);
		} else {
			logger.warn(
				"Custom FTS5 WASM not found — falling back to default sql.js WASM. " +
					"FTS5 full-text search will be unavailable.",
			);
		}

		return mod.default(config);
	};
} catch {
	logger.warn(
		"sql.js not found or failed to load. Operating in volatile mode without DB.",
	);
}

export class SqlJsDatabase implements DatabaseAdapter {
	private db: Database | null = null;
	private dbPath: string;
	private dirty = false;
	private persistTimer: ReturnType<typeof setInterval> | null = null;

	constructor(path: string) {
		this.dbPath = path === ":memory:" ? path : expandTildePath(path);
	}

	async initialize(): Promise<void> {
		if (!initSqlJsFn) throw new Error("sql.js is unavailable in this runtime");

		try {
			staticInstance = await initSqlJsFn();

			if (this.dbPath !== ":memory:") {
				const dir = dirname(this.dbPath);
				mkdirSync(dir, { recursive: true });
			}

			if (this.dbPath === ":memory:") {
				this.db = new staticInstance.Database();
			} else if (existsSync(this.dbPath)) {
					const buffer = readFileSync(this.dbPath);
					this.db = new staticInstance.Database(buffer);
			} else {
				this.db = new staticInstance.Database();
			}

			this.db.run("PRAGMA foreign_keys = ON;");

			await this.runMigrations();

			if (this.dbPath !== ":memory:") {
				this.persistTimer = setInterval(() => this.persist(), 30_000);
			}
		} catch (error) {
			this.db = null;
			throw error;
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
		const db = this.ensureOpen();
		db.run(sql, params ?? []);
		this.dirty = true;
	}

	async get<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
		const db = this.ensureOpen();
		const stmt: Statement = db.prepare(sql);
		if (params && params.length > 0) stmt.bind(params);
		if (stmt.step()) {
			const row = normalizeSqlJsRow(stmt.getAsObject()) as T;
			stmt.free();
			return row;
		}
		stmt.free();
		return undefined;
	}

	async all<T>(sql: string, params?: unknown[]): Promise<T[]> {
		const db = this.ensureOpen();
		const stmt: Statement = db.prepare(sql);
		if (params && params.length > 0) stmt.bind(params);
		const results: T[] = [];
		while (stmt.step()) {
			results.push(normalizeSqlJsRow(stmt.getAsObject()) as T);
		}
		stmt.free();
		return results;
	}

	async transaction<T>(fn: () => Promise<T>): Promise<T> {
		const db = this.ensureOpen();
		db.run("BEGIN TRANSACTION");
		try {
			const result = await fn();
			db.run("COMMIT");
			this.dirty = true;
			return result;
		} catch (e) {
			db.run("ROLLBACK");
			throw e;
		}
	}

	async flush(): Promise<void> {
		this.persist();
	}

	async currentTime(): Promise<Date> {
		const row = await this.get<{ now: string }>(
			"SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now",
		);
		return new Date(row?.now ?? new Date().toISOString());
	}

	private ensureOpen(): Database {
		if (!this.db) {
			throw new Error("Database is not initialized. Call initialize() first.");
		}
		return this.db;
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
				await this.transaction(async () => {
					await migration.up(this);
					await this.run("INSERT INTO _migrations (version) VALUES (?)", [
						migration.version,
					]);
				});
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
			const tempPath = `${this.dbPath}.${process.pid}.${Date.now()}.tmp`;
			try {
				writeFileSync(tempPath, buffer);
				const fd = openSync(tempPath, "r+");
				try {
					fsyncSync(fd);
				} finally {
					closeSync(fd);
				}
				renameSync(tempPath, this.dbPath);
			} finally {
				if (existsSync(tempPath)) unlinkSync(tempPath);
			}
			this.dirty = false;
		} catch (e) {
			logger.warn(
				"Failed to persist SQLite database: %s",
				e instanceof Error ? e.message : String(e),
			);
		}
	}
}

function normalizeSqlJsRow(row: Record<string, unknown>): Record<string, unknown> {
	const normalized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		normalized[key] = value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value) : value;
	}

	return normalized;
}
