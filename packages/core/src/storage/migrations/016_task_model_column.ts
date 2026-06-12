import type { DatabaseAdapter } from "../database.js";

async function addColumn(
	db: DatabaseAdapter,
	table: string,
	definition: string,
): Promise<void> {
	try {
		await db.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (!/duplicate column|already exists/i.test(message)) throw err;
	}
}

export async function up(db: DatabaseAdapter): Promise<void> {
	await addColumn(db, "agent_workflow_tasks", "model TEXT DEFAULT NULL");
}

export async function down(db: DatabaseAdapter): Promise<void> {
	// SQLite does not support DROP COLUMN before version 3.35.0.
	// No-op: the column will remain but is harmless.
}
