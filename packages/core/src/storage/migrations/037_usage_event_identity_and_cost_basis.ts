import type { DatabaseAdapter } from "../database.js";

export async function up(db: DatabaseAdapter): Promise<void> {
	await db.run("ALTER TABLE ai_usage_events ADD COLUMN event_id TEXT");
	await db.run(
		"ALTER TABLE ai_usage_events ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'legacy-estimate'",
	);
	await db.run(
		"UPDATE ai_usage_events SET cost_source = 'unknown' WHERE estimated_cost = 0 AND provider NOT IN ('local', 'ollama')",
	);
	await db.run(
		"UPDATE ai_usage_events SET cost_source = 'free' WHERE provider IN ('local', 'ollama')",
	);
	await db.run(
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_usage_event_id_unique ON ai_usage_events (event_id) WHERE event_id IS NOT NULL",
	);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP INDEX IF EXISTS idx_ai_usage_event_id_unique");
}
