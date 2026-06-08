import type { DatabaseAdapter } from "../database.js";

export async function up(db: DatabaseAdapter): Promise<void> {
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_updated_at ON agent_workflow_runs (status, updated_at)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_workflow_runs_conversation_status ON agent_workflow_runs (conversation_id, status)",
	);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP INDEX IF EXISTS idx_workflow_runs_conversation_status");
	await db.run("DROP INDEX IF EXISTS idx_workflow_runs_status_updated_at");
}
