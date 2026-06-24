import type { DatabaseAdapter } from "../database.js";

/**
 * 018_ai_usage_and_agent_model_profiles
 *
 * Two concerns:
 *
 * 1. `agent_model_profiles` — per-agent, per-model reasoning effort so each agent
 *    can remember a distinct thinking level for every model it uses. Keyed by
 *    (agent_id, model). When an agent switches models, we resolve its profile for
 *    the new model (seeding from the model default or "none" when unsupported).
 *
 * 2. `ai_usage_events` — durable ledger of every LLM token/cost event so usage
 *    survives restarts. Aggregated on demand by provider/model/agent/date.
 *    Replaces the in-memory-only counters that were lost on every restart.
 */
export async function up(db: DatabaseAdapter): Promise<void> {
	await db.run(`
		CREATE TABLE IF NOT EXISTS agent_model_profiles (
			agent_id          TEXT NOT NULL,
			model             TEXT NOT NULL,
			reasoning_effort  TEXT NOT NULL DEFAULT 'none',
			created_at        TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (agent_id, model)
		)
	`);

	await db.run(`
		CREATE TABLE IF NOT EXISTS ai_usage_events (
			id                 INTEGER PRIMARY KEY AUTOINCREMENT,
			created_at         TEXT NOT NULL DEFAULT (datetime('now')),
			provider           TEXT NOT NULL,
			model              TEXT,
			agent_id           TEXT,
			conversation_id    TEXT,
			request_id         TEXT,
			prompt_tokens      INTEGER NOT NULL DEFAULT 0,
			completion_tokens  INTEGER NOT NULL DEFAULT 0,
			reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
			total_tokens       INTEGER NOT NULL DEFAULT 0,
			estimated_cost     REAL NOT NULL DEFAULT 0
		)
	`);

	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_ai_usage_created_at ON ai_usage_events (created_at)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_ai_usage_provider ON ai_usage_events (provider)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_ai_usage_model ON ai_usage_events (model)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_ai_usage_agent ON ai_usage_events (agent_id)",
	);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP INDEX IF EXISTS idx_ai_usage_agent");
	await db.run("DROP INDEX IF EXISTS idx_ai_usage_model");
	await db.run("DROP INDEX IF EXISTS idx_ai_usage_provider");
	await db.run("DROP INDEX IF EXISTS idx_ai_usage_created_at");
	await db.run("DROP TABLE IF EXISTS ai_usage_events");
	await db.run("DROP TABLE IF EXISTS agent_model_profiles");
}
