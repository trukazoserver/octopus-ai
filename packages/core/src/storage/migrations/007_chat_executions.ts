import type { DatabaseAdapter } from "../database.js";

export async function up(db: DatabaseAdapter): Promise<void> {
	await db.run(`
		CREATE TABLE IF NOT EXISTS chat_executions (
			id TEXT PRIMARY KEY,
			request_id TEXT,
			conversation_id TEXT NOT NULL,
			agent_id TEXT,
			status TEXT NOT NULL,
			current_status TEXT,
			activities TEXT,
			assistant_message_id TEXT,
			error TEXT,
			started_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			completed_at TEXT
		)
	`);

	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_chat_executions_conversation_id ON chat_executions (conversation_id)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_chat_executions_status ON chat_executions (status)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_chat_executions_updated_at ON chat_executions (updated_at)",
	);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP TABLE IF EXISTS chat_executions");
}
