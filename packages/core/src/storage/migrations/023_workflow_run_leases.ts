import type { DatabaseAdapter } from "../database.js";

async function addColumn(db: DatabaseAdapter, definition: string): Promise<void> {
	try {
		await db.run(`ALTER TABLE agent_workflow_runs ADD COLUMN ${definition}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/duplicate column|already exists/i.test(message)) throw error;
	}
}

export async function up(db: DatabaseAdapter): Promise<void> {
	await addColumn(db, "owner_id TEXT DEFAULT NULL");
	await addColumn(db, "lease_expires_at TEXT DEFAULT NULL");
	await addColumn(db, "last_heartbeat_at TEXT DEFAULT NULL");
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_workflow_runs_claimable ON agent_workflow_runs (status, lease_expires_at, updated_at)",
	);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP INDEX IF EXISTS idx_workflow_runs_claimable");
}
