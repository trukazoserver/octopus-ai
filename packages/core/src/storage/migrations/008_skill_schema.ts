import type { DatabaseAdapter } from "../database.js";

async function addColumnIfMissing(
	db: DatabaseAdapter,
	table: string,
	column: string,
	definition: string,
): Promise<void> {
	const rows = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
	if (rows.some((row) => row.name === column)) return;
	await db.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

export async function up(db: DatabaseAdapter): Promise<void> {
	const skillColumns = await db.all<{ name: string }>(
		"PRAGMA table_info(skills)",
	);
	const skillColumnNames = new Set(skillColumns.map((row) => row.name));
	await addColumnIfMissing(
		db,
		"skills",
		"examples",
		"examples TEXT NOT NULL DEFAULT '[]'",
	);
	await addColumnIfMissing(
		db,
		"skills",
		"templates",
		"templates TEXT NOT NULL DEFAULT '[]'",
	);
	await addColumnIfMissing(
		db,
		"skills",
		"triggerConditions",
		'triggerConditions TEXT NOT NULL DEFAULT \'{"keywords":[],"taskPatterns":[],"domains":[]}\'',
	);
	await addColumnIfMissing(
		db,
		"skills",
		"contextEstimate",
		'contextEstimate TEXT NOT NULL DEFAULT \'{"instructions":0,"perExample":0,"templates":0}\'',
	);
	await addColumnIfMissing(
		db,
		"skills",
		"dependencies",
		"dependencies TEXT NOT NULL DEFAULT '[]'",
	);
	await addColumnIfMissing(
		db,
		"skills",
		"related",
		"related TEXT NOT NULL DEFAULT '[]'",
	);
	if (skillColumnNames.has("trigger_conditions")) {
		await db.run(
			"UPDATE skills SET triggerConditions = trigger_conditions WHERE trigger_conditions IS NOT NULL AND trigger_conditions != ''",
		);
	}

	const usageColumns = await db.all<{ name: string }>(
		"PRAGMA table_info(skill_usage)",
	);
	const usageColumnNames = new Set(usageColumns.map((row) => row.name));
	await addColumnIfMissing(db, "skill_usage", "skillId", "skillId TEXT");
	await addColumnIfMissing(
		db,
		"skill_usage",
		"failureReason",
		"failureReason TEXT",
	);
	await addColumnIfMissing(
		db,
		"skill_usage",
		"userFeedback",
		"userFeedback TEXT",
	);
	await addColumnIfMissing(
		db,
		"skill_usage",
		"successReason",
		"successReason TEXT",
	);
	await addColumnIfMissing(db, "skill_usage", "timestamp", "timestamp TEXT");
	if (usageColumnNames.has("skill_id")) {
		await db.run(
			"UPDATE skill_usage SET skillId = skill_id WHERE (skillId IS NULL OR skillId = '') AND skill_id IS NOT NULL",
		);
	}
	if (usageColumnNames.has("feedback")) {
		await db.run(
			"UPDATE skill_usage SET userFeedback = feedback WHERE (userFeedback IS NULL OR userFeedback = '') AND feedback IS NOT NULL",
		);
	}
	if (usageColumnNames.has("created_at")) {
		await db.run(
			"UPDATE skill_usage SET timestamp = created_at WHERE (timestamp IS NULL OR timestamp = '') AND created_at IS NOT NULL",
		);
	}
	await db.run(
		"UPDATE skill_usage SET timestamp = datetime('now') WHERE timestamp IS NULL OR timestamp = ''",
	);

	await db.run(
		"CREATE INDEX IF NOT EXISTS idx_skill_usage_skillId ON skill_usage (skillId)",
	);
}

export async function down(_db: DatabaseAdapter): Promise<void> {
	// SQLite cannot drop columns portably; keep additive compatibility columns.
}
