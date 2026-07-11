import type { DatabaseAdapter } from "../database.js";

/** Durable receipts for tool calls, used to resume interrupted executions safely. */
export async function up(db: DatabaseAdapter): Promise<void> {
	await db.run(`
		CREATE TABLE IF NOT EXISTS chat_tool_actions (
			id TEXT PRIMARY KEY,
			conversation_id TEXT NOT NULL,
			execution_id TEXT NOT NULL,
			tool_call_id TEXT,
			tool_name TEXT NOT NULL,
			arguments_json TEXT NOT NULL,
			arguments_hash TEXT NOT NULL,
			status TEXT NOT NULL,
			result_json TEXT,
			error TEXT,
			started_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			completed_at TEXT
		)
	`);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_chat_tool_actions_lookup ON chat_tool_actions (conversation_id, tool_name, arguments_hash, updated_at)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_chat_tool_actions_execution ON chat_tool_actions (execution_id, updated_at)",
	);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP TABLE IF EXISTS chat_tool_actions");
}
