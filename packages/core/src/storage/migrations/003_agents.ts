import type { DatabaseAdapter } from "../database.js";

export async function up(db: DatabaseAdapter): Promise<void> {
	await db.run(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      role TEXT NOT NULL DEFAULT 'assistant',
      personality TEXT,
      system_prompt TEXT NOT NULL,
      model TEXT,
      avatar TEXT,
      color TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      is_main INTEGER NOT NULL DEFAULT 0,
      parent_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      config TEXT
    )
  `);

	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_agents_is_main ON agents (is_main)",
	);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP INDEX IF EXISTS idx_agents_is_main");
	await db.run("DROP TABLE IF EXISTS agents");
}
