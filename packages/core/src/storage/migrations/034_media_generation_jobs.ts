import type { DatabaseAdapter } from "../database.js";

export async function up(db: DatabaseAdapter): Promise<void> {
	await db.run(`CREATE TABLE IF NOT EXISTS media_generation_jobs (
		id TEXT PRIMARY KEY,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		completed_at TEXT,
		status TEXT NOT NULL,
		media_type TEXT NOT NULL,
		provider TEXT NOT NULL,
		model TEXT,
		transport TEXT,
		tool_name TEXT,
		action TEXT,
		prompt TEXT,
		request_json TEXT NOT NULL DEFAULT '{}',
		operation_name TEXT,
		external_job_id TEXT,
		idempotency_key TEXT,
		attempt INTEGER NOT NULL DEFAULT 0,
		max_attempts INTEGER NOT NULL DEFAULT 1,
		progress REAL NOT NULL DEFAULT 0,
		error TEXT,
		result_json TEXT NOT NULL DEFAULT '{}',
		media_urls_json TEXT NOT NULL DEFAULT '[]',
		agent_id TEXT,
		conversation_id TEXT,
		channel_id TEXT,
		run_id TEXT,
		worker_id TEXT,
		task_id TEXT,
		estimated_cost REAL
	)`);
	await db.run("CREATE INDEX IF NOT EXISTS idx_media_generation_jobs_status ON media_generation_jobs (status)");
	await db.run("CREATE INDEX IF NOT EXISTS idx_media_generation_jobs_created_at ON media_generation_jobs (created_at)");
	await db.run("CREATE INDEX IF NOT EXISTS idx_media_generation_jobs_provider_model ON media_generation_jobs (provider, model)");
	await db.run("CREATE INDEX IF NOT EXISTS idx_media_generation_jobs_operation ON media_generation_jobs (operation_name)");
	await db.run("CREATE INDEX IF NOT EXISTS idx_media_generation_jobs_run ON media_generation_jobs (run_id)");
	await db.run("CREATE INDEX IF NOT EXISTS idx_media_generation_jobs_idempotency ON media_generation_jobs (idempotency_key)");
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP TABLE IF EXISTS media_generation_jobs");
}
