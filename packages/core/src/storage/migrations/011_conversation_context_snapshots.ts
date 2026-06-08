import type { DatabaseAdapter } from "../database.js";

export async function up(db: DatabaseAdapter): Promise<void> {
	await db.run(`
		CREATE TABLE IF NOT EXISTS conversation_context_snapshots (
			conversation_id TEXT PRIMARY KEY,
			rolling_summary TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
		)
	`);

	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_conversation_context_snapshots_updated ON conversation_context_snapshots(updated_at DESC)",
	);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP TABLE IF EXISTS conversation_context_snapshots");
}
