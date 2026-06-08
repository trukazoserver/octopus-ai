import type { DatabaseAdapter } from "../database.js";

export async function up(db: DatabaseAdapter): Promise<void> {
	await db.run(
		"ALTER TABLE agent_workflow_runs ADD COLUMN execution_id TEXT",
	);
	await db.run(
		"ALTER TABLE agent_workflow_tasks ADD COLUMN expected_artifacts TEXT",
	);
	await db.run(
		"ALTER TABLE agent_workflow_tasks ADD COLUMN verified_artifacts TEXT",
	);
	await db.run(
		"ALTER TABLE agent_workflow_artifacts ADD COLUMN verified_at TEXT",
	);
	await db.run(
		"ALTER TABLE agent_workflow_artifacts ADD COLUMN verification_error TEXT",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_workflow_runs_inline_conv ON agent_workflow_runs (conversation_id, status)",
	);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP INDEX IF EXISTS idx_workflow_runs_inline_conv");
}
