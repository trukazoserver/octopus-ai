import type { DatabaseAdapter } from "../database.js";

/**
 * tool_health — cached health/quota status for external web tools (search +
 * reader MCP servers). Probed on startup and by a daily cron, then consulted by
 * the executor so the agent can steer directly to a fallback instead of
 * discovering an out-of-quota failure at call time.
 *
 * Rows are keyed by MCP server name (e.g. "zai-web-search", "zai-web-reader").
 */
export async function up(db: DatabaseAdapter): Promise<void> {
	await db.run(`
		CREATE TABLE IF NOT EXISTS tool_health (
			server              TEXT PRIMARY KEY,
			status              TEXT NOT NULL DEFAULT 'unknown',
			detail              TEXT,
			checked_at          TEXT,
			cache_until         TEXT,
			consecutive_failures INTEGER NOT NULL DEFAULT 0
		)
	`);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_tool_health_status ON tool_health (status)",
	);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP INDEX IF EXISTS idx_tool_health_status");
	await db.run("DROP TABLE IF EXISTS tool_health");
}
