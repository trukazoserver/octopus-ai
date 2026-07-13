import type { DatabaseAdapter } from "../database.js";

export async function up(db: DatabaseAdapter): Promise<void> {
	try {
		await db.run("ALTER TABLE memory_relations ADD COLUMN owner_memory_id TEXT DEFAULT NULL");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/duplicate column|already exists/i.test(message)) throw error;
	}
	let lastId = "";
	while (true) {
		const rows = await db.all<{ id: string; metadata: string | null }>(
			"SELECT id, metadata FROM memory_relations WHERE owner_memory_id IS NULL AND id > ? ORDER BY id ASC LIMIT 500",
			[lastId],
		);
		if (rows.length === 0) break;
		for (const row of rows) {
			try {
				const memoryId = JSON.parse(row.metadata ?? "{}").memoryId;
				if (typeof memoryId === "string" && memoryId) {
					await db.run("UPDATE memory_relations SET owner_memory_id = ? WHERE id = ? AND owner_memory_id IS NULL", [memoryId, row.id]);
				}
			} catch {}
		}
		lastId = rows.at(-1)?.id ?? lastId;
	}
	await db.run("CREATE INDEX IF NOT EXISTS idx_memory_relations_owner ON memory_relations (owner_memory_id)");
	await db.run("CREATE INDEX IF NOT EXISTS idx_memory_node_links_node ON memory_node_links (node_id)");
	await db.run("CREATE INDEX IF NOT EXISTS idx_memory_source_links_source ON memory_source_links (source_id)");
	await db.run("CREATE INDEX IF NOT EXISTS idx_memory_relation_sources_source ON memory_relation_sources (source_id)");
}

export async function down(db: DatabaseAdapter): Promise<void> {
	for (const index of [
		"idx_memory_relations_owner",
		"idx_memory_node_links_node",
		"idx_memory_source_links_source",
		"idx_memory_relation_sources_source",
	]) await db.run(`DROP INDEX IF EXISTS ${index}`);
}
