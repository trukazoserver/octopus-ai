import type { DatabaseAdapter } from "../database.js";

async function addColumnIfMissing(
	db: DatabaseAdapter,
	table: string,
	column: string,
	definition: string,
): Promise<void> {
	const columns = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
	if (columns.some((existing) => existing.name === column)) return;
	try {
		await db.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/duplicate column|already exists/i.test(message)) throw error;
	}
}

export async function up(db: DatabaseAdapter): Promise<void> {
	await db.run(`CREATE TABLE IF NOT EXISTS memory_claims (
		id TEXT PRIMARY KEY,
		memory_id TEXT NOT NULL,
		tenant_id TEXT NOT NULL,
		user_id TEXT,
		project_id TEXT,
		agent_role TEXT,
		entity TEXT NOT NULL,
		claim_key TEXT NOT NULL,
		claim_value TEXT NOT NULL,
		valid_from TEXT NOT NULL,
		valid_to TEXT,
		recorded_at TEXT NOT NULL,
		retracted_at TEXT,
		confidence REAL NOT NULL,
		source_id TEXT
	)`);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_memory_claims_lookup ON memory_claims (tenant_id, user_id, project_id, agent_role, entity, claim_key, valid_from, valid_to)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_memory_claims_memory_tx ON memory_claims (memory_id, recorded_at, retracted_at)",
	);

	await db.run(`CREATE TABLE IF NOT EXISTS learning_insight_evidence (
		insight_id TEXT NOT NULL,
		experience_id TEXT NOT NULL,
		relation TEXT NOT NULL,
		recorded_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		PRIMARY KEY (insight_id, experience_id)
	)`);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_learning_insight_evidence_experience ON learning_insight_evidence (experience_id, relation, insight_id)",
	);
	await addColumnIfMissing(
		db,
		"learning_insights",
		"invalidated_at",
		"invalidated_at TEXT DEFAULT NULL",
	);
	await addColumnIfMissing(
		db,
		"learning_insights",
		"invalidation_reason",
		"invalidation_reason TEXT DEFAULT NULL",
	);
	await addColumnIfMissing(
		db,
		"learning_insights",
		"invalidated_by_experience_id",
		"invalidated_by_experience_id TEXT DEFAULT NULL",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_learning_insights_active_scope ON learning_insights (scope_key, invalidated_at, confidence, importance, created_at)",
	);
	await db.run(`CREATE TABLE IF NOT EXISTS memory_edges (
		id TEXT PRIMARY KEY,
		source_id TEXT NOT NULL,
		target_id TEXT NOT NULL,
		type TEXT NOT NULL,
		confidence REAL NOT NULL,
		created_at TEXT NOT NULL,
		metadata TEXT NOT NULL DEFAULT '{}'
	)`);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_memory_edges_target ON memory_edges (target_id, type)",
	);
	await db.run(`INSERT INTO learning_insight_evidence
		(insight_id, experience_id, relation, recorded_at, updated_at)
		SELECT li.id, li.experience_id, 'supports', li.created_at, li.created_at
		FROM learning_insights li
		WHERE NOT EXISTS (
			SELECT 1 FROM learning_insight_evidence e
			WHERE e.insight_id = li.id AND e.experience_id = li.experience_id
		)`);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP INDEX IF EXISTS idx_memory_edges_target");
	await db.run("DROP INDEX IF EXISTS idx_learning_insights_active_scope");
	await db.run("DROP INDEX IF EXISTS idx_learning_insight_evidence_experience");
	await db.run("DROP TABLE IF EXISTS learning_insight_evidence");
	await db.run("DROP INDEX IF EXISTS idx_memory_claims_memory_tx");
	await db.run("DROP INDEX IF EXISTS idx_memory_claims_lookup");
	await db.run("DROP TABLE IF EXISTS memory_claims");
}
