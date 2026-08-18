import type { DatabaseAdapter } from "../database.js";

export async function up(db: DatabaseAdapter): Promise<void> {
	await db.run("ALTER TABLE media_generation_jobs ADD COLUMN lease_token TEXT");
	await db.run("ALTER TABLE media_generation_jobs ADD COLUMN lease_expires_at TEXT");
	await db.run(`UPDATE media_generation_jobs
		SET idempotency_key = NULL
		WHERE id IN (
			SELECT id FROM (
				SELECT id,
					ROW_NUMBER() OVER (
						PARTITION BY idempotency_key
						ORDER BY
							CASE
								WHEN operation_name IS NOT NULL AND status IN ('running', 'submitting', 'cancel_requested') THEN 0
								WHEN status = 'succeeded' THEN 1
								WHEN status = 'running' THEN 2
								WHEN status = 'submitting' THEN 3
								WHEN status = 'queued' THEN 4
								ELSE 5
							END,
							created_at DESC
					) AS duplicate_rank
				FROM media_generation_jobs
				WHERE idempotency_key IS NOT NULL
			) ranked
			WHERE duplicate_rank > 1
		)`);
	await db.run("DROP INDEX IF EXISTS idx_media_generation_jobs_idempotency");
	await db.run(
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_media_generation_jobs_idempotency ON media_generation_jobs (idempotency_key) WHERE idempotency_key IS NOT NULL",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_media_generation_jobs_lease ON media_generation_jobs (status, lease_expires_at)",
	);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP INDEX IF EXISTS idx_media_generation_jobs_lease");
	await db.run("DROP INDEX IF EXISTS idx_media_generation_jobs_idempotency");
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_media_generation_jobs_idempotency ON media_generation_jobs (idempotency_key)",
	);
}
