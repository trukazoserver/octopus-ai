import { nanoid } from "nanoid";
import type { DatabaseAdapter } from "../storage/database.js";
import { FTSSearchEngine } from "./fts-search.js";
import { MemoryIntegrityLayer } from "./integrity.js";
import type { LongTermMemory } from "./ltm.js";
import type {
	ActiveForgettingOptions,
	ActiveForgettingReport,
	EmbeddingFunction,
	MemoryCandidate,
	MemoryCoverageSnapshot,
	MemoryExplanation,
	MemoryFeedbackInput,
	MemoryFeedbackResult,
	MemoryItem,
	MemoryPack,
	MemoryReadContext,
	MemorySourceTrustLevel,
	MemoryStatus,
	MemoryType,
	MemoryUsageRecord,
	MemoryWriteResult,
	ProspectiveReminder,
	ScoredMemory,
} from "./types.js";
import { UncertaintyEstimator } from "./uncertainty.js";

const TRUST_RANK: Record<MemorySourceTrustLevel, number> = {
	external: 1,
	user_inferred: 2,
	user_explicit: 3,
	agent: 4,
	system: 5,
};

export interface MemoryOrchestratorConfig {
	defaultTenantId?: string;
	defaultUserId?: string;
	defaultProjectId?: string;
	maxReadCandidates?: number;
	minRelevance?: number;
}

export interface MemoryOrchestratorDeps {
	db: DatabaseAdapter;
	ltm: LongTermMemory;
	embeddingFn: EmbeddingFunction;
	ftsSearch?: FTSSearchEngine;
	integrity?: MemoryIntegrityLayer;
	uncertaintyEstimator?: UncertaintyEstimator;
	config?: MemoryOrchestratorConfig;
}

export class MemoryOrchestrator {
	private initialized = false;
	private ftsSearch?: FTSSearchEngine;
	private integrity: MemoryIntegrityLayer;
	private uncertaintyEstimator: UncertaintyEstimator;
	private config: Required<MemoryOrchestratorConfig>;

	constructor(private deps: MemoryOrchestratorDeps) {
		this.ftsSearch = deps.ftsSearch ?? new FTSSearchEngine(deps.db);
		this.integrity = deps.integrity ?? new MemoryIntegrityLayer(deps.db);
		this.uncertaintyEstimator =
			deps.uncertaintyEstimator ?? new UncertaintyEstimator();
		this.config = {
			defaultTenantId: deps.config?.defaultTenantId ?? "local",
			defaultUserId: deps.config?.defaultUserId ?? "local-user",
			defaultProjectId: deps.config?.defaultProjectId ?? "default-project",
			maxReadCandidates: deps.config?.maxReadCandidates ?? 50,
			minRelevance: deps.config?.minRelevance ?? 0.45,
		};
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		await this.integrity.initialize();
		await this.ftsSearch?.initialize().catch(() => {});
		await this.deps.db.run(
			`CREATE TABLE IF NOT EXISTS memory_evidence (
				id TEXT PRIMARY KEY,
				memory_id TEXT NOT NULL,
				source_type TEXT NOT NULL,
				source_id TEXT,
				excerpt TEXT,
				created_at TEXT NOT NULL
			)`,
		);
		await this.deps.db.run(
			`CREATE TABLE IF NOT EXISTS memory_usage (
				id TEXT PRIMARY KEY,
				memory_id TEXT NOT NULL,
				session_id TEXT,
				task_id TEXT,
				agent_role TEXT,
				retrieved_at TEXT NOT NULL,
				feedback_type TEXT NOT NULL DEFAULT 'none',
				outcome TEXT
			)`,
		);
		await this.deps.db.run(
			`CREATE TABLE IF NOT EXISTS memory_edges (
				id TEXT PRIMARY KEY,
				source_id TEXT NOT NULL,
				target_id TEXT NOT NULL,
				type TEXT NOT NULL,
				confidence REAL NOT NULL,
				created_at TEXT NOT NULL
			)`,
		);
		await this.deps.db.run(
			`CREATE TABLE IF NOT EXISTS memory_versions (
				id TEXT PRIMARY KEY,
				memory_id TEXT NOT NULL,
				previous_content TEXT,
				change_reason TEXT NOT NULL,
				changed_by TEXT NOT NULL,
				changed_at TEXT NOT NULL
			)`,
		);
		await this.deps.db.run(
			`CREATE TABLE IF NOT EXISTS memory_coverage (
				id TEXT PRIMARY KEY,
				tenant_id TEXT NOT NULL,
				user_id TEXT,
				topic_label TEXT NOT NULL,
				coverage_score REAL NOT NULL,
				confidence_dist TEXT NOT NULL DEFAULT '{}',
				known_gaps TEXT NOT NULL DEFAULT '[]',
				last_updated TEXT NOT NULL
			)`,
		);
		await this.deps.db.run(
			"CREATE INDEX IF NOT EXISTS idx_memory_evidence_memory ON memory_evidence (memory_id)",
		);
		await this.deps.db.run(
			"CREATE INDEX IF NOT EXISTS idx_memory_usage_memory ON memory_usage (memory_id, retrieved_at)",
		);
		await this.deps.db.run(
			"CREATE INDEX IF NOT EXISTS idx_memory_edges_source ON memory_edges (source_id, type)",
		);
		await this.deps.db.run(
			"CREATE INDEX IF NOT EXISTS idx_memory_coverage_scope ON memory_coverage (tenant_id, user_id, topic_label)",
		);
		this.initialized = true;
	}

	async write(candidate: MemoryCandidate): Promise<MemoryWriteResult> {
		await this.initialize();
		const validation = await this.integrity.validate(
			this.normalizeCandidate(candidate),
		);
		if (!validation.allowed || !validation.candidate) {
			return {
				accepted: false,
				reason: validation.reason,
				validation,
			};
		}

		const normalized = validation.candidate;
		const now = new Date();
		const embedding = await this.deps.embeddingFn(normalized.content);
		const duplicate = await this.findDuplicate(normalized, embedding);
		if (duplicate) {
			const duplicateConfidence = Number(duplicate.metadata.confidence ?? 0.5);
			const reinforced: MemoryItem = {
				...duplicate,
				importance: Math.max(
					duplicate.importance,
					normalized.importance ?? this.computeImportance(normalized),
				),
				lastAccessed: now,
				metadata: {
					...duplicate.metadata,
					confidence: Math.min(1, duplicateConfidence + 0.05),
					duplicateReinforcedAt: now.toISOString(),
					duplicateReinforcementCount:
						Number(duplicate.metadata.duplicateReinforcementCount ?? 0) + 1,
				},
			};
			await this.deps.ltm.update(reinforced);
			await this.recordEvidence(duplicate.id, normalized);
			await this.updateCoverage(normalized, reinforced);
			return {
				accepted: true,
				memoryId: duplicate.id,
				reason: "duplicate_reinforced",
				validation,
			};
		}
		const memoryId = nanoid();
		const item: MemoryItem = {
			id: memoryId,
			type: normalized.type,
			content: normalized.content,
			embedding,
			importance: normalized.importance ?? this.computeImportance(normalized),
			accessCount: 0,
			lastAccessed: now,
			createdAt: now,
			associations: [],
			source: normalized.source ?? {
				taskId: normalized.scope.taskId,
				channelId: normalized.scope.sessionId,
			},
			metadata: {
				...normalized.metadata,
				tenantId: normalized.scope.tenantId,
				userId: normalized.scope.userId,
				projectId: normalized.scope.projectId,
				agentRole: normalized.scope.agentRole,
				sourceTrust: normalized.sourceTrust,
				confidence: normalized.confidence ?? validation.confidenceCap,
				status: "active",
			},
		};

		await this.deps.ltm.store(item);
		await this.recordEvidence(memoryId, normalized);
		await this.applyDeclaredRelations(item, normalized);
		await this.updateCoverage(normalized, item);
		return {
			accepted: true,
			memoryId,
			validation,
		};
	}

	async read(
		query: string,
		context: MemoryReadContext,
		budgetTokens: number,
	): Promise<MemoryPack> {
		await this.initialize();
		const normalizedContext = this.normalizeContext(context);
		const topicLabel = this.topicLabel(query);
		const coverage = await this.getCoverage(
			normalizedContext.tenantId,
			normalizedContext.userId,
			topicLabel,
		);
		const embedding = await this.deps.embeddingFn(query);
		const retrieved = await this.deps.ltm.retrieveByEmbedding(embedding, {
			maxResults: this.config.maxReadCandidates,
			maxTokens: Math.max(64, budgetTokens),
			minRelevance: this.config.minRelevance,
			recencyWeight: 0.18,
			frequencyWeight: 0.12,
			relevanceWeight: 0.7,
			filter: (item) => this.matchesContext(item, normalizedContext),
			updateAccess: false,
		});
		const hybridResults = await this.retrieveHybrid(query, retrieved, (item) =>
			this.matchesContext(item, normalizedContext),
		);
		const filtered = hybridResults.filter((memory) =>
			this.matchesContext(memory.item, normalizedContext),
		);
		const uncertainty = this.uncertaintyEstimator.estimate(filtered, coverage);
		const selected = this.applyTokenBudget(filtered, budgetTokens);
		if (normalizedContext.trackUsage !== false) {
			await this.recordReadUsage(selected, normalizedContext);
		}
		const tokenBudgetUsed = selected.reduce(
			(total, memory) => total + estimateTokens(memory.item.content),
			0,
		);

		return {
			taskObjective: query,
			uncertaintyLevel: uncertainty.level,
			memories: selected,
			userMemory: selected.filter((memory) => memory.item.type === "user"),
			projectMemory: selected.filter(
				(memory) =>
					memory.item.type === "org" || memory.item.type === "semantic",
			),
			similarEpisodes: selected.filter(
				(memory) => memory.item.type === "episodic",
			),
			agentLessons: selected.filter(
				(memory) =>
					memory.item.type === "agent" || memory.item.type === "procedural",
			),
			prospectiveReminders: selected.filter(
				(memory) => memory.item.type === "prospective",
			),
			knownGaps:
				uncertainty.knownGaps.length > 0
					? uncertainty.knownGaps
					: uncertainty.level === "NO_COVERAGE"
						? [`No reliable memory coverage for: ${query.slice(0, 120)}`]
						: [],
			toolRecommendations: [],
			knownRisks:
				uncertainty.level === "LOW_CONFIDENCE"
					? ["Memory coverage is weak; avoid overconfident recall."]
					: [],
			tokenBudgetUsed,
			tokenBudgetRemaining: Math.max(0, budgetTokens - tokenBudgetUsed),
		};
	}

	async forget(memoryId: string, reason: string): Promise<void> {
		await this.initialize();
		const item = await this.deps.ltm.getById(memoryId);
		if (!item) return;
		await this.deps.db.run(
			`INSERT INTO memory_versions (id, memory_id, previous_content, change_reason, changed_by, changed_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[
				nanoid(),
				memoryId,
				item.content,
				reason,
				"user",
				new Date().toISOString(),
			],
		);
		await this.deps.ltm.update({
			...item,
			metadata: {
				...item.metadata,
				status: "user_deleted",
				deletedReason: reason,
			},
		});
	}

	async recordUsage(record: MemoryUsageRecord): Promise<void> {
		await this.initialize();
		await this.deps.db.run(
			`INSERT INTO memory_usage
				(id, memory_id, session_id, task_id, agent_role, retrieved_at, feedback_type, outcome)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				nanoid(),
				record.memoryId,
				record.sessionId ?? null,
				record.taskId ?? null,
				record.agentRole ?? null,
				new Date().toISOString(),
				record.feedbackType ?? "none",
				record.outcome ?? null,
			],
		);
	}

	async recordReadUsage(
		memories: ScoredMemory[],
		context: MemoryReadContext,
	): Promise<void> {
		await this.recordReadUsageByIds(
			memories.map((memory) => memory.item.id),
			context,
		);
	}

	async recordReadUsageByIds(
		memoryIds: string[],
		context: MemoryReadContext,
	): Promise<void> {
		await this.initialize();
		const normalizedContext = this.normalizeContext(context);
		const uniqueIds = Array.from(new Set(memoryIds.filter(Boolean)));
		await Promise.all(
			uniqueIds.map((memoryId) =>
				Promise.all([
					this.deps.ltm.updateAccess(memoryId),
					this.recordUsage({
						memoryId,
						sessionId: normalizedContext.sessionId,
						taskId: normalizedContext.taskId,
						agentRole: normalizedContext.agentRole,
						feedbackType: "none",
					}),
				]),
			),
		);
	}

	async applyFeedback(
		feedback: MemoryFeedbackInput,
	): Promise<MemoryFeedbackResult | undefined> {
		await this.initialize();
		const item = await this.deps.ltm.getById(feedback.memoryId);
		if (!item) return undefined;

		const previousConfidence = Number(item.metadata.confidence ?? 0.5);
		const previousStatus = this.getMemoryStatus(item);
		let nextConfidence = previousConfidence;
		let nextStatus = previousStatus;
		let nextContent = item.content;
		let versionCreated = false;

		switch (feedback.feedbackType) {
			case "explicit_approve":
				nextConfidence = Math.min(1, previousConfidence + 0.1);
				break;
			case "explicit_correct":
				nextConfidence = Math.max(previousConfidence, 0.7);
				if (feedback.correction?.trim()) {
					nextContent = feedback.correction.trim();
					versionCreated = true;
				}
				nextStatus = "active";
				break;
			case "explicit_delete":
				nextConfidence = 0;
				nextStatus = "user_deleted";
				versionCreated = true;
				break;
			case "implicit_positive":
				nextConfidence = Math.min(0.85, previousConfidence + 0.02);
				break;
			case "implicit_negative":
				nextConfidence = Math.max(0, previousConfidence - 0.1);
				break;
			case "implicit_neutral":
				break;
		}

		await this.recordUsage(feedback);
		if (versionCreated) {
			await this.recordVersion(
				item.id,
				item.content,
				feedback.feedbackType,
				feedback.changedBy ?? "user",
			);
		}
		const updated: MemoryItem = {
			...item,
			content: nextContent,
			metadata: {
				...item.metadata,
				confidence: nextConfidence,
				status: nextStatus,
				lastFeedbackType: feedback.feedbackType,
				lastFeedbackAt: new Date().toISOString(),
			},
		};
		if (nextContent !== item.content) {
			updated.embedding = await this.deps.embeddingFn(nextContent);
		}
		await this.deps.ltm.update(updated);

		return {
			memoryId: item.id,
			previousConfidence,
			nextConfidence,
			previousStatus,
			nextStatus,
			versionCreated,
		};
	}

	async runActiveForgetting(
		options: ActiveForgettingOptions = {},
	): Promise<ActiveForgettingReport> {
		await this.initialize();
		const now = options.now ?? new Date();
		const unusedDays = options.unusedDays ?? 60;
		const lowImportanceThreshold = options.lowImportanceThreshold ?? 0.25;
		const contradictionGraceDays = options.contradictionGraceDays ?? 14;
		const report: ActiveForgettingReport = {
			evaluated: 0,
			compressed: 0,
			expired: 0,
			superseded: 0,
			degraded: 0,
			untouched: 0,
		};
		const items = await this.deps.ltm.listAll(5000, { includeInactive: true });

		for (const item of items) {
			report.evaluated += 1;
			const status = this.getMemoryStatus(item);
			if (status === "user_deleted" || status === "expired") {
				report.untouched += 1;
				continue;
			}
			const expiresAt = this.getMetadataDate(item, "expiresAt");
			if (expiresAt && expiresAt.getTime() <= now.getTime()) {
				await this.updateStatus(item, "expired", "ttl_expired");
				report.expired += 1;
				continue;
			}
			const supersededBy = item.metadata.supersededBy;
			if (typeof supersededBy === "string" && supersededBy.length > 0) {
				await this.updateStatus(item, "superseded", "superseded_by_new_memory");
				report.superseded += 1;
				continue;
			}
			const lastAccessedMs = item.lastAccessed.getTime();
			const unusedForDays = (now.getTime() - lastAccessedMs) / 86_400_000;
			if (
				unusedForDays >= unusedDays &&
				item.importance <= lowImportanceThreshold &&
				item.accessCount === 0
			) {
				await this.updateStatus(item, "expired", "unused_low_importance");
				report.compressed += 1;
				continue;
			}
			if (status === "contradicted") {
				const updatedAt =
					this.getMetadataDate(item, "contradictedAt") ?? item.createdAt;
				const contradictedDays =
					(now.getTime() - updatedAt.getTime()) / 86_400_000;
				if (contradictedDays >= contradictionGraceDays) {
					const confidence = Math.max(
						0,
						Number(item.metadata.confidence ?? 0.5) - 0.15,
					);
					await this.deps.ltm.update({
						...item,
						metadata: {
							...item.metadata,
							confidence,
							lastActiveForgettingReason: "stale_contradiction",
							lastActiveForgettingAt: now.toISOString(),
						},
					});
					report.degraded += 1;
					continue;
				}
			}
			report.untouched += 1;
		}

		return report;
	}

	async getProspectiveReminders(
		context: MemoryReadContext,
		now = new Date(),
	): Promise<ProspectiveReminder[]> {
		await this.initialize();
		const normalizedContext = this.normalizeContext(context);
		const items = await this.deps.ltm.listAll(1000);
		return items
			.filter((item) => item.type === "prospective")
			.filter((item) => this.matchesContext(item, normalizedContext))
			.map((item) => this.toProspectiveReminder(item))
			.filter((reminder) => reminder.status === "pending")
			.filter(
				(reminder) =>
					!reminder.dueAt ||
					reminder.dueAt.getTime() >= now.getTime() - 86_400_000,
			)
			.sort((a, b) => {
				const aDue = a.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
				const bDue = b.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
				return aDue - bDue || b.importance - a.importance;
			});
	}

	async explain(memoryIds: string[]): Promise<MemoryExplanation[]> {
		await this.initialize();
		const explanations: MemoryExplanation[] = [];
		for (const memoryId of memoryIds) {
			const item = await this.deps.ltm.getById(memoryId);
			if (!item) continue;
			const evidenceRows = await this.deps.db.all<{
				source_type: string;
				source_id: string | null;
				excerpt: string | null;
				created_at: string;
			}>(
				"SELECT source_type, source_id, excerpt, created_at FROM memory_evidence WHERE memory_id = ? ORDER BY created_at DESC",
				[memoryId],
			);
			const usageRows = await this.deps.db.all<{
				session_id: string | null;
				task_id: string | null;
				agent_role: string | null;
				retrieved_at: string;
				feedback_type: string;
				outcome: string | null;
			}>(
				"SELECT session_id, task_id, agent_role, retrieved_at, feedback_type, outcome FROM memory_usage WHERE memory_id = ? ORDER BY retrieved_at DESC LIMIT 20",
				[memoryId],
			);

			explanations.push({
				memoryId,
				content: item.content,
				type: item.type,
				confidence: Number(item.metadata.confidence ?? 0.5),
				sourceTrust:
					typeof item.metadata.sourceTrust === "string"
						? (item.metadata.sourceTrust as MemorySourceTrustLevel)
						: "unknown",
				evidence: evidenceRows.map((row) => ({
					sourceType: row.source_type,
					sourceId: row.source_id ?? undefined,
					excerpt: row.excerpt ?? undefined,
					createdAt: new Date(row.created_at),
				})),
				usage: usageRows.map((row) => ({
					sessionId: row.session_id ?? undefined,
					taskId: row.task_id ?? undefined,
					agentRole: row.agent_role ?? undefined,
					retrievedAt: new Date(row.retrieved_at),
					feedbackType: row.feedback_type,
					outcome: row.outcome ?? undefined,
				})),
			});
		}
		return explanations;
	}

	private normalizeCandidate(candidate: MemoryCandidate): MemoryCandidate {
		return {
			...candidate,
			scope: this.normalizeContext(candidate.scope),
			metadata: candidate.metadata ?? {},
		};
	}

	private normalizeContext<T extends MemoryReadContext>(context: T): T {
		return {
			...context,
			tenantId: context.tenantId ?? this.config.defaultTenantId,
			userId: context.userId ?? this.config.defaultUserId,
			projectId: context.projectId ?? this.config.defaultProjectId,
		};
	}

	private async findDuplicate(
		candidate: MemoryCandidate,
		embedding: number[],
	): Promise<MemoryItem | undefined> {
		const context = this.normalizeContext(candidate.scope);
		const results = await this.deps.ltm.retrieveByEmbedding(embedding, {
			maxResults: 5,
			maxTokens: 1000,
			minRelevance: 0.92,
			recencyWeight: 0,
			frequencyWeight: 0,
			relevanceWeight: 1,
			filter: (item) => this.matchesContext(item, context),
			updateAccess: false,
		});
		return results.find(
			(result) =>
				result.item.type === candidate.type &&
				this.getMemoryStatus(result.item) === "active" &&
				this.matchesContext(result.item, context),
		)?.item;
	}

	private async applyDeclaredRelations(
		item: MemoryItem,
		candidate: MemoryCandidate,
	): Promise<void> {
		const supersedes = this.readStringList(candidate.metadata?.supersedes);
		for (const targetId of supersedes) {
			await this.createEdge(item.id, targetId, "supersedes", 0.85);
			const target = await this.deps.ltm.getById(targetId);
			if (target)
				await this.updateStatus(
					target,
					"superseded",
					"superseded_by_new_memory",
				);
		}

		const contradicts = this.readStringList(candidate.metadata?.contradicts);
		for (const targetId of contradicts) {
			await this.createEdge(item.id, targetId, "contradicts", 0.75);
			const target = await this.deps.ltm.getById(targetId);
			if (target) {
				await this.deps.ltm.update({
					...target,
					metadata: {
						...target.metadata,
						status: "contradicted",
						contradictedBy: item.id,
						contradictedAt: new Date().toISOString(),
					},
				});
			}
		}
	}

	private async createEdge(
		sourceId: string,
		targetId: string,
		type: string,
		confidence: number,
	): Promise<void> {
		await this.deps.db.run(
			`INSERT INTO memory_edges (id, source_id, target_id, type, confidence, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[
				nanoid(),
				sourceId,
				targetId,
				type,
				confidence,
				new Date().toISOString(),
			],
		);
	}

	private readStringList(value: unknown): string[] {
		if (typeof value === "string" && value.trim()) return [value.trim()];
		if (Array.isArray(value)) {
			return value.filter(
				(entry): entry is string =>
					typeof entry === "string" && entry.trim().length > 0,
			);
		}
		return [];
	}

	private async retrieveHybrid(
		query: string,
		vectorResults: ScoredMemory[],
		filter?: (item: MemoryItem) => boolean,
	): Promise<ScoredMemory[]> {
		if (!this.ftsSearch) return vectorResults;
		try {
			const hybrid = await this.ftsSearch.hybridSearch(query, vectorResults);
			const deduped = new Map<string, ScoredMemory>();
			for (const result of hybrid) {
				if (filter && !filter(result.item)) continue;
				const previous = deduped.get(result.item.id);
				if (!previous || result.score > previous.score) {
					deduped.set(result.item.id, result);
				}
			}
			return Array.from(deduped.values()).sort((a, b) => b.score - a.score);
		} catch {
			return vectorResults;
		}
	}

	private computeImportance(candidate: MemoryCandidate): number {
		const baseByType: Record<MemoryType, number> = {
			episodic: 0.45,
			semantic: 0.7,
			procedural: 0.72,
			user: 0.82,
			org: 0.8,
			agent: 0.68,
			prospective: 0.9,
			meta: 0.6,
		};
		return Math.min(
			1,
			baseByType[candidate.type] * (candidate.confidence ?? 0.7),
		);
	}

	private async recordEvidence(
		memoryId: string,
		candidate: MemoryCandidate,
	): Promise<void> {
		if (!candidate.evidence) return;
		await this.deps.db.run(
			`INSERT INTO memory_evidence (id, memory_id, source_type, source_id, excerpt, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[
				nanoid(),
				memoryId,
				candidate.evidence.sourceType,
				candidate.evidence.sourceId ?? null,
				(candidate.evidence.excerpt ?? candidate.content).slice(0, 1200),
				new Date().toISOString(),
			],
		);
	}

	private async recordVersion(
		memoryId: string,
		previousContent: string,
		changeReason: string,
		changedBy: "system" | "user" | "agent",
	): Promise<void> {
		await this.deps.db.run(
			`INSERT INTO memory_versions (id, memory_id, previous_content, change_reason, changed_by, changed_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[
				nanoid(),
				memoryId,
				previousContent,
				changeReason,
				changedBy,
				new Date().toISOString(),
			],
		);
	}

	private async updateCoverage(
		candidate: MemoryCandidate,
		item: MemoryItem,
	): Promise<void> {
		const topic = this.topicLabel(candidate.content);
		const confidence = Number(item.metadata.confidence ?? 0.5);
		await this.deps.db.run(
			`INSERT OR REPLACE INTO memory_coverage
				(id, tenant_id, user_id, topic_label, coverage_score, confidence_dist, known_gaps, last_updated)
				VALUES (
					COALESCE((SELECT id FROM memory_coverage WHERE tenant_id = ? AND COALESCE(user_id, '') = COALESCE(?, '') AND topic_label = ?), ?),
					?, ?, ?, ?, ?, ?, ?
				)`,
			[
				candidate.scope.tenantId,
				candidate.scope.userId ?? null,
				topic,
				nanoid(),
				candidate.scope.tenantId,
				candidate.scope.userId ?? null,
				topic,
				Math.min(1, confidence + item.importance * 0.25),
				JSON.stringify({ latest: confidence }),
				JSON.stringify([]),
				new Date().toISOString(),
			],
		);
	}

	private async getCoverage(
		tenantId: string,
		userId: string | undefined,
		topicLabel: string,
	): Promise<MemoryCoverageSnapshot | undefined> {
		const row = await this.deps.db.get<{
			topic_label: string;
			coverage_score: number;
			confidence_dist: string;
			known_gaps: string;
			last_updated: string;
		}>(
			`SELECT topic_label, coverage_score, confidence_dist, known_gaps, last_updated
			 FROM memory_coverage
			 WHERE tenant_id = ? AND COALESCE(user_id, '') = COALESCE(?, '') AND topic_label = ?`,
			[tenantId, userId ?? null, topicLabel],
		);
		if (!row) return undefined;
		return {
			topicLabel: row.topic_label,
			coverageScore: row.coverage_score,
			confidenceDistribution: parseJsonObject(row.confidence_dist),
			knownGaps: parseJsonArray(row.known_gaps),
			lastUpdated: new Date(row.last_updated),
		};
	}

	private matchesContext(
		item: MemoryItem,
		context: MemoryReadContext,
	): boolean {
		const metadata = item.metadata;
		if (metadata.status && metadata.status !== "active") return false;
		if (metadata.tenantId && metadata.tenantId !== context.tenantId)
			return false;
		if (
			metadata.userId &&
			context.userId &&
			metadata.userId !== context.userId
		) {
			return false;
		}
		if (
			metadata.projectId &&
			context.projectId &&
			metadata.projectId !== context.projectId
		) {
			return false;
		}
		if (
			context.agentRole &&
			metadata.agentRole &&
			metadata.agentRole !== context.agentRole
		) {
			return false;
		}
		if (context.timeRange?.since && item.createdAt < context.timeRange.since) {
			return false;
		}
		if (context.timeRange?.until && item.createdAt > context.timeRange.until) {
			return false;
		}
		if (context.minTrustLevel) {
			const sourceTrust =
				typeof metadata.sourceTrust === "string"
					? TRUST_RANK[metadata.sourceTrust as MemorySourceTrustLevel]
					: undefined;
			return (sourceTrust ?? 0) >= TRUST_RANK[context.minTrustLevel];
		}
		return true;
	}

	private getMemoryStatus(item: MemoryItem): MemoryStatus {
		const status = item.metadata.status;
		return status === "expired" ||
			status === "superseded" ||
			status === "contradicted" ||
			status === "user_deleted"
			? status
			: "active";
	}

	private getMetadataDate(item: MemoryItem, key: string): Date | undefined {
		const raw = item.metadata[key];
		if (typeof raw !== "string") return undefined;
		const parsed = new Date(raw);
		return Number.isNaN(parsed.getTime()) ? undefined : parsed;
	}

	private async updateStatus(
		item: MemoryItem,
		status: MemoryStatus,
		reason: string,
	): Promise<void> {
		await this.recordVersion(item.id, item.content, reason, "system");
		await this.deps.ltm.update({
			...item,
			metadata: {
				...item.metadata,
				status,
				lastActiveForgettingReason: reason,
				lastActiveForgettingAt: new Date().toISOString(),
			},
		});
	}

	private applyTokenBudget(
		memories: ScoredMemory[],
		budgetTokens: number,
	): ScoredMemory[] {
		const selected: ScoredMemory[] = [];
		let used = 0;
		for (const memory of memories.slice(0, 10)) {
			const cost = estimateTokens(memory.item.content);
			if (used + cost > budgetTokens && selected.length > 0) continue;
			selected.push(memory);
			used += cost;
			if (used >= budgetTokens) break;
		}
		return selected;
	}

	private topicLabel(content: string): string {
		return (
			content
				.toLowerCase()
				.replace(/[^\p{L}\p{N}\s]/gu, " ")
				.split(/\s+/)
				.filter((word) => word.length > 3)
				.slice(0, 4)
				.join(" ") || "general"
		);
	}

	private toProspectiveReminder(item: MemoryItem): ProspectiveReminder {
		const dueAtRaw = item.metadata.dueAt;
		const dueAt = typeof dueAtRaw === "string" ? new Date(dueAtRaw) : undefined;
		const validDueAt =
			dueAt && !Number.isNaN(dueAt.getTime()) ? dueAt : undefined;
		const rawStatus = item.metadata.prospectiveStatus;
		const status =
			rawStatus === "fulfilled" || rawStatus === "expired"
				? rawStatus
				: "pending";
		return {
			memoryId: item.id,
			commitment: item.content,
			dueAt: validDueAt,
			status,
			triggerCondition:
				typeof item.metadata.triggerCondition === "string"
					? item.metadata.triggerCondition
					: undefined,
			confidence: Number(item.metadata.confidence ?? 0.5),
			importance: item.importance,
		};
	}
}

function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.3));
}

function parseJsonObject(value: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function parseJsonArray(value: string): string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		return [];
	}
}
