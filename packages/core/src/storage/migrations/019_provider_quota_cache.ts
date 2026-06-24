import type { DatabaseAdapter } from "../database.js";

/**
 * 019_provider_quota_cache — persists the last-captured provider quota snapshot
 * (e.g. Codex x-codex-* headers) so it survives restarts. The in-memory cache is
 * lost on restart; this table restores the last known value until the next real
 * provider call refreshes it.
 */
export async function up(db: DatabaseAdapter): Promise<void> {
	await db.run(`
		CREATE TABLE IF NOT EXISTS provider_quota_cache (
			provider      TEXT PRIMARY KEY,
			payload       TEXT NOT NULL,
			captured_at   INTEGER NOT NULL
		)
	`);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP TABLE IF EXISTS provider_quota_cache");
}
