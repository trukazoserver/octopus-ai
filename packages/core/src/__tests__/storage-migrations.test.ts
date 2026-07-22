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
			Array.from({ length: 33 }, (_, index) => index + 1),
		);

		for (const table of ["experiences", "learning_insights"]) {
			const columns = await db.all<{
				name: string;
				notnull: number;
				dflt_value: string | null;
			}>(`PRAGMA table_info(${table})`);
			expect(columns.map((column) => column.name)).toEqual(
				expect.arrayContaining([
					"scope_key",
					"scope_tenant_id",
					"scope_user_id",
					"scope_project_id",
					"scope_agent_role",
					"scope_session_id",
					"scope_task_id",
				]),
			);
			expect(columns.find((column) => column.name === "scope_key")?.notnull).toBe(
				1,
			);
			expect(
				columns.find((column) => column.name === "scope_key")?.dflt_value,
			).toContain("__learning_legacy_unscoped_v1__");
		}
		const insightColumns = await db.all<{ name: string }>(
			"PRAGMA table_info(learning_insights)",
		);
		expect(insightColumns.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"invalidated_at",
				"invalidation_reason",
				"invalidated_by_experience_id",
			]),
		);
		const temporalTables = await db.all<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table'",
		);
		expect(temporalTables.map((table) => table.name)).toEqual(
			expect.arrayContaining([
				"memory_claims",
				"learning_insight_evidence",
				"memory_vector_lsh",
				"memory_operations",
				"artifact_annotations",
			]),
		);

		const outboxColumns = await db.all<{ name: string }>(
			"PRAGMA table_info(memory_vector_outbox)",
		);
		const operationColumns = await db.all<{ name: string }>(
			"PRAGMA table_info(memory_operations)",
		);
		expect(operationColumns.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"idempotency_key",
				"attempt_count",
				"control_action",
				"fence_version",
			]),
		);
		expect(
			await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_benchmark_runs'"),
		).toBeDefined();
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
				"idx_experiences_learning_scope",
				"idx_learning_insights_scope",
				"idx_memory_claims_lookup",
				"idx_memory_claims_memory_tx",
				"idx_learning_insight_evidence_experience",
				"idx_learning_insights_active_scope",
				"idx_memory_edges_target",
				"idx_memory_vector_lsh_lookup",
				"idx_memory_operations_status",
				"idx_memory_claims_memory_unique",
				"idx_memory_operations_idempotency",
				"idx_memory_operations_claimable",
			]),
		);
	});
});
