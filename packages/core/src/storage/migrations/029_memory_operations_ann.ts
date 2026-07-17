import type { DatabaseAdapter } from "../database.js";

export async function up(db: DatabaseAdapter): Promise<void> {
	await db.run(`CREATE TABLE IF NOT EXISTS memory_vector_lsh (
		memory_id TEXT NOT NULL,
		embedding_version TEXT NOT NULL,
		dimensions INTEGER NOT NULL,
		table_no INTEGER NOT NULL,
		bucket TEXT NOT NULL,
		scope_tenant TEXT NOT NULL,
		scope_user TEXT NOT NULL,
		scope_project TEXT NOT NULL,
		scope_agent TEXT NOT NULL,
		scope_session TEXT NOT NULL,
		scope_task TEXT NOT NULL,
		PRIMARY KEY (memory_id, table_no)
	)`);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_memory_vector_lsh_lookup ON memory_vector_lsh (embedding_version, dimensions, scope_tenant, scope_user, scope_project, table_no, bucket)",
	);
	await db.run(`CREATE TABLE IF NOT EXISTS memory_operations (
		id TEXT PRIMARY KEY,
		type TEXT NOT NULL,
		status TEXT NOT NULL,
		target_descriptor TEXT,
		cursor TEXT,
		request TEXT NOT NULL,
		progress TEXT NOT NULL,
		lease_token TEXT,
		lease_expires_at TEXT,
		last_error TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		completed_at TEXT
	)`);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_memory_operations_status ON memory_operations (status, updated_at)",
	);
	await db.run(
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_claims_memory_unique ON memory_claims (memory_id)",
	);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP INDEX IF EXISTS idx_memory_claims_memory_unique");
	await db.run("DROP INDEX IF EXISTS idx_memory_operations_status");
	await db.run("DROP TABLE IF EXISTS memory_operations");
	await db.run("DROP INDEX IF EXISTS idx_memory_vector_lsh_lookup");
	await db.run("DROP TABLE IF EXISTS memory_vector_lsh");
}
