import type { DatabaseAdapter } from "../database.js";

export async function up(db: DatabaseAdapter): Promise<void> {
	await db.run(`CREATE TABLE IF NOT EXISTS memory_benchmark_datasets (
		id TEXT PRIMARY KEY, name TEXT NOT NULL, format TEXT NOT NULL, status TEXT NOT NULL,
		source_name TEXT NOT NULL, source_sha256 TEXT NOT NULL, options TEXT NOT NULL DEFAULT '{}',
		metadata TEXT NOT NULL DEFAULT '{}', document_count INTEGER NOT NULL DEFAULT 0,
		case_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
	)`);
	await db.run(`CREATE TABLE IF NOT EXISTS memory_benchmark_documents (
		id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, corpus_id TEXT NOT NULL, external_id TEXT NOT NULL,
		ordinal INTEGER NOT NULL, role TEXT, content TEXT NOT NULL, occurred_at TEXT,
		metadata TEXT NOT NULL DEFAULT '{}', UNIQUE(dataset_id, corpus_id, external_id),
		FOREIGN KEY(dataset_id) REFERENCES memory_benchmark_datasets(id) ON DELETE CASCADE
	)`);
	await db.run(`CREATE TABLE IF NOT EXISTS memory_benchmark_cases (
		id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, corpus_id TEXT NOT NULL, external_id TEXT NOT NULL,
		category TEXT NOT NULL, query TEXT NOT NULL, expected_document_ids TEXT NOT NULL,
		forbidden_document_ids TEXT NOT NULL DEFAULT '[]', expected_answer TEXT, rubric TEXT,
		k INTEGER, status TEXT NOT NULL DEFAULT 'ready', skip_reason TEXT,
		metadata TEXT NOT NULL DEFAULT '{}', UNIQUE(dataset_id, external_id),
		FOREIGN KEY(dataset_id) REFERENCES memory_benchmark_datasets(id) ON DELETE CASCADE
	)`);
	await db.run(`CREATE TABLE IF NOT EXISTS memory_benchmark_runs (
		id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, status TEXT NOT NULL, options TEXT NOT NULL,
		progress TEXT NOT NULL DEFAULT '{}', metrics TEXT NOT NULL DEFAULT '{}', last_error TEXT,
		created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
		FOREIGN KEY(dataset_id) REFERENCES memory_benchmark_datasets(id) ON DELETE CASCADE
	)`);
	await db.run(`CREATE TABLE IF NOT EXISTS memory_benchmark_case_results (
		run_id TEXT NOT NULL, case_id TEXT NOT NULL, status TEXT NOT NULL,
		retrieved_document_ids TEXT NOT NULL DEFAULT '[]', scores TEXT NOT NULL DEFAULT '[]',
		metrics TEXT NOT NULL DEFAULT '{}', latency_ms REAL NOT NULL DEFAULT 0, error TEXT,
		created_at TEXT NOT NULL, PRIMARY KEY(run_id, case_id),
		FOREIGN KEY(run_id) REFERENCES memory_benchmark_runs(id) ON DELETE CASCADE,
		FOREIGN KEY(case_id) REFERENCES memory_benchmark_cases(id) ON DELETE CASCADE
	)`);
	await db.run("CREATE INDEX IF NOT EXISTS idx_memory_benchmark_documents_corpus ON memory_benchmark_documents (dataset_id, corpus_id, ordinal)");
	await db.run("CREATE INDEX IF NOT EXISTS idx_memory_benchmark_cases_category ON memory_benchmark_cases (dataset_id, category)");
	await db.run("CREATE INDEX IF NOT EXISTS idx_memory_benchmark_runs_status ON memory_benchmark_runs (status, updated_at)");
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP TABLE IF EXISTS memory_benchmark_case_results");
	await db.run("DROP TABLE IF EXISTS memory_benchmark_runs");
	await db.run("DROP TABLE IF EXISTS memory_benchmark_cases");
	await db.run("DROP TABLE IF EXISTS memory_benchmark_documents");
	await db.run("DROP TABLE IF EXISTS memory_benchmark_datasets");
}
