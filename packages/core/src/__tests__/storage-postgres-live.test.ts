import { describe, expect, it } from "vitest";
import { createDatabaseAdapter } from "../storage/database.js";

function firstEnv(...names: string[]): string {
	for (const name of names) {
		const value = process.env[name]?.trim();
		if (value) return value;
	}
	return "";
}

function booleanEnv(...names: string[]): boolean {
	return firstEnv(...names).toLowerCase() === "true";
}

const postgresUrl = firstEnv(
	"OCTOPUS_POSTGRES_TEST_URL",
	"OCTOPUS_POSTGRES_URL",
	"DATABASE_URL",
);
const postgresSsl = booleanEnv(
	"OCTOPUS_POSTGRES_TEST_SSL",
	"OCTOPUS_POSTGRES_SSL",
);

describe.skipIf(!postgresUrl)("PostgreSQL database adapter integration", () => {
	it("runs migrations, parameterized queries, and transactions", async () => {
		const db = createDatabaseAdapter("postgresql", {
			connectionString: postgresUrl,
			options: postgresSsl ? { ssl: { rejectUnauthorized: false } } : undefined,
		});
		const tableName = `octopus_pg_integration_${crypto.randomUUID().replace(/-/g, "_")}`;

		try {
			await db.initialize();
			await db.run(
				`CREATE TABLE IF NOT EXISTS ${tableName} (id TEXT PRIMARY KEY, value TEXT NOT NULL)`,
			);
			await db.run(`INSERT INTO ${tableName} (id, value) VALUES (?, ?)`, [
				"one",
				"before",
			]);
			await db.transaction(async () => {
				await db.run(`UPDATE ${tableName} SET value = ? WHERE id = ?`, [
					"after",
					"one",
				]);
			});

			const row = await db.get<{ value: string }>(
				`SELECT value FROM ${tableName} WHERE id = ?`,
				["one"],
			);
			const migration = await db.get<{ version: number }>(
				"SELECT version FROM _migrations WHERE version = ?",
				[1],
			);

			expect(row?.value).toBe("after");
			expect(Number(migration?.version)).toBe(1);
		} finally {
			await db.run(`DROP TABLE IF EXISTS ${tableName}`).catch(() => undefined);
			await db.close();
		}
	}, 60000);
});
