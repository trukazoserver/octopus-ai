import type { DatabaseAdapter } from "../database.js";

async function addColumn(
	db: DatabaseAdapter,
	definition: string,
): Promise<void> {
	try {
		await db.run(`ALTER TABLE chat_executions ADD COLUMN ${definition}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/duplicate column|already exists/i.test(message)) throw error;
	}
}

export async function up(db: DatabaseAdapter): Promise<void> {
	await addColumn(db, "completion_reason TEXT DEFAULT NULL");
	await addColumn(db, "pending_action TEXT DEFAULT NULL");
}

export async function down(_db: DatabaseAdapter): Promise<void> {
	// Portable no-op: older SQLite versions cannot drop columns safely.
}
