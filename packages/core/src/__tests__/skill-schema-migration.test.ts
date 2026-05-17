import { afterEach, describe, expect, it } from "vitest";
import { SkillRegistry } from "../skills/registry.js";
import type { Skill } from "../skills/types.js";
import {
	type DatabaseAdapter,
	createDatabaseAdapter,
} from "../storage/database.js";
import { up as migrateSkillSchema } from "../storage/migrations/008_skill_schema.js";

const embedFn = async (): Promise<number[]> => new Array(16).fill(0);

function createSkill(id: string): Skill {
	return {
		id,
		name: `skill-${id}`,
		version: "1.0.0",
		description: "Migrated skill",
		tags: ["migration"],
		embedding: new Array(16).fill(0),
		instructions: "Use the migrated skill safely.",
		examples: [],
		templates: [],
		triggerConditions: {
			keywords: ["migration"],
			taskPatterns: [],
			domains: [],
		},
		contextEstimate: {
			instructions: 8,
			perExample: 0,
			templates: 0,
		},
		metrics: {
			timesUsed: 0,
			successRate: 0,
			avgUserRating: 0,
			lastUsed: new Date(0).toISOString(),
			improvementsCount: 0,
			createdAt: new Date(0).toISOString(),
		},
		quality: {
			completeness: 1,
			accuracy: 1,
			clarity: 1,
		},
		dependencies: [],
		related: [],
	};
}

describe("skill schema migration", () => {
	let db: DatabaseAdapter | undefined;

	afterEach(async () => {
		await db?.close();
		db = undefined;
	});

	it("upgrades legacy skill tables for SkillRegistry compatibility", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();

		await db.run("DROP TABLE IF EXISTS skill_usage");
		await db.run("DROP TABLE IF EXISTS skills");
		await db.run(`
			CREATE TABLE skills (
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
			CREATE TABLE skill_usage (
				id TEXT PRIMARY KEY,
				skill_id TEXT,
				task TEXT,
				success INTEGER,
				feedback TEXT,
				created_at TEXT
			)
		`);
		await db.run(
			"INSERT INTO skills (id, name, version, description, tags, embedding, instructions, metrics, quality, trigger_conditions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				"legacy-skill",
				"legacy skill",
				"1.0.0",
				"Legacy description",
				JSON.stringify(["legacy"]),
				JSON.stringify(new Array(16).fill(0)),
				"Legacy instructions",
				JSON.stringify({
					timesUsed: 0,
					successRate: 0,
					avgUserRating: 0,
					lastUsed: new Date(0).toISOString(),
					improvementsCount: 0,
					createdAt: new Date(0).toISOString(),
				}),
				JSON.stringify({ completeness: 1, accuracy: 1, clarity: 1 }),
				JSON.stringify({
					keywords: ["legacy"],
					taskPatterns: ["legacy task"],
					domains: ["migration"],
				}),
				"2024-01-01T00:00:00.000Z",
				"2024-01-01T00:00:00.000Z",
			],
		);
		await db.run(
			"INSERT INTO skill_usage (id, skill_id, task, success, feedback, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			[
				"usage-1",
				"legacy-skill",
				"Legacy task",
				1,
				"5",
				"2024-01-02T00:00:00.000Z",
			],
		);

		await migrateSkillSchema(db);

		const registry = new SkillRegistry(db, embedFn);
		const legacyUsage = await registry.getUsageHistory("legacy-skill", 10);
		expect(legacyUsage).toHaveLength(1);
		expect(legacyUsage[0]?.userFeedback).toBe("5");
		expect(legacyUsage[0]?.timestamp.toISOString()).toBe(
			"2024-01-02T00:00:00.000Z",
		);

		await registry.save(createSkill("new-skill"));
		const savedSkill = await registry.getById("new-skill");
		expect(savedSkill?.triggerConditions.keywords).toContain("migration");
		expect(savedSkill?.contextEstimate.instructions).toBe(8);
	});
});
