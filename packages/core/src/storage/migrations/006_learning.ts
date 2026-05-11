import type { DatabaseAdapter } from "../database.js";

export async function up(db: DatabaseAdapter): Promise<void> {
	await db.run(`
		CREATE TABLE IF NOT EXISTS experiences (
			id TEXT PRIMARY KEY,
			conversation_id TEXT,
			task_id TEXT,
			agent_id TEXT,
			channel_id TEXT,
			user_request TEXT NOT NULL,
			final_response TEXT NOT NULL,
			status TEXT NOT NULL,
			confidence REAL NOT NULL,
			tools_used TEXT NOT NULL,
			skills_used TEXT NOT NULL,
			duration_ms INTEGER,
			metadata TEXT NOT NULL,
			created_at TEXT NOT NULL
		)
	`);

	await db.run(`
		CREATE TABLE IF NOT EXISTS learning_insights (
			id TEXT PRIMARY KEY,
			experience_id TEXT NOT NULL,
			type TEXT NOT NULL,
			domain TEXT,
			keywords TEXT NOT NULL,
			content TEXT NOT NULL,
			evidence TEXT,
			confidence REAL NOT NULL,
			importance REAL NOT NULL,
			embedding TEXT NOT NULL,
			use_count INTEGER NOT NULL DEFAULT 0,
			last_used_at TEXT,
			created_at TEXT NOT NULL
		)
	`);

	await db.run("CREATE INDEX IF NOT EXISTS idx_experiences_status ON experiences (status)");
	await db.run("CREATE INDEX IF NOT EXISTS idx_experiences_created_at ON experiences (created_at)");
	await db.run("CREATE INDEX IF NOT EXISTS idx_learning_insights_type ON learning_insights (type)");
	await db.run("CREATE INDEX IF NOT EXISTS idx_learning_insights_importance ON learning_insights (importance)");
	await db.run("CREATE INDEX IF NOT EXISTS idx_learning_insights_created_at ON learning_insights (created_at)");
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP TABLE IF EXISTS learning_insights");
	await db.run("DROP TABLE IF EXISTS experiences");
}
