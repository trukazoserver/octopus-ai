import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expandTildePath } from "../utils/helpers.js";
import { createLogger } from "../utils/logger.js";
import type { DatabaseAdapter } from "./database.js";
import { migrations } from "./migrations/index.js";

const logger = createLogger("sqlite-native");

type TransactionContext = { depth: number };

export class NativeSqliteDatabase implements DatabaseAdapter {
	private db: DatabaseSync | null = null;
	private readonly dbPath: string;
	private readonly transactionContext = new AsyncLocalStorage<TransactionContext>();
	private transactionTail: Promise<void> = Promise.resolve();
	private savepointId = 0;

	constructor(path: string) {
		this.dbPath = path === ":memory:" ? path : expandTildePath(path);
	}

	async initialize(): Promise<void> {
		if (this.db) return;
		if (this.dbPath !== ":memory:") mkdirSync(dirname(this.dbPath), { recursive: true });
		const db = new DatabaseSync(this.dbPath);
		this.db = db;
		try {
			db.exec("PRAGMA foreign_keys = ON");
			db.exec("PRAGMA busy_timeout = 5000");
			db.exec("CREATE VIRTUAL TABLE temp.__octopus_fts5_probe USING fts5(content)");
			db.exec("DROP TABLE temp.__octopus_fts5_probe");
			await this.runMigrations();
			const version = await this.get<{ version: string }>("SELECT sqlite_version() AS version");
			logger.info("Native SQLite %s initialized at %s", version?.version ?? "unknown", this.dbPath);
		} catch (error) {
			db.close();
			this.db = null;
			throw error;
		}
	}

	async close(): Promise<void> {
		await this.transactionTail.catch(() => {});
		this.db?.close();
		this.db = null;
	}

	async run(sql: string, params?: unknown[]): Promise<void> {
		await this.waitForTransaction();
		const db = this.ensureOpen();
		if (!params || params.length === 0) {
			db.exec(sql);
			return;
		}
		db.prepare(sql).run(...normalizeParams(params));
	}

	async get<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
		await this.waitForTransaction();
		const row = this.ensureOpen().prepare(sql).get(...normalizeParams(params ?? []));
		return row ? (normalizeRow(row) as T) : undefined;
	}

	async all<T>(sql: string, params?: unknown[]): Promise<T[]> {
		await this.waitForTransaction();
		return this.ensureOpen()
			.prepare(sql)
			.all(...normalizeParams(params ?? []))
			.map((row) => normalizeRow(row) as T);
	}

	async transaction<T>(fn: () => Promise<T>): Promise<T> {
		const existing = this.transactionContext.getStore();
		if (existing) return this.runSavepoint(existing, fn);

		let release!: () => void;
		const previous = this.transactionTail;
		this.transactionTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		let db: DatabaseSync | undefined;
		let began = false;
		try {
			db = this.ensureOpen();
			db.exec("BEGIN IMMEDIATE");
			began = true;
			const result = await this.transactionContext.run({ depth: 1 }, fn);
			db.exec("COMMIT");
			began = false;
			return result;
		} catch (error) {
			if (began) db?.exec("ROLLBACK");
			throw error;
		} finally {
			release();
		}
	}

	async flush(): Promise<void> {
		await this.waitForTransaction();
	}

	async currentTime(): Promise<Date> {
		const row = await this.get<{ now: string }>(
			"SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now",
		);
		return new Date(row?.now ?? new Date().toISOString());
	}

	private async runSavepoint<T>(context: TransactionContext, fn: () => Promise<T>): Promise<T> {
		const name = `octopus_sp_${++this.savepointId}`;
		const db = this.ensureOpen();
		db.exec(`SAVEPOINT ${name}`);
		context.depth++;
		try {
			const result = await fn();
			db.exec(`RELEASE SAVEPOINT ${name}`);
			return result;
		} catch (error) {
			db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
			db.exec(`RELEASE SAVEPOINT ${name}`);
			throw error;
		} finally {
			context.depth--;
		}
	}

	private async waitForTransaction(): Promise<void> {
		if (!this.transactionContext.getStore()) await this.transactionTail;
	}

	private ensureOpen(): DatabaseSync {
		if (!this.db) throw new Error("Native SQLite is not initialized");
		return this.db;
	}

	private async runMigrations(): Promise<void> {
		this.ensureOpen().exec(`CREATE TABLE IF NOT EXISTS _migrations (
			version INTEGER PRIMARY KEY,
			applied_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`);
		const applied = new Set(
			(await this.all<{ version: number }>("SELECT version FROM _migrations")).map((row) => Number(row.version)),
		);
		for (const migration of migrations) {
			if (applied.has(migration.version)) continue;
			await this.transaction(async () => {
				await migration.up(this);
				await this.run("INSERT INTO _migrations (version) VALUES (?)", [migration.version]);
			});
		}
	}
}

function normalizeParams(params: unknown[]): Array<null | number | bigint | string | Uint8Array> {
	return params.map((value) => {
		if (value === undefined || value === null) return null;
		if (typeof value === "boolean") return value ? 1 : 0;
		if (typeof value === "number" || typeof value === "bigint" || typeof value === "string") return value;
		if (value instanceof Uint8Array) return value;
		throw new TypeError(`Unsupported SQLite parameter type: ${typeof value}`);
	});
}

function normalizeRow(row: unknown): Record<string, unknown> {
	const normalized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
		normalized[key] = value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value) : value;
	}
	return normalized;
}
