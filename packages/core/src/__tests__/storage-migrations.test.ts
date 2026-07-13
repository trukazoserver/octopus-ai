import { afterEach, describe, expect, it } from "vitest";
import { type DatabaseAdapter, createDatabaseAdapter } from "../storage/database.js";

describe("storage migration ledger", () => {
	let db: DatabaseAdapter | undefined;

	afterEach(async () => {
		await db?.close();
		db = undefined;
	});

	it("records every migration and creates the latest durability indexes", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();

		const versions = await db.all<{ version: number }>(
			"SELECT version FROM _migrations ORDER BY version ASC",
		);
		expect(versions.map((row) => row.version)).toEqual(
			Array.from({ length: 26 }, (_, index) => index + 1),
		);

		const outboxColumns = await db.all<{ name: string }>(
			"PRAGMA table_info(memory_vector_outbox)",
		);
		expect(outboxColumns.map((column) => column.name)).toEqual(
			expect.arrayContaining(["revision", "lease_token", "lease_expires_at"]),
		);

		const relationColumns = await db.all<{ name: string }>(
			"PRAGMA table_info(memory_relations)",
		);
		expect(relationColumns.map((column) => column.name)).toContain("owner_memory_id");

		const indexes = await db.all<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'index'",
		);
		expect(indexes.map((index) => index.name)).toEqual(
			expect.arrayContaining([
				"idx_memory_vector_outbox_claimable",
				"idx_memory_relations_owner",
				"idx_memory_node_links_node",
			]),
		);
	});
});
