import { SqliteDatabase } from "./sqlite.js";

export type DatabaseBackend = "sqlite" | "postgresql" | "mysql" | "mongodb";

export interface DatabaseAdapter {
	initialize(): Promise<void>;
	close(): Promise<void>;
	run(sql: string, params?: unknown[]): Promise<void>;
	get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
	all<T>(sql: string, params?: unknown[]): Promise<T[]>;
	transaction<T>(fn: () => Promise<T>): Promise<T>;
}

export interface DatabaseConfig {
	/**
	 * Database file path (for SQLite)
	 */
	path?: string;
	/**
	 * Connection string (for PostgreSQL, MySQL, MongoDB)
	 * @example "postgresql://user:password@localhost:5432/dbname"
	 */
	connectionString?: string;
	/**
	 * Additional options for database configuration
	 */
	options?: Record<string, unknown>;
}

/**
 * Creates a database adapter based on the specified backend
 *
 * Supported backends:
 * - sqlite: Embedded SQL database (default, no server required)
 * - postgresql: PostgreSQL server (requires pg package)
 * - mysql: MySQL/MariaDB server (requires mysql2 package)
 * - mongodb: MongoDB document store (requires mongodb package)
 *
 * @param backend - Database backend type
 * @param config - Database configuration
 * @returns DatabaseAdapter instance
 *
 * @example
 * ```ts
 * // SQLite (default)
 * const db = createDatabaseAdapter("sqlite", { path: "./data.db" });
 *
 * // PostgreSQL
 * const db = createDatabaseAdapter("postgresql", {
 *   connectionString: "postgresql://user:pass@localhost/db"
 * });
 * ```
 */
export function createDatabaseAdapter(
	backend: DatabaseBackend,
	config: DatabaseConfig = {},
): DatabaseAdapter {
	switch (backend) {
		case "sqlite":
			return new SqliteDatabase(config.path ?? ":memory:");

		case "postgresql":
			throw new Error(
				"PostgreSQL backend not yet implemented. Install 'pg' package and implement PostgresDatabase adapter.",
			);

		case "mysql":
			throw new Error(
				"MySQL backend not yet implemented. Install 'mysql2' package and implement MySQLDatabase adapter.",
			);

		case "mongodb":
			throw new Error(
				"MongoDB backend not yet implemented. Install 'mongodb' package and implement MongoDatabase adapter.",
			);

		default: {
			// Exhaustive check for TypeScript
			const _exhaustive: never = backend;
			throw new Error(`Unsupported database backend: ${_exhaustive}`);
		}
	}
}
