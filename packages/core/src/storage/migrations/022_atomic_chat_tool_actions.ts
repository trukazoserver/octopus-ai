import type { DatabaseAdapter } from "../database.js";

export async function up(db: DatabaseAdapter): Promise<void> {
	await db.run(`
		UPDATE chat_tool_actions
		SET status = 'failed',
			error = COALESCE(error, 'Superseded duplicate receipt during idempotency migration'),
			completed_at = COALESCE(completed_at, updated_at)
		WHERE status IN ('running', 'completed', 'uncertain')
			AND EXISTS (
				SELECT 1 FROM chat_tool_actions AS newer
				WHERE newer.execution_id = chat_tool_actions.execution_id
					AND newer.tool_name = chat_tool_actions.tool_name
					AND newer.arguments_hash = chat_tool_actions.arguments_hash
					AND newer.status IN ('running', 'completed', 'uncertain')
					AND (
						newer.updated_at > chat_tool_actions.updated_at
						OR (newer.updated_at = chat_tool_actions.updated_at AND newer.id > chat_tool_actions.id)
					)
			)
	`);
	await db.run(`
		CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_tool_actions_active_call
		ON chat_tool_actions (execution_id, tool_name, arguments_hash)
		WHERE status IN ('running', 'completed', 'uncertain')
	`);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP INDEX IF EXISTS uq_chat_tool_actions_active_call");
}
