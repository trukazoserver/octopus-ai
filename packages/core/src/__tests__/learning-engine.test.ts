import { afterEach, describe, expect, it } from "vitest";
import { LearningEngine } from "../learning/engine.js";
import type { SkillForge } from "../skills/forge.js";
import { SkillRegistry } from "../skills/registry.js";
import type { Skill } from "../skills/types.js";
import {
	type DatabaseAdapter,
	createDatabaseAdapter,
} from "../storage/database.js";

const embedFn = async (text: string): Promise<number[]> => {
	const vec = new Array(16).fill(0);
	for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
		let hash = 0;
		for (const ch of word) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
		vec[Math.abs(hash) % vec.length] += 1;
	}
	const norm = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0));
	return norm > 0 ? vec.map((value) => value / norm) : vec;
};

describe("LearningEngine", () => {
	let db: DatabaseAdapter | undefined;

	afterEach(async () => {
		await db?.close();
		db = undefined;
	});

	async function createEngine(config = {}) {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const engine = new LearningEngine(db, embedFn, {
			config: { autoReflect: false, ...config },
		});
		await engine.initialize();
		return engine;
	}

	function createTestSkill(id: string): Skill {
		return {
			id,
			name: "test-skill",
			version: "1.0.0",
			description: "Reusable test skill",
			tags: ["test"],
			embedding: new Array(16).fill(0),
			instructions: "Use the tested approach.",
			examples: [],
			templates: [],
			triggerConditions: {
				keywords: ["test"],
				taskPatterns: [],
				domains: [],
			},
			contextEstimate: {
				instructions: 6,
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

	it("stores successful experiences and actionable insights", async () => {
		const engine = await createEngine();

		const experience = await engine.recordExperience({
			userRequest: "Extract product images from Etsy page",
			finalResponse:
				"Completed successfully. Used browser_extract_images and returned the product image URLs.",
			toolsUsed: [
				{
					name: "browser_extract_images",
					success: true,
					summary: "found 5 image URLs",
				},
			],
		});

		expect(experience.status).toBe("succeeded");
		const insights = await engine.listInsights({ limit: 10 });
		expect(insights.length).toBeGreaterThan(0);
		expect(insights.some((insight) => insight.type === "procedure")).toBe(true);
		expect(insights.some((insight) => insight.type === "tool_strategy")).toBe(
			true,
		);
	});

	it("does not store insights below the confidence threshold", async () => {
		const engine = await createEngine({ minConfidenceToStore: 0.9 });

		await engine.recordExperience({
			userRequest: "Do something vague",
			finalResponse: "Maybe done.",
			confidence: 0.4,
		});

		const insights = await engine.listInsights({ limit: 10 });
		expect(insights).toHaveLength(0);
	});

	it("does not persist experiences or insights when disabled", async () => {
		const engine = await createEngine({ enabled: false });

		const experience = await engine.recordExperience({
			userRequest: "Extract product images from Etsy page",
			finalResponse: "Completed successfully using browser_extract_images.",
			confidence: 0.9,
			toolsUsed: [{ name: "browser_extract_images", success: true }],
		});

		expect(experience.status).toBe("succeeded");
		const insights = await engine.listInsights({ limit: 10 });
		expect(insights).toHaveLength(0);
		const row = await db?.get<{ cnt: number }>(
			"SELECT COUNT(*) as cnt FROM experiences",
		);
		expect(row?.cnt).toBe(0);
	});

	it("retrieves relevant learning guidance", async () => {
		const engine = await createEngine();
		await engine.recordExperience({
			userRequest: "Extract product images from Etsy page",
			finalResponse:
				"Completed successfully using browser_extract_images before clicking thumbnails.",
			confidence: 0.9,
			toolsUsed: [{ name: "browser_extract_images", success: true }],
		});

		const relevant = await engine.retrieveRelevant("Need Etsy product images");
		expect(relevant.length).toBeGreaterThan(0);
		expect(relevant.map((item) => item.content).join("\n")).toContain(
			"browser_extract_images",
		);
	});

	it("records feedback against the latest conversation experience", async () => {
		const engine = await createEngine();
		const experience = await engine.recordExperience({
			conversationId: "conv-1",
			userRequest: "Summarize this",
			finalResponse: "Completed successfully with a concise summary.",
		});

		await engine.addFeedback({
			conversationId: "conv-1",
			rating: "negative",
			comment: "Wrong focus",
		});
		const row = await db?.get<{ status: string; metadata: string }>(
			"SELECT status, metadata FROM experiences WHERE id = ?",
			[experience.id],
		);
		expect(row?.status).toBe("failed");
		expect(row?.metadata).toContain("Wrong focus");
		const insights = await engine.listInsights({ limit: 10 });
		expect(insights.some((insight) => insight.type === "what_failed")).toBe(
			true,
		);
		expect(insights.map((insight) => insight.content).join("\n")).toContain(
			"Wrong focus",
		);
	});

	it("turns positive feedback into reusable what-worked guidance", async () => {
		const engine = await createEngine();
		const experience = await engine.recordExperience({
			userRequest: "Configure a GitHub MCP server",
			finalResponse:
				"Completed successfully by using the catalog preset and replacing token placeholders with environment variables.",
			confidence: 0.8,
		});

		await engine.addFeedback({
			experienceId: experience.id,
			rating: "positive",
			comment: "The preset plus env placeholder approach worked",
		});

		const row = await db?.get<{ status: string; metadata: string }>(
			"SELECT status, metadata FROM experiences WHERE id = ?",
			[experience.id],
		);
		expect(row?.status).toBe("succeeded");
		expect(row?.metadata).toContain("preset plus env placeholder");
		const insights = await engine.listInsights({ limit: 10 });
		const feedbackInsight = insights.find(
			(insight) => insight.type === "what_worked",
		);
		expect(feedbackInsight?.content).toContain("User confirmed");
		expect(feedbackInsight?.evidence).toContain("preset plus env placeholder");
	});

	it("applies explicit feedback to skill metrics and skill creation", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const registry = new SkillRegistry(db, embedFn);
		await registry.save(createTestSkill("skill-1"));
		const createdSkills: Array<{ description: string; whatWorked: string }> =
			[];
		const skillForge = {
			createSkill: async (
				task: { description: string },
				result: { whatWorked: string },
			) => {
				createdSkills.push({
					description: task.description,
					whatWorked: result.whatWorked,
				});
				return createTestSkill("created-skill");
			},
		} as unknown as SkillForge;
		const engine = new LearningEngine(db, embedFn, {
			config: {
				autoReflect: false,
				minSimilarSuccessesForSkill: 1,
			},
			skillRegistry: registry,
			skillForge,
		});
		await engine.initialize();

		const experience = await engine.recordExperience({
			userRequest: "Configure GitHub MCP integration safely",
			finalResponse: "Failed because credentials were missing.",
			status: "failed",
			confidence: 0.8,
			skillsUsed: [{ id: "skill-1", name: "test-skill" }],
		});
		await engine.addFeedback({
			experienceId: experience.id,
			rating: "positive",
			comment: "Actually worked after setting GITHUB_TOKEN",
		});

		const history = await registry.getUsageHistory("skill-1", 10);
		expect(history).toHaveLength(2);
		expect(history.some((usage) => usage.userFeedback === "5")).toBe(true);
		expect(
			history.some((usage) =>
				usage.successReason?.includes("Actually worked after setting"),
			),
		).toBe(true);
		const skill = await registry.getById("skill-1");
		expect(skill?.metrics.timesUsed).toBe(2);
		expect(skill?.metrics.successRate).toBe(0.5);
		expect(skill?.metrics.avgUserRating).toBe(5);
		expect(createdSkills).toHaveLength(1);
		expect(createdSkills[0]?.description).toBe(
			"Configure GitHub MCP integration safely",
		);
		expect(createdSkills[0]?.whatWorked).toContain("User confirmed");
	});

	it("captures the root cause of a failure masked as partial (e.g. 10MB overflow)", async () => {
		const engine = await createEngine();
		await engine.recordExperience({
			userRequest: "Create a wedding website with generated images",
			finalResponse:
				"He completado la web. Nota: un request fallo con Codex backend error (400): string_above_max_length (string too long). Listo.",
			status: "partial",
			confidence: 0.85,
			toolsUsed: [{ name: "codex_generate_image", success: true }],
		});

		const insights = await engine.listInsights({ limit: 30 });
		const anti = insights.find(
			(i) => i.type === "anti_pattern" && i.confidence >= 0.9,
		);
		expect(anti).toBeTruthy();
		expect(anti?.content).toMatch(/string_above_max_length|too long/i);
		expect(anti?.evidence ?? "").toContain("context_over_limit");
	});

	it("promotes a high-confidence failure lesson into retrieved guidance", async () => {
		const engine = await createEngine();
		await engine.recordExperience({
			userRequest: "Create a wedding website with generated images",
			finalResponse:
				"Completed but a request failed: Codex backend error (400) string_above_max_length string too long.",
			status: "partial",
			confidence: 0.85,
		});

		const relevant = await engine.retrieveRelevant("wedding website images");
		// The captured anti_pattern (conf >= 0.8) must be promoted into the
		// results instead of being crowded out by general insights.
		expect(
			relevant.some((i) => i.type === "anti_pattern" && i.confidence >= 0.8),
		).toBe(true);
	});

	it("reinforces an existing near-duplicate lesson instead of duplicating it", async () => {
		const engine = await createEngine();
		const base = {
			userRequest: "Extract product images from Etsy page",
			finalResponse:
				"Completed successfully using browser_extract_images to get the image URLs.",
			confidence: 0.9,
			toolsUsed: [{ name: "browser_extract_images", success: true }],
		};
		await engine.recordExperience(base);
		const beforeProcedures = (
			await engine.listInsights({ limit: 50, type: "procedure" })
		).length;

		// Same lesson again — should reinforce the existing one, not add a copy.
		await engine.recordExperience(base);
		const afterProcedures = (
			await engine.listInsights({ limit: 50, type: "procedure" })
		).length;

		expect(afterProcedures).toBe(beforeProcedures);
	});

	it("consolidates exact-keyword duplicate insights", async () => {
		const engine = await createEngine();
		// Insert two insights with identical type + keyword set directly, then
		// consolidate — they must merge into one (highest confidence kept).
		const kw = JSON.stringify(["etsy", "images", "extract"]);
		for (const conf of [0.7, 0.9]) {
			await db?.run(
				`INSERT INTO learning_insights (id, experience_id, type, domain, keywords, content, evidence, confidence, importance, embedding, use_count, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					`dup-${conf}`,
					"exp",
					"procedure",
					"web",
					kw,
					`Extract Etsy images (conf ${conf})`,
					null,
					conf,
					0.7,
					"[]",
					0,
					new Date().toISOString(),
				],
			);
		}
		const removed = await engine.consolidateInsights();
		expect(removed).toBe(1);
		const remaining = await engine.listInsights({
			limit: 50,
			type: "procedure",
		});
		expect(
			remaining.filter((i) => i.content.startsWith("Extract Etsy images")),
		).toHaveLength(1);
		expect(remaining[0]?.confidence).toBeGreaterThanOrEqual(0.9);
	});
});
