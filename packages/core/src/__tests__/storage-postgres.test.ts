import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabaseAdapter } from "../storage/database.js";
import { PostgresDatabase, __postgresTestUtils } from "../storage/postgres.js";

const pgMock = vi.hoisted(() => ({
	instances: [] as Array<{
		config: unknown;
		connect: ReturnType<typeof vi.fn>;
		query: ReturnType<typeof vi.fn>;
		end: ReturnType<typeof vi.fn>;
	}>,
}));

vi.mock("pg", () => ({
	Client: class {
		config: unknown;
		connect = vi.fn(async () => undefined);
		query = vi.fn(async (sql: string) => {
			if (sql.includes("SELECT version FROM _migrations")) return { rows: [] };
			if (sql.includes("information_schema.columns")) return { rows: [] };
			if (sql.includes("SELECT one")) return { rows: [{ one: 1 }] };
			return { rows: [] };
		});
		end = vi.fn(async () => undefined);

		constructor(config: unknown) {
			this.config = config;
			pgMock.instances.push(this);
		}
	},
}));

describe("PostgresDatabase", () => {
	afterEach(() => {
		pgMock.instances.length = 0;
	});

	it("requires a connection string", async () => {
		const db = createDatabaseAdapter("postgresql");

		await expect(db.initialize()).rejects.toThrow(
			/requires a connectionString/,
		);
	});

	it("initializes, migrates, translates placeholders, and closes", async () => {
		const db = createDatabaseAdapter("postgresql", {
			connectionString: "postgresql://user:pass@localhost/octopus",
			options: { application_name: "octopus-test" },
		});

		expect(db).toBeInstanceOf(PostgresDatabase);
		await db.initialize();
		const client = pgMock.instances[0];

		expect(client?.config).toMatchObject({
			connectionString: "postgresql://user:pass@localhost/octopus",
			application_name: "octopus-test",
		});
		expect(client?.connect).toHaveBeenCalledOnce();
		expect(
			client?.query.mock.calls.some((call) =>
				String(call[0]).includes("CREATE TABLE IF NOT EXISTS _migrations"),
			),
		).toBe(true);
		expect(
			client?.query.mock.calls.some((call) =>
				String(call[0]).includes("embedding BYTEA"),
			),
		).toBe(true);
		client?.query.mockClear();

		await db.run("INSERT INTO demo (a, b) VALUES (?, ?)", ["a", "b"]);
		const row = await db.get<{ one: number }>("SELECT one", []);
		await db.close();

		expect(client?.query).toHaveBeenCalledWith(
			"INSERT INTO demo (a, b) VALUES ($1, $2)",
			["a", "b"],
		);
		expect(row).toEqual({ one: 1 });
		expect(client?.end).toHaveBeenCalledOnce();
	});

	it("translates sqlite compatibility SQL", () => {
		const utils = __postgresTestUtils;

		expect(
			utils.preparePostgresSql("PRAGMA table_info(skills)", []).sql,
		).toContain("information_schema.columns");
		expect(
			utils.preparePostgresSql(
				"INSERT OR IGNORE INTO links (a, b) VALUES (?, ?)",
				["a", "b"],
			).sql,
		).toBe("INSERT INTO links (a, b) VALUES ($1, $2) ON CONFLICT DO NOTHING");
		expect(
			utils.preparePostgresSql(
				"INSERT OR REPLACE INTO memory_items (id, content, embedding) VALUES (?, ?, ?)",
				["m1", "content", Buffer.from([])],
			).sql,
		).toBe(
			"INSERT INTO memory_items (id, content, embedding) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, embedding = EXCLUDED.embedding",
		);
		expect(
			utils.preparePostgresSql(
				"SELECT rowid, * FROM memory_audit_logs ORDER BY rowid ASC",
				[],
			).sql,
		).toBe("SELECT * FROM memory_audit_logs ORDER BY created_at ASC, id ASC");
		expect(
			utils.preparePostgresSql(
				"UPDATE memory_nodes SET confidence = MAX(confidence, ?) WHERE id = ?",
				[0.8, "node-1"],
			).sql,
		).toBe(
			"UPDATE memory_nodes SET confidence = GREATEST(confidence, $1) WHERE id = $2",
		);
	});

	it("wraps operations in transactions", async () => {
		const db = createDatabaseAdapter("postgresql", {
			connectionString: "postgresql://localhost/octopus",
		});
		await db.initialize();
		const client = pgMock.instances[0];
		client?.query.mockClear();

		await db.transaction(async () => {
			await db.run("UPDATE demo SET a = ?", ["value"]);
		});

		expect(client?.query.mock.calls.map((call) => call[0])).toEqual([
			"BEGIN",
			"UPDATE demo SET a = $1",
			"COMMIT",
		]);
	});
});
