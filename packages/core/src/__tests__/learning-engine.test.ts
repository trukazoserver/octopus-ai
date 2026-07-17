import { afterEach, describe, expect, it, vi } from "vitest";
import { LearningEngine } from "../learning/engine.js";
import { LongTermMemory } from "../memory/ltm.js";
import { SqliteVectorStore } from "../memory/sqlite-vss.js";
import type { SkillForge } from "../skills/forge.js";
import { SkillRegistry } from "../skills/registry.js";
import type { Skill } from "../skills/types.js";
import {
	type DatabaseAdapter,
	createDatabaseAdapter,
} from "../storage/database.js";

const TEST_SCOPE = {
	tenantId: "tenant-a",
	userId: "user-a",
	projectId: "project-a",
	agentRole: "agent-a",
};
const SCOPED_ACCESS = { kind: "scoped", scope: TEST_SCOPE } as const;
const ADMIN_ACCESS = { kind: "admin" } as const;

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
			scope: TEST_SCOPE,
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
		const insights = await engine.listInsights(SCOPED_ACCESS, { limit: 10 });
		expect(insights.length).toBeGreaterThan(0);
		expect(insights.some((insight) => insight.type === "procedure")).toBe(true);
		expect(insights.some((insight) => insight.type === "tool_strategy")).toBe(
			true,
		);
	});

	it("does not store insights below the confidence threshold", async () => {
		const engine = await createEngine({ minConfidenceToStore: 0.9 });

		await engine.recordExperience({
			scope: TEST_SCOPE,
			userRequest: "Do something vague",
			finalResponse: "Maybe done.",
			confidence: 0.4,
		});

		const insights = await engine.listInsights(SCOPED_ACCESS, { limit: 10 });
		expect(insights).toHaveLength(0);
	});

	it("does not persist experiences or insights when disabled", async () => {
		const engine = await createEngine({ enabled: false });

		const experience = await engine.recordExperience({
			scope: TEST_SCOPE,
			userRequest: "Extract product images from Etsy page",
			finalResponse: "Completed successfully using browser_extract_images.",
			confidence: 0.9,
			toolsUsed: [{ name: "browser_extract_images", success: true }],
		});

		expect(experience.status).toBe("succeeded");
		const insights = await engine.listInsights(SCOPED_ACCESS, { limit: 10 });
		expect(insights).toHaveLength(0);
		const row = await db?.get<{ cnt: number }>(
			"SELECT COUNT(*) as cnt FROM experiences",
		);
		expect(row?.cnt).toBe(0);
	});

	it("retrieves relevant learning guidance", async () => {
		const engine = await createEngine();
		await engine.recordExperience({
			scope: TEST_SCOPE,
			userRequest: "Extract product images from Etsy page",
			finalResponse:
				"Completed successfully using browser_extract_images before clicking thumbnails.",
			confidence: 0.9,
			toolsUsed: [{ name: "browser_extract_images", success: true }],
		});

		const relevant = await engine.retrieveRelevant(
			"Need Etsy product images",
			TEST_SCOPE,
		);
		expect(relevant.length).toBeGreaterThan(0);
		expect(relevant.map((item) => item.content).join("\n")).toContain(
			"browser_extract_images",
		);
	});

	it("isolates learning by tenant, user, project, and agent", async () => {
		const engine = await createEngine();
		const otherScope = { ...TEST_SCOPE, agentRole: "agent-b" };
		await engine.recordExperience({
			scope: TEST_SCOPE,
			userRequest: "Extract product images from Etsy page",
			finalResponse:
				"Completed successfully using browser_extract_images before opening thumbnails.",
			confidence: 0.9,
		});

		expect(
			await engine.retrieveRelevant("Need Etsy product images", otherScope),
		).toHaveLength(0);

		await engine.recordExperience({
			scope: otherScope,
			userRequest: "Extract product images from Etsy page",
			finalResponse:
				"Completed successfully using the product JSON payload instead of thumbnails.",
			confidence: 0.9,
		});

		const firstAgent = await engine.retrieveRelevant(
			"Need Etsy product images",
			TEST_SCOPE,
		);
		const secondAgent = await engine.retrieveRelevant(
			"Need Etsy product images",
			otherScope,
		);
		expect(firstAgent.length).toBeGreaterThan(0);
		expect(secondAgent.length).toBeGreaterThan(0);
		expect(firstAgent.every((item) => item.scope.agentRole === "agent-a")).toBe(
			true,
		);
		expect(secondAgent.every((item) => item.scope.agentRole === "agent-b")).toBe(
			true,
		);
	});

	it("requires explicit scoped or admin access for learning management", async () => {
		const engine = await createEngine();
		const otherScope = { ...TEST_SCOPE, agentRole: "agent-b" };
		await engine.recordExperience({
			scope: TEST_SCOPE,
			userRequest: "Review TypeScript changes",
			finalResponse: "Completed successfully after typecheck and tests.",
			confidence: 0.9,
		});
		await engine.recordExperience({
			scope: otherScope,
			userRequest: "Review Python changes",
			finalResponse: "Completed successfully after pytest and lint.",
			confidence: 0.9,
		});

		const scopedExperiences = await engine.listExperiences(SCOPED_ACCESS, {
			limit: 10,
		});
		const scopedInsights = await engine.listInsights(SCOPED_ACCESS, {
			limit: 20,
		});
		const adminExperiences = await engine.listExperiences(ADMIN_ACCESS, {
			limit: 10,
		});
		expect(scopedExperiences).toHaveLength(1);
		expect(scopedExperiences[0]?.scope.agentRole).toBe("agent-a");
		expect(scopedInsights.every((item) => item.scope.agentRole === "agent-a")).toBe(
			true,
		);
		expect(adminExperiences).toHaveLength(2);
	});

	it("rejects feedback targeting another learning scope", async () => {
		const engine = await createEngine();
		const otherScope = { ...TEST_SCOPE, agentRole: "agent-b" };
		const experience = await engine.recordExperience({
			scope: otherScope,
			conversationId: "shared-conversation-id",
			userRequest: "Deploy the service",
			finalResponse: "Completed successfully with verified health checks.",
			confidence: 0.9,
		});

		expect(
			await engine.addFeedback(SCOPED_ACCESS, {
				experienceId: experience.id,
				rating: "negative",
			}),
		).toBe(false);
		const untouched = await db?.get<{ status: string }>(
			"SELECT status FROM experiences WHERE id = ?",
			[experience.id],
		);
		expect(untouched?.status).toBe("succeeded");

		expect(
			await engine.addFeedback(
				{ kind: "scoped", scope: otherScope },
				{
					experienceId: experience.id,
					rating: "negative",
					comment: "Health check was stale",
				},
			),
		).toBe(true);
		const updated = await db?.get<{ status: string }>(
			"SELECT status FROM experiences WHERE id = ?",
			[experience.id],
		);
		expect(updated?.status).toBe("failed");
	});

	it("forgets both a scoped insight and its long-term mirror", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const store = new SqliteVectorStore(db);
		await store.initialize();
		const ltm = new LongTermMemory(store, db);
		const engine = new LearningEngine(db, embedFn, {
			ltm,
			config: { autoReflect: false },
		});
		await engine.initialize();
		await engine.recordExperience({
			scope: TEST_SCOPE,
			userRequest: "Prepare a verified deployment",
			finalResponse:
				"Completed successfully after build, migration, and health verification.",
			confidence: 0.95,
		});
		const insight = (
			await engine.listInsights(SCOPED_ACCESS, {
				limit: 20,
				type: "procedure",
			})
		)[0];
		expect(insight).toBeDefined();
		expect(await ltm.getById(`learn_${insight?.id}`)).toBeDefined();

		const otherAccess = {
			kind: "scoped" as const,
			scope: { ...TEST_SCOPE, agentRole: "agent-b" },
		};
		expect(await engine.forgetInsight(otherAccess, insight?.id ?? "")).toBe(
			false,
		);
		expect(await engine.forgetInsight(SCOPED_ACCESS, insight?.id ?? "")).toBe(
			true,
		);
		expect(await ltm.getById(`learn_${insight?.id}`)).toBeUndefined();
		expect(
			await db.get("SELECT id FROM learning_insights WHERE id = ?", [insight?.id]),
		).toBeUndefined();
		expect(await engine.forgetInsight(SCOPED_ACCESS, insight?.id ?? "")).toBe(
			false,
		);
	});

	it("rolls back a new insight when its long-term mirror cannot be staged", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const store = new SqliteVectorStore(db);
		await store.initialize();
		const ltm = new LongTermMemory(store, db);
		const engine = new LearningEngine(db, embedFn, {
			ltm,
			config: { autoReflect: false },
		});
		await engine.initialize();
		const realStageStore = ltm.stageStore.bind(ltm);
		vi.spyOn(ltm, "stageStore").mockImplementationOnce(async (memory) => {
			await realStageStore(memory);
			throw new Error("failure-after-learning-mirror");
		});

		await expect(
			engine.recordUserCorrection({
				scope: TEST_SCOPE,
				content: "Always verify the migration before deployment",
			}),
		).rejects.toThrow("failure-after-learning-mirror");
		expect(
			await db.get("SELECT id FROM learning_insights LIMIT 1"),
		).toBeUndefined();
		expect(
			await db.get(
				"SELECT id FROM memory_items WHERE metadata LIKE '%learning_engine%' LIMIT 1",
			),
		).toBeUndefined();
		expect(
			(await db.get<{ count: number }>(
				"SELECT COUNT(*) AS count FROM experiences",
			))?.count,
		).toBe(1);
	});

	it("removes redundant long-term mirrors during scoped consolidation", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const store = new SqliteVectorStore(db);
		await store.initialize();
		const ltm = new LongTermMemory(store, db);
		const engine = new LearningEngine(db, embedFn, {
			ltm,
			config: { autoReflect: false },
		});
		await engine.initialize();
		const scopeKey = JSON.stringify([
			TEST_SCOPE.tenantId,
			TEST_SCOPE.userId,
			TEST_SCOPE.projectId,
			TEST_SCOPE.agentRole,
		]);
		const embedding = await embedFn("verified release procedure");
		for (const entry of [
			{ id: "duplicate-low", confidence: 0.7 },
			{ id: "duplicate-high", confidence: 0.95 },
		]) {
			await db.run(
				`INSERT INTO learning_insights (id, experience_id, type, keywords, content, confidence, importance, embedding, use_count, created_at, scope_key, scope_tenant_id, scope_user_id, scope_project_id, scope_agent_role)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					entry.id,
					"experience-a",
					"procedure",
					JSON.stringify(["release", "verified"]),
					`Verified release procedure ${entry.id}`,
					entry.confidence,
					0.8,
					JSON.stringify(embedding),
					0,
					new Date().toISOString(),
					scopeKey,
					TEST_SCOPE.tenantId,
					TEST_SCOPE.userId,
					TEST_SCOPE.projectId,
					TEST_SCOPE.agentRole,
				],
			);
			await ltm.store({
				id: `learn_${entry.id}`,
				type: "procedural",
				content: `Verified release procedure ${entry.id}`,
				embedding,
				importance: 0.8,
				accessCount: 0,
				lastAccessed: new Date(),
				createdAt: new Date(),
				associations: [],
				source: { taskId: "experience-a" },
				metadata: { status: "active", source: "learning_engine" },
			});
		}

		expect(await engine.consolidateInsights(SCOPED_ACCESS)).toBe(1);
		expect(await ltm.getById("learn_duplicate-low")).toBeUndefined();
		expect(await ltm.getById("learn_duplicate-high")).toBeDefined();
		expect(
			await db.get("SELECT id FROM learning_insights WHERE id = ?", [
				"duplicate-low",
			]),
		).toBeUndefined();
		expect(await engine.consolidateInsights(SCOPED_ACCESS)).toBe(0);
	});

	it("reuses scoped learning across sessions without exposing legacy rows", async () => {
		const engine = await createEngine();
		await engine.recordExperience({
			scope: { ...TEST_SCOPE, sessionId: "session-a", taskId: "task-a" },
			userRequest: "Build a release checklist",
			finalResponse:
				"Completed successfully by validating tests, artifacts, and release notes.",
			confidence: 0.9,
		});
		await db?.run(
			`INSERT INTO learning_insights (id, experience_id, type, keywords, content, confidence, importance, embedding, use_count, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"legacy-insight",
				"legacy-experience",
				"procedure",
				JSON.stringify(["release", "checklist"]),
				"Legacy unscoped guidance must remain quarantined",
				0.99,
				0.99,
				JSON.stringify(await embedFn("release checklist legacy")),
				0,
				new Date().toISOString(),
			],
		);

		const relevant = await engine.retrieveRelevant("release checklist", {
			...TEST_SCOPE,
			sessionId: "session-b",
			taskId: "task-b",
		});
		expect(relevant.length).toBeGreaterThan(0);
		expect(relevant.some((item) => item.id === "legacy-insight")).toBe(false);
	});

	it("rejects incomplete learning scopes", async () => {
		const engine = await createEngine();
		await expect(
			engine.recordExperience({
				scope: { ...TEST_SCOPE, userId: "" },
				userRequest: "Unsafe unscoped experience",
				finalResponse: "This must not be persisted.",
			}),
		).rejects.toThrow(/Invalid learning scope/);
	});

	it("prioritizes deterministic outcome checks over completion wording", async () => {
		const engine = await createEngine();
		const failed = await engine.recordExperience({
			scope: TEST_SCOPE,
			userRequest: "Build the project",
			finalResponse: "Completed successfully and everything is done.",
			outcome: {
				verified: true,
				checks: [{ name: "build", passed: false, evidence: "exit code 1" }],
			},
		});
		const succeeded = await engine.recordExperience({
			scope: TEST_SCOPE,
			userRequest: "Validate the artifact",
			finalResponse: "No completion marker is present here.",
			outcome: {
				verified: true,
				checks: [
					{ name: "file_exists", passed: true },
					{ name: "checksum", passed: true },
				],
			},
		});
		expect(failed.status).toBe("failed");
		expect(failed.confidence).toBe(0.9);
		expect(succeeded.status).toBe("succeeded");
		expect(succeeded.confidence).toBe(0.95);
		expect(succeeded.metadata.assessmentReasons).toContain("verified_outcome");
	});

	it("records feedback against the latest conversation experience", async () => {
		const engine = await createEngine();
		const experience = await engine.recordExperience({
			scope: TEST_SCOPE,
			conversationId: "conv-1",
			userRequest: "Summarize this",
			finalResponse: "Completed successfully with a concise summary.",
		});

		await engine.addFeedback(SCOPED_ACCESS, {
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
		const insights = await engine.listInsights(SCOPED_ACCESS, { limit: 10 });
		expect(insights.some((insight) => insight.type === "what_failed")).toBe(
			true,
		);
		expect(insights.map((insight) => insight.content).join("\n")).toContain(
			"Wrong focus",
		);
		expect(
			insights.some((insight) =>
				["procedure", "tool_strategy", "what_worked"].includes(insight.type),
			),
		).toBe(false);
		const allInsights = await engine.listInsights(SCOPED_ACCESS, {
			limit: 20,
			includeInvalidated: true,
		});
		expect(
			allInsights.some(
				(insight) => insight.invalidatedAt && insight.invalidatedByExperienceId === experience.id,
			),
		).toBe(true);
	});

	it("removes invalidated procedural mirrors after negative feedback", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const store = new SqliteVectorStore(db);
		await store.initialize();
		const ltm = new LongTermMemory(store, db);
		const engine = new LearningEngine(db, embedFn, {
			ltm,
			config: { autoReflect: false },
		});
		await engine.initialize();
		const experience = await engine.recordExperience({
			scope: TEST_SCOPE,
			userRequest: "Deploy service using the release pipeline",
			finalResponse:
				"Completed successfully by running the release pipeline and health checks.",
			confidence: 0.95,
		});
		const before = await engine.listInsights(SCOPED_ACCESS, { limit: 30 });
		const positive = before.filter((insight) =>
			["procedure", "tool_strategy", "what_worked"].includes(insight.type),
		);
		expect(positive.length).toBeGreaterThan(0);
		expect(await ltm.getById(`learn_${positive[0]?.id}`)).toBeDefined();

		await engine.addFeedback(SCOPED_ACCESS, {
			experienceId: experience.id,
			rating: "negative",
			comment: "The deployment health check was stale",
		});
		const active = await engine.listInsights(SCOPED_ACCESS, { limit: 30 });
		expect(active.some((insight) => insight.type === "what_failed")).toBe(true);
		for (const insight of positive) {
			expect(active.some((candidate) => candidate.id === insight.id)).toBe(false);
			expect(await ltm.getById(`learn_${insight.id}`)).toBeUndefined();
		}
		const relevant = await engine.retrieveRelevant(
			"release pipeline deployment",
			TEST_SCOPE,
		);
		expect(relevant.some((insight) => positive.some((old) => old.id === insight.id))).toBe(
			false,
		);
	});

	it("keeps reinforced insights until every supporting experience is refuted", async () => {
		const engine = await createEngine();
		const input = {
			scope: TEST_SCOPE,
			userRequest: "Publish release with verified checklist",
			finalResponse:
				"Completed successfully using tests, artifact checks, and release verification.",
			confidence: 0.95,
		};
		const first = await engine.recordExperience(input);
		const second = await engine.recordExperience(input);
		const procedure = (
			await engine.listInsights(SCOPED_ACCESS, {
				limit: 30,
				type: "procedure",
			})
		)[0];
		expect(procedure).toBeDefined();
		expect(
			(
				await db?.get<{ count: number }>(
					"SELECT COUNT(*) AS count FROM learning_insight_evidence WHERE insight_id = ? AND relation = 'supports'",
					[procedure?.id],
				)
			)?.count,
		).toBe(2);

		await engine.addFeedback(SCOPED_ACCESS, {
			experienceId: first.id,
			rating: "negative",
		});
		expect(
			(await engine.listInsights(SCOPED_ACCESS, { limit: 30 })).some(
				(insight) => insight.id === procedure?.id,
			),
		).toBe(true);
		await engine.addFeedback(SCOPED_ACCESS, {
			experienceId: second.id,
			rating: "negative",
		});
		expect(
			(await engine.listInsights(SCOPED_ACCESS, { limit: 30 })).some(
				(insight) => insight.id === procedure?.id,
			),
		).toBe(false);
	});

	it("turns positive feedback into reusable what-worked guidance", async () => {
		const engine = await createEngine();
		const experience = await engine.recordExperience({
			scope: TEST_SCOPE,
			userRequest: "Configure a GitHub MCP server",
			finalResponse:
				"Completed successfully by using the catalog preset and replacing token placeholders with environment variables.",
			confidence: 0.8,
		});

		await engine.addFeedback(SCOPED_ACCESS, {
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
		const insights = await engine.listInsights(SCOPED_ACCESS, { limit: 10 });
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
			scope: TEST_SCOPE,
			userRequest: "Configure GitHub MCP integration safely",
			finalResponse: "Failed because credentials were missing.",
			status: "failed",
			confidence: 0.8,
			skillsUsed: [{ id: "skill-1", name: "test-skill" }],
		});
		await engine.addFeedback(SCOPED_ACCESS, {
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
			scope: TEST_SCOPE,
			userRequest: "Create a wedding website with generated images",
			finalResponse:
				"He completado la web. Nota: un request fallo con Codex backend error (400): string_above_max_length (string too long). Listo.",
			status: "partial",
			confidence: 0.85,
			toolsUsed: [{ name: "codex_generate_image", success: true }],
		});

		const insights = await engine.listInsights(SCOPED_ACCESS, { limit: 30 });
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
			scope: TEST_SCOPE,
			userRequest: "Create a wedding website with generated images",
			finalResponse:
				"Completed but a request failed: Codex backend error (400) string_above_max_length string too long.",
			status: "partial",
			confidence: 0.85,
		});

		const relevant = await engine.retrieveRelevant(
			"wedding website images",
			TEST_SCOPE,
		);
		// The captured anti_pattern (conf >= 0.8) must be promoted into the
		// results instead of being crowded out by general insights.
		expect(
			relevant.some((i) => i.type === "anti_pattern" && i.confidence >= 0.8),
		).toBe(true);
	});

	it("reinforces an existing near-duplicate lesson instead of duplicating it", async () => {
		const engine = await createEngine();
		const base = {
			scope: TEST_SCOPE,
			userRequest: "Extract product images from Etsy page",
			finalResponse:
				"Completed successfully using browser_extract_images to get the image URLs.",
			confidence: 0.9,
			toolsUsed: [{ name: "browser_extract_images", success: true }],
		};
		await engine.recordExperience(base);
		const beforeProcedures = (
			await engine.listInsights(SCOPED_ACCESS, {
				limit: 50,
				type: "procedure",
			})
		).length;

		// Same lesson again — should reinforce the existing one, not add a copy.
		await engine.recordExperience(base);
		const afterProcedures = (
			await engine.listInsights(SCOPED_ACCESS, {
				limit: 50,
				type: "procedure",
			})
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
		const removed = await engine.consolidateInsights(ADMIN_ACCESS);
		expect(removed).toBe(1);
		const remaining = await engine.listInsights(ADMIN_ACCESS, {
			limit: 50,
			type: "procedure",
		});
		expect(
			remaining.filter((i) => i.content.startsWith("Extract Etsy images")),
		).toHaveLength(1);
		expect(remaining[0]?.confidence).toBeGreaterThanOrEqual(0.9);
	});
});
