import type { DatabaseAdapter } from "../database.js";

async function addColumn(
	db: DatabaseAdapter,
	table: string,
	definition: string,
): Promise<void> {
	try {
		await db.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (!/duplicate column|already exists/i.test(message)) throw err;
	}
}

export async function up(db: DatabaseAdapter): Promise<void> {
	await addColumn(db, "agents", "is_builtin_arm INTEGER NOT NULL DEFAULT 0");
	await addColumn(db, "agents", "arm_key TEXT");
	await addColumn(db, "agents", "base_profile TEXT");
	await addColumn(db, "agents", "user_overrides TEXT");
	await addColumn(db, "agents", "capabilities TEXT");
	await addColumn(db, "agents", "tool_permissions TEXT");
	await addColumn(db, "agents", "knowledge_base_ids TEXT");
	await addColumn(db, "agents", "fallback_model TEXT");
	await addColumn(db, "agents", "can_spawn_subagents INTEGER NOT NULL DEFAULT 1");
	await addColumn(db, "agents", "max_spawn_depth INTEGER NOT NULL DEFAULT 2");

	await db.run(
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_arm_key ON agents (arm_key) WHERE arm_key IS NOT NULL",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_agents_builtin_arm ON agents (is_builtin_arm)",
	);

	await db.run(`
    CREATE TABLE IF NOT EXISTS agent_workflow_runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      root_agent_id TEXT,
      goal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      current_phase TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      metadata TEXT
    )
  `);

	await db.run(`
    CREATE TABLE IF NOT EXISTS agent_workflow_tasks (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      parent_task_id TEXT,
      assigned_agent_id TEXT,
      arm_key TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      step_key TEXT,
      progress_signature TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      stagnant_attempt_count INTEGER NOT NULL DEFAULT 0,
      max_stagnant_attempts INTEGER NOT NULL DEFAULT 5,
      priority INTEGER NOT NULL DEFAULT 5,
      depends_on TEXT,
      acceptance_criteria TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      metadata TEXT
    )
  `);

	await db.run(`
    CREATE TABLE IF NOT EXISTS agent_workflow_attempts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      step_key TEXT,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      error TEXT,
      progress_signature_before TEXT,
      progress_signature_after TEXT,
      metadata TEXT
    )
  `);

	await db.run(`
    CREATE TABLE IF NOT EXISTS agent_workflow_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      task_id TEXT,
      agent_id TEXT,
      event_type TEXT NOT NULL,
      message TEXT,
      tool_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT
    )
  `);

	await db.run(`
    CREATE TABLE IF NOT EXISTS agent_workflow_artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      task_id TEXT,
      agent_id TEXT,
      artifact_type TEXT NOT NULL,
      url TEXT,
      path TEXT,
      description TEXT,
      exists_verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT
    )
  `);

	await db.run(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      from_agent_id TEXT NOT NULL,
      to_agent_id TEXT,
      task_id TEXT,
      message_type TEXT NOT NULL DEFAULT 'message',
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      read_at TEXT,
      metadata TEXT
    )
  `);

	await db.run(`
    CREATE TABLE IF NOT EXISTS knowledge_collections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT
    )
  `);

	await db.run(`
    CREATE TABLE IF NOT EXISTS knowledge_items (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      media_id TEXT,
      source_type TEXT NOT NULL,
      source_uri TEXT,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT
    )
  `);

	await db.run(`
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      modality TEXT NOT NULL DEFAULT 'text',
      embedding TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT
    )
  `);

	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_workflow_tasks_run ON agent_workflow_tasks (run_id)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_workflow_tasks_status ON agent_workflow_tasks (status)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_workflow_events_run ON agent_workflow_events (run_id)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_agent_messages_run ON agent_messages (run_id)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_knowledge_items_collection ON knowledge_items (collection_id)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_item ON knowledge_chunks (item_id)",
	);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP INDEX IF EXISTS idx_knowledge_chunks_item");
	await db.run("DROP INDEX IF EXISTS idx_knowledge_items_collection");
	await db.run("DROP INDEX IF EXISTS idx_agent_messages_run");
	await db.run("DROP INDEX IF EXISTS idx_workflow_events_run");
	await db.run("DROP INDEX IF EXISTS idx_workflow_tasks_status");
	await db.run("DROP INDEX IF EXISTS idx_workflow_tasks_run");
	await db.run("DROP TABLE IF EXISTS knowledge_chunks");
	await db.run("DROP TABLE IF EXISTS knowledge_items");
	await db.run("DROP TABLE IF EXISTS knowledge_collections");
	await db.run("DROP TABLE IF EXISTS agent_messages");
	await db.run("DROP TABLE IF EXISTS agent_workflow_artifacts");
	await db.run("DROP TABLE IF EXISTS agent_workflow_events");
	await db.run("DROP TABLE IF EXISTS agent_workflow_attempts");
	await db.run("DROP TABLE IF EXISTS agent_workflow_tasks");
	await db.run("DROP TABLE IF EXISTS agent_workflow_runs");
	await db.run("DROP INDEX IF EXISTS idx_agents_builtin_arm");
	await db.run("DROP INDEX IF EXISTS idx_agents_arm_key");
}
