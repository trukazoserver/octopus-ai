import type { DatabaseAdapter } from "../database.js";

async function addColumnIfMissing(
	db: DatabaseAdapter,
	column: string,
	definition: string,
): Promise<void> {
	const columns = await db.all<{ name: string }>("PRAGMA table_info(memory_operations)");
	if (columns.some((existing) => existing.name === column)) return;
	try {
		await db.run(`ALTER TABLE memory_operations ADD COLUMN ${definition}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/duplicate column|already exists/i.test(message)) throw error;
	}
}

export async function up(db: DatabaseAdapter): Promise<void> {
	await addColumnIfMissing(db, "idempotency_key", "idempotency_key TEXT");
	await addColumnIfMissing(
		db,
		"attempt_count",
		"attempt_count INTEGER NOT NULL DEFAULT 0",
	);
	await db.run(
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_operations_idempotency ON memory_operations (idempotency_key)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_memory_operations_claimable ON memory_operations (status, lease_expires_at, updated_at)",
	);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP INDEX IF EXISTS idx_memory_operations_claimable");
	await db.run("DROP INDEX IF EXISTS idx_memory_operations_idempotency");
}
