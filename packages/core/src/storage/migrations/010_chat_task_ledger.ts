import type { DatabaseAdapter } from "../database.js";

export async function up(db: DatabaseAdapter): Promise<void> {
	await db.run(`
		CREATE TABLE IF NOT EXISTS chat_task_ledger (
			id TEXT PRIMARY KEY,
			conversation_id TEXT NOT NULL,
			objective TEXT NOT NULL,
			status TEXT NOT NULL,
			summary TEXT,
			outputs TEXT,
			tool_names TEXT,
			source_message_id TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			completed_at TEXT,
			FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
		)
	`);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_chat_task_ledger_conversation_updated ON chat_task_ledger(conversation_id, updated_at DESC)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_chat_task_ledger_status ON chat_task_ledger(status)",
	);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP TABLE IF EXISTS chat_task_ledger");
}
