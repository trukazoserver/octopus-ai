import type { DatabaseAdapter } from "../database.js";

export async function up(db: DatabaseAdapter): Promise<void> {
	await db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      channel TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `);

	await db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      role TEXT,
      content TEXT,
      timestamp TEXT,
      metadata TEXT
    )
  `);

	await db.run(`
    CREATE TABLE IF NOT EXISTS memory_items (
      id TEXT PRIMARY KEY,
      type TEXT,
      content TEXT,
      embedding BLOB,
      importance REAL,
      access_count INTEGER,
      last_accessed TEXT,
      created_at TEXT,
      metadata TEXT,
      source TEXT
    )
  `);

	await db.run(`
    CREATE TABLE IF NOT EXISTS memory_associations (
      from_id TEXT,
      to_id TEXT,
      strength REAL,
      PRIMARY KEY (from_id, to_id)
    )
  `);

	await db.run(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT,
      version TEXT,
      description TEXT,
      tags TEXT,
      embedding BLOB,
      instructions TEXT,
      metrics TEXT,
      quality TEXT,
      trigger_conditions TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `);

	await db.run(`
    CREATE TABLE IF NOT EXISTS skill_usage (
      id TEXT PRIMARY KEY,
      skill_id TEXT,
      task TEXT,
      success INTEGER,
      feedback TEXT,
      created_at TEXT
    )
  `);

	await db.run(`
    CREATE TABLE IF NOT EXISTS channel_sessions (
      id TEXT PRIMARY KEY,
      channel TEXT,
      status TEXT,
      config TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `);

	await db.run(`
    CREATE TABLE IF NOT EXISTS config_history (
      id TEXT PRIMARY KEY,
      key TEXT,
      value TEXT,
      changed_at TEXT
    )
  `);

	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages (conversation_id)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_memory_items_type ON memory_items (type)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_memory_items_importance ON memory_items (importance)",
	);
	await db.run("CREATE INDEX IF NOT EXISTS idx_skills_name ON skills (name)");
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_skill_usage_skill_id ON skill_usage (skill_id)",
	);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP TABLE IF EXISTS config_history");
	await db.run("DROP TABLE IF EXISTS channel_sessions");
	await db.run("DROP TABLE IF EXISTS skill_usage");
	await db.run("DROP TABLE IF EXISTS skills");
	await db.run("DROP TABLE IF EXISTS memory_associations");
	await db.run("DROP TABLE IF EXISTS memory_items");
	await db.run("DROP TABLE IF EXISTS messages");
	await db.run("DROP TABLE IF EXISTS conversations");
}
