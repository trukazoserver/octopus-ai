import type { DatabaseAdapter } from "../database.js";

export async function up(db: DatabaseAdapter): Promise<void> {
	await db.run(
		"ALTER TABLE media_generation_jobs ADD COLUMN submission_sequence INTEGER NOT NULL DEFAULT 0",
	);
}

export async function down(_db: DatabaseAdapter): Promise<void> {
	// SQLite cannot drop columns portably. The additive column is harmless.
}
