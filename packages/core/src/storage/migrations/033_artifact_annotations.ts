import type { DatabaseAdapter } from "../database.js";

export async function up(db: DatabaseAdapter): Promise<void> {
	await db.run(`CREATE TABLE IF NOT EXISTS artifact_annotations (
		id TEXT PRIMARY KEY,
		artifact_key TEXT NOT NULL,
		version_id TEXT NOT NULL,
		conversation_id TEXT,
		body TEXT NOT NULL,
		page_number INTEGER,
		anchor_json TEXT NOT NULL DEFAULT '{}',
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_artifact_annotations_lookup ON artifact_annotations (artifact_key, version_id, created_at)",
	);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP TABLE IF EXISTS artifact_annotations");
}
