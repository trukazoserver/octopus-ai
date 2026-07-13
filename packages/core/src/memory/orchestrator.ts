import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import type { DatabaseAdapter } from "../storage/database.js";
import { decrypt, encrypt } from "../utils/crypto.js";
import { isAssistantMemoryDenialEcho } from "./denial-echo.js";
import { FTSSearchEngine } from "./fts-search.js";
import { MemoryIntegrityLayer } from "./integrity.js";
import type { LongTermMemory } from "./ltm.js";
import type {
	ActiveForgettingOptions,
	ActiveForgettingReport,
	EmbeddingFunction,
	MemoryActionLogEntry,
	MemoryAuditEntry,
	MemoryAuditIntegrityReport,
	MemoryBackfillReport,
	MemoryCandidate,
	MemoryCoverageSnapshot,
	MemoryExplanation,
	MemoryFeedbackInput,
	MemoryFeedbackResult,
	MemoryGraphPath,
	MemoryGraphSnapshot,
	MemoryGraphTraversalOptions,
	MemoryItem,
	MemoryLogIntegrityResult,
	MemoryPack,
	MemoryPermissions,
	MemoryReadContext,
	MemoryRelationType,
	MemorySensitivity,
	MemorySource,
	MemorySourceTrustLevel,
	MemoryStatus,
	MemoryType,
	MemoryUsageRecord,
	MemoryVerificationReport,
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

const MEMORY_ENCRYPTION_PREFIX = "enc:v1:";

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
		await this.ensureAdvancedBrainTables();
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

	private async ensureAdvancedBrainTables(): Promise<void> {
		const statements = [
			`CREATE TABLE IF NOT EXISTS memory_sources (
				id TEXT PRIMARY KEY,
				source_type TEXT NOT NULL,
				title TEXT,
				uri TEXT,
				quoted_evidence TEXT,
				authority_score REAL NOT NULL DEFAULT 0.5,
				created_at TEXT NOT NULL,
				metadata TEXT NOT NULL DEFAULT '{}'
			)`,
			`CREATE TABLE IF NOT EXISTS memory_source_links (
				memory_id TEXT NOT NULL,
				source_id TEXT NOT NULL,
				PRIMARY KEY (memory_id, source_id)
			)`,
			`CREATE TABLE IF NOT EXISTS memory_nodes (
				id TEXT PRIMARY KEY,
				node_type TEXT NOT NULL,
				name TEXT NOT NULL,
				summary TEXT,
				confidence REAL NOT NULL DEFAULT 0.5,
				status TEXT NOT NULL DEFAULT 'active',
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				metadata TEXT NOT NULL DEFAULT '{}'
			)`,
			`CREATE TABLE IF NOT EXISTS memory_node_links (
				memory_id TEXT NOT NULL,
				node_id TEXT NOT NULL,
				relation TEXT NOT NULL DEFAULT 'mentions',
				PRIMARY KEY (memory_id, node_id, relation)
			)`,
			`CREATE TABLE IF NOT EXISTS memory_relations (
				id TEXT PRIMARY KEY,
				from_node_id TEXT NOT NULL,
				edge_type TEXT NOT NULL,
				to_node_id TEXT NOT NULL,
				context TEXT,
				confidence REAL NOT NULL DEFAULT 0.5,
				status TEXT NOT NULL DEFAULT 'active',
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				last_validated_at TEXT,
				metadata TEXT NOT NULL DEFAULT '{}'
			)`,
			`CREATE TABLE IF NOT EXISTS memory_relation_sources (
				edge_id TEXT NOT NULL,
				source_id TEXT NOT NULL,
				PRIMARY KEY (edge_id, source_id)
			)`,
			`CREATE TABLE IF NOT EXISTS memory_permissions (
				memory_id TEXT PRIMARY KEY,
				visible_to_agents TEXT NOT NULL DEFAULT '[]',
				hidden_from_agents TEXT NOT NULL DEFAULT '[]',
				visible_to_users TEXT NOT NULL DEFAULT '[]',
				requires_user_confirmation_before_use INTEGER NOT NULL DEFAULT 0,
				sensitivity TEXT NOT NULL DEFAULT 'low',
				retention_policy TEXT,
				expires_at TEXT,
				metadata TEXT NOT NULL DEFAULT '{}'
			)`,
			`CREATE TABLE IF NOT EXISTS memory_action_logs (
				id TEXT PRIMARY KEY,
				session_id TEXT,
				agent_id TEXT,
				action_type TEXT NOT NULL,
				input TEXT NOT NULL DEFAULT '{}',
				output TEXT NOT NULL DEFAULT '{}',
				status TEXT NOT NULL,
				created_at TEXT NOT NULL,
				previous_hash TEXT,
				entry_hash TEXT
			)`,
			`CREATE TABLE IF NOT EXISTS memory_audit_logs (
				id TEXT PRIMARY KEY,
				actor_id TEXT NOT NULL,
				action TEXT NOT NULL,
				memory_id TEXT,
				before TEXT,
				after TEXT,
				created_at TEXT NOT NULL,
				previous_hash TEXT,
				entry_hash TEXT
			)`,
			"CREATE INDEX IF NOT EXISTS idx_memory_sources_type ON memory_sources (source_type, created_at)",
			"CREATE INDEX IF NOT EXISTS idx_memory_nodes_type_name ON memory_nodes (node_type, name)",
			"CREATE INDEX IF NOT EXISTS idx_memory_relations_from ON memory_relations (from_node_id, edge_type)",
			"CREATE INDEX IF NOT EXISTS idx_memory_relations_to ON memory_relations (to_node_id, edge_type)",
			"CREATE INDEX IF NOT EXISTS idx_memory_permissions_sensitivity ON memory_permissions (sensitivity)",
			"CREATE INDEX IF NOT EXISTS idx_memory_audit_memory ON memory_audit_logs (memory_id, created_at)",
		];
		for (const statement of statements) await this.deps.db.run(statement);
		await this.ensureLogHashColumns();
	}

	private async ensureLogHashColumns(): Promise<void> {
		await this.ensureColumn("memory_action_logs", "previous_hash", "TEXT");
		await this.ensureColumn("memory_action_logs", "entry_hash", "TEXT");
		await this.ensureColumn("memory_audit_logs", "previous_hash", "TEXT");
		await this.ensureColumn("memory_audit_logs", "entry_hash", "TEXT");
	}

	private async ensureColumn(
		table: "memory_action_logs" | "memory_audit_logs",
		column: string,
		definition: string,
	): Promise<void> {
		const columns = await this.deps.db.all<{ name: string }>(
			`PRAGMA table_info(${table})`,
		);
		if (columns.some((existing) => existing.name === column)) return;
		await this.deps.db.run(
			`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,
		);
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
		const embedding = await this.deps.embeddingFn(
			normalized.content,
			"document",
		);
		const duplicate = await this.findDuplicate(normalized, embedding);
		if (duplicate) {
			const duplicateConfidence = Number(duplicate.metadata.confidence ?? 0.5);
			const duplicateExpiresAt = this.computeExpiresAt(normalized);
			const reinforced: MemoryItem = {
				...duplicate,
				importance: Math.max(
					duplicate.importance,
					normalized.importance ?? this.computeImportance(normalized),
				),
				lastAccessed: now,
				metadata: {
					...duplicate.metadata,
					entities:
						normalized.metadata?.entities ?? duplicate.metadata.entities,
					relations:
						normalized.metadata?.relations ?? duplicate.metadata.relations,
					permissions: normalized.permissions ?? duplicate.metadata.permissions,
					sensitivity: normalized.permissions
						? this.getSensitivity(normalized)
						: duplicate.metadata.sensitivity,
					expiresAt: duplicateExpiresAt ?? duplicate.metadata.expiresAt,
					confidence: Math.min(1, duplicateConfidence + 0.05),
					duplicateReinforcedAt: now.toISOString(),
					duplicateReinforcementCount:
						Number(duplicate.metadata.duplicateReinforcementCount ?? 0) + 1,
				},
			};
			await this.deps.ltm.update(reinforced);
			await this.recordEvidence(duplicate.id, normalized);
			await this.recordStructuredSource(
				duplicate.id,
				normalized,
				this.normalizeSource(normalized.source, normalized),
			);
			await this.recordPermissions(
				duplicate.id,
				normalized.permissions,
				duplicateExpiresAt ?? duplicate.metadata.expiresAt,
			);
			await this.upsertEntitiesAndRelations(reinforced, normalized);
			await this.applyDeclaredRelations(reinforced, normalized);
			await this.updateCoverage(normalized, reinforced);
			await this.recordAudit({
				actorId: normalized.scope.userId ?? "system",
				action: "duplicate_reinforced",
				memoryId: duplicate.id,
				before: this.auditSnapshot(duplicate),
				after: this.auditSnapshot(reinforced),
			});
			await this.recordActionLog({
				sessionId: normalized.scope.sessionId,
				agentId: normalized.scope.agentRole,
				actionType: "memory.write",
				input: { type: normalized.type, duplicate: true },
				output: { memoryId: duplicate.id, reason: "duplicate_reinforced" },
				status: "completed",
			});
			return {
				accepted: true,
				memoryId: duplicate.id,
				reason: "duplicate_reinforced",
				validation,
			};
		}
		const memoryId = nanoid();
		const expiresAt = this.computeExpiresAt(normalized);
		let item: MemoryItem = {
			id: memoryId,
			type: normalized.type,
			content: normalized.content,
			embedding,
			importance: normalized.importance ?? this.computeImportance(normalized),
			accessCount: 0,
			lastAccessed: now,
			createdAt: now,
			associations: [],
			source: this.normalizeSource(normalized.source, normalized),
			metadata: {
				...normalized.metadata,
				tenantId: normalized.scope.tenantId,
				userId: normalized.scope.userId,
				projectId: normalized.scope.projectId,
				agentRole: normalized.scope.agentRole,
				sourceTrust: normalized.sourceTrust,
				confidence: normalized.confidence ?? validation.confidenceCap,
				status: "active",
				sensitivity: this.getSensitivity(normalized),
				permissions: normalized.permissions,
				expiresAt,
			},
		};

		await this.deps.ltm.store(item);
		await this.recordEvidence(memoryId, normalized);
		await this.recordStructuredSource(memoryId, normalized, item.source);
		await this.recordPermissions(memoryId, normalized.permissions, expiresAt);
		await this.upsertEntitiesAndRelations(item, normalized);
		await this.applyDeclaredRelations(item, normalized);
		item = await this.detectStructuredContradictions(item, normalized);
		await this.updateCoverage(normalized, item);
		await this.recordAudit({
			actorId: normalized.scope.userId ?? "system",
			action: "created",
			memoryId,
			after: this.auditSnapshot(item),
		});
		await this.recordActionLog({
			sessionId: normalized.scope.sessionId,
			agentId: normalized.scope.agentRole,
			actionType: "memory.write",
			input: { type: normalized.type },
			output: { memoryId },
			status: "completed",
		});
		return {
			accepted: true,
			memoryId,
			validation,
		};
	}

	private normalizeSource(
		source: MemorySource | undefined,
		candidate: MemoryCandidate,
	): MemorySource {
		return {
			...source,
			sourceType: source?.sourceType ?? candidate.evidence?.sourceType,
			sourceId: source?.sourceId ?? candidate.evidence?.sourceId,
			quotedEvidence:
				this.protectMemoryText(
					source?.quotedEvidence ??
						candidate.evidence?.excerpt ??
						candidate.content,
				) ?? undefined,
			conversationId:
				source?.conversationId ?? candidate.source?.conversationId,
			taskId:
				source?.taskId ?? candidate.source?.taskId ?? candidate.scope.taskId,
			channelId:
				source?.channelId ??
				candidate.source?.channelId ??
				candidate.scope.sessionId,
			authorityScore:
				source?.authorityScore ??
				this.sourceTrustToAuthority(candidate.sourceTrust),
			retrievedAt: source?.retrievedAt ?? new Date().toISOString(),
		};
	}

	private getSensitivity(candidate: MemoryCandidate): MemorySensitivity {
		const explicit =
			candidate.permissions?.sensitivity ?? candidate.metadata?.sensitivity;
		return explicit === "medium" ||
			explicit === "high" ||
			explicit === "restricted"
			? explicit
			: "low";
	}

	private getStoredSensitivity(item: MemoryItem): MemorySensitivity {
		const sensitivity = item.metadata.sensitivity;
		return sensitivity === "medium" ||
			sensitivity === "high" ||
			sensitivity === "restricted"
			? sensitivity
			: "low";
	}

	private computeExpiresAt(candidate: MemoryCandidate): string | undefined {
		const explicit = candidate.permissions?.retention?.expiresAt;
		if (explicit) return explicit;
		if (typeof candidate.metadata?.expiresAt === "string") {
			return candidate.metadata.expiresAt;
		}
		const retention = candidate.permissions?.retention;
		if (retention?.policy === "expire_after_days" && retention.days) {
			const expiresAt = new Date();
			expiresAt.setUTCDate(expiresAt.getUTCDate() + retention.days);
			return expiresAt.toISOString();
		}
		return undefined;
	}

	private sourceTrustToAuthority(trust: MemorySourceTrustLevel): number {
		return TRUST_RANK[trust] / TRUST_RANK.system;
	}

	private async recordStructuredSource(
		memoryId: string,
		candidate: MemoryCandidate,
		source: MemorySource,
	): Promise<void> {
		const sourceId =
			source.sourceId ?? candidate.evidence?.sourceId ?? `src_${memoryId}`;
		const now = new Date().toISOString();
		await this.deps.db.run(
			`INSERT OR REPLACE INTO memory_sources
				(id, source_type, title, uri, quoted_evidence, authority_score, created_at, metadata)
				VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM memory_sources WHERE id = ?), ?), ?)`,
			[
				sourceId,
				source.sourceType ??
					candidate.evidence?.sourceType ??
					"agent_observation",
				source.title ?? null,
				source.uri ?? null,
				this.protectMemoryText(
					this.unprotectMemoryText(source.quotedEvidence) ??
						candidate.evidence?.excerpt ??
						candidate.content,
					2000,
				),
				clamp01(
					source.authorityScore ??
						this.sourceTrustToAuthority(candidate.sourceTrust),
				),
				sourceId,
				now,
				JSON.stringify({
					...source.metadata,
					publishedAt: source.publishedAt,
					retrievedAt: source.retrievedAt,
					sourceTrust: candidate.sourceTrust,
				}),
			],
		);
		await this.deps.db.run(
			"INSERT OR IGNORE INTO memory_source_links (memory_id, source_id) VALUES (?, ?)",
			[memoryId, sourceId],
		);
	}

	private async recordPermissions(
		memoryId: string,
		permissions: MemoryPermissions | undefined,
		expiresAt?: unknown,
	): Promise<void> {
		if (!permissions) return;
		const effectiveExpiresAt =
			typeof expiresAt === "string"
				? expiresAt
				: permissions.retention?.expiresAt;
		await this.deps.db.run(
			`INSERT OR REPLACE INTO memory_permissions
				(memory_id, visible_to_agents, hidden_from_agents, visible_to_users,
				requires_user_confirmation_before_use, sensitivity, retention_policy, expires_at, metadata)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				memoryId,
				JSON.stringify(permissions.visibleToAgents ?? []),
				JSON.stringify(permissions.hiddenFromAgents ?? []),
				JSON.stringify(permissions.visibleToUsers ?? []),
				permissions.requiresUserConfirmationBeforeUse ? 1 : 0,
				permissions.sensitivity ?? "low",
				permissions.retention?.policy ?? null,
				effectiveExpiresAt ?? null,
				JSON.stringify({ retention: permissions.retention ?? null }),
			],
		);
	}

	private async upsertEntitiesAndRelations(
		item: MemoryItem,
		candidate: MemoryCandidate,
	): Promise<void> {
		const entities = this.readEntityDescriptors(candidate.metadata?.entities);
		const entityIds = new Map<string, string>();
		for (const entity of entities) {
			const nodeId = await this.upsertNode(entity);
			entityIds.set(entity.name.toLowerCase(), nodeId);
			await this.deps.db.run(
				"INSERT OR IGNORE INTO memory_node_links (memory_id, node_id, relation) VALUES (?, ?, ?)",
				[item.id, nodeId, "mentions"],
			);
			await this.createEdge(
				item.id,
				nodeId,
				"mentions",
				entity.confidence ?? 0.65,
			);
		}

		const relations = this.readRelationDescriptors(
			candidate.metadata?.relations,
		);
		for (const relation of relations) {
			const from = entityIds.get(relation.from.toLowerCase());
			const to = entityIds.get(relation.to.toLowerCase());
			if (!from || !to) continue;
			const now = new Date().toISOString();
			await this.deps.db.run(
				`INSERT INTO memory_relations
					(id, from_node_id, edge_type, to_node_id, context, confidence, status, created_at, updated_at, last_validated_at, metadata)
					VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
				[
					nanoid(),
					from,
					relation.type,
					to,
					relation.context ?? null,
					relation.confidence ?? 0.65,
					now,
					now,
					now,
					JSON.stringify({ memoryId: item.id }),
				],
			);
		}
	}

	private async upsertNode(entity: {
		name: string;
		type: string;
		summary?: string;
		confidence?: number;
	}): Promise<string> {
		const existing = await this.deps.db.get<{ id: string }>(
			"SELECT id FROM memory_nodes WHERE node_type = ? AND name = ? LIMIT 1",
			[entity.type, entity.name],
		);
		const now = new Date().toISOString();
		if (existing) {
			await this.deps.db.run(
				"UPDATE memory_nodes SET summary = COALESCE(?, summary), confidence = MAX(confidence, ?), updated_at = ? WHERE id = ?",
				[entity.summary ?? null, entity.confidence ?? 0.5, now, existing.id],
			);
			return existing.id;
		}

		const id = `node_${nanoid()}`;
		await this.deps.db.run(
			`INSERT INTO memory_nodes (id, node_type, name, summary, confidence, status, created_at, updated_at, metadata)
				VALUES (?, ?, ?, ?, ?, 'active', ?, ?, '{}')`,
			[
				id,
				entity.type,
				entity.name,
				entity.summary ?? null,
				entity.confidence ?? 0.5,
				now,
				now,
			],
		);
		return id;
	}

	async read(
		query: string,
		context: MemoryReadContext,
		budgetTokens: number,
	): Promise<MemoryPack> {
		await this.initialize();
		const startedAt = Date.now();
		const normalizedContext = this.normalizeContext(context);
		const topicLabel = this.topicLabel(query);
		const coverage = await this.getCoverage(
			normalizedContext.tenantId,
			normalizedContext.userId,
			topicLabel,
		);
		const embedding = await this.deps.embeddingFn(query, "query");
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
		const filtered = this.deduplicateScoredMemories([
			...hybridResults.filter((memory) =>
				this.matchesContext(memory.item, normalizedContext),
			),
			...(await this.retrieveExactIdentifierMatches(query, normalizedContext)),
		]);
		const enriched = await this.applyRetrievalSignals(
			query,
			filtered,
			normalizedContext,
		);
		const uncertainty = this.uncertaintyEstimator.estimate(enriched, coverage);
		const selected = this.applyTokenBudget(enriched, budgetTokens);
		if (normalizedContext.trackUsage !== false) {
			await this.recordReadUsage(selected, normalizedContext);
		}
		const tokenBudgetUsed = selected.reduce(
			(total, memory) => total + estimateTokens(memory.item.content),
			0,
		);

		const graphRelations = normalizedContext.includeGraph
			? await this.getGraphRelations(selected.map((memory) => memory.item.id))
			: [];

		const pack: MemoryPack = {
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
			verificationSummary: this.buildVerificationSummary(selected),
			sourceSummary: this.buildSourceSummary(selected),
			entityMatches: this.buildEntityMatches(query, selected),
			graphRelations,
		};
		await this.recordActionLog({
			sessionId: normalizedContext.sessionId,
			agentId: normalizedContext.agentRole,
			actionType: "memory.read",
			input: {
				query: query.slice(0, 200),
				budgetTokens,
				includeSources: normalizedContext.includeSources === true,
				includeGraph: normalizedContext.includeGraph === true,
			},
			output: {
				selectedCount: selected.length,
				redactedCount: selected.filter(
					(memory) => memory.item.metadata.redacted,
				).length,
				durationMs: Date.now() - startedAt,
				uncertaintyLevel: pack.uncertaintyLevel,
			},
			status: "completed",
		});
		return pack;
	}

	async forget(memoryId: string, reason: string): Promise<void> {
		await this.initialize();
		const item = await this.deps.ltm.getById(memoryId);
		if (!item) return;
		await this.deps.db.transaction(async () => {
			for (const statement of [
				"DELETE FROM memory_evidence WHERE memory_id = ?",
				"DELETE FROM memory_usage WHERE memory_id = ?",
				"DELETE FROM memory_versions WHERE memory_id = ?",
				"DELETE FROM memory_permissions WHERE memory_id = ?",
				"DELETE FROM memory_source_links WHERE memory_id = ?",
				"DELETE FROM memory_node_links WHERE memory_id = ?",
				"DELETE FROM memory_edges WHERE source_id = ? OR target_id = ?",
			]) {
				await this.deps.db.run(
					statement,
					statement.includes(" OR target_id") ? [memoryId, memoryId] : [memoryId],
				);
			}
			await this.deps.ltm.forget(memoryId);
		});
		await this.recordAudit({
			actorId: "user",
			action: "forgotten",
			memoryId,
			before: this.auditSnapshot(item),
			after: { deleted: true },
		});
		await this.recordActionLog({
			actionType: "memory.forget",
			input: { memoryId, reasonCode: reason ? "user_requested" : "unspecified" },
			output: { memoryId, status: "physically_deleted" },
			status: "completed",
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

		if (feedback.feedbackType === "explicit_delete") {
			await this.forget(item.id, "explicit_delete");
			return {
				memoryId: item.id,
				previousConfidence,
				nextConfidence,
				previousStatus,
				nextStatus,
				versionCreated: false,
			};
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
			updated.embedding = await this.deps.embeddingFn(nextContent, "document");
		}
		await this.deps.ltm.update(updated);
		await this.recordAudit({
			actorId: feedback.changedBy ?? "user",
			action: `feedback:${feedback.feedbackType}`,
			memoryId: item.id,
			before: this.auditSnapshot(item),
			after: this.auditSnapshot(updated),
		});
		await this.recordActionLog({
			sessionId: feedback.sessionId,
			agentId: feedback.agentRole,
			actionType: "memory.feedback",
			input: {
				memoryId: item.id,
				feedbackType: feedback.feedbackType,
				outcome: feedback.outcome,
			},
			output: {
				memoryId: item.id,
				previousConfidence,
				nextConfidence,
				nextStatus,
			},
			status: "completed",
		});

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
			if (isAssistantMemoryDenialEcho(item.content)) {
				await this.updateStatus(item, "expired", "assistant_denial_echo");
				report.expired += 1;
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

		await this.recordActionLog({
			actionType: "memory.retention_run",
			input: {
				unusedDays,
				lowImportanceThreshold,
				contradictionGraceDays,
				now: now.toISOString(),
			},
			output: { ...report },
			status: "completed",
		});

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
					excerpt: this.unprotectMemoryText(row.excerpt) ?? undefined,
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

	async verify(memoryIds: string[]): Promise<MemoryVerificationReport[]> {
		await this.initialize();
		const reports: MemoryVerificationReport[] = [];
		for (const memoryId of Array.from(new Set(memoryIds.filter(Boolean)))) {
			const item = await this.deps.ltm.getById(memoryId);
			if (!item) continue;
			const contradictionPenalty = await this.getContradictionPenalty(item.id);
			const signals = {
				semanticScore: 1,
				confidence: clamp01(Number(item.metadata.confidence ?? 0.5)),
				sourceAuthority: clamp01(
					Number(item.source.authorityScore ?? item.metadata.sourceAuthority) ||
						this.sourceTrustToAuthority(
							(item.metadata.sourceTrust as MemorySourceTrustLevel) ??
								"external",
						),
				),
				freshness: this.computeFreshness(item),
				entityMatch: 0,
				contradictionPenalty,
				permissionPenalty: 0,
			};
			reports.push({
				memoryId: item.id,
				content: item.content,
				type: item.type,
				verification: await this.verifyMemory(item, signals),
				sensitivity: this.getSensitivityFromItem(item),
				sources: await this.getSourcesForMemory(item.id, item.source),
			});
		}
		return reports;
	}

	async getSources(memoryId: string): Promise<MemorySource[]> {
		await this.initialize();
		const item = await this.deps.ltm.getById(memoryId);
		if (!item) return [];
		return this.getSourcesForMemory(memoryId, item.source);
	}

	async canReadMemory(
		memoryId: string,
		context: MemoryReadContext,
	): Promise<boolean> {
		await this.initialize();
		const item = await this.deps.ltm.getById(memoryId);
		return Boolean(
			item && this.canExposeMemory(item, this.normalizeContext(context)),
		);
	}

	async filterReadableMemoryIds(
		memoryIds: string[],
		context: MemoryReadContext,
	): Promise<string[]> {
		await this.initialize();
		const normalizedContext = this.normalizeContext(context);
		const readable: string[] = [];
		let deniedCount = 0;
		let sensitiveDeniedCount = 0;
		let confirmationDeniedCount = 0;
		for (const memoryId of Array.from(new Set(memoryIds.filter(Boolean)))) {
			const item = await this.deps.ltm.getById(memoryId);
			if (item && this.canExposeMemory(item, normalizedContext)) {
				readable.push(memoryId);
			} else if (item) {
				deniedCount++;
				const sensitivity = this.getSensitivityFromItem(item);
				if (sensitivity === "high" || sensitivity === "restricted") {
					sensitiveDeniedCount++;
				}
				if (this.requiresConfirmation(item, normalizedContext)) {
					confirmationDeniedCount++;
				}
			}
		}
		if (deniedCount > 0) {
			await this.recordActionLog({
				sessionId: normalizedContext.sessionId,
				agentId: normalizedContext.agentRole,
				actionType: "memory.access_denied",
				input: {
					requestedCount: memoryIds.length,
					userId: normalizedContext.userId,
					agentRole: normalizedContext.agentRole,
				},
				output: {
					deniedCount,
					sensitiveDeniedCount,
					confirmationDeniedCount,
				},
				status: "completed",
			});
		}
		return readable;
	}

	async getGraph(memoryIds: string[]): Promise<MemoryGraphSnapshot> {
		await this.initialize();
		const uniqueMemoryIds = Array.from(new Set(memoryIds.filter(Boolean)));
		const nodes = new Map<string, MemoryGraphSnapshot["nodes"][number]>();
		const relations = new Map<
			string,
			MemoryGraphSnapshot["relations"][number]
		>();

		for (const memoryId of uniqueMemoryIds) {
			const item = await this.deps.ltm.getById(memoryId);
			if (!item) continue;
			nodes.set(item.id, {
				id: item.id,
				type: `memory:${item.type}`,
				name: item.content.slice(0, 120),
				summary: item.content,
				confidence: Number(item.metadata.confidence ?? 0.5),
				status: this.getMemoryStatus(item),
				metadata: item.metadata,
			});
		}

		if (uniqueMemoryIds.length === 0) {
			return { memoryIds: [], nodes: [], relations: [] };
		}

		const memoryPlaceholders = uniqueMemoryIds.map(() => "?").join(", ");
		const linkedNodes = await this.deps.db.all<{
			memory_id: string;
			node_id: string;
			relation: string;
			node_type: string;
			name: string;
			summary: string | null;
			confidence: number;
			status: string;
			metadata: string;
		}>(
			`SELECT l.memory_id, l.node_id, l.relation, n.node_type, n.name, n.summary,
				n.confidence, n.status, n.metadata
				FROM memory_node_links l
				JOIN memory_nodes n ON n.id = l.node_id
				WHERE l.memory_id IN (${memoryPlaceholders})`,
			uniqueMemoryIds,
		);

		for (const row of linkedNodes) {
			nodes.set(row.node_id, {
				id: row.node_id,
				type: row.node_type,
				name: row.name,
				summary: row.summary ?? undefined,
				confidence: row.confidence,
				status: row.status,
				metadata: parseJsonObject(row.metadata),
			});
			relations.set(`${row.memory_id}:${row.relation}:${row.node_id}`, {
				id: `${row.memory_id}:${row.relation}:${row.node_id}`,
				fromId: row.memory_id,
				toId: row.node_id,
				type: this.normalizeRelationType(row.relation),
				confidence: row.confidence,
				status: "active",
				metadata: {},
			});
		}

		const allNodeIds = Array.from(nodes.keys());
		const allPlaceholders = allNodeIds.map(() => "?").join(", ");
		if (allNodeIds.length > 0) {
			const memoryEdges = await this.deps.db.all<{
				id: string;
				source_id: string;
				target_id: string;
				type: string;
				confidence: number;
			}>(
				`SELECT id, source_id, target_id, type, confidence FROM memory_edges
					WHERE source_id IN (${allPlaceholders}) OR target_id IN (${allPlaceholders})`,
				[...allNodeIds, ...allNodeIds],
			);
			for (const row of memoryEdges) {
				relations.set(row.id, {
					id: row.id,
					fromId: row.source_id,
					toId: row.target_id,
					type: this.normalizeRelationType(row.type),
					confidence: row.confidence,
					status: "active",
					metadata: {},
				});
			}

			const semanticRelations = await this.deps.db.all<{
				id: string;
				from_node_id: string;
				to_node_id: string;
				edge_type: string;
				context: string | null;
				confidence: number;
				status: string;
				metadata: string;
			}>(
				`SELECT id, from_node_id, to_node_id, edge_type, context, confidence, status, metadata
					FROM memory_relations
					WHERE from_node_id IN (${allPlaceholders}) OR to_node_id IN (${allPlaceholders})`,
				[...allNodeIds, ...allNodeIds],
			);
			for (const row of semanticRelations) {
				relations.set(row.id, {
					id: row.id,
					fromId: row.from_node_id,
					toId: row.to_node_id,
					type: this.normalizeRelationType(row.edge_type),
					confidence: row.confidence,
					context: row.context ?? undefined,
					status: row.status,
					metadata: parseJsonObject(row.metadata),
				});
			}
		}

		return {
			memoryIds: uniqueMemoryIds,
			nodes: Array.from(nodes.values()),
			relations: Array.from(relations.values()),
		};
	}

	async getGraphByEntity(
		entityName: string,
		context: MemoryReadContext,
		options: MemoryGraphTraversalOptions = {},
	): Promise<MemoryGraphSnapshot> {
		await this.initialize();
		const normalizedEntity = entityName.trim().toLowerCase();
		if (!normalizedEntity) return { memoryIds: [], nodes: [], relations: [] };

		const nodes = await this.deps.db.all<{ id: string }>(
			"SELECT id FROM memory_nodes WHERE lower(name) = ? ORDER BY confidence DESC LIMIT 20",
			[normalizedEntity],
		);
		if (nodes.length === 0) return { memoryIds: [], nodes: [], relations: [] };

		const linkedMemoryIds = await this.getMemoryIdsLinkedToNodeIds(
			nodes.map((node) => node.id),
		);
		const readableMemoryIds = await this.filterReadableMemoryIds(
			linkedMemoryIds,
			context,
		);
		return this.traverseGraph(readableMemoryIds, context, options);
	}

	async traverseGraph(
		memoryIds: string[],
		context: MemoryReadContext,
		options: MemoryGraphTraversalOptions = {},
	): Promise<MemoryGraphSnapshot> {
		await this.initialize();
		const normalizedContext = this.normalizeContext(context);
		const maxDepth = this.normalizeDepth(options.maxDepth, 2, 4);
		const maxNodes = this.normalizeLimit(options.maxNodes ?? 30, 30, 100);
		const allowedRelationTypes = new Set(options.relationTypes ?? []);
		const seedMemoryIds = await this.filterReadableMemoryIds(
			memoryIds,
			normalizedContext,
		);
		const visitedMemoryIds = new Set(seedMemoryIds);
		let frontier = seedMemoryIds;
		const paths = new Map<string, MemoryGraphPath>();

		for (
			let depth = 1;
			depth <= maxDepth &&
			frontier.length > 0 &&
			visitedMemoryIds.size < maxNodes;
			depth++
		) {
			const linkedNodeIds = await this.getNodeIdsLinkedToMemoryIds(frontier);
			const relatedNodeIds = await this.getRelatedNodeIds(
				linkedNodeIds,
				allowedRelationTypes,
			);
			const reachableNodeIds = Array.from(
				new Set([...linkedNodeIds, ...relatedNodeIds]),
			);
			const linkedRows = await this.getMemoryNodeLinks(reachableNodeIds);
			const candidateMemoryIds = linkedRows
				.map((row) => row.memory_id)
				.filter((memoryId) => !visitedMemoryIds.has(memoryId));
			const readableCandidates = await this.filterReadableMemoryIds(
				candidateMemoryIds,
				normalizedContext,
			);
			const nextFrontier: string[] = [];

			for (const memoryId of readableCandidates) {
				if (visitedMemoryIds.size >= maxNodes) break;
				visitedMemoryIds.add(memoryId);
				nextFrontier.push(memoryId);
				const link = linkedRows.find((row) => row.memory_id === memoryId);
				if (link) {
					paths.set(memoryId, {
						fromMemoryId: seedMemoryIds[0] ?? memoryId,
						toMemoryId: memoryId,
						nodeIds: [link.node_id],
						relationIds: [],
						depth,
						explanation: `Reached readable memory through graph node ${link.node_id}.`,
					});
				}
			}

			frontier = nextFrontier;
		}

		const graph = await this.getGraph(Array.from(visitedMemoryIds));
		return { ...graph, paths: Array.from(paths.values()) };
	}

	async listAudit(memoryId?: string, limit = 50): Promise<MemoryAuditEntry[]> {
		await this.initialize();
		const safeLimit = this.normalizeLimit(limit, 50, 200);
		const rows = memoryId
			? await this.deps.db.all<{
					id: string;
					actor_id: string;
					action: string;
					memory_id: string | null;
					before: string | null;
					after: string | null;
					created_at: string;
					previous_hash: string | null;
					entry_hash: string | null;
				}>(
					"SELECT id, actor_id, action, memory_id, before, after, created_at, previous_hash, entry_hash FROM memory_audit_logs WHERE memory_id = ? ORDER BY created_at DESC LIMIT ?",
					[memoryId, safeLimit],
				)
			: await this.deps.db.all<{
					id: string;
					actor_id: string;
					action: string;
					memory_id: string | null;
					before: string | null;
					after: string | null;
					created_at: string;
					previous_hash: string | null;
					entry_hash: string | null;
				}>(
					"SELECT id, actor_id, action, memory_id, before, after, created_at, previous_hash, entry_hash FROM memory_audit_logs ORDER BY created_at DESC LIMIT ?",
					[safeLimit],
				);
		return rows.map((row) => {
			const before = this.unprotectLogJson(row.before);
			const after = this.unprotectLogJson(row.after);
			return {
				id: row.id,
				actorId: row.actor_id,
				action: row.action,
				memoryId: row.memory_id ?? undefined,
				before: before ? parseJsonObject(before) : undefined,
				after: after ? parseJsonObject(after) : undefined,
				createdAt: new Date(row.created_at),
				previousHash: row.previous_hash ?? undefined,
				entryHash: row.entry_hash ?? undefined,
			};
		});
	}

	async listActionLogs(limit = 50): Promise<MemoryActionLogEntry[]> {
		await this.initialize();
		const safeLimit = this.normalizeLimit(limit, 50, 200);
		const rows = await this.deps.db.all<{
			id: string;
			session_id: string | null;
			agent_id: string | null;
			action_type: string;
			input: string;
			output: string;
			status: string;
			created_at: string;
			previous_hash: string | null;
			entry_hash: string | null;
		}>(
			"SELECT id, session_id, agent_id, action_type, input, output, status, created_at, previous_hash, entry_hash FROM memory_action_logs ORDER BY created_at DESC LIMIT ?",
			[safeLimit],
		);
		return rows.map((row) => ({
			id: row.id,
			sessionId: row.session_id ?? undefined,
			agentId: row.agent_id ?? undefined,
			actionType: row.action_type,
			input: parseJsonObject(this.unprotectLogJson(row.input) ?? "{}"),
			output: parseJsonObject(this.unprotectLogJson(row.output) ?? "{}"),
			status: row.status,
			createdAt: new Date(row.created_at),
			previousHash: row.previous_hash ?? undefined,
			entryHash: row.entry_hash ?? undefined,
		}));
	}

	async verifyAuditIntegrity(): Promise<MemoryAuditIntegrityReport> {
		await this.initialize();
		const audit = await this.verifyLogIntegrity("memory_audit_logs");
		const actions = await this.verifyLogIntegrity("memory_action_logs");
		return {
			valid: audit.valid && actions.valid,
			generatedAt: new Date(),
			audit,
			actions,
		};
	}

	async backfillAdvancedMemory(limit = 1000): Promise<MemoryBackfillReport> {
		await this.initialize();
		const safeLimit = this.normalizeLimit(limit, 1000, 10000);
		const items = await this.deps.ltm.listAll(safeLimit);
		const report: MemoryBackfillReport = {
			scanned: 0,
			sourcesLinked: 0,
			permissionsCreated: 0,
			nodesLinked: 0,
			skipped: 0,
		};

		for (const item of items) {
			report.scanned++;
			if (this.getMemoryStatus(item) === "user_deleted") {
				report.skipped++;
				continue;
			}
			const candidate = this.legacyItemToCandidate(item);
			const hadSources = await this.hasRows(
				"memory_source_links",
				"memory_id",
				item.id,
			);
			const hadPermissions = await this.hasRows(
				"memory_permissions",
				"memory_id",
				item.id,
			);
			const hadNodes = await this.hasRows(
				"memory_node_links",
				"memory_id",
				item.id,
			);

			await this.recordStructuredSource(
				item.id,
				candidate,
				this.normalizeSource(item.source, candidate),
			);
			await this.recordPermissions(
				item.id,
				candidate.permissions,
				this.computeExpiresAt(candidate),
			);
			await this.upsertEntitiesAndRelations(item, candidate);

			if (!hadSources) report.sourcesLinked++;
			if (!hadPermissions) report.permissionsCreated++;
			if (
				!hadNodes &&
				(await this.hasRows("memory_node_links", "memory_id", item.id))
			) {
				report.nodesLinked++;
			}
		}

		await this.recordActionLog({
			actionType: "memory.backfill",
			input: { limit: safeLimit },
			output: { ...report },
			status: "completed",
		});
		return report;
	}

	private normalizeCandidate(candidate: MemoryCandidate): MemoryCandidate {
		return {
			...candidate,
			scope: this.normalizeContext(candidate.scope),
			metadata: candidate.metadata ?? {},
		};
	}

	private legacyItemToCandidate(item: MemoryItem): MemoryCandidate {
		const metadata = {
			...item.metadata,
			entities:
				item.metadata.entities ?? this.inferLegacyEntities(item.content),
		};
		return {
			type: item.type,
			content: item.content,
			sourceTrust: this.readSourceTrust(item.metadata.sourceTrust),
			scope: {
				tenantId:
					typeof item.metadata.tenantId === "string"
						? item.metadata.tenantId
						: this.config.defaultTenantId,
				userId:
					typeof item.metadata.userId === "string"
						? item.metadata.userId
						: this.config.defaultUserId,
				projectId:
					typeof item.metadata.projectId === "string"
						? item.metadata.projectId
						: this.config.defaultProjectId,
				agentRole:
					typeof item.metadata.agentRole === "string"
						? item.metadata.agentRole
						: undefined,
				sessionId: item.source.channelId ?? item.source.conversationId,
				taskId: item.source.taskId,
			},
			confidence:
				typeof item.metadata.confidence === "number"
					? item.metadata.confidence
					: 0.55,
			importance: item.importance,
			source: item.source,
			permissions: this.legacyPermissions(item),
			metadata,
			evidence: {
				sourceType: "message",
				sourceId:
					item.source.sourceId ??
					item.source.conversationId ??
					item.source.channelId ??
					item.source.taskId,
				excerpt: item.content.slice(0, 2000),
			},
		};
	}

	private legacyPermissions(item: MemoryItem): MemoryPermissions {
		const existing = item.metadata.permissions;
		if (existing && typeof existing === "object" && !Array.isArray(existing)) {
			return existing as MemoryPermissions;
		}
		return {
			sensitivity: this.getSensitivityFromItem(item),
			retention:
				typeof item.metadata.expiresAt === "string"
					? { policy: "expire_after_days", expiresAt: item.metadata.expiresAt }
					: undefined,
		};
	}

	private readSourceTrust(value: unknown): MemorySourceTrustLevel {
		return value === "system" ||
			value === "agent" ||
			value === "user_explicit" ||
			value === "user_inferred" ||
			value === "external"
			? value
			: "agent";
	}

	private inferLegacyEntities(content: string): Array<{
		name: string;
		type: string;
		confidence: number;
	}> {
		const names = new Set<string>();
		for (const match of content.matchAll(
			/\b[A-ZÁÉÍÓÚÑ][\p{L}\p{N}&_.-]*(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}\p{N}&_.-]*){0,2}\b/gu,
		)) {
			const name = match[0].trim();
			if (name.length >= 3 && !/^(Task|Error|Decision|User)$/i.test(name)) {
				names.add(name);
			}
			if (names.size >= 5) break;
		}
		return Array.from(names).map((name) => ({
			name,
			type: "entity",
			confidence: 0.55,
		}));
	}

	private async hasRows(
		table: string,
		column: string,
		value: string,
	): Promise<boolean> {
		const allowedTables = new Set([
			"memory_source_links",
			"memory_permissions",
			"memory_node_links",
		]);
		if (!allowedTables.has(table) || column !== "memory_id") return false;
		const row = await this.deps.db.get<{ count: number }>(
			`SELECT COUNT(*) as count FROM ${table} WHERE ${column} = ?`,
			[value],
		);
		return Number(row?.count ?? 0) > 0;
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
				this.matchesContext(result.item, context) &&
				!this.claimsConflict(candidate.metadata, result.item.metadata),
		)?.item;
	}

	private claimsConflict(
		candidateMetadata: Record<string, unknown> | undefined,
		existingMetadata: Record<string, unknown> | undefined,
	): boolean {
		const candidateClaim = this.readClaimDescriptor(candidateMetadata);
		const existingClaim = this.readClaimDescriptor(existingMetadata);
		return Boolean(
			candidateClaim &&
				existingClaim &&
				candidateClaim.entity === existingClaim.entity &&
				candidateClaim.key === existingClaim.key &&
				candidateClaim.value !== existingClaim.value,
		);
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
					{
						supersededBy: item.id,
						supersededAt: new Date().toISOString(),
					},
				);
		}

		const contradicts = this.readStringList(candidate.metadata?.contradicts);
		for (const targetId of contradicts) {
			await this.createEdge(item.id, targetId, "contradicts", 0.75);
			const target = await this.deps.ltm.getById(targetId);
			if (target) {
				const updated: MemoryItem = {
					...target,
					metadata: {
						...target.metadata,
						status: "contradicted",
						contradictedBy: item.id,
						contradictedAt: new Date().toISOString(),
					},
				};
				await this.recordVersion(
					target.id,
					target.content,
					"contradicted_by_new_memory",
					"system",
				);
				await this.deps.ltm.update(updated);
				await this.recordAudit({
					actorId: candidate.scope.userId ?? "system",
					action: "status:contradicted",
					memoryId: target.id,
					before: this.auditSnapshot(target),
					after: this.auditSnapshot(updated),
				});
			}
		}

		const supports = this.readStringList(candidate.metadata?.supports);
		for (const targetId of supports) {
			await this.createEdge(item.id, targetId, "supports", 0.7);
		}

		const dependsOn = this.readStringList(candidate.metadata?.dependsOn);
		for (const targetId of dependsOn) {
			await this.createEdge(item.id, targetId, "depends_on", 0.7);
		}
	}

	private async createEdge(
		sourceId: string,
		targetId: string,
		type: MemoryRelationType,
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

	private async detectStructuredContradictions(
		item: MemoryItem,
		candidate: MemoryCandidate,
	): Promise<MemoryItem> {
		const claim = this.readClaimDescriptor(candidate.metadata);
		if (!claim) return item;
		const context = this.normalizeContext(candidate.scope);
		const items = await this.deps.ltm.listAll(1000);
		const currentConfidence = Number(item.metadata.confidence ?? 0.5);
		let currentItem = item;
		for (const existing of items) {
			if (existing.id === item.id) continue;
			if (!this.matchesContext(existing, context)) continue;
			const existingClaim = this.readClaimDescriptor(existing.metadata);
			if (!existingClaim) continue;
			if (existingClaim.key !== claim.key) continue;
			if (existingClaim.entity !== claim.entity) continue;
			if (existingClaim.value === claim.value) continue;
			await this.createEdge(item.id, existing.id, "contradicts", 0.8);
			const existingConfidence = Number(existing.metadata.confidence ?? 0.5);
			if (currentConfidence >= existingConfidence) {
				const updated: MemoryItem = {
					...existing,
					metadata: {
						...existing.metadata,
						status: "contradicted",
						contradictedBy: item.id,
						contradictedAt: new Date().toISOString(),
						autoContradiction: true,
					},
				};
				await this.recordVersion(
					existing.id,
					existing.content,
					"auto_contradicted",
					"system",
				);
				await this.deps.ltm.update(updated);
				await this.recordAudit({
					actorId: context.userId ?? "system",
					action: "auto_contradicted",
					memoryId: existing.id,
					before: this.auditSnapshot(existing),
					after: this.auditSnapshot(updated),
				});
			} else {
				currentItem = {
					...currentItem,
					metadata: {
						...currentItem.metadata,
						status: "contradicted",
						contradictedBy: existing.id,
						contradictedAt: new Date().toISOString(),
						autoContradiction: true,
					},
				};
				await this.recordVersion(
					currentItem.id,
					currentItem.content,
					"auto_contradicted",
					"system",
				);
				await this.deps.ltm.update(currentItem);
				await this.recordAudit({
					actorId: context.userId ?? "system",
					action: "auto_contradicted",
					memoryId: currentItem.id,
					before: this.auditSnapshot(item),
					after: this.auditSnapshot(currentItem),
				});
			}
		}
		return currentItem;
	}

	private readClaimDescriptor(
		metadata: Record<string, unknown> | undefined,
	): { entity: string; key: string; value: string } | undefined {
		if (!metadata) return undefined;
		const claim = metadata.claim;
		if (claim && typeof claim === "object" && !Array.isArray(claim)) {
			const obj = claim as Record<string, unknown>;
			const entity = this.normalizeClaimPart(obj.entity);
			const key = this.normalizeClaimPart(obj.key ?? obj.attribute);
			const value = this.normalizeClaimPart(obj.value);
			if (entity && key && value) return { entity, key, value };
		}
		const entity = this.normalizeClaimPart(metadata.claimEntity);
		const key = this.normalizeClaimPart(metadata.claimKey);
		const value = this.normalizeClaimPart(metadata.claimValue);
		if (entity && key && value) return { entity, key, value };
		return undefined;
	}

	private normalizeClaimPart(value: unknown): string | undefined {
		if (typeof value === "string" && value.trim()) {
			return value.trim().toLowerCase();
		}
		if (typeof value === "number" || typeof value === "boolean") {
			return String(value).toLowerCase();
		}
		return undefined;
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

	private readEntityDescriptors(value: unknown): Array<{
		name: string;
		type: string;
		summary?: string;
		confidence?: number;
	}> {
		if (!Array.isArray(value)) return [];
		const descriptors: Array<{
			name: string;
			type: string;
			summary?: string;
			confidence?: number;
		}> = [];
		for (const entry of value) {
			if (typeof entry === "string" && entry.trim()) {
				descriptors.push({
					name: entry.trim(),
					type: "concept",
					confidence: 0.65,
				});
				continue;
			}
			if (!entry || typeof entry !== "object") continue;
			const obj = entry as Record<string, unknown>;
			const name = typeof obj.name === "string" ? obj.name.trim() : "";
			if (!name) continue;
			descriptors.push({
				name,
				type: typeof obj.type === "string" ? obj.type : "concept",
				summary: typeof obj.summary === "string" ? obj.summary : undefined,
				confidence:
					typeof obj.confidence === "number" ? clamp01(obj.confidence) : 0.65,
			});
		}
		return descriptors;
	}

	private readRelationDescriptors(value: unknown): Array<{
		from: string;
		to: string;
		type: MemoryRelationType;
		context?: string;
		confidence?: number;
	}> {
		if (!Array.isArray(value)) return [];
		const descriptors: Array<{
			from: string;
			to: string;
			type: MemoryRelationType;
			context?: string;
			confidence?: number;
		}> = [];
		for (const entry of value) {
			if (!entry || typeof entry !== "object") continue;
			const obj = entry as Record<string, unknown>;
			const from = typeof obj.from === "string" ? obj.from.trim() : "";
			const to = typeof obj.to === "string" ? obj.to.trim() : "";
			if (!from || !to) continue;
			descriptors.push({
				from,
				to,
				type: this.normalizeRelationType(obj.type),
				context: typeof obj.context === "string" ? obj.context : undefined,
				confidence:
					typeof obj.confidence === "number" ? clamp01(obj.confidence) : 0.65,
			});
		}
		return descriptors;
	}

	private normalizeRelationType(value: unknown): MemoryRelationType {
		const allowed = new Set<MemoryRelationType>([
			"associated",
			"mentions",
			"supports",
			"contradicts",
			"supersedes",
			"derived_from",
			"depends_on",
			"caused",
			"blocked_by",
			"entity_of",
			"same_entity_as",
			"prefers",
			"uses",
			"created",
			"updated",
			"confirmed_by",
		]);
		return typeof value === "string" && allowed.has(value as MemoryRelationType)
			? (value as MemoryRelationType)
			: "associated";
	}

	private async applyRetrievalSignals(
		query: string,
		memories: ScoredMemory[],
		context: MemoryReadContext,
	): Promise<ScoredMemory[]> {
		const queryEntities = this.extractQueryEntities(query);
		const enriched: ScoredMemory[] = [];
		for (const memory of memories) {
			const item = memory.item;
			const confidence = clamp01(Number(item.metadata.confidence ?? 0.5));
			const sourceAuthority = clamp01(
				Number(item.source.authorityScore ?? item.metadata.sourceAuthority) ||
					this.sourceTrustToAuthority(
						(item.metadata.sourceTrust as MemorySourceTrustLevel) ?? "external",
					),
			);
			const freshness = this.computeFreshness(item);
			const entityMatch = this.computeEntityMatch(queryEntities, item);
			const contradictionPenalty = await this.getContradictionPenalty(item.id);
			const requiresConfirmation = this.requiresConfirmation(item, context);
			const permissionPenalty = requiresConfirmation ? 0.2 : 0;
			const adjustedScore =
				memory.score *
					(0.72 + confidence * 0.28) *
					(0.76 + sourceAuthority * 0.24) *
					(0.82 + freshness * 0.18) +
				entityMatch * 0.15 -
				contradictionPenalty -
				permissionPenalty;

			const signals = {
				semanticScore: memory.score,
				confidence,
				sourceAuthority,
				freshness,
				entityMatch,
				contradictionPenalty,
				permissionPenalty,
			};
			const verification = await this.verifyMemory(item, signals);
			enriched.push({
				...memory,
				item: requiresConfirmation
					? this.redactMemoryItem(item, "requires_user_confirmation_before_use")
					: item,
				score: Math.max(0, adjustedScore),
				signals,
				verification,
			});
		}
		return enriched.sort((a, b) => b.score - a.score);
	}

	private redactMemoryItem(item: MemoryItem, reason: string): MemoryItem {
		return {
			...item,
			content: `[Memory withheld: ${reason}]`,
			source: {
				sourceId: item.source.sourceId,
				sourceType: item.source.sourceType,
				title: item.source.title,
				authorityScore: item.source.authorityScore,
			},
			metadata: {
				tenantId: item.metadata.tenantId,
				userId: item.metadata.userId,
				projectId: item.metadata.projectId,
				agentRole: item.metadata.agentRole,
				sourceTrust: item.metadata.sourceTrust,
				confidence: item.metadata.confidence,
				status: item.metadata.status,
				sensitivity: item.metadata.sensitivity,
				permissions: item.metadata.permissions,
				redacted: true,
				redactionReason: reason,
			},
		};
	}

	private extractQueryEntities(query: string): Set<string> {
		const entities = new Set<string>();
		for (const quoted of query.matchAll(/["'“”]([^"'“”]{2,80})["'“”]/g)) {
			entities.add(quoted[1].toLowerCase());
		}
		for (const token of query.match(/\b[A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ-]{2,}\b/g) ??
			[]) {
			entities.add(token.toLowerCase());
		}
		for (const token of query.match(/\b[\w]+[-_][\w-]+\b/g) ?? []) {
			entities.add(token.toLowerCase());
		}
		return entities;
	}

	private computeEntityMatch(
		queryEntities: Set<string>,
		item: MemoryItem,
	): number {
		if (queryEntities.size === 0) return 0;
		const entities = this.readEntityDescriptors(item.metadata.entities).map(
			(entity) => entity.name.toLowerCase(),
		);
		if (entities.length === 0) return 0;
		const matches = entities.filter(
			(entity) =>
				queryEntities.has(entity) ||
				item.content.toLowerCase().includes(entity),
		).length;
		return matches / Math.max(entities.length, queryEntities.size);
	}

	private computeFreshness(item: MemoryItem): number {
		const raw = item.source.publishedAt ?? item.source.retrievedAt;
		const date = raw ? new Date(raw) : item.createdAt;
		const time = Number.isNaN(date.getTime())
			? item.createdAt.getTime()
			: date.getTime();
		const days = Math.max(0, (Date.now() - time) / (1000 * 60 * 60 * 24));
		return Math.exp(-days / 365);
	}

	private async getContradictionPenalty(memoryId: string): Promise<number> {
		const rows = await this.deps.db.all<{ confidence: number }>(
			`SELECT confidence FROM memory_edges
				WHERE (source_id = ? OR target_id = ?) AND type = 'contradicts'`,
			[memoryId, memoryId],
		);
		const strongest = rows.reduce(
			(max, row) => Math.max(max, Number(row.confidence ?? 0)),
			0,
		);
		return Math.min(0.6, strongest * 0.5);
	}

	private requiresConfirmation(
		item: MemoryItem,
		context: MemoryReadContext,
	): boolean {
		const permissions = item.metadata.permissions as
			| MemoryPermissions
			| undefined;
		return Boolean(
			!context.userConfirmed &&
				(permissions?.requiresUserConfirmationBeforeUse ||
					this.getSensitivityFromItem(item) === "restricted"),
		);
	}

	private async verifyMemory(
		item: MemoryItem,
		signals: ScoredMemory["signals"],
	): Promise<NonNullable<ScoredMemory["verification"]>> {
		const sourceIds = await this.getSourceIds(item.id);
		const contradictions = await this.getContradictionIds(item.id);
		const status = this.getVerificationStatus(
			item,
			signals,
			sourceIds,
			contradictions,
		);
		return {
			status,
			confidence: clamp01(
				((signals?.confidence ?? 0.5) + (signals?.sourceAuthority ?? 0.5)) / 2 -
					(signals?.contradictionPenalty ?? 0),
			),
			signals: this.describeSignals(signals, sourceIds, contradictions),
			sourceIds,
			contradictions,
			recommendation:
				status === "supported"
					? "use"
					: status === "conflict" || status === "restricted"
						? "ask_user"
						: status === "expired"
							? "ignore"
							: "verify",
		};
	}

	private getVerificationStatus(
		item: MemoryItem,
		signals: ScoredMemory["signals"],
		sourceIds: string[],
		contradictions: string[],
	): NonNullable<ScoredMemory["verification"]>["status"] {
		if (this.getMemoryStatus(item) === "expired") return "expired";
		if (this.getSensitivityFromItem(item) === "restricted") return "restricted";
		if ((signals?.permissionPenalty ?? 0) > 0) return "restricted";
		if (
			contradictions.length > 0 ||
			(signals?.contradictionPenalty ?? 0) > 0.25
		)
			return "conflict";
		if (sourceIds.length === 0) return "unverified";
		if (
			(signals?.confidence ?? 0) >= 0.75 &&
			(signals?.sourceAuthority ?? 0) >= 0.6
		)
			return "supported";
		return "weak";
	}

	private getSensitivityFromItem(item: MemoryItem): MemorySensitivity {
		const permissions = item.metadata.permissions as
			| MemoryPermissions
			| undefined;
		const sensitivity = permissions?.sensitivity ?? item.metadata.sensitivity;
		return sensitivity === "medium" ||
			sensitivity === "high" ||
			sensitivity === "restricted"
			? sensitivity
			: "low";
	}

	private describeSignals(
		signals: ScoredMemory["signals"],
		sourceIds: string[],
		contradictions: string[],
	): string[] {
		const result: string[] = [];
		if (sourceIds.length > 0) result.push("has_source");
		if ((signals?.confidence ?? 0) >= 0.75) result.push("high_confidence");
		if ((signals?.sourceAuthority ?? 0) >= 0.7)
			result.push("authoritative_source");
		if ((signals?.freshness ?? 0) < 0.35) result.push("stale_source");
		if ((signals?.entityMatch ?? 0) > 0) result.push("entity_match");
		if (contradictions.length > 0) result.push("has_contradiction");
		return result;
	}

	private async getSourceIds(memoryId: string): Promise<string[]> {
		const rows = await this.deps.db.all<{ source_id: string }>(
			`SELECT source_id FROM memory_source_links WHERE memory_id = ?
			 UNION
			 SELECT source_id FROM memory_evidence WHERE memory_id = ? AND source_id IS NOT NULL`,
			[memoryId, memoryId],
		);
		return rows.map((row) => row.source_id).filter(Boolean);
	}

	private async getSourcesForMemory(
		memoryId: string,
		fallback: MemorySource,
	): Promise<MemorySource[]> {
		const rows = await this.deps.db.all<{
			id: string;
			source_type: string;
			title: string | null;
			uri: string | null;
			quoted_evidence: string | null;
			authority_score: number;
			created_at: string;
			metadata: string;
		}>(
			`SELECT s.* FROM memory_sources s
				JOIN memory_source_links l ON l.source_id = s.id
				WHERE l.memory_id = ?
				ORDER BY s.authority_score DESC, s.created_at DESC`,
			[memoryId],
		);
		if (rows.length === 0)
			return fallback ? [this.unprotectMemorySource(fallback)] : [];
		return rows.map((row) => {
			const metadata = parseJsonObject(row.metadata);
			return {
				sourceId: row.id,
				sourceType: row.source_type as MemorySource["sourceType"],
				title: row.title ?? undefined,
				uri: row.uri ?? undefined,
				quotedEvidence:
					this.unprotectMemoryText(row.quoted_evidence) ?? undefined,
				authorityScore: row.authority_score,
				retrievedAt:
					typeof metadata.retrievedAt === "string"
						? metadata.retrievedAt
						: row.created_at,
				publishedAt:
					typeof metadata.publishedAt === "string"
						? metadata.publishedAt
						: undefined,
				metadata,
			};
		});
	}

	private async recordAudit(entry: {
		actorId: string;
		action: string;
		memoryId?: string;
		before?: Record<string, unknown>;
		after?: Record<string, unknown>;
	}): Promise<void> {
		const id = nanoid();
		const createdAt = new Date().toISOString();
		const before = this.protectLogJson(
			entry.before ? JSON.stringify(entry.before) : null,
		);
		const after = this.protectLogJson(
			entry.after ? JSON.stringify(entry.after) : null,
		);
		const previousHash = await this.latestLogHash("memory_audit_logs");
		const entryHash = this.hashAuditLog({
			id,
			actorId: entry.actorId,
			action: entry.action,
			memoryId: entry.memoryId ?? null,
			before,
			after,
			createdAt,
			previousHash,
		});
		await this.deps.db.run(
			`INSERT INTO memory_audit_logs (id, actor_id, action, memory_id, before, after, created_at, previous_hash, entry_hash)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				entry.actorId,
				entry.action,
				entry.memoryId ?? null,
				before,
				after,
				createdAt,
				previousHash,
				entryHash,
			],
		);
	}

	private async recordActionLog(entry: {
		sessionId?: string;
		agentId?: string;
		actionType: string;
		input: Record<string, unknown>;
		output: Record<string, unknown>;
		status: string;
	}): Promise<void> {
		const id = nanoid();
		const createdAt = new Date().toISOString();
		const input = this.protectLogJson(JSON.stringify(entry.input)) ?? "{}";
		const output = this.protectLogJson(JSON.stringify(entry.output)) ?? "{}";
		const previousHash = await this.latestLogHash("memory_action_logs");
		const entryHash = this.hashActionLog({
			id,
			sessionId: entry.sessionId ?? null,
			agentId: entry.agentId ?? null,
			actionType: entry.actionType,
			input,
			output,
			status: entry.status,
			createdAt,
			previousHash,
		});
		await this.deps.db.run(
			`INSERT INTO memory_action_logs (id, session_id, agent_id, action_type, input, output, status, created_at, previous_hash, entry_hash)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				entry.sessionId ?? null,
				entry.agentId ?? null,
				entry.actionType,
				input,
				output,
				entry.status,
				createdAt,
				previousHash,
				entryHash,
			],
		);
	}

	private async latestLogHash(
		table: "memory_audit_logs" | "memory_action_logs",
	): Promise<string | null> {
		const row = await this.deps.db.get<{ entry_hash: string | null }>(
			`SELECT entry_hash FROM ${table} WHERE entry_hash IS NOT NULL ORDER BY rowid DESC LIMIT 1`,
		);
		return row?.entry_hash ?? null;
	}

	private hashAuditLog(entry: {
		id: string;
		actorId: string;
		action: string;
		memoryId: string | null;
		before: string | null;
		after: string | null;
		createdAt: string;
		previousHash: string | null;
	}): string {
		return hashStableObject({ table: "memory_audit_logs", ...entry });
	}

	private hashActionLog(entry: {
		id: string;
		sessionId: string | null;
		agentId: string | null;
		actionType: string;
		input: string;
		output: string;
		status: string;
		createdAt: string;
		previousHash: string | null;
	}): string {
		return hashStableObject({ table: "memory_action_logs", ...entry });
	}

	private protectLogJson(value: string | null): string | null {
		if (!value) return value;
		const key = this.logEncryptionKey();
		return key ? `${MEMORY_ENCRYPTION_PREFIX}${encrypt(value, key)}` : value;
	}

	private unprotectLogJson(value: string | null): string | null {
		if (!value?.startsWith(MEMORY_ENCRYPTION_PREFIX)) return value;
		const key = this.logEncryptionKey();
		if (!key) {
			return JSON.stringify({ encrypted: true, unavailable: true });
		}
		try {
			return decrypt(value.slice(MEMORY_ENCRYPTION_PREFIX.length), key);
		} catch {
			return JSON.stringify({ encrypted: true, unavailable: true });
		}
	}

	private protectMemoryText(
		value: string | null | undefined,
		maxLength?: number,
	): string | null {
		if (!value) return value ?? null;
		const plain = maxLength ? value.slice(0, maxLength) : value;
		const key = this.logEncryptionKey();
		if (!key || plain.startsWith(MEMORY_ENCRYPTION_PREFIX)) return plain;
		return `${MEMORY_ENCRYPTION_PREFIX}${encrypt(plain, key)}`;
	}

	private unprotectMemoryText(value: string | null | undefined): string | null {
		if (!value) return value ?? null;
		if (!value.startsWith(MEMORY_ENCRYPTION_PREFIX)) return value;
		const key = this.logEncryptionKey();
		if (!key) return "[Encrypted memory text unavailable]";
		try {
			return decrypt(value.slice(MEMORY_ENCRYPTION_PREFIX.length), key);
		} catch {
			return "[Encrypted memory text unavailable]";
		}
	}

	private unprotectMemorySource(source: MemorySource): MemorySource {
		return {
			...source,
			quotedEvidence:
				this.unprotectMemoryText(source.quotedEvidence) ?? undefined,
		};
	}

	private logEncryptionKey(): string {
		return (
			process.env.OCTOPUS_MEMORY_LOG_ENCRYPTION_KEY?.trim() ||
			process.env.OCTOPUS_ENCRYPTION_KEY?.trim() ||
			""
		);
	}

	private async verifyLogIntegrity(
		table: "memory_audit_logs" | "memory_action_logs",
	): Promise<MemoryLogIntegrityResult> {
		const rows = await this.deps.db.all<Record<string, unknown>>(
			`SELECT rowid, * FROM ${table} ORDER BY rowid ASC`,
		);
		const result: MemoryLogIntegrityResult = {
			table,
			valid: true,
			checked: 0,
			legacy: 0,
			missingHash: 0,
			mismatches: [],
			chainBreaks: [],
		};
		let previousHash: string | null = null;
		let seenHashed = false;

		for (const row of rows) {
			const id = String(row.id ?? "");
			const entryHash =
				typeof row.entry_hash === "string" ? row.entry_hash : null;
			const rowPreviousHash =
				typeof row.previous_hash === "string" ? row.previous_hash : null;
			if (!entryHash) {
				if (seenHashed) {
					result.missingHash += 1;
					result.valid = false;
					result.firstInvalidId ??= id;
				} else {
					result.legacy += 1;
				}
				continue;
			}

			seenHashed = true;
			result.checked += 1;
			if (rowPreviousHash !== previousHash) {
				result.valid = false;
				result.chainBreaks.push(id);
				result.firstInvalidId ??= id;
			}

			const expected: string =
				table === "memory_audit_logs"
					? this.hashAuditLog({
							id,
							actorId: String(row.actor_id ?? ""),
							action: String(row.action ?? ""),
							memoryId:
								typeof row.memory_id === "string" ? row.memory_id : null,
							before: typeof row.before === "string" ? row.before : null,
							after: typeof row.after === "string" ? row.after : null,
							createdAt: String(row.created_at ?? ""),
							previousHash: rowPreviousHash,
						})
					: this.hashActionLog({
							id,
							sessionId:
								typeof row.session_id === "string" ? row.session_id : null,
							agentId: typeof row.agent_id === "string" ? row.agent_id : null,
							actionType: String(row.action_type ?? ""),
							input: String(row.input ?? "{}"),
							output: String(row.output ?? "{}"),
							status: String(row.status ?? ""),
							createdAt: String(row.created_at ?? ""),
							previousHash: rowPreviousHash,
						});
			if (entryHash !== expected) {
				result.valid = false;
				result.mismatches.push(id);
				result.firstInvalidId ??= id;
			}
			previousHash = entryHash;
		}

		return result;
	}

	private auditSnapshot(item: MemoryItem): Record<string, unknown> {
		return {
			id: item.id,
			type: item.type,
			importance: item.importance,
			confidence: Number(item.metadata.confidence ?? 0.5),
			status: this.getMemoryStatus(item),
			sensitivity: this.getStoredSensitivity(item),
			redacted: true,
		};
	}

	private async getContradictionIds(memoryId: string): Promise<string[]> {
		const rows = await this.deps.db.all<{ id: string }>(
			`SELECT CASE WHEN source_id = ? THEN target_id ELSE source_id END as id
				FROM memory_edges
				WHERE (source_id = ? OR target_id = ?) AND type = 'contradicts'`,
			[memoryId, memoryId, memoryId],
		);
		return rows.map((row) => row.id).filter(Boolean);
	}

	private buildVerificationSummary(
		memories: ScoredMemory[],
	): Record<NonNullable<ScoredMemory["verification"]>["status"], number> {
		const summary = {
			supported: 0,
			weak: 0,
			unverified: 0,
			conflict: 0,
			expired: 0,
			restricted: 0,
		};
		for (const memory of memories) {
			summary[memory.verification?.status ?? "unverified"] += 1;
		}
		return summary;
	}

	private buildSourceSummary(
		memories: ScoredMemory[],
	): MemoryPack["sourceSummary"] {
		let strongest: MemorySourceTrustLevel | undefined;
		let strongestRank = 0;
		let freshest: Date | undefined;
		let totalAuthority = 0;
		for (const memory of memories) {
			const trust = memory.item.metadata.sourceTrust as
				| MemorySourceTrustLevel
				| undefined;
			if (trust && TRUST_RANK[trust] > strongestRank) {
				strongest = trust;
				strongestRank = TRUST_RANK[trust];
			}
			totalAuthority += memory.signals?.sourceAuthority ?? 0.5;
			const date = new Date(
				memory.item.source.publishedAt ??
					memory.item.source.retrievedAt ??
					memory.item.createdAt,
			);
			if (!Number.isNaN(date.getTime()) && (!freshest || date > freshest)) {
				freshest = date;
			}
		}
		return {
			strongestSourceTrust: strongest,
			freshestSourceAt: freshest,
			averageAuthority:
				memories.length > 0 ? clamp01(totalAuthority / memories.length) : 0,
		};
	}

	private buildEntityMatches(
		query: string,
		memories: ScoredMemory[],
	): MemoryPack["entityMatches"] {
		const queryEntities = this.extractQueryEntities(query);
		const matches = new Map<string, string[]>();
		for (const memory of memories) {
			for (const entity of this.readEntityDescriptors(
				memory.item.metadata.entities,
			)) {
				const normalized = entity.name.toLowerCase();
				if (!queryEntities.has(normalized)) continue;
				matches.set(entity.name, [
					...(matches.get(entity.name) ?? []),
					memory.item.id,
				]);
			}
		}
		return Array.from(matches.entries()).map(([entity, memoryIds]) => ({
			entity,
			memoryIds,
		}));
	}

	private async getGraphRelations(
		memoryIds: string[],
	): Promise<MemoryPack["graphRelations"]> {
		if (memoryIds.length === 0) return [];
		const placeholders = memoryIds.map(() => "?").join(", ");
		const rows = await this.deps.db.all<{
			source_id: string;
			target_id: string;
			type: string;
			confidence: number;
		}>(
			`SELECT source_id, target_id, type, confidence FROM memory_edges
				WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})
				ORDER BY confidence DESC LIMIT 30`,
			[...memoryIds, ...memoryIds],
		);
		return rows.map((row) => ({
			sourceId: row.source_id,
			targetId: row.target_id,
			type: this.normalizeRelationType(row.type),
			confidence: row.confidence,
		}));
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

	private async retrieveExactIdentifierMatches(
		query: string,
		context: MemoryReadContext,
	): Promise<ScoredMemory[]> {
		const identifiers = this.extractExactIdentifiers(query);
		if (identifiers.length === 0) return [];

		const items = await this.deps.ltm.listAll(5000);
		const matches: ScoredMemory[] = [];
		for (const item of items) {
			if (!this.matchesContext(item, context)) continue;
			const searchable =
				`${item.content} ${JSON.stringify(item.source)} ${JSON.stringify(item.metadata)}`.toLowerCase();
			const matchCount = identifiers.filter((identifier) =>
				searchable.includes(identifier),
			).length;
			if (matchCount === 0) continue;

			const typeBoost =
				item.type === "semantic" || item.type === "user" || item.type === "org"
					? 0.55
					: item.type === "episodic"
						? -0.2
						: 0.15;
			const denialPenalty = isAssistantMemoryDenialEcho(item.content)
				? 0.55
				: 0;
			matches.push({
				item,
				score: Math.max(
					0.05,
					0.85 + matchCount / identifiers.length + typeBoost - denialPenalty,
				),
			});
		}

		return matches.sort((a, b) => b.score - a.score).slice(0, 20);
	}

	private extractExactIdentifiers(query: string): string[] {
		const identifiers = new Set<string>();
		for (const token of query.match(/\b[A-Za-z][A-Za-z0-9_-]{7,}\b/g) ?? []) {
			if (/[A-Z]/.test(token.slice(1)) || /\d|[_-]/.test(token)) {
				identifiers.add(token.toLowerCase());
			}
		}
		return Array.from(identifiers).slice(0, 10);
	}

	private deduplicateScoredMemories(memories: ScoredMemory[]): ScoredMemory[] {
		const deduped = new Map<string, ScoredMemory>();
		for (const memory of memories) {
			const previous = deduped.get(memory.item.id);
			if (!previous || memory.score > previous.score) {
				deduped.set(memory.item.id, memory);
			}
		}
		return Array.from(deduped.values()).sort((a, b) => b.score - a.score);
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
				this.protectMemoryText(
					candidate.evidence.excerpt ?? candidate.content,
					1200,
				),
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
				this.protectMemoryText(previousContent),
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
		const permissions = metadata.permissions as MemoryPermissions | undefined;
		if (permissions?.hiddenFromAgents?.includes(context.agentRole ?? "")) {
			return false;
		}
		if (
			permissions?.visibleToAgents?.length &&
			(!context.agentRole ||
				!permissions.visibleToAgents.includes(context.agentRole))
		) {
			return false;
		}
		if (
			permissions?.visibleToUsers?.length &&
			(!context.userId || !permissions.visibleToUsers.includes(context.userId))
		) {
			return false;
		}
		if (
			this.getSensitivityFromItem(item) === "restricted" &&
			!context.includeSources
		) {
			return false;
		}
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

	private canExposeMemory(
		item: MemoryItem,
		context: MemoryReadContext,
	): boolean {
		return (
			this.matchesContext(item, context) &&
			!this.requiresConfirmation(item, context)
		);
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

	private async getNodeIdsLinkedToMemoryIds(
		memoryIds: string[],
	): Promise<string[]> {
		const unique = Array.from(new Set(memoryIds.filter(Boolean)));
		if (unique.length === 0) return [];
		const placeholders = unique.map(() => "?").join(", ");
		const rows = await this.deps.db.all<{ node_id: string }>(
			`SELECT DISTINCT node_id FROM memory_node_links WHERE memory_id IN (${placeholders})`,
			unique,
		);
		return rows.map((row) => row.node_id);
	}

	private async getMemoryIdsLinkedToNodeIds(
		nodeIds: string[],
	): Promise<string[]> {
		const unique = Array.from(new Set(nodeIds.filter(Boolean)));
		if (unique.length === 0) return [];
		const placeholders = unique.map(() => "?").join(", ");
		const rows = await this.deps.db.all<{ memory_id: string }>(
			`SELECT DISTINCT memory_id FROM memory_node_links WHERE node_id IN (${placeholders})`,
			unique,
		);
		return rows.map((row) => row.memory_id);
	}

	private async getMemoryNodeLinks(
		nodeIds: string[],
	): Promise<Array<{ memory_id: string; node_id: string }>> {
		const unique = Array.from(new Set(nodeIds.filter(Boolean)));
		if (unique.length === 0) return [];
		const placeholders = unique.map(() => "?").join(", ");
		return this.deps.db.all<{ memory_id: string; node_id: string }>(
			`SELECT DISTINCT memory_id, node_id FROM memory_node_links WHERE node_id IN (${placeholders})`,
			unique,
		);
	}

	private async getRelatedNodeIds(
		nodeIds: string[],
		allowedRelationTypes: Set<MemoryRelationType>,
	): Promise<string[]> {
		const unique = Array.from(new Set(nodeIds.filter(Boolean)));
		if (unique.length === 0) return [];
		const placeholders = unique.map(() => "?").join(", ");
		const rows = await this.deps.db.all<{
			from_node_id: string;
			to_node_id: string;
			edge_type: string;
		}>(
			`SELECT from_node_id, to_node_id, edge_type FROM memory_relations
				WHERE status = 'active'
				AND (from_node_id IN (${placeholders}) OR to_node_id IN (${placeholders}))`,
			[...unique, ...unique],
		);
		const related = new Set<string>();
		for (const row of rows) {
			const relationType = this.normalizeRelationType(row.edge_type);
			if (
				allowedRelationTypes.size > 0 &&
				!allowedRelationTypes.has(relationType)
			) {
				continue;
			}
			if (unique.includes(row.from_node_id)) related.add(row.to_node_id);
			if (unique.includes(row.to_node_id)) related.add(row.from_node_id);
		}
		return Array.from(related);
	}

	private getMetadataDate(item: MemoryItem, key: string): Date | undefined {
		const raw = item.metadata[key];
		if (typeof raw !== "string") return undefined;
		const parsed = new Date(raw);
		return Number.isNaN(parsed.getTime()) ? undefined : parsed;
	}

	private normalizeLimit(limit: number, fallback: number, max: number): number {
		const value = Number.isFinite(limit) ? Math.trunc(limit) : fallback;
		return Math.max(1, Math.min(value, max));
	}

	private normalizeDepth(
		depth: number | undefined,
		fallback: number,
		max: number,
	): number {
		const value = Number.isFinite(depth)
			? Math.trunc(depth as number)
			: fallback;
		return Math.max(0, Math.min(value, max));
	}

	private async updateStatus(
		item: MemoryItem,
		status: MemoryStatus,
		reason: string,
		metadata?: Record<string, unknown>,
	): Promise<void> {
		await this.recordVersion(item.id, item.content, reason, "system");
		const updated: MemoryItem = {
			...item,
			metadata: {
				...item.metadata,
				...metadata,
				status,
				lastActiveForgettingReason: reason,
				lastActiveForgettingAt: new Date().toISOString(),
			},
		};
		await this.deps.ltm.update(updated);
		await this.recordAudit({
			actorId: "system",
			action: `status:${status}`,
			memoryId: item.id,
			before: this.auditSnapshot(item),
			after: this.auditSnapshot(updated),
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

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(1, value));
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

function hashStableObject(value: Record<string, unknown>): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
		.join(",")}}`;
}
