import { afterEach, describe, expect, it } from "vitest";
import {
	type DatabaseAdapter,
	createDatabaseAdapter,
} from "../storage/database.js";
import {
	down as downKanbanMigration,
	up as upKanbanMigration,
} from "../storage/migrations/015_kanban_swarm_dependencies.js";

describe("Kanban Swarm migration", () => {
	let db: DatabaseAdapter | undefined;

	afterEach(async () => {
		await db?.close();
		db = undefined;
	});

	it("creates durable Kanban tables, columns, and indexes idempotently", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();

		await upKanbanMigration(db);
		await upKanbanMigration(db);

		const requirementColumns = await db.all<{ name: string }>(
			"PRAGMA table_info(agent_workflow_task_requirements)",
		);
		const taskColumns = await db.all<{ name: string }>(
			"PRAGMA table_info(agent_workflow_tasks)",
		);
		const artifactColumns = await db.all<{ name: string }>(
			"PRAGMA table_info(agent_workflow_artifacts)",
		);
		const indexes = await db.all<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'index'",
		);

		expect(requirementColumns.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"requirement_key",
				"requirement_type",
				"artifact_key",
				"artifact_type",
				"min_count",
				"satisfied_by_artifact_id",
			]),
		);
		expect(taskColumns.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"claim_token",
				"lease_expires_at",
				"ready_at",
				"produces",
				"requires_human_review",
			]),
		);
		expect(artifactColumns.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"artifact_key",
				"producer_task_id",
				"size_bytes",
				"mime_type",
				"quality_score",
			]),
		);
		expect(indexes.map((index) => index.name)).toEqual(
			expect.arrayContaining([
				"idx_task_requirements_artifact",
				"idx_workflow_tasks_ready",
				"idx_workflow_artifacts_key",
			]),
		);
		const dispatcherStateColumns = await db.all<{ name: string }>(
			"PRAGMA table_info(kanban_dispatcher_state)",
		);
		expect(dispatcherStateColumns.map((column) => column.name)).toEqual(
			expect.arrayContaining(["id", "enabled", "updated_at", "metadata"]),
		);
	});

	it("drops Kanban-only tables on down migration", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		await upKanbanMigration(db);

		await downKanbanMigration(db);

		const tables = await db.all<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table'",
		);
		expect(tables.map((table) => table.name)).not.toEqual(
			expect.arrayContaining([
				"kanban_boards",
				"kanban_dispatcher_state",
				"agent_workflow_task_requirements",
				"agent_workflow_task_leases",
				"agent_workflow_blockers",
				"agent_workflow_task_comments",
			]),
		);
	});
});
