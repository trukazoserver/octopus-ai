import type { DatabaseAdapter } from "../database.js";

const LEGACY_SCOPE = "__learning_legacy_unscoped_v1__";

type LearningTable = "experiences" | "learning_insights";

async function addColumnIfMissing(
	db: DatabaseAdapter,
	table: LearningTable,
	column: string,
	definition: string,
): Promise<void> {
	const columns = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
	if (columns.some((existing) => existing.name === column)) return;
	try {
		await db.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/duplicate column|already exists/i.test(message)) throw error;
	}
}

export async function up(db: DatabaseAdapter): Promise<void> {
	for (const table of ["experiences", "learning_insights"] as const) {
		await addColumnIfMissing(
			db,
			table,
			"scope_key",
			`scope_key TEXT NOT NULL DEFAULT '${LEGACY_SCOPE}'`,
		);
		for (const column of [
			"scope_tenant_id",
			"scope_user_id",
			"scope_project_id",
			"scope_agent_role",
		] as const) {
			await addColumnIfMissing(
				db,
				table,
				column,
				`${column} TEXT NOT NULL DEFAULT '${LEGACY_SCOPE}'`,
			);
		}
		await addColumnIfMissing(
			db,
			table,
			"scope_session_id",
			"scope_session_id TEXT DEFAULT NULL",
		);
		await addColumnIfMissing(
			db,
			table,
			"scope_task_id",
			"scope_task_id TEXT DEFAULT NULL",
		);
	}

	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_experiences_learning_scope ON experiences (scope_key, status, created_at)",
	);
	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_learning_insights_scope ON learning_insights (scope_key, confidence, importance, created_at)",
	);
}

export async function down(db: DatabaseAdapter): Promise<void> {
	await db.run("DROP INDEX IF EXISTS idx_learning_insights_scope");
	await db.run("DROP INDEX IF EXISTS idx_experiences_learning_scope");
}
