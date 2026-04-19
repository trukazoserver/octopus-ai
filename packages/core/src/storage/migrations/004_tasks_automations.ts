import type { DatabaseAdapter } from "../database.js";

export async function up(db: DatabaseAdapter): Promise<void> {
	await db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 5,
      assigned_agent_id TEXT,
      created_by TEXT,
      parent_task_id TEXT,
      result TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      metadata TEXT
    )
  `);

	await db.run(`
    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      trigger_type TEXT NOT NULL,
      trigger_config TEXT NOT NULL,
      action_type TEXT NOT NULL,
      action_config TEXT NOT NULL,
      agent_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run TEXT,
      run_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

	await db.run("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status)");
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_tasks_assigned_agent ON tasks (assigned_agent_id)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_automations_enabled ON automations (enabled)",
	);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP INDEX IF EXISTS idx_automations_enabled");
	await db.run("DROP INDEX IF EXISTS idx_tasks_assigned_agent");
	await db.run("DROP INDEX IF EXISTS idx_tasks_status");
	await db.run("DROP TABLE IF EXISTS automations");
	await db.run("DROP TABLE IF EXISTS tasks");
}
