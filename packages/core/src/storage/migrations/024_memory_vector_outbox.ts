import type { DatabaseAdapter } from "../database.js";

export async function up(db: DatabaseAdapter): Promise<void> {
	await db.run(`CREATE TABLE IF NOT EXISTS memory_vector_outbox (
		target_id TEXT NOT NULL,
		memory_id TEXT NOT NULL,
		operation TEXT NOT NULL,
		attempt_count INTEGER NOT NULL DEFAULT 0,
		available_at TEXT NOT NULL,
		last_error TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		PRIMARY KEY (target_id, memory_id)
	)`);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_memory_vector_outbox_due ON memory_vector_outbox (target_id, available_at)",
	);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP INDEX IF EXISTS idx_memory_vector_outbox_due");
	await db.run("DROP TABLE IF EXISTS memory_vector_outbox");
}
