import { createLogger } from "../utils/logger.js";
import type { DatabaseAdapter } from "./database.js";

const logger = createLogger("sqlite");

export type SQLiteDriver = "auto" | "native" | "sqljs";

export class SqliteDatabase implements DatabaseAdapter {
	private delegate: DatabaseAdapter | null = null;
	private activeDriver: Exclude<SQLiteDriver, "auto"> | null = null;

	constructor(
		private readonly path: string,
		private readonly driver: SQLiteDriver = "native",
	) {}

	async initialize(): Promise<void> {
		if (this.delegate) return;
		if (this.driver !== "sqljs") {
			try {
				const { NativeSqliteDatabase } = await import("./sqlite-native.js");
				const native = new NativeSqliteDatabase(this.path);
				await native.initialize();
				this.delegate = native;
				this.activeDriver = "native";
				return;
			} catch (error) {
				if (this.driver === "native" || !isNativeCapabilityError(error)) throw error;
				logger.warn("Native SQLite unavailable; using SQL.js fallback: %s", errorMessage(error));
			}
		}

		const { SqlJsDatabase } = await import("./sqlite-sqljs.js");
		const fallback = new SqlJsDatabase(this.path);
		await fallback.initialize();
		this.delegate = fallback;
		this.activeDriver = "sqljs";
	}

	getDriver(): Exclude<SQLiteDriver, "auto"> | null {
		return this.activeDriver;
	}

	async close(): Promise<void> {
		await this.delegate?.close();
		this.delegate = null;
		this.activeDriver = null;
	}

	run(sql: string, params?: unknown[]): Promise<void> {
		return this.ensureDelegate().run(sql, params);
	}

	get<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
		return this.ensureDelegate().get<T>(sql, params);
	}

	all<T>(sql: string, params?: unknown[]): Promise<T[]> {
		return this.ensureDelegate().all<T>(sql, params);
	}

	transaction<T>(fn: () => Promise<T>): Promise<T> {
		return this.ensureDelegate().transaction(fn);
	}

	async flush(): Promise<void> {
		await this.ensureDelegate().flush?.();
	}

	private ensureDelegate(): DatabaseAdapter {
		if (!this.delegate) throw new Error("SQLite is not initialized");
		return this.delegate;
	}
}

function isNativeCapabilityError(error: unknown): boolean {
	const code = (error as { code?: string })?.code;
	const message = errorMessage(error);
	return (
		code === "ERR_UNKNOWN_BUILTIN_MODULE" ||
		code === "ERR_MODULE_NOT_FOUND" ||
		/node:sqlite|experimental-sqlite/i.test(message)
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
