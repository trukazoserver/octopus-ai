import { nanoid } from "nanoid";
import type { LLMRouter } from "../ai/router.js";
import type { LongTermMemory } from "../memory/ltm.js";
import type { EmbeddingFunction, MemoryItem } from "../memory/types.js";
import type { SkillForge } from "../skills/forge.js";
import type { SkillImprover } from "../skills/improver.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { SkillUsage } from "../skills/types.js";
import type { DatabaseAdapter } from "../storage/database.js";
import { createLogger } from "../utils/logger.js";
import type {
	ExperienceRecord,
	ExperienceRecordInput,
	ExperienceStatus,
	LearningAccess,
	LearningEngineConfig,
	LearningFeedbackInput,
	LearningInsight,
	LearningInsightType,
	LearningScope,
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

const LEGACY_SCOPE = "__learning_legacy_unscoped_v1__";
const logger = createLogger("learning-engine");

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
	scope_key: string;
	scope_tenant_id: string;
	scope_user_id: string;
	scope_project_id: string;
	scope_agent_role: string;
	scope_session_id: string | null;
	scope_task_id: string | null;
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
	scope_key: string;
	scope_tenant_id: string;
	scope_user_id: string;
	scope_project_id: string;
	scope_agent_role: string;
	scope_session_id: string | null;
	scope_task_id: string | null;
	invalidated_at: string | null;
	invalidation_reason: string | null;
	invalidated_by_experience_id: string | null;
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

	private consolidateCounter = 0;
	/**
	 * recordExperience is dispatched fire-and-forget by the runtime
	 * (recordLearningExperience). Without draining, shutdown() closes the
	 * database while a write is still in flight and the write later throws
	 * "SQLite is not initialized". Every invocation is tracked here and drained
	 * by flush() before the storage layer closes.
	 */
	private readonly pendingExperienceWrites = new Set<Promise<unknown>>();

	recordExperience(input: ExperienceRecordInput): Promise<ExperienceRecord> {
		const work = this.doRecordExperience(input);
		this.pendingExperienceWrites.add(work);
		// Drop from the pending set once settled. Use then(onFulfilled, onRejected)
		// rather than a bare .finally(): a detached .finally() on a rejected work
		// promise re-emits the rejection as an unhandled one. The caller remains
		// responsible for handling `work` itself.
		const cleanup = (): void => {
			this.pendingExperienceWrites.delete(work);
		};
		work.then(cleanup, cleanup);
		return work;
	}

	/**
	 * Wait for in-flight recordExperience writes to settle, bounded by timeoutMs
	 * so shutdown can never hang on a stuck learning write. Call before closing
	 * the database.
	 */
	async flush(timeoutMs = 10_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (this.pendingExperienceWrites.size > 0) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) return;
			const snapshot = [...this.pendingExperienceWrites];
			await Promise.race([
				Promise.allSettled(snapshot),
				new Promise<void>((resolve) => setTimeout(resolve, remaining)),
			]);
		}
	}

	private async doRecordExperience(
		input: ExperienceRecordInput,
	): Promise<ExperienceRecord> {
		await this.ensureTables();
		const scope = this.normalizeScope(input.scope);
		const assessed = this.assessExperience(input);
		const experience: ExperienceRecord = {
			id: nanoid(),
			scope,
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
			`INSERT INTO experiences (id, conversation_id, task_id, agent_id, channel_id, user_request, final_response, status, confidence, tools_used, skills_used, duration_ms, metadata, created_at, scope_key, scope_tenant_id, scope_user_id, scope_project_id, scope_agent_role, scope_session_id, scope_task_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
				this.scopeKey(scope),
				scope.tenantId,
				scope.userId,
				scope.projectId,
				scope.agentRole,
				scope.sessionId ?? null,
				scope.taskId ?? null,
			],
		);

		const insights = await this.extractInsights(experience);
		for (const insight of insights) await this.storeInsight(insight);
		await this.recordSkillUsage(experience);
		await this.maybeCreateSkill(experience, insights);
		// Periodically consolidate the insight store (dedupe near-duplicates)
		// so semantic retrieval stays high-signal as the store grows.
		this.consolidateCounter++;
		if (this.consolidateCounter % 25 === 0) {
			await this.consolidateInsights({ kind: "scoped", scope }).catch(() => {});
		}
		return experience;
	}

	async recordUserCorrection(input: {
		scope: LearningScope;
		content: string;
		conversationId?: string;
		channelId?: string;
		agentId?: string;
	}): Promise<void> {
		if (!this.config.enabled) return;
		await this.ensureTables();
		const content = input.content.trim();
		if (!content) return;
		const scope = this.normalizeScope(input.scope);

		const experience: ExperienceRecord = {
			id: nanoid(),
			scope,
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
			`INSERT INTO experiences (id, conversation_id, task_id, agent_id, channel_id, user_request, final_response, status, confidence, tools_used, skills_used, duration_ms, metadata, created_at, scope_key, scope_tenant_id, scope_user_id, scope_project_id, scope_agent_role, scope_session_id, scope_task_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
				this.scopeKey(scope),
				scope.tenantId,
				scope.userId,
				scope.projectId,
				scope.agentRole,
				scope.sessionId ?? null,
				scope.taskId ?? null,
			],
		);

		const keywords = this.extractKeywords(content);
		const insight: LearningInsight = {
			id: nanoid(),
			scope,
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

	async retrieveRelevant(
		query: string,
		scopeInput: LearningScope,
	): Promise<LearningInsight[]> {
		if (!this.config.enabled) return [];
		await this.ensureTables();
		const scope = this.normalizeScope(scopeInput);
		const scopeKey = this.scopeKey(scope);
		const queryEmbedding = await this.embedFn(query);
		const queryKeywords = new Set(this.extractKeywords(query));
		const rows = await this.db.all<InsightRow>(
			"SELECT * FROM learning_insights WHERE scope_key = ? AND invalidated_at IS NULL AND confidence >= ? ORDER BY importance DESC, created_at DESC LIMIT 200",
			[scopeKey, this.config.minConfidenceToInject],
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

		// Critical failure lessons (anti_pattern / what_failed) are promoted so
		// the agent does NOT repeat a costly past mistake, even when they'd
		// otherwise lose the general-insight cap race. This is the fix for "the
		// agent learned the lesson but still repeated it": the captured mistake
		// is guaranteed a slot when it is relevant, instead of being crowded out
		// by noisier lower-value insights.
		const CRITICAL_CONFIDENCE = 0.8;
		const CRITICAL_RELEVANCE = 0.3;
		const MAX_CRITICAL = 3;
		const totalCap = this.config.maxInsightsPerContext + MAX_CRITICAL;
		const selected: LearningInsight[] = [];
		const seenIds = new Set<string>();
		let tokens = 0;
		const isCriticalFailure = (item: { insight: LearningInsight }) =>
			(item.insight.type === "anti_pattern" ||
				item.insight.type === "what_failed") &&
			item.insight.confidence >= CRITICAL_CONFIDENCE;

		// Phase 1 — always include relevant high-confidence failure lessons.
		let criticalAdded = 0;
		for (const item of scored) {
			if (criticalAdded >= MAX_CRITICAL) break;
			if (!isCriticalFailure(item) || item.score < CRITICAL_RELEVANCE) continue;
			if (seenIds.has(item.insight.id)) continue;
			const nextTokens = Math.ceil(item.insight.content.length / 4);
			if (tokens + nextTokens > this.config.maxContextTokens) continue;
			tokens += nextTokens;
			selected.push(item.insight);
			seenIds.add(item.insight.id);
			criticalAdded++;
		}

		// Phase 2 — fill the remaining slots with the top general insights.
		for (const item of scored) {
			if (selected.length >= totalCap) break;
			if (seenIds.has(item.insight.id)) continue;
			if (item.score < 0.3) break;
			const nextTokens = Math.ceil(item.insight.content.length / 4);
			if (tokens + nextTokens > this.config.maxContextTokens) break;
			tokens += nextTokens;
			selected.push(item.insight);
			seenIds.add(item.insight.id);
		}

		if (selected.length > 0)
			await this.markInsightsUsed(
				selected.map((i) => i.id),
				scopeKey,
			);
		return selected;
	}

	async listInsights(
		access: LearningAccess,
		options: {
			limit?: number;
			type?: LearningInsightType;
			includeInvalidated?: boolean;
		} = {},
	): Promise<LearningInsight[]> {
		await this.ensureTables();
		const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
		const scopeKey = this.scopeKeyForAccess(access);
		const clauses: string[] = [];
		const params: unknown[] = [];
		if (scopeKey) {
			clauses.push("scope_key = ?");
			params.push(scopeKey);
		}
		if (options.type) {
			clauses.push("type = ?");
			params.push(options.type);
		}
		if (!options.includeInvalidated) clauses.push("invalidated_at IS NULL");
		params.push(limit);
		const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
		const rows = await this.db.all<InsightRow>(
			`SELECT * FROM learning_insights${where} ORDER BY created_at DESC LIMIT ?`,
			params,
		);
		return rows.map((row) => this.deserializeInsight(row));
	}

	async listExperiences(
		access: LearningAccess,
		options: { limit?: number; status?: ExperienceStatus } = {},
	): Promise<ExperienceRecord[]> {
		await this.ensureTables();
		const limit = Math.max(1, Math.min(options.limit ?? 30, 100));
		const scopeKey = this.scopeKeyForAccess(access);
		const clauses: string[] = [];
		const params: unknown[] = [];
		if (scopeKey) {
			clauses.push("scope_key = ?");
			params.push(scopeKey);
		}
		if (options.status) {
			clauses.push("status = ?");
			params.push(options.status);
		}
		params.push(limit);
		const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
		const rows = await this.db.all<ExperienceRow>(
			`SELECT * FROM experiences${where} ORDER BY created_at DESC LIMIT ?`,
			params,
		);
		return rows.map((row) => this.deserializeExperience(row));
	}

	async forgetInsight(access: LearningAccess, id: string): Promise<boolean> {
		await this.ensureTables();
		const scopeKey = this.scopeKeyForAccess(access);
		const existing = await this.db.get<{ id: string; scope_key: string }>(
			`SELECT id, scope_key FROM learning_insights WHERE id = ?${scopeKey ? " AND scope_key = ?" : ""}`,
			scopeKey ? [id, scopeKey] : [id],
		);
		if (!existing) return false;
		return this.deleteInsightWithMirror(existing.id, existing.scope_key);
	}

	/**
	 * Consolidate the insight store: merge exact-keyset duplicates (same type +
	 * identical keyword set) into a single highest-confidence entry. Cheap O(n)
	 * scan, safe (only merges true duplicates), keeps retrieval high-signal as
	 * the store grows. Returns how many redundant rows were removed.
	 */
	async consolidateInsights(access: LearningAccess): Promise<number> {
		await this.ensureTables();
		const scopeKey = this.scopeKeyForAccess(access);
		const rows = await this.db
			.all<{
				id: string;
				scope_key: string;
				type: string;
				keywords: string;
				confidence: number;
				importance: number;
			}>(
				`SELECT id, scope_key, type, keywords, confidence, importance FROM learning_insights${scopeKey ? " WHERE scope_key = ? AND invalidated_at IS NULL" : " WHERE invalidated_at IS NULL"}`,
				scopeKey ? [scopeKey] : [],
			);
		const bySig = new Map<
			string,
			Array<{
				id: string;
				scope_key: string;
				confidence: number;
				importance: number;
			}>
		>();
		for (const r of rows) {
			let kw: string[] = [];
			try {
				kw = JSON.parse(r.keywords) as string[];
			} catch {
				continue;
			}
			const sig = `${r.scope_key}|${r.type}|${[...new Set(kw)].sort().join(",")}`;
			const arr = bySig.get(sig) ?? [];
			arr.push(r);
			bySig.set(sig, arr);
		}
		let removed = 0;
		for (const arr of bySig.values()) {
			if (arr.length < 2) continue;
			arr.sort(
				(a, b) => b.confidence * b.importance - a.confidence * a.importance,
			);
			for (const r of arr.slice(1)) {
				try {
					if (await this.deleteInsightWithMirror(r.id, r.scope_key)) removed++;
				} catch (error) {
					logger.warn(
						`Failed to consolidate learning insight ${r.id}: ${String(error)}`,
					);
				}
			}
		}
		return removed;
	}

	async addFeedback(
		access: LearningAccess,
		feedback: LearningFeedbackInput,
	): Promise<boolean> {
		await this.ensureTables();
		const scopeKey = this.scopeKeyForAccess(access);
		const target = feedback.experienceId
			? await this.db.get<ExperienceRow>(
					`SELECT * FROM experiences WHERE id = ?${scopeKey ? " AND scope_key = ?" : ""}`,
					scopeKey
						? [feedback.experienceId, scopeKey]
						: [feedback.experienceId],
				)
			: feedback.conversationId
				? await this.db.get<ExperienceRow>(
						`SELECT * FROM experiences WHERE conversation_id = ?${scopeKey ? " AND scope_key = ?" : ""} ORDER BY created_at DESC LIMIT 1`,
						scopeKey
							? [feedback.conversationId, scopeKey]
							: [feedback.conversationId],
					)
				: undefined;
		if (!target) return false;
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
			"UPDATE experiences SET status = ?, confidence = ?, metadata = ? WHERE id = ? AND scope_key = ?",
			[
				positive ? "succeeded" : "failed",
				positive
					? Math.max(target.confidence, 0.85)
					: Math.max(target.confidence, 0.75),
				JSON.stringify({ ...metadata, feedback: feedbackItems }),
				target.id,
				target.scope_key,
			],
		);

		if (!this.config.enabled || target.scope_key === LEGACY_SCOPE) return true;
		const updatedExperience = this.deserializeExperience({
			...target,
			status: positive ? "succeeded" : "failed",
			confidence: positive
				? Math.max(target.confidence, 0.85)
				: Math.max(target.confidence, 0.75),
			metadata: JSON.stringify({ ...metadata, feedback: feedbackItems }),
		});
		if (!positive) {
			await this.invalidateInsightsForExperience(
				updatedExperience.id,
				target.scope_key,
				feedback.comment ?? "negative_user_feedback",
			);
		}
		const content = positive
			? `User confirmed this approach worked: ${this.compact(updatedExperience.finalResponse, 450)}`
			: `User marked this approach as failed${feedback.comment ? `: ${feedback.comment}` : ""}. Avoid repeating it without correction: ${this.compact(updatedExperience.finalResponse, 350)}`;
		const keywords = this.extractKeywords(
			`${updatedExperience.userRequest} ${feedback.comment ?? ""} ${updatedExperience.finalResponse}`,
		);
		const type: LearningInsightType = positive ? "what_worked" : "what_failed";
		const insight: LearningInsight = {
			id: nanoid(),
			scope: updatedExperience.scope,
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
		return true;
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
			Omit<
				LearningInsight,
				"id" | "scope" | "embedding" | "createdAt" | "useCount"
			>
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

		// Capture the ROOT CAUSE of failures that retries/fallback masked as
		// "partial"/"succeeded" — e.g. a 400 string_above_max_length from
		// embedding base64, a 429, a timeout, an auth drop. Without this the
		// lesson never gets a strong, specific anti_pattern, so the agent
		// repeats the same mistake. Confidence 0.9 makes it a promoted
		// critical failure in retrieveRelevant.
		const masked = this.detectMaskedFailure(experience);
		if (masked) {
			insights.push({
				experienceId: experience.id,
				type: "anti_pattern",
				domain,
				keywords,
				content: `Past failure to avoid repeating in similar tasks: ${masked.excerpt}`,
				evidence: `markers: ${masked.markers.join(", ")}`,
				confidence: 0.9,
				importance: 0.9,
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
				scope: experience.scope,
				embedding,
				useCount: 0,
				createdAt: new Date(),
			});
		}
		return result;
	}

	/**
	 * Detect a failure that retries/fallback may have masked as a non-failure.
	 * Scans the final response + tool errors for concrete error signatures
	 * (10MB overflow, auth, rate-limit, timeout, network, empty-response,
	 * quota) and returns an excerpt of the root cause to turn into a strong
	 * anti_pattern insight.
	 */
	private detectMaskedFailure(
		experience: ExperienceRecord,
	): { excerpt: string; markers: string[] } | null {
		const toolErrors = experience.toolsUsed
			.map((t) => t.error || t.summary || "")
			.filter(Boolean)
			.join(" ");
		const text = `${experience.finalResponse}\n${toolErrors}`;
		const MARKERS: Array<[string, RegExp]> = [
			[
				"context_over_limit",
				/string_above_max_length|string too long|maximum length/i,
			],
			["auth", /\b40[13]\b|unauthorized|forbidden|invalid.?api.?key/i],
			[
				"rate_limit",
				/\b429\b|rate.?limit|too many requests|overload|code["']?\s*:\s*1305/i,
			],
			["timeout", /timed out|timeout|operation was aborted/i],
			[
				"network",
				/econnreset|econnrefused|fetch failed|socket hang up|network error/i,
			],
			[
				"empty_response",
				/empty response|closed before completion|stream error/i,
			],
			[
				"quota",
				/quota|insufficient|sin saldo|limit.{0,15}(exhaust|exceed|reach)/i,
			],
		];
		const markers: string[] = [];
		let firstRe: RegExp | undefined;
		for (const [label, re] of MARKERS) {
			if (re.test(text)) {
				markers.push(label);
				if (!firstRe) firstRe = re;
			}
		}
		if (markers.length === 0) return null;
		let excerpt = "";
		if (firstRe) {
			const m = firstRe.exec(text);
			if (m?.index != null) {
				const start = Math.max(0, m.index - 80);
				const end = Math.min(text.length, m.index + 120);
				excerpt = text.slice(start, end).replace(/\s+/g, " ").trim();
			}
		}
		if (!excerpt) excerpt = this.compact(text, 220);
		return { excerpt, markers };
	}

	/** Jaccard similarity between two keyword sets, in [0, 1]. */
	private jaccard(a: string[], b: string[]): number {
		const setA = new Set(a);
		const setB = new Set(b);
		if (setA.size === 0 || setB.size === 0) return 0;
		let inter = 0;
		for (const k of setA) if (setB.has(k)) inter++;
		return inter / (setA.size + setB.size - inter);
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
				scope: experience.scope,
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

	/**
	 * Reinforce an existing near-duplicate insight (same type + high keyword
	 * overlap) by raising its confidence/importance, instead of storing a new
	 * copy. Bounded to recent insights of the same type so it stays cheap on
	 * every experience. Returns true when it reinforced an existing insight.
	 */
	private async reinforceExisting(
		insight: LearningInsight,
	): Promise<string | undefined> {
		const scopeKey = this.scopeKey(this.normalizeScope(insight.scope));
		const rows = await this.db
			.all<{
				id: string;
				keywords: string;
				confidence: number;
				importance: number;
			}>(
				"SELECT id, keywords, confidence, importance FROM learning_insights WHERE scope_key = ? AND invalidated_at IS NULL AND type = ? ORDER BY created_at DESC LIMIT 60",
				[scopeKey, insight.type],
			)
			.catch(() => []);
		for (const row of rows) {
			let existingKw: string[] = [];
			try {
				existingKw = JSON.parse(row.keywords) as string[];
			} catch {
				continue;
			}
			if (this.jaccard(insight.keywords, existingKw) < 0.6) continue;
			const newConfidence = Math.min(
				0.99,
				Math.max(row.confidence, insight.confidence) + 0.03,
			);
			const newImportance = Math.min(
				0.99,
				Math.max(row.importance, insight.importance) + 0.02,
			);
			// If the incoming lesson is the stronger / more specific version
			// (higher confidence — e.g. a captured root-cause failure vs a
			// generic one), adopt its wording + keywords so the store holds the
			// best phrasing instead of the first one written.
			if (insight.confidence > row.confidence) {
				await this.db
					.run(
						"UPDATE learning_insights SET confidence = ?, importance = ?, content = ?, evidence = ?, keywords = ? WHERE id = ? AND scope_key = ?",
						[
							newConfidence,
							newImportance,
							insight.content,
							insight.evidence ?? null,
							JSON.stringify(insight.keywords),
							row.id,
							scopeKey,
						],
					)
					.catch(() => {});
			} else {
				await this.db
					.run(
						"UPDATE learning_insights SET confidence = ?, importance = ?, evidence = COALESCE(?, evidence) WHERE id = ? AND scope_key = ?",
						[
							newConfidence,
							newImportance,
							insight.evidence ?? null,
							row.id,
							scopeKey,
						],
					)
					.catch(() => {});
			}
			return row.id;
		}
		return undefined;
	}

	private async storeInsight(insight: LearningInsight): Promise<void> {
		const scope = this.normalizeScope(insight.scope);
		const scopeKey = this.scopeKey(scope);
		// Upsert: if a near-duplicate already exists, reinforce it (raise
		// confidence/importance) instead of inserting another copy. This keeps
		// the insight store high-signal — the same lesson surfacing again
		// strengthens it rather than adding noise — and is the closed learning
		// loop (a repeated mistake makes the existing lesson more prominent).
		const reinforcedInsightId = await this.reinforceExisting(insight);
		if (reinforcedInsightId) {
			await this.recordInsightEvidence(
				reinforcedInsightId,
				insight.experienceId,
				"supports",
			);
			return;
		}

		const shouldMirror =
			this.options.ltm &&
			insight.confidence >= Math.max(0.8, this.config.minConfidenceToStore) &&
			[
				"procedure",
				"anti_pattern",
				"tool_strategy",
				"what_worked",
				"what_failed",
			].includes(insight.type);
		const embeddingDescriptor = this.embedFn.getDescriptor?.();
		const memory: MemoryItem | undefined = shouldMirror
			? {
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
					...(embeddingDescriptor
						? {
							embeddingProvider: embeddingDescriptor.provider,
							embeddingModel: embeddingDescriptor.model,
							embeddingDimensions: embeddingDescriptor.dimensions,
							embeddingVersion: embeddingDescriptor.version,
							embeddingQuality: embeddingDescriptor.quality,
						}
						: {}),
					tenantId: scope.tenantId,
					userId: scope.userId,
					projectId: scope.projectId,
					agentRole: scope.agentRole,
					insightId: insight.id,
					type: insight.type,
					confidence: insight.confidence,
				},
			}
			: undefined;

		await this.db.transaction(async () => {
			await this.db.run(
				`INSERT INTO learning_insights (id, experience_id, type, domain, keywords, content, evidence, confidence, importance, embedding, use_count, last_used_at, created_at, scope_key, scope_tenant_id, scope_user_id, scope_project_id, scope_agent_role, scope_session_id, scope_task_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
					scopeKey,
					scope.tenantId,
					scope.userId,
					scope.projectId,
					scope.agentRole,
					scope.sessionId ?? null,
					scope.taskId ?? null,
				],
			);
			if (memory && this.options.ltm) {
				await this.options.ltm.stageStore(memory);
			}
			await this.recordInsightEvidence(
				insight.id,
				insight.experienceId,
				"supports",
			);
		});
		if (memory && this.options.ltm) {
			await this.options.ltm.finalizeStore(memory.id).catch((error) => {
				logger.warn(
					`Failed to finalize learning mirror write ${memory.id}: ${String(error)}`,
				);
			});
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
				"SELECT COUNT(*) as cnt FROM experiences WHERE scope_key = ? AND status = 'succeeded' AND user_request LIKE ?",
				[this.scopeKey(experience.scope), like],
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
		if (input.outcome) {
			const passed = input.outcome.checks.filter((check) => check.passed).length;
			const failed = input.outcome.checks.length - passed;
			if (input.outcome.verified && failed === 0 && passed > 0) {
				return {
					status: "succeeded",
					confidence: 0.95,
					reasons: ["verified_outcome", ...input.outcome.checks.map((c) => c.name)],
				};
			}
			if (failed > 0) {
				return {
					status: passed > 0 ? "partial" : "failed",
					confidence: 0.9,
					reasons: [
						"failed_outcome_verification",
						...input.outcome.checks
							.filter((check) => !check.passed)
							.map((check) => check.name),
					],
				};
			}
		}

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

	private async markInsightsUsed(ids: string[], scopeKey: string): Promise<void> {
		const now = new Date().toISOString();
		for (const id of ids) {
			await this.db
				.run(
					"UPDATE learning_insights SET use_count = use_count + 1, last_used_at = ? WHERE id = ? AND scope_key = ?",
					[now, id, scopeKey],
				)
				.catch(() => {});
		}
	}

	private async ensureTables(): Promise<void> {
		await this.db.run(
			`CREATE TABLE IF NOT EXISTS experiences (id TEXT PRIMARY KEY, conversation_id TEXT, task_id TEXT, agent_id TEXT, channel_id TEXT, user_request TEXT NOT NULL, final_response TEXT NOT NULL, status TEXT NOT NULL, confidence REAL NOT NULL, tools_used TEXT NOT NULL, skills_used TEXT NOT NULL, duration_ms INTEGER, metadata TEXT NOT NULL, created_at TEXT NOT NULL, scope_key TEXT NOT NULL DEFAULT '${LEGACY_SCOPE}', scope_tenant_id TEXT NOT NULL DEFAULT '${LEGACY_SCOPE}', scope_user_id TEXT NOT NULL DEFAULT '${LEGACY_SCOPE}', scope_project_id TEXT NOT NULL DEFAULT '${LEGACY_SCOPE}', scope_agent_role TEXT NOT NULL DEFAULT '${LEGACY_SCOPE}', scope_session_id TEXT, scope_task_id TEXT)`,
		);
		await this.db.run(
			`CREATE TABLE IF NOT EXISTS learning_insights (id TEXT PRIMARY KEY, experience_id TEXT NOT NULL, type TEXT NOT NULL, domain TEXT, keywords TEXT NOT NULL, content TEXT NOT NULL, evidence TEXT, confidence REAL NOT NULL, importance REAL NOT NULL, embedding TEXT NOT NULL, use_count INTEGER NOT NULL DEFAULT 0, last_used_at TEXT, created_at TEXT NOT NULL, scope_key TEXT NOT NULL DEFAULT '${LEGACY_SCOPE}', scope_tenant_id TEXT NOT NULL DEFAULT '${LEGACY_SCOPE}', scope_user_id TEXT NOT NULL DEFAULT '${LEGACY_SCOPE}', scope_project_id TEXT NOT NULL DEFAULT '${LEGACY_SCOPE}', scope_agent_role TEXT NOT NULL DEFAULT '${LEGACY_SCOPE}', scope_session_id TEXT, scope_task_id TEXT, invalidated_at TEXT, invalidation_reason TEXT, invalidated_by_experience_id TEXT)`,
		);
		await this.db.run(
			"CREATE TABLE IF NOT EXISTS learning_insight_evidence (insight_id TEXT NOT NULL, experience_id TEXT NOT NULL, relation TEXT NOT NULL, recorded_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (insight_id, experience_id))",
		);
	}

	private deserializeInsight(row: InsightRow): LearningInsight {
		return {
			id: row.id,
			scope: this.deserializeScope(row),
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
			invalidatedAt: row.invalidated_at
				? new Date(row.invalidated_at)
				: undefined,
			invalidationReason: row.invalidation_reason ?? undefined,
			invalidatedByExperienceId:
				row.invalidated_by_experience_id ?? undefined,
			createdAt: new Date(row.created_at),
		};
	}

	private deserializeExperience(row: ExperienceRow): ExperienceRecord {
		return {
			id: row.id,
			scope: this.deserializeScope(row),
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

	private normalizeScope(scope: LearningScope): LearningScope {
		const required = {
			tenantId: scope?.tenantId?.trim(),
			userId: scope?.userId?.trim(),
			projectId: scope?.projectId?.trim(),
			agentRole: scope?.agentRole?.trim(),
		};
		for (const [key, value] of Object.entries(required)) {
			if (!value || value === LEGACY_SCOPE) {
				throw new Error(`Invalid learning scope: ${key} is required`);
			}
		}
		return {
			tenantId: required.tenantId as string,
			userId: required.userId as string,
			projectId: required.projectId as string,
			agentRole: required.agentRole as string,
			sessionId: scope.sessionId?.trim() || undefined,
			taskId: scope.taskId?.trim() || undefined,
		};
	}

	private scopeKeyForAccess(access: LearningAccess): string | undefined {
		if (access.kind === "admin") return undefined;
		return this.scopeKey(this.normalizeScope(access.scope));
	}

	private scopeKey(scope: LearningScope): string {
		return JSON.stringify([
			scope.tenantId,
			scope.userId,
			scope.projectId,
			scope.agentRole,
		]);
	}

	private async recordInsightEvidence(
		insightId: string,
		experienceId: string,
		relation: "supports" | "refutes",
	): Promise<void> {
		const now = new Date().toISOString();
		await this.db.run(
			`INSERT OR REPLACE INTO learning_insight_evidence
			 (insight_id, experience_id, relation, recorded_at, updated_at)
			 VALUES (?, ?, ?, COALESCE((SELECT recorded_at FROM learning_insight_evidence WHERE insight_id = ? AND experience_id = ?), ?), ?)`,
			[insightId, experienceId, relation, insightId, experienceId, now, now],
		);
	}

	private async invalidateInsightsForExperience(
		experienceId: string,
		scopeKey: string,
		reason: string,
	): Promise<void> {
		const positiveTypes: LearningInsightType[] = [
			"procedure",
			"tool_strategy",
			"what_worked",
			"skill_candidate",
		];
		const placeholders = positiveTypes.map(() => "?").join(", ");
		const candidates = await this.db.all<{ id: string }>(
			`SELECT DISTINCT li.id
			 FROM learning_insights li
			 JOIN learning_insight_evidence e ON e.insight_id = li.id
			 WHERE e.experience_id = ? AND e.relation = 'supports'
			 AND li.scope_key = ? AND li.invalidated_at IS NULL
			 AND li.type IN (${placeholders})`,
			[experienceId, scopeKey, ...positiveTypes],
		);
		const invalidatedIds: string[] = [];
		await this.db.transaction(async () => {
			for (const candidate of candidates) {
				await this.recordInsightEvidence(candidate.id, experienceId, "refutes");
				const support = await this.db.get<{ count: number }>(
					`SELECT COUNT(*) AS count
					 FROM learning_insight_evidence e
					 JOIN experiences x ON x.id = e.experience_id
					 WHERE e.insight_id = ? AND e.relation = 'supports'
					 AND e.experience_id <> ? AND x.status <> 'failed'`,
					[candidate.id, experienceId],
				);
				if ((support?.count ?? 0) > 0) continue;
				if (this.options.ltm) {
					await this.options.ltm.stageForget(`learn_${candidate.id}`);
				}
				await this.db.run(
					`UPDATE learning_insights
					 SET invalidated_at = ?, invalidation_reason = ?, invalidated_by_experience_id = ?
					 WHERE id = ? AND scope_key = ? AND invalidated_at IS NULL`,
					[
						new Date().toISOString(),
						reason.slice(0, 1000),
						experienceId,
						candidate.id,
						scopeKey,
					],
				);
				invalidatedIds.push(candidate.id);
			}
		});
		if (this.options.ltm) {
			await Promise.all(
				invalidatedIds.map((id) =>
					this.options.ltm
						?.finalizeForget(`learn_${id}`)
						.catch((error) =>
							logger.warn(
								`Failed to finalize invalidated learning mirror learn_${id}: ${String(error)}`,
							),
						),
				),
			);
		}
	}

	private async deleteInsightWithMirror(
		id: string,
		scopeKey: string,
	): Promise<boolean> {
		const mirrorId = `learn_${id}`;
		const deleted = await this.db.transaction(async () => {
			const existing = await this.db.get<{ id: string }>(
				"SELECT id FROM learning_insights WHERE id = ? AND scope_key = ?",
				[id, scopeKey],
			);
			if (!existing) return false;
			if (this.options.ltm) await this.options.ltm.stageForget(mirrorId);
			await this.db.run(
				"DELETE FROM learning_insight_evidence WHERE insight_id = ?",
				[id],
			);
			await this.db.run(
				"DELETE FROM learning_insights WHERE id = ? AND scope_key = ?",
				[id, scopeKey],
			);
			return true;
		});

		if (deleted && this.options.ltm) {
			await this.options.ltm.finalizeForget(mirrorId).catch((error) => {
				logger.warn(
					`Failed to finalize learning mirror deletion ${mirrorId}: ${String(error)}`,
				);
			});
		}
		return deleted;
	}

	private deserializeScope(
		row: Pick<
			ExperienceRow,
			| "scope_tenant_id"
			| "scope_user_id"
			| "scope_project_id"
			| "scope_agent_role"
			| "scope_session_id"
			| "scope_task_id"
		>,
	): LearningScope {
		return {
			tenantId: row.scope_tenant_id,
			userId: row.scope_user_id,
			projectId: row.scope_project_id,
			agentRole: row.scope_agent_role,
			sessionId: row.scope_session_id ?? undefined,
			taskId: row.scope_task_id ?? undefined,
		};
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
