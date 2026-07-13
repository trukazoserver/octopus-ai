import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteDatabase } from "../storage/sqlite.js";

describe.each(["native", "sqljs"] as const)("SQLite %s driver", (driver) => {
	let db: SqliteDatabase | undefined;
	const dirs: string[] = [];

	afterEach(async () => {
		await db?.close();
		db = undefined;
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("supports CRUD, BLOBs, FTS5, nested transactions and rollback", async () => {
		db = new SqliteDatabase(":memory:", driver);
		await db.initialize();
		expect(db.getDriver()).toBe(driver);
		await db.run("CREATE TABLE sample (id TEXT PRIMARY KEY, value BLOB)");
		const blob = Buffer.from(new Float32Array([1.5, 2.5]).buffer);
		await db.run("INSERT INTO sample (id, value) VALUES (?, ?)", ["one", blob]);
		const row = await db.get<{ id: string; value: Buffer }>(
			"SELECT id, value FROM sample WHERE id = ?",
			["one"],
		);
		expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
		expect(Buffer.isBuffer(row?.value)).toBe(true);
		expect([...new Float32Array(row?.value.buffer, row?.value.byteOffset, 2)]).toEqual([1.5, 2.5]);

		await db.run("CREATE VIRTUAL TABLE docs USING fts5(body)");
		await db.run("INSERT INTO docs (body) VALUES (?)", ["native full text search"]);
		expect(await db.get("SELECT rowid FROM docs WHERE docs MATCH ?", ["native"])).toBeDefined();

		await db.transaction(async () => {
			await db?.run("INSERT INTO sample (id, value) VALUES (?, ?)", ["outer", Buffer.from("a")]);
			if (driver === "native") {
				await db?.transaction(async () => {
					await db?.run("INSERT INTO sample (id, value) VALUES (?, ?)", ["inner", Buffer.from("b")]);
				});
			}
		});
		if (driver === "native") expect(await db.get("SELECT id FROM sample WHERE id = 'inner'")).toBeDefined();

		await expect(
			db.transaction(async () => {
				await db?.run("INSERT INTO sample (id, value) VALUES (?, ?)", ["rollback", Buffer.from("c")]);
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		expect(await db.get("SELECT id FROM sample WHERE id = 'rollback'")).toBeUndefined();
	});

	it("persists a standard SQLite file across close and reopen", async () => {
		const dir = mkdtempSync(join(tmpdir(), "octopus-sqlite-"));
		dirs.push(dir);
		const path = join(dir, "nested", "octopus.db");
		db = new SqliteDatabase(path, driver);
		await db.initialize();
		await db.run("CREATE TABLE durable (value TEXT)");
		await db.run("INSERT INTO durable (value) VALUES (?)", [driver]);
		await db.flush();
		await db.close();

		db = new SqliteDatabase(path, driver);
		await db.initialize();
		expect(await db.get<{ value: string }>("SELECT value FROM durable")).toEqual({ value: driver });
	});
});

describe("native SQLite safety", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("does not replace a corrupt existing database", async () => {
		const dir = mkdtempSync(join(tmpdir(), "octopus-corrupt-"));
		dirs.push(dir);
		const path = join(dir, "octopus.db");
		const original = Buffer.from("not a sqlite database");
		writeFileSync(path, original);
		const db = new SqliteDatabase(path, "native");
		await expect(db.initialize()).rejects.toThrow();
		expect(readFileSync(path)).toEqual(original);
	});

	it("serializes concurrent transactions without leaking writes", async () => {
		const db = new SqliteDatabase(":memory:", "native");
		await db.initialize();
		await db.run("CREATE TABLE ordered (value TEXT)");
		let releaseFirst!: () => void;
		let firstStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			firstStarted = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = db.transaction(async () => {
			await db.run("INSERT INTO ordered (value) VALUES ('first')");
			firstStarted();
			await release;
		});
		await started;
		const second = db.transaction(async () => {
			await db.run("INSERT INTO ordered (value) VALUES ('second')");
		});
		await Promise.resolve();
		expect(await Promise.race([second.then(() => "done"), Promise.resolve("waiting")])).toBe("waiting");
		releaseFirst();
		await Promise.all([first, second]);
		expect(await db.all<{ value: string }>("SELECT value FROM ordered ORDER BY rowid")).toEqual([
			{ value: "first" },
			{ value: "second" },
		]);
		await db.close();
	});
});
