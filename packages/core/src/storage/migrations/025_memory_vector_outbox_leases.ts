import type { DatabaseAdapter } from "../database.js";

async function addColumn(db: DatabaseAdapter, definition: string): Promise<void> {
	try {
		await db.run(`ALTER TABLE memory_vector_outbox ADD COLUMN ${definition}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/duplicate column|already exists/i.test(message)) throw error;
	}
}

export async function up(db: DatabaseAdapter): Promise<void> {
	await addColumn(db, "revision INTEGER NOT NULL DEFAULT 1");
	await addColumn(db, "lease_token TEXT DEFAULT NULL");
	await addColumn(db, "lease_expires_at TEXT DEFAULT NULL");
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_memory_vector_outbox_claimable ON memory_vector_outbox (target_id, available_at, lease_expires_at, created_at)",
	);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP INDEX IF EXISTS idx_memory_vector_outbox_claimable");
}
