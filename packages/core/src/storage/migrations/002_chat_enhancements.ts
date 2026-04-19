import type { DatabaseAdapter } from "../database.js";

export async function up(db: DatabaseAdapter): Promise<void> {
	await db.run("ALTER TABLE conversations ADD COLUMN title TEXT");
	await db.run("ALTER TABLE conversations ADD COLUMN agent_id TEXT");
	await db.run("ALTER TABLE messages ADD COLUMN model TEXT");
	await db.run("ALTER TABLE messages ADD COLUMN tokens INTEGER");
	await db.run("ALTER TABLE messages ADD COLUMN parent_id TEXT");
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_conversations_agent_id ON conversations (agent_id)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations (updated_at)",
	);
}

export async function down(db: DatabaseAdapter): Promise<void> {}
