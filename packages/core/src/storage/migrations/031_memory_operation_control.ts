import type { DatabaseAdapter } from "../database.js";

async function addColumnIfMissing(
	db: DatabaseAdapter,
	column: string,
	definition: string,
): Promise<void> {
	const columns = await db.all<{ name: string }>("PRAGMA table_info(memory_operations)");
	if (columns.some((existing) => existing.name === column)) return;
	await db.run(`ALTER TABLE memory_operations ADD COLUMN ${definition}`);
}

export async function up(db: DatabaseAdapter): Promise<void> {
	await addColumnIfMissing(
		db,
		"control_action",
		"control_action TEXT NOT NULL DEFAULT 'run'",
	);
	await addColumnIfMissing(
		db,
		"fence_version",
		"fence_version INTEGER NOT NULL DEFAULT 0",
	);
}

export async function down(): Promise<void> {}
