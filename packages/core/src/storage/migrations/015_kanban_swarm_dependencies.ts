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
	await addColumn(db, "agent_workflow_runs", "board_id TEXT");
	await addColumn(
		db,
		"agent_workflow_runs",
		"workflow_kind TEXT DEFAULT 'standard'",
	);
	await addColumn(db, "agent_workflow_runs", "planner_agent_id TEXT");
	await addColumn(
		db,
		"agent_workflow_runs",
		"dispatcher_status TEXT DEFAULT 'idle'",
	);
	await addColumn(db, "agent_workflow_runs", "dispatcher_last_tick_at TEXT");

	await addColumn(
		db,
		"agent_workflow_tasks",
		"workspace_type TEXT DEFAULT 'scratch'",
	);
	await addColumn(db, "agent_workflow_tasks", "workspace_path TEXT");
	await addColumn(db, "agent_workflow_tasks", "claim_token TEXT");
	await addColumn(db, "agent_workflow_tasks", "claimed_by_agent_id TEXT");
	await addColumn(db, "agent_workflow_tasks", "claimed_by_arm_key TEXT");
	await addColumn(db, "agent_workflow_tasks", "lease_expires_at TEXT");
	await addColumn(db, "agent_workflow_tasks", "last_heartbeat_at TEXT");
	await addColumn(db, "agent_workflow_tasks", "ready_at TEXT");
	await addColumn(db, "agent_workflow_tasks", "blocked_reason TEXT");
	await addColumn(db, "agent_workflow_tasks", "review_reason TEXT");
	await addColumn(
		db,
		"agent_workflow_tasks",
		"requires_human_review INTEGER NOT NULL DEFAULT 0",
	);
	await addColumn(db, "agent_workflow_tasks", "produces TEXT");
	await addColumn(db, "agent_workflow_tasks", "requirement_summary TEXT");
	await addColumn(db, "agent_workflow_tasks", "wip_group TEXT");

	await addColumn(db, "agent_workflow_artifacts", "artifact_key TEXT");
	await addColumn(db, "agent_workflow_artifacts", "producer_task_id TEXT");
	await addColumn(db, "agent_workflow_artifacts", "content_hash TEXT");
	await addColumn(db, "agent_workflow_artifacts", "size_bytes INTEGER");
	await addColumn(db, "agent_workflow_artifacts", "mime_type TEXT");
	await addColumn(db, "agent_workflow_artifacts", "quality_score REAL");

	await db.run(`
    CREATE TABLE IF NOT EXISTS kanban_boards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      default_workspace_type TEXT NOT NULL DEFAULT 'scratch',
      default_workspace_path TEXT,
      created_by_agent_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT
    )
  `);

	await db.run(`
    CREATE TABLE IF NOT EXISTS agent_workflow_task_requirements (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      requirement_key TEXT NOT NULL,
      requirement_type TEXT NOT NULL,
      required_task_id TEXT,
      required_status TEXT,
      artifact_key TEXT,
      artifact_type TEXT,
      min_count INTEGER NOT NULL DEFAULT 1,
      optional INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      satisfied_by_task_id TEXT,
      satisfied_by_artifact_id TEXT,
      satisfied_at TEXT,
      failure_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT
    )
  `);

	await db.run(`
    CREATE TABLE IF NOT EXISTS agent_workflow_task_leases (
      task_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      arm_key TEXT,
      lease_token TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_heartbeat_at TEXT NOT NULL,
      heartbeat_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      metadata TEXT
    )
  `);

	await db.run(`
    CREATE TABLE IF NOT EXISTS agent_workflow_blockers (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      blocker_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'normal',
      reason TEXT NOT NULL,
      owner_agent_id TEXT,
      opened_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      resolution TEXT,
      metadata TEXT
    )
  `);

	await db.run(`
    CREATE TABLE IF NOT EXISTS agent_workflow_task_comments (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      author_agent_id TEXT,
      comment_type TEXT NOT NULL DEFAULT 'comment',
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT
    )
  `);

	await db.run(`
    CREATE TABLE IF NOT EXISTS kanban_dispatcher_state (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT
    )
  `);

	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_key ON agent_workflow_artifacts (run_id, artifact_key)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_task_key ON agent_workflow_artifacts (task_id, artifact_key)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_workflow_tasks_ready ON agent_workflow_tasks (status, priority, created_at)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_workflow_tasks_lease ON agent_workflow_tasks (status, lease_expires_at)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_task_requirements_task ON agent_workflow_task_requirements (task_id, status)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_task_requirements_run ON agent_workflow_task_requirements (run_id, status)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_task_requirements_artifact ON agent_workflow_task_requirements (run_id, artifact_key, status)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_task_requirements_required_task ON agent_workflow_task_requirements (required_task_id, status)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_workflow_blockers_task ON agent_workflow_blockers (task_id, resolved_at)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_workflow_task_comments_task ON agent_workflow_task_comments (task_id, created_at)",
	);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP INDEX IF EXISTS idx_workflow_task_comments_task");
	await db.run("DROP INDEX IF EXISTS idx_workflow_blockers_task");
	await db.run("DROP INDEX IF EXISTS idx_task_requirements_required_task");
	await db.run("DROP INDEX IF EXISTS idx_task_requirements_artifact");
	await db.run("DROP INDEX IF EXISTS idx_task_requirements_run");
	await db.run("DROP INDEX IF EXISTS idx_task_requirements_task");
	await db.run("DROP INDEX IF EXISTS idx_workflow_tasks_lease");
	await db.run("DROP INDEX IF EXISTS idx_workflow_tasks_ready");
	await db.run("DROP INDEX IF EXISTS idx_workflow_artifacts_task_key");
	await db.run("DROP INDEX IF EXISTS idx_workflow_artifacts_key");
	await db.run("DROP TABLE IF EXISTS agent_workflow_blockers");
	await db.run("DROP TABLE IF EXISTS agent_workflow_task_comments");
	await db.run("DROP TABLE IF EXISTS kanban_dispatcher_state");
	await db.run("DROP TABLE IF EXISTS agent_workflow_task_leases");
	await db.run("DROP TABLE IF EXISTS agent_workflow_task_requirements");
	await db.run("DROP TABLE IF EXISTS kanban_boards");
}
