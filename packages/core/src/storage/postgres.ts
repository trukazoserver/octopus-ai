import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient, type QueryResult } from "pg";
import type { DatabaseAdapter, DatabaseConfig } from "./database.js";
import { migrations } from "./migrations/index.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export class PostgresDatabase implements DatabaseAdapter {
	private pool: Pool | null = null;
	private readonly transactionContext = new AsyncLocalStorage<PoolClient>();

	constructor(private config: DatabaseConfig) {}

	async initialize(): Promise<void> {
		const connectionString = this.config.connectionString ?? this.config.path;
		if (!connectionString) {
			throw new Error(
				"PostgreSQL backend requires a connectionString in storage config.",
			);
		}
		this.pool = new Pool({
			connectionString,
			...(this.config.options ?? {}),
		});
		await this.runMigrations();
	}

	async close(): Promise<void> {
		if (!this.pool) return;
		await this.pool.end();
		this.pool = null;
	}

	async run(sql: string, params?: unknown[]): Promise<void> {
		await this.query(sql, params);
	}

	async get<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
		const result = await this.query(sql, params);
		return result.rows[0] as T | undefined;
	}

	async all<T>(sql: string, params?: unknown[]): Promise<T[]> {
		const result = await this.query(sql, params);
		return result.rows as T[];
	}

	async transaction<T>(fn: () => Promise<T>): Promise<T> {
		const pool = this.ensureOpen();
		if (this.transactionContext.getStore()) return await fn();
		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			try {
				const result = await this.transactionContext.run(client, fn);
				await client.query("COMMIT");
				return result;
			} catch (err) {
				await client.query("ROLLBACK");
				throw err;
			}
		} finally {
			client.release();
		}
	}

	async flush(): Promise<void> {
		// PostgreSQL commits each non-transactional query immediately.
	}

	private async runMigrations(): Promise<void> {
		await this.run(`
			CREATE TABLE IF NOT EXISTS _migrations (
				version INTEGER PRIMARY KEY,
				applied_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
			)
		`);

		const applied = await this.all<{ version: number }>(
			"SELECT version FROM _migrations",
		);
		const appliedVersions = new Set(applied.map((row) => Number(row.version)));

		for (const migration of migrations) {
			if (appliedVersions.has(migration.version)) continue;
			await migration.up(this);
			await this.run("INSERT INTO _migrations (version) VALUES (?)", [
				migration.version,
			]);
		}
	}

	private async query(
		sql: string,
		params?: unknown[],
	): Promise<QueryResult<Record<string, unknown>>> {
		const client: Queryable = this.transactionContext.getStore() ?? this.ensureOpen();
		const prepared = preparePostgresSql(sql, params ?? []);
		return await client.query(prepared.sql, prepared.params);
	}

	private ensureOpen(): Pool {
		if (!this.pool) {
			throw new Error("Database is not initialized. Call initialize() first.");
		}
		return this.pool;
	}
}

function preparePostgresSql(
	sql: string,
	params: unknown[],
): { sql: string; params: unknown[] } {
	const pragma = sql.trim().match(/^PRAGMA\s+table_info\(([^)]+)\)$/i);
	if (pragma?.[1]) {
		return {
			sql: "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1",
			params: [pragma[1].replace(/["'`]/g, "")],
		};
	}

	const isInsertOrIgnore = /^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+/i.test(sql);
	let next = 0;
	const converted = transformInsertOrReplace(sql)
		.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+/i, "INSERT INTO ")
		.replace(/\bVALUES\b([\s\S]*)$/i, (match) => {
			return isInsertOrIgnore ? `${match} ON CONFLICT DO NOTHING` : match;
		})
		.replace(/\bBLOB\b/gi, "BYTEA")
		.replace(/datetime\('now'\)/gi, "CURRENT_TIMESTAMP")
		.replace(/\bMAX\(\s*([^,()]+)\s*,\s*([^)]+)\)/gi, "GREATEST($1, $2)")
		.replace(
			/SELECT\s+rowid,\s+\*\s+FROM\s+(\w+)\s+ORDER\s+BY\s+rowid\s+ASC/gi,
			"SELECT * FROM $1 ORDER BY created_at ASC, id ASC",
		)
		.replace(/ORDER\s+BY\s+rowid\s+DESC/gi, "ORDER BY created_at DESC, id DESC")
		.replace(/\?/g, () => `$${++next}`);

	return { sql: converted, params };
}

function transformInsertOrReplace(sql: string): string {
	const match = sql.match(
		/^\s*INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i,
	);
	if (!match?.[1] || !match[2] || !match[3]) return sql;
	const table = match[1];
	const columns = match[2].split(",").map((column) => column.trim());
	const values = match[3];
	const conflictColumn = columns[0];
	const updates = columns
		.slice(1)
		.map((column) => `${column} = EXCLUDED.${column}`)
		.join(", ");
	return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values}) ON CONFLICT (${conflictColumn}) DO UPDATE SET ${updates}`;
}

export const __postgresTestUtils = { preparePostgresSql };
