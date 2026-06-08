import { nanoid } from "nanoid";
import type { LLMRouter } from "../ai/router.js";
import type { LongTermMemory } from "../memory/ltm.js";
import type { EmbeddingFunction, MemoryItem } from "../memory/types.js";
import type { SkillForge } from "../skills/forge.js";
import type { SkillImprover } from "../skills/improver.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { SkillUsage } from "../skills/types.js";
import type { DatabaseAdapter } from "../storage/database.js";
import type {
	ExperienceRecord,
	ExperienceRecordInput,
	ExperienceStatus,
	LearningEngineConfig,
	LearningFeedbackInput,
	LearningInsight,
	LearningInsightType,
} from "./types.js";

const DEFAULT_CONFIG: LearningEngineConfig = {
	enabled: true,
	autoReflect: true,
	minConfidenceToStore: 0.65,
	minConfidenceToInject: 0.55,
	maxInsightsPerContext: 5,
	maxContextTokens: 1000,
	autoCreateSkills: true,
	minSimilarSuccessesForSkill: 3,
	retainFailedInsights: true,
};

type ExperienceRow = {
	id: string;
	conversation_id: string | null;
	task_id: string | null;
	agent_id: string | null;
	channel_id: string | null;
	user_request: string;
	final_response: string;
	status: ExperienceStatus;
	confidence: number;
	tools_used: string;
	skills_used: string;
	duration_ms: number | null;
	metadata: string;
	created_at: string;
};

type InsightRow = {
	id: string;
	experience_id: string;
	type: LearningInsightType;
	domain: string | null;
	keywords: string;
	content: string;
	evidence: string | null;
	confidence: number;
	importance: number;
	embedding: string;
	use_count: number;
	last_used_at: string | null;
	created_at: string;
};

export class LearningEngine {
	private config: LearningEngineConfig;

	constructor(
		private db: DatabaseAdapter,
		private embedFn: EmbeddingFunction,
		private options: {
			ltm?: LongTermMemory;
			router?: LLMRouter;
			skillRegistry?: SkillRegistry;
			skillForge?: SkillForge;
			skillImprover?: SkillImprover;
			config?: Partial<LearningEngineConfig>;
		} = {},
	) {
		this.config = { ...DEFAULT_CONFIG, ...options.config };
	}

	updateConfig(config: Partial<LearningEngineConfig>): void {
		this.config = { ...this.config, ...config };
	}

	isEnabled(): boolean {
		return this.config.enabled;
	}

	async initialize(): Promise<void> {
		await this.ensureTables();
	}

	async recordExperience(
		input: ExperienceRecordInput,
	): Promise<ExperienceRecord> {
		await this.ensureTables();
		const assessed = this.assessExperience(input);
		const experience: ExperienceRecord = {
			id: nanoid(),
			conversationId: input.conversationId,
			taskId: input.taskId,
			agentId: input.agentId,
			channelId: input.channelId,
			userRequest: input.userRequest,
			finalResponse: input.finalResponse,
			status: input.status ?? assessed.status,
			confidence: input.confidence ?? assessed.confidence,
			toolsUsed: input.toolsUsed ?? [],
			skillsUsed: input.skillsUsed ?? [],
			durationMs: input.durationMs,
			metadata: { ...input.metadata, assessmentReasons: assessed.reasons },
			createdAt: new Date(),
		};

		if (!this.config.enabled) return experience;

		await this.db.run(
			`INSERT INTO experiences (id, conversation_id, task_id, agent_id, channel_id, user_request, final_response, status, confidence, tools_used, skills_used, duration_ms, metadata, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				experience.id,
				experience.conversationId ?? null,
				experience.taskId ?? null,
				experience.agentId ?? null,
				experience.channelId ?? null,
				experience.userRequest,
				experience.finalResponse,
				experience.status,
				experience.confidence,
				JSON.stringify(experience.toolsUsed),
				JSON.stringify(experience.skillsUsed),
				experience.durationMs ?? null,
				JSON.stringify(experience.metadata),
				experience.createdAt.toISOString(),
			],
		);

		const insights = await this.extractInsights(experience);
		for (const insight of insights) await this.storeInsight(insight);
		await this.recordSkillUsage(experience);
		await this.maybeCreateSkill(experience, insights);
		return experience;
	}

	async recordUserCorrection(input: {
		content: string;
		conversationId?: string;
		channelId?: string;
		agentId?: string;
	}): Promise<void> {
		if (!this.config.enabled) return;
		await this.ensureTables();
		const content = input.content.trim();
		if (!content) return;

		const experience: ExperienceRecord = {
			id: nanoid(),
			conversationId: input.conversationId,
			agentId: input.agentId,
			channelId: input.channelId,
			userRequest: content,
			finalResponse: `Explicit user procedural correction: ${content}`,
			status: "succeeded",
			confidence: 0.98,
			toolsUsed: [],
			skillsUsed: [],
			metadata: { source: "explicit_user_correction" },
			createdAt: new Date(),
		};

		await this.db.run(
			`INSERT INTO experiences (id, conversation_id, task_id, agent_id, channel_id, user_request, final_response, status, confidence, tools_used, skills_used, duration_ms, metadata, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				experience.id,
				experience.conversationId ?? null,
				null,
				experience.agentId ?? null,
				experience.channelId ?? null,
				experience.userRequest,
				experience.finalResponse,
				experience.status,
				experience.confidence,
				JSON.stringify([]),
				JSON.stringify([]),
				null,
				JSON.stringify(experience.metadata),
				experience.createdAt.toISOString(),
			],
		);

		const keywords = this.extractKeywords(content);
		const insight: LearningInsight = {
			id: nanoid(),
			experienceId: experience.id,
			type: "procedure",
			domain: this.detectDomain(keywords, content),
			keywords,
			content: `User explicit operational correction: ${content}`,
			evidence: content.slice(0, 500),
			confidence: 0.98,
			importance: 0.98,
			embedding: await this.embedFn(
				`explicit correction ${keywords.join(" ")} ${content}`,
			),
			useCount: 0,
			createdAt: new Date(),
		};
		await this.storeInsight(insight);
	}

	async retrieveRelevant(query: string): Promise<LearningInsight[]> {
		if (!this.config.enabled) return [];
		await this.ensureTables();
		const queryEmbedding = await this.embedFn(query);
		const queryKeywords = new Set(this.extractKeywords(query));
		const rows = await this.db.all<InsightRow>(
			"SELECT * FROM learning_insights WHERE confidence >= ? ORDER BY importance DESC, created_at DESC LIMIT 200",
			[this.config.minConfidenceToInject],
		);
		const scored = rows.map((row) => {
			const insight = this.deserializeInsight(row);
			const similarity = this.cosineSimilarity(
				queryEmbedding,
				insight.embedding,
			);
			const keywordOverlap = insight.keywords.filter((k) =>
				queryKeywords.has(k),
			).length;
			const keywordScore =
				insight.keywords.length > 0
					? keywordOverlap / insight.keywords.length
					: 0;
			const score =
				similarity * 0.5 +
				keywordScore * 0.25 +
				insight.confidence * 0.15 +
				insight.importance * 0.1;
			return { insight, score };
		});

		scored.sort((a, b) => b.score - a.score);
		const selected: LearningInsight[] = [];
		let tokens = 0;
		for (const item of scored) {
			if (selected.length >= this.config.maxInsightsPerContext) break;
			if (item.score < 0.3) continue;
			const nextTokens = Math.ceil(item.insight.content.length / 4);
			if (tokens + nextTokens > this.config.maxContextTokens) break;
			tokens += nextTokens;
			selected.push(item.insight);
		}

		if (selected.length > 0)
			await this.markInsightsUsed(selected.map((i) => i.id));
		return selected;
	}

	async listInsights(
		options: { limit?: number; type?: LearningInsightType } = {},
	): Promise<LearningInsight[]> {
		await this.ensureTables();
		const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
		const rows = options.type
			? await this.db.all<InsightRow>(
					"SELECT * FROM learning_insights WHERE type = ? ORDER BY created_at DESC LIMIT ?",
					[options.type, limit],
				)
			: await this.db.all<InsightRow>(
					"SELECT * FROM learning_insights ORDER BY created_at DESC LIMIT ?",
					[limit],
				);
		return rows.map((row) => this.deserializeInsight(row));
	}

	async listExperiences(
		options: { limit?: number; status?: ExperienceStatus } = {},
	): Promise<ExperienceRecord[]> {
		await this.ensureTables();
		const limit = Math.max(1, Math.min(options.limit ?? 30, 100));
		const rows = options.status
			? await this.db.all<ExperienceRow>(
					"SELECT * FROM experiences WHERE status = ? ORDER BY created_at DESC LIMIT ?",
					[options.status, limit],
				)
			: await this.db.all<ExperienceRow>(
					"SELECT * FROM experiences ORDER BY created_at DESC LIMIT ?",
					[limit],
				);
		return rows.map((row) => this.deserializeExperience(row));
	}

	async forgetInsight(id: string): Promise<boolean> {
		await this.ensureTables();
		const existing = await this.db.get<{ id: string }>(
			"SELECT id FROM learning_insights WHERE id = ?",
			[id],
		);
		if (!existing) return false;
		await this.db.run("DELETE FROM learning_insights WHERE id = ?", [id]);
		return true;
	}

	async addFeedback(feedback: LearningFeedbackInput): Promise<void> {
		await this.ensureTables();
		const target = feedback.experienceId
			? await this.db.get<ExperienceRow>(
					"SELECT * FROM experiences WHERE id = ?",
					[feedback.experienceId],
				)
			: feedback.conversationId
				? await this.db.get<ExperienceRow>(
						"SELECT * FROM experiences WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1",
						[feedback.conversationId],
					)
				: undefined;
		if (!target) return;
		const positive =
			typeof feedback.rating === "number"
				? feedback.rating > 0
				: feedback.rating === "positive";
		const metadata = this.safeJson<Record<string, unknown>>(
			target.metadata,
			{},
		);
		const feedbackItems = Array.isArray(metadata.feedback)
			? metadata.feedback
			: [];
		feedbackItems.push({
			rating: feedback.rating,
			comment: feedback.comment,
			at: new Date().toISOString(),
			messageId: feedback.messageId,
		});
		await this.db.run(
			"UPDATE experiences SET status = ?, confidence = ?, metadata = ? WHERE id = ?",
			[
				positive ? "succeeded" : "failed",
				positive
					? Math.max(target.confidence, 0.85)
					: Math.max(target.confidence, 0.75),
				JSON.stringify({ ...metadata, feedback: feedbackItems }),
				target.id,
			],
		);

		if (!this.config.enabled) return;
		const updatedExperience = this.deserializeExperience({
			...target,
			status: positive ? "succeeded" : "failed",
			confidence: positive
				? Math.max(target.confidence, 0.85)
				: Math.max(target.confidence, 0.75),
			metadata: JSON.stringify({ ...metadata, feedback: feedbackItems }),
		});
		const content = positive
			? `User confirmed this approach worked: ${this.compact(updatedExperience.finalResponse, 450)}`
			: `User marked this approach as failed${feedback.comment ? `: ${feedback.comment}` : ""}. Avoid repeating it without correction: ${this.compact(updatedExperience.finalResponse, 350)}`;
		const keywords = this.extractKeywords(
			`${updatedExperience.userRequest} ${feedback.comment ?? ""} ${updatedExperience.finalResponse}`,
		);
		const type: LearningInsightType = positive ? "what_worked" : "what_failed";
		const insight: LearningInsight = {
			id: nanoid(),
			experienceId: updatedExperience.id,
			type,
			domain: this.detectDomain(keywords, updatedExperience.userRequest),
			keywords,
			content,
			evidence:
				feedback.comment ?? this.compact(updatedExperience.userRequest, 300),
			confidence: positive ? 0.9 : 0.85,
			importance: positive ? 0.8 : 0.9,
			embedding: await this.embedFn(`${type} ${keywords.join(" ")} ${content}`),
			useCount: 0,
			createdAt: new Date(),
		};
		await this.storeInsight(insight);
		await this.recordSkillUsage(updatedExperience, feedback);
		if (positive) await this.maybeCreateSkill(updatedExperience, [insight]);
	}

	private async extractInsights(
		experience: ExperienceRecord,
	): Promise<LearningInsight[]> {
		if (!this.config.enabled) return [];
		if (experience.confidence < this.config.minConfidenceToStore) return [];
		if (experience.status === "failed" && !this.config.retainFailedInsights)
			return [];

		const local = await this.extractLocalInsights(experience);
		if (!this.config.autoReflect || !this.options.router) return local;

		try {
			const reflected = await this.extractLlmInsights(experience);
			return this.dedupeInsights([...local, ...reflected]);
		} catch {
			return local;
		}
	}

	private async extractLocalInsights(
		experience: ExperienceRecord,
	): Promise<LearningInsight[]> {
		const insights: Array<
			Omit<LearningInsight, "id" | "embedding" | "createdAt" | "useCount">
		> = [];
		const keywords = this.extractKeywords(
			`${experience.userRequest} ${experience.finalResponse}`,
		);
		const domain = this.detectDomain(keywords, experience.userRequest);
		const successfulTools = experience.toolsUsed.filter((tool) => tool.success);
		const failedTools = experience.toolsUsed.filter((tool) => !tool.success);

		if (experience.status === "succeeded") {
			const toolText =
				successfulTools.length > 0
					? ` Tools that produced progress: ${[...new Set(successfulTools.map((t) => t.name))].join(", ")}.`
					: "";
			insights.push({
				experienceId: experience.id,
				type: "procedure",
				domain,
				keywords,
				content: `For similar ${domain ?? "general"} requests, start from the approach that completed this task: ${this.compact(experience.finalResponse, 500)}${toolText}`,
				evidence: this.compact(experience.userRequest, 300),
				confidence: experience.confidence,
				importance: experience.status === "succeeded" ? 0.85 : 0.7,
				lastUsedAt: undefined,
			});
		}

		if (experience.status === "succeeded" && successfulTools.length > 0) {
			insights.push({
				experienceId: experience.id,
				type: "tool_strategy",
				domain,
				keywords,
				content: `Useful tool strategy for similar tasks: ${successfulTools
					.map(
						(t) =>
							`${t.name}${t.summary ? ` (${this.compact(t.summary, 120)})` : ""}`,
					)
					.slice(0, 5)
					.join(" -> ")}.`,
				evidence: this.compact(experience.userRequest, 300),
				confidence: Math.min(0.95, experience.confidence + 0.05),
				importance: 0.75,
				lastUsedAt: undefined,
			});
		}

		if (
			failedTools.length > 0 ||
			experience.status === "failed" ||
			experience.status === "partial"
		) {
			const repeatedFailures = [...new Set(failedTools.map((t) => t.name))];
			insights.push({
				experienceId: experience.id,
				type: experience.status === "failed" ? "what_failed" : "anti_pattern",
				domain,
				keywords,
				content: `Avoid this pattern in similar tasks: ${repeatedFailures.length > 0 ? `do not keep repeating failed tools (${repeatedFailures.join(", ")}) without new evidence` : "do not assume success when the result is partial"}. Verify progress before continuing.`,
				evidence: failedTools
					.map((t) => t.error || t.summary || t.name)
					.slice(0, 3)
					.join(" | "),
				confidence: Math.max(0.65, experience.confidence),
				importance: experience.status === "failed" ? 0.8 : 0.7,
				lastUsedAt: undefined,
			});
		}

		const result: LearningInsight[] = [];
		for (const insight of insights) {
			const embedding = await this.embedFn(
				`${insight.type} ${insight.domain ?? ""} ${insight.keywords.join(" ")} ${insight.content}`,
			);
			result.push({
				...insight,
				id: nanoid(),
				embedding,
				useCount: 0,
				createdAt: new Date(),
			});
		}
		return result;
	}

	private async extractLlmInsights(
		experience: ExperienceRecord,
	): Promise<LearningInsight[]> {
		if (!this.options.router) return [];
		const response = await this.options.router.chat({
			model: "default",
			temperature: 0.2,
			maxTokens: 1200,
			messages: [
				{
					role: "system",
					content:
						'Extract only specific reusable learnings from an assistant task. Respond valid JSON: {"insights":[{"type":"procedure|anti_pattern|tool_strategy|what_worked|what_failed|skill_candidate","content":"...","keywords":["..."],"domain":"...","confidence":0.0}]}. Do not include generic advice.',
				},
				{
					role: "user",
					content: `Request: ${experience.userRequest}\nStatus: ${experience.status}\nTools: ${JSON.stringify(experience.toolsUsed.slice(0, 8))}\nFinal response: ${this.compact(experience.finalResponse, 1200)}`,
				},
			],
		});

		const jsonMatch = response.content.match(/\{[\s\S]*\}/);
		if (!jsonMatch) return [];
		const parsed = JSON.parse(jsonMatch[0]) as {
			insights?: Array<Record<string, unknown>>;
		};
		const raw = Array.isArray(parsed.insights) ? parsed.insights : [];
		const result: LearningInsight[] = [];
		for (const item of raw.slice(0, 5)) {
			const content =
				typeof item.content === "string" ? item.content.trim() : "";
			if (content.length < 30) continue;
			const type = this.normalizeInsightType(item.type);
			const confidence = this.clamp(
				typeof item.confidence === "number"
					? item.confidence
					: experience.confidence,
			);
			if (confidence < this.config.minConfidenceToStore) continue;
			const keywords = Array.isArray(item.keywords)
				? item.keywords
						.filter((k): k is string => typeof k === "string")
						.slice(0, 12)
				: this.extractKeywords(content);
			const domain =
				typeof item.domain === "string"
					? item.domain
					: this.detectDomain(keywords, content);
			const embedding = await this.embedFn(
				`${type} ${domain ?? ""} ${keywords.join(" ")} ${content}`,
			);
			result.push({
				id: nanoid(),
				experienceId: experience.id,
				type,
				domain,
				keywords,
				content,
				evidence: this.compact(experience.userRequest, 300),
				confidence,
				importance: confidence,
				embedding,
				useCount: 0,
				createdAt: new Date(),
			});
		}
		return result;
	}

	private async storeInsight(insight: LearningInsight): Promise<void> {
		await this.db.run(
			`INSERT INTO learning_insights (id, experience_id, type, domain, keywords, content, evidence, confidence, importance, embedding, use_count, last_used_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				insight.id,
				insight.experienceId,
				insight.type,
				insight.domain ?? null,
				JSON.stringify(insight.keywords),
				insight.content,
				insight.evidence ?? null,
				insight.confidence,
				insight.importance,
				JSON.stringify(insight.embedding),
				insight.useCount,
				insight.lastUsedAt?.toISOString() ?? null,
				insight.createdAt.toISOString(),
			],
		);

		if (
			this.options.ltm &&
			insight.confidence >= Math.max(0.8, this.config.minConfidenceToStore) &&
			[
				"procedure",
				"anti_pattern",
				"tool_strategy",
				"what_worked",
				"what_failed",
			].includes(insight.type)
		) {
			const memory: MemoryItem = {
				id: `learn_${insight.id}`,
				type: "procedural",
				content: insight.content,
				embedding: insight.embedding,
				importance: insight.importance,
				accessCount: 0,
				lastAccessed: new Date(),
				createdAt: new Date(),
				associations: [],
				source: { taskId: insight.experienceId },
				metadata: {
					source: "learning_engine",
					insightId: insight.id,
					type: insight.type,
					confidence: insight.confidence,
				},
			};
			await this.options.ltm.store(memory).catch(() => {});
		}
	}

	private async recordSkillUsage(
		experience: ExperienceRecord,
		feedback?: LearningFeedbackInput,
	): Promise<void> {
		if (!this.options.skillRegistry || experience.skillsUsed.length === 0)
			return;
		const feedbackRating = feedback
			? typeof feedback.rating === "number"
				? String(feedback.rating)
				: feedback.rating === "positive"
					? "5"
					: "1"
			: undefined;
		for (const skill of experience.skillsUsed) {
			const usage: SkillUsage = {
				id: nanoid(),
				skillId: skill.id,
				task: experience.userRequest,
				success: experience.status === "succeeded",
				failureReason:
					experience.status === "failed"
						? (feedback?.comment ?? this.compact(experience.finalResponse, 300))
						: undefined,
				userFeedback: feedbackRating,
				successReason:
					experience.status === "succeeded"
						? (feedback?.comment ?? "Task completed with usable final response")
						: undefined,
				timestamp: experience.createdAt,
			};
			await this.options.skillRegistry.recordUsage(usage).catch(() => {});
			await this.options.skillRegistry.updateMetrics(skill.id).catch(() => {});
		}
		if (this.options.skillImprover) {
			const candidates = await this.options.skillRegistry
				.findSkillsNeedingImprovement()
				.catch(() => []);
			for (const skill of candidates.slice(0, 2)) {
				const history = await this.options.skillRegistry
					.getUsageHistory(skill.id, 50)
					.catch(() => []);
				if (history.length >= 3)
					await this.options.skillImprover
						.improveSkill(skill, history)
						.catch(() => {});
			}
		}
	}

	private async maybeCreateSkill(
		experience: ExperienceRecord,
		insights: LearningInsight[],
	): Promise<void> {
		if (!this.config.autoCreateSkills || !this.options.skillForge) return;
		if (experience.status !== "succeeded") return;
		if (
			!insights.some(
				(i) =>
					i.type === "procedure" ||
					i.type === "skill_candidate" ||
					i.type === "what_worked",
			)
		)
			return;
		const keywords = this.extractKeywords(experience.userRequest);
		if (keywords.length < 3) return;
		const like = `%${keywords[0] ?? ""}%`;
		const similar = await this.db
			.all<{ cnt: number }>(
				"SELECT COUNT(*) as cnt FROM experiences WHERE status = 'succeeded' AND user_request LIKE ?",
				[like],
			)
			.catch(() => [{ cnt: 0 }]);
		if ((similar[0]?.cnt ?? 0) < this.config.minSimilarSuccessesForSkill)
			return;

		const domain = this.detectDomain(keywords, experience.userRequest);
		await this.options.skillForge
			.createSkill(
				{
					description: experience.userRequest,
					complexity: 0.7,
					domains: domain ? [domain] : [],
					keywords,
				},
				{
					summary: this.compact(experience.finalResponse, 400),
					whatWorked: insights
						.filter(
							(i) => i.type !== "what_failed" && i.type !== "anti_pattern",
						)
						.map((i) => i.content)
						.join("\n"),
					whatCouldImprove: insights
						.filter(
							(i) => i.type === "what_failed" || i.type === "anti_pattern",
						)
						.map((i) => i.content)
						.join("\n"),
					patterns: insights.map((i) => i.content).slice(0, 5),
				},
			)
			.catch(() => {});
	}

	private assessExperience(input: ExperienceRecordInput): {
		status: ExperienceStatus;
		confidence: number;
		reasons: string[];
	} {
		const reasons: string[] = [];
		const final = input.finalResponse.toLowerCase();
		const tools = input.toolsUsed ?? [];
		const successfulTools = tools.filter((t) => t.success).length;
		const failedTools = tools.filter((t) => !t.success).length;
		let confidence = 0.55;
		let status: ExperienceStatus = "unknown";

		if (input.finalResponse.trim().length > 40) {
			confidence += 0.1;
			reasons.push("non_empty_final_response");
		}
		if (successfulTools > 0) {
			confidence += 0.1;
			reasons.push("successful_tools");
		}
		if (
			/completed successfully|finished successfully|he completado|completad[ao]|listo|done/i.test(
				input.finalResponse,
			)
		) {
			confidence += 0.1;
			status = "succeeded";
			reasons.push("completion_marker");
		}
		if (
			/error|failed|fall[oó]|bloque|captcha|limit|l[ií]mite/i.test(final) ||
			failedTools > successfulTools
		) {
			confidence += 0.05;
			status = successfulTools > 0 ? "partial" : "failed";
			reasons.push("failure_or_blocker_marker");
		}
		if (status === "unknown")
			status =
				failedTools > 0 && successfulTools === 0 ? "failed" : "succeeded";
		return { status, confidence: this.clamp(confidence), reasons };
	}

	private async markInsightsUsed(ids: string[]): Promise<void> {
		const now = new Date().toISOString();
		for (const id of ids) {
			await this.db
				.run(
					"UPDATE learning_insights SET use_count = use_count + 1, last_used_at = ? WHERE id = ?",
					[now, id],
				)
				.catch(() => {});
		}
	}

	private async ensureTables(): Promise<void> {
		await this.db.run(
			"CREATE TABLE IF NOT EXISTS experiences (id TEXT PRIMARY KEY, conversation_id TEXT, task_id TEXT, agent_id TEXT, channel_id TEXT, user_request TEXT NOT NULL, final_response TEXT NOT NULL, status TEXT NOT NULL, confidence REAL NOT NULL, tools_used TEXT NOT NULL, skills_used TEXT NOT NULL, duration_ms INTEGER, metadata TEXT NOT NULL, created_at TEXT NOT NULL)",
		);
		await this.db.run(
			"CREATE TABLE IF NOT EXISTS learning_insights (id TEXT PRIMARY KEY, experience_id TEXT NOT NULL, type TEXT NOT NULL, domain TEXT, keywords TEXT NOT NULL, content TEXT NOT NULL, evidence TEXT, confidence REAL NOT NULL, importance REAL NOT NULL, embedding TEXT NOT NULL, use_count INTEGER NOT NULL DEFAULT 0, last_used_at TEXT, created_at TEXT NOT NULL)",
		);
	}

	private deserializeInsight(row: InsightRow): LearningInsight {
		return {
			id: row.id,
			experienceId: row.experience_id,
			type: row.type,
			domain: row.domain ?? undefined,
			keywords: this.safeJson<string[]>(row.keywords, []),
			content: row.content,
			evidence: row.evidence ?? undefined,
			confidence: row.confidence,
			importance: row.importance,
			embedding: this.safeJson<number[]>(row.embedding, []),
			useCount: row.use_count,
			lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : undefined,
			createdAt: new Date(row.created_at),
		};
	}

	private deserializeExperience(row: ExperienceRow): ExperienceRecord {
		return {
			id: row.id,
			conversationId: row.conversation_id ?? undefined,
			taskId: row.task_id ?? undefined,
			agentId: row.agent_id ?? undefined,
			channelId: row.channel_id ?? undefined,
			userRequest: row.user_request,
			finalResponse: row.final_response,
			status: row.status,
			confidence: row.confidence,
			toolsUsed: this.safeJson(row.tools_used, []),
			skillsUsed: this.safeJson(row.skills_used, []),
			durationMs: row.duration_ms ?? undefined,
			metadata: this.safeJson<Record<string, unknown>>(row.metadata, {}),
			createdAt: new Date(row.created_at),
		};
	}

	private normalizeInsightType(value: unknown): LearningInsightType {
		const allowed: LearningInsightType[] = [
			"what_worked",
			"what_failed",
			"procedure",
			"anti_pattern",
			"tool_strategy",
			"skill_candidate",
		];
		return allowed.includes(value as LearningInsightType)
			? (value as LearningInsightType)
			: "procedure";
	}

	private dedupeInsights(insights: LearningInsight[]): LearningInsight[] {
		const seen = new Set<string>();
		const result: LearningInsight[] = [];
		for (const insight of insights) {
			const key = `${insight.type}:${insight.content.toLowerCase().slice(0, 120)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			result.push(insight);
		}
		return result;
	}

	private extractKeywords(text: string): string[] {
		const stop = new Set([
			"the",
			"and",
			"for",
			"with",
			"that",
			"this",
			"from",
			"para",
			"que",
			"con",
			"una",
			"unos",
			"las",
			"los",
			"del",
			"como",
			"por",
			"pero",
			"when",
			"what",
			"how",
			"hacer",
			"algo",
		]);
		return [
			...new Set(
				text
					.toLowerCase()
					.replace(/[^a-z0-9áéíóúñ\s-]/gi, " ")
					.split(/\s+/)
					.map((w) => w.trim())
					.filter((w) => w.length > 3 && !stop.has(w)),
			),
		].slice(0, 16);
	}

	private detectDomain(keywords: string[], text: string): string | undefined {
		const source = `${keywords.join(" ")} ${text}`.toLowerCase();
		if (
			/code|codigo|typescript|javascript|python|test|build|api|bug/.test(source)
		)
			return "coding";
		if (/browser|web|scrap|etsy|pagina|imagen|producto/.test(source))
			return "browser-automation";
		if (/document|write|redact|texto|resumen/.test(source)) return "writing";
		if (/research|investig|buscar|compare/.test(source)) return "research";
		return undefined;
	}

	private cosineSimilarity(a: number[], b: number[]): number {
		if (a.length !== b.length || a.length === 0) return 0;
		let dot = 0;
		let normA = 0;
		let normB = 0;
		for (let i = 0; i < a.length; i++) {
			dot += (a[i] ?? 0) * (b[i] ?? 0);
			normA += (a[i] ?? 0) ** 2;
			normB += (b[i] ?? 0) ** 2;
		}
		const denom = Math.sqrt(normA) * Math.sqrt(normB);
		return denom === 0 ? 0 : dot / denom;
	}

	private safeJson<T>(value: string, fallback: T): T {
		try {
			return JSON.parse(value) as T;
		} catch {
			return fallback;
		}
	}

	private compact(value: string, max: number): string {
		const normalized = value.replace(/\s+/g, " ").trim();
		return normalized.length > max
			? `${normalized.slice(0, max - 3).trimEnd()}...`
			: normalized;
	}

	private clamp(value: number): number {
		return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
	}
}
