import type { DatabaseAdapter } from "../database.js";

export async function up(db: DatabaseAdapter): Promise<void> {
	await db.run(`
		CREATE TABLE IF NOT EXISTS memory_sources (
			id TEXT PRIMARY KEY,
			source_type TEXT NOT NULL,
			title TEXT,
			uri TEXT,
			quoted_evidence TEXT,
			authority_score REAL NOT NULL DEFAULT 0.5,
			created_at TEXT NOT NULL,
			metadata TEXT NOT NULL DEFAULT '{}'
		)
	`);

	await db.run(`
		CREATE TABLE IF NOT EXISTS memory_source_links (
			memory_id TEXT NOT NULL,
			source_id TEXT NOT NULL,
			PRIMARY KEY (memory_id, source_id)
		)
	`);

	await db.run(`
		CREATE TABLE IF NOT EXISTS memory_nodes (
			id TEXT PRIMARY KEY,
			node_type TEXT NOT NULL,
			name TEXT NOT NULL,
			summary TEXT,
			confidence REAL NOT NULL DEFAULT 0.5,
			status TEXT NOT NULL DEFAULT 'active',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			metadata TEXT NOT NULL DEFAULT '{}'
		)
	`);

	await db.run(`
		CREATE TABLE IF NOT EXISTS memory_node_links (
			memory_id TEXT NOT NULL,
			node_id TEXT NOT NULL,
			relation TEXT NOT NULL DEFAULT 'mentions',
			PRIMARY KEY (memory_id, node_id, relation)
		)
	`);

	await db.run(`
		CREATE TABLE IF NOT EXISTS memory_relations (
			id TEXT PRIMARY KEY,
			from_node_id TEXT NOT NULL,
			edge_type TEXT NOT NULL,
			to_node_id TEXT NOT NULL,
			context TEXT,
			confidence REAL NOT NULL DEFAULT 0.5,
			status TEXT NOT NULL DEFAULT 'active',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			last_validated_at TEXT,
			metadata TEXT NOT NULL DEFAULT '{}'
		)
	`);

	await db.run(`
		CREATE TABLE IF NOT EXISTS memory_relation_sources (
			edge_id TEXT NOT NULL,
			source_id TEXT NOT NULL,
			PRIMARY KEY (edge_id, source_id)
		)
	`);

	await db.run(`
		CREATE TABLE IF NOT EXISTS memory_permissions (
			memory_id TEXT PRIMARY KEY,
			visible_to_agents TEXT NOT NULL DEFAULT '[]',
			hidden_from_agents TEXT NOT NULL DEFAULT '[]',
			visible_to_users TEXT NOT NULL DEFAULT '[]',
			requires_user_confirmation_before_use INTEGER NOT NULL DEFAULT 0,
			sensitivity TEXT NOT NULL DEFAULT 'low',
			retention_policy TEXT,
			expires_at TEXT,
			metadata TEXT NOT NULL DEFAULT '{}'
		)
	`);

	await db.run(`
		CREATE TABLE IF NOT EXISTS memory_action_logs (
			id TEXT PRIMARY KEY,
			session_id TEXT,
			agent_id TEXT,
			action_type TEXT NOT NULL,
			input TEXT NOT NULL DEFAULT '{}',
			output TEXT NOT NULL DEFAULT '{}',
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			previous_hash TEXT,
			entry_hash TEXT
		)
	`);

	await db.run(`
		CREATE TABLE IF NOT EXISTS memory_audit_logs (
			id TEXT PRIMARY KEY,
			actor_id TEXT NOT NULL,
			action TEXT NOT NULL,
			memory_id TEXT,
			before TEXT,
			after TEXT,
			created_at TEXT NOT NULL,
			previous_hash TEXT,
			entry_hash TEXT
		)
	`);

	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_memory_sources_type ON memory_sources (source_type, created_at)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_memory_nodes_type_name ON memory_nodes (node_type, name)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_memory_relations_from ON memory_relations (from_node_id, edge_type)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_memory_relations_to ON memory_relations (to_node_id, edge_type)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_memory_permissions_sensitivity ON memory_permissions (sensitivity)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_memory_audit_memory ON memory_audit_logs (memory_id, created_at)",
	);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP TABLE IF EXISTS memory_audit_logs");
	await db.run("DROP TABLE IF EXISTS memory_action_logs");
	await db.run("DROP TABLE IF EXISTS memory_permissions");
	await db.run("DROP TABLE IF EXISTS memory_relation_sources");
	await db.run("DROP TABLE IF EXISTS memory_relations");
	await db.run("DROP TABLE IF EXISTS memory_node_links");
	await db.run("DROP TABLE IF EXISTS memory_nodes");
	await db.run("DROP TABLE IF EXISTS memory_source_links");
	await db.run("DROP TABLE IF EXISTS memory_sources");
}
