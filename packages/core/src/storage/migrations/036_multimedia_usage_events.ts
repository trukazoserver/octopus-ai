import type { DatabaseAdapter } from "../database.js";

export async function up(db: DatabaseAdapter): Promise<void> {
	await db.run(`
		CREATE TABLE IF NOT EXISTS multimedia_usage_events (
			id                         TEXT PRIMARY KEY,
			created_at                 TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at                 TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			media_type                 TEXT NOT NULL,
			provider                   TEXT NOT NULL,
			model                      TEXT,
			transport                  TEXT,
			status                     TEXT NOT NULL,
			job_id                     TEXT,
			tool_name                  TEXT,
			agent_id                   TEXT,
			conversation_id            TEXT,
			requested_outputs          INTEGER NOT NULL DEFAULT 1,
			output_count               INTEGER NOT NULL DEFAULT 0,
			requested_duration_seconds REAL,
			generated_duration_seconds REAL,
			estimated_cost             REAL,
			cost_source                TEXT
		)
	`);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_multimedia_usage_created_at ON multimedia_usage_events (created_at)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_multimedia_usage_provider ON multimedia_usage_events (provider)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_multimedia_usage_media_type ON multimedia_usage_events (media_type)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_multimedia_usage_agent ON multimedia_usage_events (agent_id)",
	);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP INDEX IF EXISTS idx_multimedia_usage_agent");
	await db.run("DROP INDEX IF EXISTS idx_multimedia_usage_media_type");
	await db.run("DROP INDEX IF EXISTS idx_multimedia_usage_provider");
	await db.run("DROP INDEX IF EXISTS idx_multimedia_usage_created_at");
	await db.run("DROP TABLE IF EXISTS multimedia_usage_events");
}
