import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initSqlJs from "sql.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDataFileTools } from "../tools/data-file-tools.js";

describe("data file tools", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "octopus-data-tools-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("inspects an exported SQLite database with schema, counts, and references", async () => {
		const databasePath = join(dir, "catalog.sqlite");
		await createSqliteFixture(databasePath);
		const tools = byName(createDataFileTools([dir], dir));

		const result = await tools.data_inspect?.handler(
			{ path: "catalog.sqlite", limit: 2 },
			undefined as never,
		);

		expect(result?.success, result?.error).toBe(true);
		const output = JSON.parse(result?.output ?? "{}") as {
			tables: Array<{
				ref: string;
				name: string;
				rowCount: number;
				columns: Array<{ name: string; primaryKeyPosition: number }>;
			}>;
			rows: Array<{ ref: string; values: Record<string, unknown> }>;
		};
		expect(output.tables).toContainEqual(
			expect.objectContaining({
				ref: "sqlite:table:products",
				name: "products",
				rowCount: 3,
				columns: expect.arrayContaining([
					expect.objectContaining({ name: "id", primaryKeyPosition: 1 }),
					expect.objectContaining({ name: "name" }),
				]),
			}),
		);
		expect(output.rows[0]).toEqual(
			expect.objectContaining({
				ref: "sqlite:table:products/row:1",
				values: expect.objectContaining({ name: "Keyboard" }),
			}),
		);
	});

	it("runs parameterized SQLite SELECT/WITH/PRAGMA queries and blocks writes", async () => {
		const databasePath = join(dir, "catalog.sqlite");
		await createSqliteFixture(databasePath);
		const tools = byName(createDataFileTools([dir], dir));

		const selected = await tools.data_query?.handler(
			{
				path: databasePath,
				sql: "WITH selected AS (SELECT * FROM products WHERE price >= ?) SELECT name, price FROM selected ORDER BY price DESC;",
				params: [20],
				limit: 5,
			},
			undefined as never,
		);
		expect(selected?.success, selected?.error).toBe(true);
		const selectedOutput = JSON.parse(selected?.output ?? "{}") as {
			rows: Array<{ ref: string; values: { name: string; price: number } }>;
		};
		expect(selectedOutput.rows).toEqual([
			{ ref: "sqlite:query/row:1", values: { name: "Monitor", price: 30 } },
			{ ref: "sqlite:query/row:2", values: { name: "Mouse", price: 20 } },
		]);

		const pragma = await tools.data_query?.handler(
			{ path: databasePath, sql: "PRAGMA table_info(products)" },
			undefined as never,
		);
		expect(pragma?.success, pragma?.error).toBe(true);

		for (const sql of [
			"DELETE FROM products",
			"SELECT * FROM products; DROP TABLE products",
			"PRAGMA writable_schema = ON",
		]) {
			const blocked = await tools.data_query?.handler(
				{ path: databasePath, sql },
				undefined as never,
			);
			expect(blocked?.success).toBe(false);
			expect(blocked?.errorCode).toBe("SECURITY_BLOCKED");
		}
	});

	it("inspects and filters CSV and TSV rows with selected columns", async () => {
		await writeFile(
			join(dir, "sales.csv"),
			"city,product,total\nLima,Keyboard,12\nCusco,Mouse,25\nLima,Monitor,40\n",
		);
		await writeFile(
			join(dir, "sales.tsv"),
			"city\ttotal\nLima\t12\nCusco\t25\n",
		);
		const tools = byName(createDataFileTools([dir], dir));

		const inspected = await tools.data_inspect?.handler(
			{ path: "sales.csv", limit: 1 },
			undefined as never,
		);
		expect(inspected?.success, inspected?.error).toBe(true);
		const inspectOutput = JSON.parse(inspected?.output ?? "{}") as {
			table: {
				ref: string;
				rowCount: number;
				columns: Array<{ name: string; type: string }>;
			};
			rows: Array<{ ref: string }>;
		};
		expect(inspectOutput.table).toEqual(
			expect.objectContaining({ ref: "csv:table:root", rowCount: 3 }),
		);
		expect(inspectOutput.table.columns).toContainEqual({
			name: "total",
			type: "number",
		});
		expect(inspectOutput.rows[0]?.ref).toBe("csv:table:root/row:1");

		const queried = await tools.data_query?.handler(
			{
				path: "sales.csv",
				filters: { city: "Lima", total: { $gte: 20 } },
				columns: ["product", "total"],
				limit: 10,
			},
			undefined as never,
		);
		expect(queried?.success, queried?.error).toBe(true);
		const queryOutput = JSON.parse(queried?.output ?? "{}") as {
			rows: Array<{ values: Record<string, unknown> }>;
		};
		expect(queryOutput.rows).toEqual([
			{
				ref: "csv:table:root/row:3",
				values: { product: "Monitor", total: "40" },
			},
		]);

		const tsv = await tools.data_inspect?.handler(
			{ path: "sales.tsv" },
			undefined as never,
		);
		expect(JSON.parse(tsv?.output ?? "{}").file.format).toBe("tsv");
	});

	it("inspects and filters JSON arrays", async () => {
		await writeFile(
			join(dir, "people.json"),
			JSON.stringify([
				{ id: 1, name: "Ana", active: true, profile: { country: "PE" } },
				{ id: 2, name: "Bruno", active: false, profile: { country: "BR" } },
			]),
		);
		const tools = byName(createDataFileTools([dir], dir));

		const result = await tools.data_query?.handler(
			{
				path: "people.json",
				filters: { "profile.country": "PE" },
				columns: ["name"],
			},
			undefined as never,
		);

		expect(result?.success, result?.error).toBe(true);
		const output = JSON.parse(result?.output ?? "{}") as {
			tableRef: string;
			rows: Array<{ ref: string; values: Record<string, unknown> }>;
		};
		expect(output.tableRef).toBe("json:table:root");
		expect(output.rows).toEqual([
			{ ref: "json:table:root/row:1", values: { name: "Ana" } },
		]);
	});

	it("rejects lexical path escapes and junctions outside allowed roots", async () => {
		const allowed = join(dir, "allowed");
		const outside = join(dir, "outside");
		await mkdir(allowed);
		await mkdir(outside);
		await writeFile(join(outside, "secret.json"), "[]");
		const tools = byName(createDataFileTools([allowed], allowed));

		const escaped = await tools.data_inspect?.handler(
			{ path: "../outside/secret.json" },
			undefined as never,
		);
		expect(escaped?.success).toBe(false);
		expect(escaped?.errorCode).toBe("SECURITY_BLOCKED");

		const link = join(allowed, "linked");
		await symlink(
			outside,
			link,
			process.platform === "win32" ? "junction" : "dir",
		);
		const junction = await tools.data_inspect?.handler(
			{ path: join(link, "secret.json") },
			undefined as never,
		);
		expect(junction?.success).toBe(false);
		expect(junction?.errorCode).toBe("SECURITY_BLOCKED");
	});
});

async function createSqliteFixture(filePath: string): Promise<void> {
	const SQL = await initSqlJs();
	const database = new SQL.Database();
	try {
		database.run(
			"CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL)",
		);
		database.run(
			"INSERT INTO products (name, price) VALUES ('Keyboard', 12), ('Mouse', 20), ('Monitor', 30)",
		);
		await writeFile(filePath, database.export());
	} finally {
		database.close();
	}
}

function byName<T extends { name: string }>(
	items: T[],
): Record<string, T | undefined> {
	return Object.fromEntries(items.map((item) => [item.name, item]));
}
