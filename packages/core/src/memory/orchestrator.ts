import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { createDatabaseAdapter, type DatabaseAdapter } from "../storage/database.js";
import { decrypt, encrypt } from "../utils/crypto.js";
import { isAssistantMemoryDenialEcho } from "./denial-echo.js";
import { MemoryBenchmarkStore, type MemoryBenchmarkFormat } from "./benchmark.js";
import { FTSSearchEngine } from "./fts-search.js";
import { MemoryIntegrityLayer } from "./integrity.js";
import { LongTermMemory } from "./ltm.js";
import { SqliteVectorStore } from "./sqlite-vss.js";
import type {
	ActiveForgettingOptions,
	ActiveForgettingReport,
	EmbeddingDescriptor,
	EmbeddingFunction,
	EmbeddingReindexReport,
	LegacyClaimBackfillReport,
	MemoryActionLogEntry,
	MemoryAuditEntry,
	MemoryAuditIntegrityReport,
	MemoryBackfillReport,
	MemoryCandidate,
	MemoryClaimInput,
	MemoryClaimRecord,
	MemoryCoverageSnapshot,
	MemoryExplanation,
	MemoryFeedbackInput,
	MemoryFeedbackResult,
	MemoryGraphPath,
	MemoryGraphSnapshot,
	MemoryGraphTraversalOptions,
	MemoryItem,
	MemoryLogIntegrityResult,
	MemoryMetricsSnapshot,
	MemoryOperationCreateInput,
	MemoryOperationListOptions,
	MemoryOperationRecord,
	MemoryOperationStatus,
	MemoryOperationType,
	MemoryPack,
	MemoryPermissions,
	MemoryReadContext,
	MemoryReadOptions,
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

type MemoryOperationRow = {
	id: string;
	type: MemoryOperationType;
	status: MemoryOperationStatus;
	target_descriptor: string | null;
	cursor: string | null;
	request: string;
	progress: string;
	lease_token: string | null;
	lease_expires_at: string | null;
	control_action: "run" | "pause" | "cancel";
	fence_version: number;
	last_error: string | null;
	attempt_count: number;
	created_at: string;
	updated_at: string;
	completed_at: string | null;
};

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
				owner_memory_id TEXT,
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
		const versionedEmbedding = this.deps.embeddingFn.embedVersioned
			? await this.deps.embeddingFn.embedVersioned(normalized.content, "document")
			: {
					values: await this.deps.embeddingFn(normalized.content, "document"),
					descriptor: this.deps.embeddingFn.getDescriptor?.(),
				};
		const embedding = versionedEmbedding.values;
		const embeddingDescriptor = versionedEmbedding.descriptor;
		const duplicate = await this.findDuplicate(
			normalized,
			embedding,
			embeddingDescriptor,
		);
		if (duplicate) {
			const stagedMemoryIds = new Set<string>();
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
			await this.deps.db.transaction(async () => {
				await this.stageMemoryItem(reinforced, stagedMemoryIds);
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
				await this.applyDeclaredRelations(
					reinforced,
					normalized,
					stagedMemoryIds,
				);
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
					output: {
						memoryId: duplicate.id,
						reason: "duplicate_reinforced",
					},
					status: "completed",
				});
			});
			await this.finalizeMemoryItems(stagedMemoryIds);
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
				...(normalized.claim
					? {
						claimEntity: normalized.claim.entity,
						claimKey: normalized.claim.key,
						claimValue: normalized.claim.value,
						claimValidFrom: this.claimDate(
							normalized.claim.validFrom,
							now,
						).toISOString(),
						claimValidTo: normalized.claim.validTo
							? this.claimDate(normalized.claim.validTo, now).toISOString()
							: undefined,
					}
					: {}),
				...(embeddingDescriptor
					? {
						embeddingProvider: embeddingDescriptor.provider,
						embeddingModel: embeddingDescriptor.model,
						embeddingDimensions: embeddingDescriptor.dimensions,
						embeddingVersion: embeddingDescriptor.version,
						embeddingQuality: embeddingDescriptor.quality,
					}
					: {}),
				tenantId: normalized.scope.tenantId,
				userId: normalized.scope.userId,
				projectId: normalized.scope.projectId,
				agentRole: normalized.scope.agentRole,
				sessionId: normalized.scope.sessionId,
				taskId: normalized.scope.taskId,
				sourceTrust: normalized.sourceTrust,
				confidence: normalized.confidence ?? validation.confidenceCap,
				status: "active",
				sensitivity: this.getSensitivity(normalized),
				permissions: normalized.permissions,
				expiresAt,
			},
		};

		const stagedMemoryIds = new Set<string>();
		await this.deps.db.transaction(async () => {
			await this.stageMemoryItem(item, stagedMemoryIds);
			await this.recordEvidence(memoryId, normalized);
			await this.recordTemporalClaim(memoryId, normalized, now);
			await this.recordStructuredSource(memoryId, normalized, item.source);
			await this.recordPermissions(memoryId, normalized.permissions, expiresAt);
			await this.upsertEntitiesAndRelations(item, normalized);
			await this.applyDeclaredRelations(item, normalized, stagedMemoryIds);
			item = await this.detectStructuredContradictions(
				item,
				normalized,
				stagedMemoryIds,
			);
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
		});
		await this.finalizeMemoryItems(stagedMemoryIds);
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
					(id, owner_memory_id, from_node_id, edge_type, to_node_id, context, confidence, status, created_at, updated_at, last_validated_at, metadata)
					VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
				[
					nanoid(),
					item.id,
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
		options: MemoryReadOptions = {},
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
		const versionedQuery = this.deps.embeddingFn.embedVersioned
			? await this.deps.embeddingFn.embedVersioned(query, "query")
			: {
					values: await this.deps.embeddingFn(query, "query"),
					descriptor: this.deps.embeddingFn.getDescriptor?.(),
				};
		const embedding = versionedQuery.values;
		const queryEmbeddingDescriptor = versionedQuery.descriptor;
		const retrieved = await this.deps.ltm.retrieveByEmbedding(embedding, {
			maxResults: this.config.maxReadCandidates,
			maxTokens: Math.max(64, budgetTokens),
			minRelevance: this.config.minRelevance,
			recencyWeight: 0.18,
			frequencyWeight: 0.12,
			relevanceWeight: 0.7,
			constraints: {
				scope: normalizedContext,
				embedding: queryEmbeddingDescriptor,
			},
			filter: (item) =>
				this.matchesContext(item, normalizedContext) &&
				this.matchesEmbeddingDescriptor(item, queryEmbeddingDescriptor),
			updateAccess: false,
		});
		const exactMatches = await this.retrieveExactIdentifierMatches(
			query,
			normalizedContext,
		);
		const filtered = await this.retrieveHybrid(
			query,
			retrieved,
			exactMatches,
			(item) => this.matchesContext(item, normalizedContext),
		);
		const expanded = await this.expandCandidatesByEdges(
			filtered,
			normalizedContext,
		);
		const temporallyValid = await this.filterTemporalClaimMemories(
			expanded,
			normalizedContext,
		);
		const enriched = await this.applyRetrievalSignals(
			query,
			temporallyValid,
			normalizedContext,
		);
		const diversified = this.applyMmr(enriched, this.config.maxReadCandidates);
		const uncertainty = this.uncertaintyEstimator.estimate(diversified, coverage);
		const selected = this.applyTokenBudget(
			diversified,
			budgetTokens,
			Math.max(1, Math.min(options.maxResults ?? 10, 100)),
		);
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
		const sourceRows = await this.deps.db.all<{ source_id: string }>(
			"SELECT source_id FROM memory_source_links WHERE memory_id = ? UNION SELECT source_id FROM memory_evidence WHERE memory_id = ? AND source_id IS NOT NULL",
			[memoryId, memoryId],
		);
		const nodeRows = await this.deps.db.all<{ node_id: string }>(
			"SELECT node_id FROM memory_node_links WHERE memory_id = ?",
			[memoryId],
		);
		const ownedRelationIds = (
			await this.deps.db.all<{ id: string }>(
				"SELECT id FROM memory_relations WHERE owner_memory_id = ?",
				[memoryId],
			)
		).map((relation) => relation.id);

		await this.deps.db.transaction(async () => {
			await this.deps.ltm.stageForget(memoryId);
			for (const relationId of ownedRelationIds) {
				await this.deps.db.run("DELETE FROM memory_relation_sources WHERE edge_id = ?", [relationId]);
				await this.deps.db.run("DELETE FROM memory_relations WHERE id = ?", [relationId]);
			}
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
			for (const { node_id: nodeId } of nodeRows) {
				const referenced = await this.deps.db.get<{ id: string }>(
					"SELECT memory_id AS id FROM memory_node_links WHERE node_id = ? LIMIT 1",
					[nodeId],
				);
				if (referenced) continue;
				const touching = await this.deps.db.all<{ id: string }>(
					"SELECT id FROM memory_relations WHERE from_node_id = ? OR to_node_id = ?",
					[nodeId, nodeId],
				);
				for (const relation of touching) {
					await this.deps.db.run("DELETE FROM memory_relation_sources WHERE edge_id = ?", [relation.id]);
					await this.deps.db.run("DELETE FROM memory_relations WHERE id = ?", [relation.id]);
				}
				await this.deps.db.run("DELETE FROM memory_nodes WHERE id = ?", [nodeId]);
			}
			for (const { source_id: sourceId } of sourceRows) {
				const linked = await this.deps.db.get<{ id: string }>(
					"SELECT memory_id AS id FROM memory_source_links WHERE source_id = ? LIMIT 1",
					[sourceId],
				);
				const relationLinked = await this.deps.db.get<{ id: string }>(
					"SELECT edge_id AS id FROM memory_relation_sources WHERE source_id = ? LIMIT 1",
					[sourceId],
				);
				if (!linked && !relationLinked) await this.deps.db.run("DELETE FROM memory_sources WHERE id = ?", [sourceId]);
			}
			if (item) {
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
					output: { memoryId, localStatus: "deleted", remoteStatus: "queued" },
					status: "completed",
				});
			}
		});
		await this.deps.ltm.finalizeForget(memoryId).catch(() => {});
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

	async reindexEmbeddings(input: {
		mode: "preview" | "apply";
		limit?: number;
		cursor?: string;
		upperBoundId?: string;
		allowFallbackTarget?: boolean;
		recordOperation?: boolean;
		operationGuard?: () => Promise<boolean>;
	}): Promise<EmbeddingReindexReport> {
		await this.initialize();
		const limit = Math.max(1, Math.min(input.limit ?? 100, 1000));
		const probe = this.deps.embeddingFn.embedVersioned
			? await this.deps.embeddingFn.embedVersioned("octopus embedding reindex probe", "document")
			: {
					values: await this.deps.embeddingFn(
						"octopus embedding reindex probe",
						"document",
					),
					descriptor: this.deps.embeddingFn.getDescriptor?.(),
				};
		const target = probe.descriptor;
		const report: EmbeddingReindexReport = {
			mode: input.mode,
			scanned: 0,
			eligible: 0,
			reindexed: 0,
			alreadyCurrent: 0,
			blocked: 0,
			failed: 0,
			target,
		};
		if (!target || (target.quality === "fallback" && !input.allowFallbackTarget)) {
			report.blocked = 1;
			return report;
		}
		const rows = await this.deps.db.all<{ id: string }>(
			`SELECT id FROM memory_items WHERE id > ?${input.upperBoundId ? " AND id <= ?" : ""} ORDER BY id ASC LIMIT ?`,
			input.upperBoundId
				? [input.cursor ?? "", input.upperBoundId, limit + 1]
				: [input.cursor ?? "", limit + 1],
		);
		report.hasMore = rows.length > limit;
		for (const row of rows.slice(0, limit)) {
			report.scanned++;
			report.nextCursor = row.id;
			const item = await this.deps.ltm.getById(row.id);
			if (!item) {
				report.failed++;
				continue;
			}
			if (
				item.metadata.embeddingVersion === target.version &&
				item.metadata.embeddingDimensions === target.dimensions &&
				item.metadata.embeddingQuality === target.quality
			) {
				report.alreadyCurrent++;
				continue;
			}
			report.eligible++;
			if (input.mode === "preview") continue;
			try {
				const embedded = this.deps.embeddingFn.embedVersioned
					? await this.deps.embeddingFn.embedVersioned(item.content, "document")
					: {
							values: await this.deps.embeddingFn(item.content, "document"),
							descriptor: this.deps.embeddingFn.getDescriptor?.(),
						};
				if (
					!embedded.descriptor ||
					embedded.descriptor.version !== target.version ||
					embedded.descriptor.quality !== target.quality ||
					embedded.values.length !== target.dimensions
				) {
					report.failed++;
					continue;
				}
				const updated: MemoryItem = {
					...item,
					embedding: embedded.values,
					metadata: {
						...item.metadata,
						embeddingProvider: target.provider,
						embeddingModel: target.model,
						embeddingDimensions: target.dimensions,
						embeddingVersion: target.version,
						embeddingQuality: target.quality,
						embeddingReindexedAt: new Date().toISOString(),
					},
				};
				await this.deps.db.transaction(async () => {
					if (input.operationGuard && !(await input.operationGuard())) {
						throw new Error("MEMORY_OPERATION_LEASE_LOST");
					}
					await this.deps.ltm.stageStore(updated);
				});
				await this.deps.ltm.finalizeStore(updated.id).catch(() => {});
				report.reindexed++;
			} catch (error) {
				if (
					error instanceof Error &&
					error.message === "MEMORY_OPERATION_LEASE_LOST"
				) {
					throw error;
				}
				report.failed++;
			}
		}
		if (input.mode === "apply" && input.recordOperation !== false) {
			await this.recordMemoryOperation("embedding.reindex", input, report);
		}
		return report;
	}

	async backfillLegacyClaims(input: {
		mode: "preview" | "apply";
		limit?: number;
		cursor?: string;
		upperBoundId?: string;
		validFromPolicy?: "require_explicit" | "created_at";
		recordOperation?: boolean;
		operationGuard?: () => Promise<boolean>;
	}): Promise<LegacyClaimBackfillReport> {
		await this.initialize();
		const limit = Math.max(1, Math.min(input.limit ?? 100, 1000));
		const report: LegacyClaimBackfillReport = {
			mode: input.mode,
			scanned: 0,
			eligible: 0,
			inserted: 0,
			alreadyPresent: 0,
			missingScope: 0,
			missingValidFrom: 0,
			invalid: 0,
			samples: [],
		};
		const rows = await this.deps.db.all<{ id: string }>(
			`SELECT id FROM memory_items WHERE id > ?${input.upperBoundId ? " AND id <= ?" : ""} ORDER BY id ASC LIMIT ?`,
			input.upperBoundId
				? [input.cursor ?? "", input.upperBoundId, limit + 1]
				: [input.cursor ?? "", limit + 1],
		);
		report.hasMore = rows.length > limit;
		for (const row of rows.slice(0, limit)) {
			report.scanned++;
			report.nextCursor = row.id;
			const item = await this.deps.ltm.getById(row.id);
			if (!item) continue;
			if (
				await this.deps.db.get("SELECT id FROM memory_claims WHERE memory_id = ?", [
					item.id,
				])
			) {
				report.alreadyPresent++;
				continue;
			}
			const descriptor = this.readClaimDescriptor(item.metadata);
			if (!descriptor) continue;
			const scopeValues = [
				item.metadata.tenantId,
				item.metadata.userId,
				item.metadata.projectId,
				item.metadata.agentRole,
			];
			if (!scopeValues.every((value) => typeof value === "string" && value.length > 0)) {
				report.missingScope++;
				continue;
			}
			const explicitValidFrom = item.metadata.claimValidFrom;
			const validFrom =
				typeof explicitValidFrom === "string"
					? new Date(explicitValidFrom)
					: input.validFromPolicy === "created_at"
						? item.createdAt
						: undefined;
			if (!validFrom) {
				report.missingValidFrom++;
				continue;
			}
			if (Number.isNaN(validFrom.getTime())) {
				report.invalid++;
				continue;
			}
			report.eligible++;
			report.samples.push({ memoryId: item.id, outcome: "eligible" });
			if (input.mode === "preview") continue;
			await this.deps.db.transaction(async () => {
				if (input.operationGuard && !(await input.operationGuard())) {
					throw new Error("MEMORY_OPERATION_LEASE_LOST");
				}
				await this.deps.db.run(
					`INSERT INTO memory_claims
				 (id, memory_id, tenant_id, user_id, project_id, agent_role, entity, claim_key, claim_value, valid_from, valid_to, recorded_at, confidence, source_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
					nanoid(), item.id, ...scopeValues, descriptor.entity, descriptor.key,
					descriptor.value, validFrom.toISOString(), null, item.createdAt.toISOString(),
					Number(item.metadata.confidence ?? 0.5), item.source.sourceId ?? null,
					],
				);
			});
			report.inserted++;
		}
		report.samples = report.samples.slice(0, 20);
		if (input.mode === "apply" && input.recordOperation !== false) {
			await this.recordMemoryOperation("claims.backfill", input, report);
		}
		return report;
	}

	async previewMemoryOperation(
		input: MemoryOperationCreateInput,
	): Promise<EmbeddingReindexReport | LegacyClaimBackfillReport> {
		const batchSize = this.normalizeOperationBatchSize(input.batchSize);
		if (input.type === "embedding.reindex") {
			return this.reindexEmbeddings({
				mode: "preview",
				limit: batchSize,
				allowFallbackTarget: input.allowFallbackTarget,
				recordOperation: false,
			});
		}
		return this.backfillLegacyClaims({
			mode: "preview",
			limit: batchSize,
			validFromPolicy: input.validFromPolicy,
			recordOperation: false,
		});
	}

	async migrateLegacyVectorPayloads(input: {
		mode: "preview" | "apply";
		limit?: number;
		cursor?: string;
		upperBoundId?: string;
	}) {
		await this.initialize();
		return this.deps.ltm.migrateLegacyPayloads(input);
	}

	async importMemoryBenchmark(input: {
		name: string;
		format: MemoryBenchmarkFormat;
		sourceName: string;
		sourceSha256: string;
		source: unknown;
		options?: Record<string, unknown>;
	}) {
		await this.initialize();
		return new MemoryBenchmarkStore(this.deps.db).importDataset(input);
	}

	async listMemoryBenchmarkDatasets() {
		await this.initialize();
		return new MemoryBenchmarkStore(this.deps.db).listDatasets();
	}

	async createMemoryBenchmarkRun(
		datasetId: string,
		options: Record<string, unknown>,
	) {
		await this.initialize();
		const store = new MemoryBenchmarkStore(this.deps.db);
		const id = await store.createRun(datasetId, options);
		return {
			id,
			metrics: await store.executeRun(id, {
				createIsolatedRuntime: async ({ runId, corpusId, documents }) => {
					const indexStartedAt = performance.now();
					const isolatedDb = createDatabaseAdapter("sqlite", { path: ":memory:" });
					await isolatedDb.initialize();
					const vectorStore = new SqliteVectorStore(isolatedDb);
					await vectorStore.initialize();
					const isolatedLtm = new LongTermMemory(vectorStore, isolatedDb);
					const scope = {
						tenantId: `benchmark:${runId}`,
						userId: "benchmark",
						projectId: `corpus:${corpusId}`,
						agentRole: "benchmark",
					};
					const isolated = new MemoryOrchestrator({
						db: isolatedDb,
						ltm: isolatedLtm,
						embeddingFn: this.deps.embeddingFn,
						config: {
							defaultTenantId: scope.tenantId,
							defaultUserId: scope.userId,
							defaultProjectId: scope.projectId,
							maxReadCandidates: Math.max(50, documents.length),
							minRelevance: this.config.minRelevance,
						},
					});
					await isolated.initialize();
					const documentIdsByMemory = new Map<string, string[]>();
					try {
						for (const document of documents) {
							const write = await isolated.write({
								type: "episodic",
								content: document.content,
								sourceTrust: "external",
								scope,
								importance: 0.7,
								source: {
									sourceType: "document",
									sourceId: document.id,
									title: document.externalId,
									publishedAt: document.occurredAt,
								},
								metadata: {
									benchmarkDocumentId: document.id,
									benchmarkOrdinal: document.ordinal,
									benchmarkRole: document.role,
								},
							});
							if (!write.accepted || !write.memoryId) {
								throw new Error(`MEMORY_BENCHMARK_DOCUMENT_REJECTED:${document.id}`);
							}
							const mapped = documentIdsByMemory.get(write.memoryId) ?? [];
							mapped.push(document.id);
							documentIdsByMemory.set(write.memoryId, mapped);
						}
					} catch (error) {
						await isolatedDb.close();
						throw error;
					}
					return {
						metadata: {
							embeddingDescriptor: this.deps.embeddingFn.getDescriptor?.(),
							documentCount: documents.length,
							indexDurationMs: performance.now() - indexStartedAt,
						},
						retrieve: async (query: string, k: number) => {
							const pack = await isolated.read(
								query,
								{ ...scope, trackUsage: false },
								Math.max(4096, k * 512),
								{ maxResults: k },
							);
							return pack.memories
								.flatMap((memory) =>
									(documentIdsByMemory.get(memory.item.id) ?? []).map((documentId) => ({
										id: documentId,
										score: memory.score,
									})),
								)
								.slice(0, k);
						},
						close: async () => isolatedDb.close(),
					};
				},
			}),
		};
	}

	async listMemoryBenchmarkRuns() {
		await this.initialize();
		return new MemoryBenchmarkStore(this.deps.db).listRuns();
	}

	async createMemoryOperation(
		input: MemoryOperationCreateInput,
		idempotencyKey?: string,
	): Promise<{ operation: MemoryOperationRecord; replayed: boolean }> {
		await this.initialize();
		const batchSize = this.normalizeOperationBatchSize(input.batchSize);
		const normalizedRequest: Record<string, unknown> = {
			batchSize,
			allowFallbackTarget: input.allowFallbackTarget === true,
			validFromPolicy: input.validFromPolicy ?? "require_explicit",
		};
		if (idempotencyKey) {
			const existing = await this.deps.db.get<MemoryOperationRow>(
				"SELECT * FROM memory_operations WHERE idempotency_key = ?",
				[idempotencyKey],
			);
			if (existing) {
				const existingRequest = this.safeJsonObject(existing.request);
				const existingIntent = {
					batchSize: existingRequest.batchSize,
					allowFallbackTarget: existingRequest.allowFallbackTarget,
					validFromPolicy: existingRequest.validFromPolicy,
				};
				if (
					existing.type !== input.type ||
					JSON.stringify(existingIntent) !== JSON.stringify(normalizedRequest)
				) {
					throw new Error("MEMORY_OPERATION_IDEMPOTENCY_CONFLICT");
				}
				return {
					operation: this.rowToMemoryOperation(existing, await this.deps.db.currentTime()),
					replayed: true,
				};
			}
		}
		const upper = await this.deps.db.get<{ id: string | null }>(
			"SELECT MAX(id) AS id FROM memory_items",
		);
		const now = (await this.deps.db.currentTime()).toISOString();
		normalizedRequest.upperBoundId = upper?.id ?? "";
		normalizedRequest.snapshotAt = now;
		let targetDescriptor: EmbeddingDescriptor | undefined;
		if (input.type === "embedding.reindex") {
			const probe = this.deps.embeddingFn.embedVersioned
				? await this.deps.embeddingFn.embedVersioned(
						"octopus operation target probe",
						"document",
					)
				: {
						values: await this.deps.embeddingFn(
							"octopus operation target probe",
							"document",
						),
						descriptor: this.deps.embeddingFn.getDescriptor?.(),
					};
			targetDescriptor = probe.descriptor;
			if (!targetDescriptor) throw new Error("MEMORY_OPERATION_TARGET_UNAVAILABLE");
			if (targetDescriptor.quality === "fallback" && !input.allowFallbackTarget) {
				throw new Error("MEMORY_OPERATION_FALLBACK_TARGET_BLOCKED");
			}
		}
		const id = nanoid();
		try {
			await this.deps.db.run(
				`INSERT INTO memory_operations
				 (id, type, status, target_descriptor, cursor, request, progress, idempotency_key, attempt_count, created_at, updated_at)
				 VALUES (?, ?, 'pending', ?, NULL, ?, '{}', ?, 0, ?, ?)`,
				[
					id,
					input.type,
					targetDescriptor ? JSON.stringify(targetDescriptor) : null,
					JSON.stringify(normalizedRequest),
					idempotencyKey ?? null,
					now,
					now,
				],
			);
		} catch (error) {
			if (idempotencyKey) {
				const winner = await this.deps.db.get<MemoryOperationRow>(
					"SELECT * FROM memory_operations WHERE idempotency_key = ?",
					[idempotencyKey],
				);
				if (winner) {
					const winnerRequest = this.safeJsonObject(winner.request);
					if (
						winner.type === input.type &&
						winnerRequest.batchSize === normalizedRequest.batchSize &&
						winnerRequest.allowFallbackTarget ===
							normalizedRequest.allowFallbackTarget &&
						winnerRequest.validFromPolicy === normalizedRequest.validFromPolicy
					) {
						return {
							operation: this.rowToMemoryOperation(
								winner,
								await this.deps.db.currentTime(),
							),
							replayed: true,
						};
					}
					throw new Error("MEMORY_OPERATION_IDEMPOTENCY_CONFLICT");
				}
			}
			throw error;
		}
		const operation = await this.getMemoryOperation(id);
		if (!operation) throw new Error("MEMORY_OPERATION_CREATE_FAILED");
		return { operation, replayed: false };
	}

	async resumeMemoryOperation(id: string): Promise<MemoryOperationRecord> {
		await this.initialize();
		const existing = await this.deps.db.get<MemoryOperationRow>(
			"SELECT * FROM memory_operations WHERE id = ?",
			[id],
		);
		if (!existing) throw new Error("MEMORY_OPERATION_NOT_FOUND");
		const existingNow = await this.deps.db.currentTime();
		if (existing.status === "completed" || existing.status === "cancelled") {
			return this.rowToMemoryOperation(existing, existingNow);
		}
		if (existing.status === "failed") throw new Error("MEMORY_OPERATION_FAILED");
		const leaseToken = nanoid();
		const now = await this.deps.db.currentTime();
		const leaseExpiresAt = new Date(now.getTime() + 300_000);
		const claimed = await this.deps.db.get<MemoryOperationRow>(
			`UPDATE memory_operations
			 SET status = 'running', control_action = 'run', lease_token = ?, lease_expires_at = ?,
			 fence_version = fence_version + 1, attempt_count = attempt_count + 1,
			 last_error = NULL, updated_at = ?
			 WHERE id = ? AND (status IN ('pending', 'paused') OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))
			 RETURNING *`,
			[
				leaseToken,
				leaseExpiresAt.toISOString(),
				now.toISOString(),
				id,
				now.toISOString(),
			],
		);
		if (!claimed) throw new Error("MEMORY_OPERATION_LEASE_CONFLICT");
		try {
			const request = this.safeJsonObject(claimed.request);
			const batchSize = this.normalizeOperationBatchSize(
				typeof request.batchSize === "number" ? request.batchSize : undefined,
			);
			const upperBoundId =
				typeof request.upperBoundId === "string" ? request.upperBoundId : "";
			if (claimed.type === "embedding.reindex") {
				const target = claimed.target_descriptor
					? (JSON.parse(claimed.target_descriptor) as EmbeddingDescriptor)
					: undefined;
				const active = this.deps.embeddingFn.getDescriptor?.();
				if (!target || !active || active.version !== target.version) {
					await this.failMemoryOperation(id, leaseToken, "embedding_target_changed");
					throw new Error("MEMORY_OPERATION_TARGET_CHANGED");
				}
			}
			let cursor = claimed.cursor ?? undefined;
			let progress = this.safeJsonObject(claimed.progress);
			let hasMore = true;
			let finalRow = claimed;
			const operationGuard = async (): Promise<boolean> => {
				const guardNow = await this.deps.db.currentTime();
				return Boolean(
					await this.deps.db.get<{ id: string }>(
						`UPDATE memory_operations SET updated_at = updated_at
						 WHERE id = ? AND lease_token = ? AND fence_version = ? AND status = 'running'
						 AND lease_expires_at > ? RETURNING id`,
						[id, leaseToken, claimed.fence_version, guardNow.toISOString()],
					),
				);
			};
			for (let index = 0; index < batchSize && hasMore; index++) {
				const control = await this.deps.db.get<Pick<MemoryOperationRow, "control_action">>(
					"SELECT control_action FROM memory_operations WHERE id = ? AND lease_token = ? AND fence_version = ?",
					[id, leaseToken, claimed.fence_version],
				);
				if (!control) throw new Error("MEMORY_OPERATION_LEASE_LOST");
				if (control.control_action !== "run") break;
				const report =
					claimed.type === "embedding.reindex"
						? await this.reindexEmbeddings({
								mode: "apply",
								limit: 1,
								cursor,
								upperBoundId,
								allowFallbackTarget: request.allowFallbackTarget === true,
								recordOperation: false,
								operationGuard,
							})
						: await this.backfillLegacyClaims({
								mode: "apply",
								limit: 1,
								cursor,
								upperBoundId,
								validFromPolicy:
									request.validFromPolicy === "created_at"
										? "created_at"
										: "require_explicit",
								recordOperation: false,
								operationGuard,
							});
				cursor = report.nextCursor ?? cursor;
				progress = this.mergeOperationProgress(progress, report);
				hasMore = report.hasMore === true;
				const checkpointNow = await this.deps.db.currentTime();
				const checkpointExpiry = new Date(checkpointNow.getTime() + 300_000);
				const checkpoint = await this.deps.db.get<MemoryOperationRow>(
					`UPDATE memory_operations SET cursor = ?, progress = ?, lease_expires_at = ?, updated_at = ?
					 WHERE id = ? AND lease_token = ? AND fence_version = ? AND status = 'running'
					 RETURNING *`,
					[
						cursor,
						JSON.stringify(progress),
						checkpointExpiry.toISOString(),
						checkpointNow.toISOString(),
						id,
						leaseToken,
						claimed.fence_version,
					],
				);
				if (!checkpoint) throw new Error("MEMORY_OPERATION_LEASE_LOST");
				finalRow = checkpoint;
			}
			const finishNow = await this.deps.db.currentTime();
			const finishControl = await this.deps.db.get<
				Pick<MemoryOperationRow, "control_action">
			>(
				"SELECT control_action FROM memory_operations WHERE id = ? AND lease_token = ? AND fence_version = ?",
				[id, leaseToken, claimed.fence_version],
			);
			if (!finishControl) throw new Error("MEMORY_OPERATION_LEASE_LOST");
			const requestedAction = finishControl.control_action;
			const finalStatus: MemoryOperationStatus =
				requestedAction === "cancel"
					? "cancelled"
					: requestedAction === "pause"
						? "paused"
						: hasMore
							? "pending"
							: "completed";
			const updated = await this.deps.db.get<MemoryOperationRow>(
				`UPDATE memory_operations
				 SET status = ?, control_action = 'run', lease_token = NULL, lease_expires_at = NULL,
				 updated_at = ?, completed_at = ?
				 WHERE id = ? AND lease_token = ? AND fence_version = ? RETURNING *`,
				[
					finalStatus,
					finishNow.toISOString(),
					finalStatus === "completed" || finalStatus === "cancelled"
						? finishNow.toISOString()
						: null,
					id,
					leaseToken,
					claimed.fence_version,
				],
			);
			if (!updated) throw new Error("MEMORY_OPERATION_LEASE_LOST");
			return this.rowToMemoryOperation(updated, finishNow);
		} catch (error) {
			if (!(error instanceof Error && error.message === "MEMORY_OPERATION_TARGET_CHANGED")) {
				const errorNow = await this.deps.db.currentTime();
				await this.deps.db.run(
					`UPDATE memory_operations SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
					 last_error = ?, updated_at = ? WHERE id = ? AND lease_token = ?`,
					[
						error instanceof Error ? error.message.slice(0, 2000) : String(error),
						errorNow.toISOString(),
						id,
						leaseToken,
					],
				);
			}
			throw error;
		}
	}

	async pauseMemoryOperation(id: string): Promise<MemoryOperationRecord> {
		return this.controlMemoryOperation(id, "pause");
	}

	async cancelMemoryOperation(id: string): Promise<MemoryOperationRecord> {
		return this.controlMemoryOperation(id, "cancel");
	}

	private async controlMemoryOperation(
		id: string,
		action: "pause" | "cancel",
	): Promise<MemoryOperationRecord> {
		await this.initialize();
		const now = await this.deps.db.currentTime();
		const row = await this.deps.db.get<MemoryOperationRow>(
			"SELECT * FROM memory_operations WHERE id = ?",
			[id],
		);
		if (!row) throw new Error("MEMORY_OPERATION_NOT_FOUND");
		if (row.status === "completed" || row.status === "cancelled" || row.status === "failed") {
			throw new Error("MEMORY_OPERATION_TERMINAL");
		}
		const immediate = row.status === "pending" || row.status === "paused";
		const updated = await this.deps.db.get<MemoryOperationRow>(
			`UPDATE memory_operations SET control_action = ?, status = ?, updated_at = ?,
			 completed_at = ?, lease_token = CASE WHEN ? THEN NULL ELSE lease_token END,
			 lease_expires_at = CASE WHEN ? THEN NULL ELSE lease_expires_at END
			 WHERE id = ? RETURNING *`,
			[
				action,
				immediate ? (action === "pause" ? "paused" : "cancelled") : "running",
				now.toISOString(),
				immediate && action === "cancel" ? now.toISOString() : null,
				immediate ? 1 : 0,
				immediate ? 1 : 0,
				id,
			],
		);
		if (!updated) throw new Error("MEMORY_OPERATION_NOT_FOUND");
		return this.rowToMemoryOperation(updated, now);
	}

	async getMemoryOperation(id: string): Promise<MemoryOperationRecord | undefined> {
		await this.initialize();
		const row = await this.deps.db.get<MemoryOperationRow>(
			"SELECT * FROM memory_operations WHERE id = ?",
			[id],
		);
		return row
			? this.rowToMemoryOperation(row, await this.deps.db.currentTime())
			: undefined;
	}

	async listMemoryOperations(
		options: MemoryOperationListOptions = {},
	): Promise<MemoryOperationRecord[]> {
		await this.initialize();
		const clauses: string[] = [];
		const params: unknown[] = [];
		if (options.type) {
			clauses.push("type = ?");
			params.push(options.type);
		}
		if (options.status) {
			clauses.push("status = ?");
			params.push(options.status);
		}
		params.push(Math.max(1, Math.min(options.limit ?? 50, 200)));
		params.push(Math.max(0, options.offset ?? 0));
		const rows = await this.deps.db.all<MemoryOperationRow>(
			`SELECT * FROM memory_operations${clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : ""}
			 ORDER BY created_at DESC LIMIT ? OFFSET ?`,
			params,
		);
		const now = await this.deps.db.currentTime();
		return rows.map((row) => this.rowToMemoryOperation(row, now));
	}

	async getMetricsSnapshot(): Promise<MemoryMetricsSnapshot> {
		await this.initialize();
		const count = async (sql: string, params: unknown[] = []) =>
			(await this.deps.db.get<{ count: number }>(sql, params))?.count ?? 0;
		const totalMemories = await count("SELECT COUNT(*) AS count FROM memory_items");
		const annIndexedMemories = await count(
			"SELECT COUNT(DISTINCT memory_id) AS count FROM memory_vector_lsh",
		);
		const operations = await this.deps.db.all<{ status: string; count: number }>(
			"SELECT status, COUNT(*) AS count FROM memory_operations GROUP BY status",
		);
		const diagnostics = this.deps.ltm.getDiagnostics();
		return {
			totalMemories,
			versionedEmbeddings: annIndexedMemories,
			fallbackEmbeddings: await count(
				"SELECT COUNT(*) AS count FROM memory_items WHERE metadata LIKE '%\"embeddingQuality\":\"fallback\"%'",
			),
			annIndexedMemories,
			annCoverage: totalMemories > 0 ? annIndexedMemories / totalMemories : 1,
			annSearches: diagnostics.annSearches ?? 0,
			annFallbackSearches: diagnostics.annFallbackSearches ?? 0,
			annAverageCandidates: diagnostics.annAverageCandidates ?? 0,
			temporalClaims: await count("SELECT COUNT(*) AS count FROM memory_claims"),
			activeInsights: await count(
				"SELECT COUNT(*) AS count FROM learning_insights WHERE invalidated_at IS NULL",
			),
			invalidatedInsights: await count(
				"SELECT COUNT(*) AS count FROM learning_insights WHERE invalidated_at IS NOT NULL",
			),
			operationsByStatus: Object.fromEntries(
				operations.map((row) => [row.status, row.count]),
			),
		};
	}

	private normalizeOperationBatchSize(value?: number): number {
		if (value === undefined) return 100;
		if (!Number.isInteger(value) || value < 1 || value > 1000) {
			throw new Error("MEMORY_OPERATION_INVALID_BATCH_SIZE");
		}
		return value;
	}

	private safeJsonObject(value: string): Record<string, unknown> {
		try {
			const parsed = JSON.parse(value) as unknown;
			return parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: {};
		} catch {
			return {};
		}
	}

	private mergeOperationProgress(
		previous: Record<string, unknown>,
		report: EmbeddingReindexReport | LegacyClaimBackfillReport,
	): Record<string, unknown> {
		const progress: Record<string, unknown> = { ...previous };
		for (const [key, value] of Object.entries(report)) {
			if (
				typeof value === "number" &&
				!["mode"].includes(key)
			) {
				progress[key] = Number(progress[key] ?? 0) + value;
			}
		}
		progress.batches = Number(progress.batches ?? 0) + 1;
		progress.hasMore = report.hasMore === true;
		if ("samples" in report) {
			progress.samples = [
				...(Array.isArray(progress.samples) ? progress.samples : []),
				...report.samples,
			].slice(0, 20);
		}
		return progress;
	}

	private async failMemoryOperation(
		id: string,
		leaseToken: string,
		reason: string,
	): Promise<void> {
		const now = (await this.deps.db.currentTime()).toISOString();
		await this.deps.db.run(
			`UPDATE memory_operations SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
			 last_error = ?, updated_at = ?, completed_at = ? WHERE id = ? AND lease_token = ?`,
			[reason, now, now, id, leaseToken],
		);
	}

	private rowToMemoryOperation(
		row: MemoryOperationRow,
		now = new Date(),
	): MemoryOperationRecord {
		const leaseExpiry = row.lease_expires_at
			? new Date(row.lease_expires_at)
			: undefined;
		const leaseState = !row.lease_token
			? "none"
			: leaseExpiry && leaseExpiry.getTime() > now.getTime()
				? "active"
				: "expired";
		let targetDescriptor: EmbeddingDescriptor | undefined;
		if (row.target_descriptor) {
			try {
				targetDescriptor = JSON.parse(row.target_descriptor) as EmbeddingDescriptor;
			} catch {}
		}
		return {
			id: row.id,
			type: row.type,
			status: row.status,
			controlAction: row.control_action ?? "run",
			fenceVersion: row.fence_version ?? 0,
			cursor: row.cursor ?? undefined,
			request: this.safeJsonObject(row.request),
			progress: this.safeJsonObject(row.progress),
			targetDescriptor,
			attemptCount: row.attempt_count ?? 0,
			lastError: row.last_error ?? undefined,
			leaseState,
			resumable:
				row.status === "pending" || row.status === "paused" ||
				(row.status === "running" && leaseState === "expired"),
			createdAt: new Date(row.created_at),
			updatedAt: new Date(row.updated_at),
			completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
		};
	}

	private async recordMemoryOperation(
		type: string,
		request: unknown,
		progress: unknown,
	): Promise<void> {
		const now = new Date().toISOString();
		await this.deps.db.run(
			`INSERT INTO memory_operations
			 (id, type, status, request, progress, created_at, updated_at, completed_at)
			 VALUES (?, ?, 'completed', ?, ?, ?, ?, ?)`,
			[nanoid(), type, JSON.stringify(request), JSON.stringify(progress), now, now, now],
		);
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
		embeddingDescriptor?: EmbeddingDescriptor,
	): Promise<MemoryItem | undefined> {
		const context = this.normalizeContext(candidate.scope);
		const results = await this.deps.ltm.retrieveByEmbedding(embedding, {
			maxResults: 5,
			maxTokens: 1000,
			minRelevance: 0.92,
			recencyWeight: 0,
			frequencyWeight: 0,
			relevanceWeight: 1,
			constraints: {
				scope: context,
				embedding: embeddingDescriptor,
			},
			filter: (item) =>
				this.matchesContext(item, context) &&
				this.matchesEmbeddingDescriptor(item, embeddingDescriptor),
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
		stagedMemoryIds?: Set<string>,
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
					stagedMemoryIds,
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
				await this.persistMemoryItem(updated, stagedMemoryIds);
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
		stagedMemoryIds?: Set<string>,
	): Promise<MemoryItem> {
		if (candidate.claim) {
			await this.detectTemporalClaimContradictions(item, candidate.claim);
			return item;
		}
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
				await this.persistMemoryItem(updated, stagedMemoryIds);
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
				await this.persistMemoryItem(currentItem, stagedMemoryIds);
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

	private claimDate(value: Date | string | undefined, fallback: Date): Date {
		if (value === undefined) return fallback;
		const date = value instanceof Date ? value : new Date(value);
		if (Number.isNaN(date.getTime())) throw new Error("Invalid temporal claim date");
		return date;
	}

	private async recordTemporalClaim(
		memoryId: string,
		candidate: MemoryCandidate,
		recordedAt: Date,
	): Promise<void> {
		if (!candidate.claim) return;
		const validFrom = this.claimDate(candidate.claim.validFrom, recordedAt);
		const validTo = candidate.claim.validTo
			? this.claimDate(candidate.claim.validTo, recordedAt)
			: undefined;
		if (validTo && validTo <= validFrom) {
			throw new Error("Temporal claim validTo must be after validFrom");
		}
		await this.deps.db.run(
			`INSERT INTO memory_claims
			 (id, memory_id, tenant_id, user_id, project_id, agent_role, entity, claim_key, claim_value, valid_from, valid_to, recorded_at, confidence, source_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				nanoid(),
				memoryId,
				candidate.scope.tenantId,
				candidate.scope.userId ?? null,
				candidate.scope.projectId ?? null,
				candidate.scope.agentRole ?? null,
				candidate.claim.entity.trim().toLowerCase(),
				candidate.claim.key.trim().toLowerCase(),
				String(candidate.claim.value),
				validFrom.toISOString(),
				validTo?.toISOString() ?? null,
				recordedAt.toISOString(),
				candidate.confidence ?? 0.7,
				candidate.source?.sourceId ?? candidate.evidence?.sourceId ?? null,
			],
		);
	}

	private async detectTemporalClaimContradictions(
		item: MemoryItem,
		claim: MemoryClaimInput,
	): Promise<void> {
		const current = await this.deps.db.get<{
			valid_from: string;
			valid_to: string | null;
			tenant_id: string;
			user_id: string | null;
			project_id: string | null;
			agent_role: string | null;
		}>("SELECT valid_from, valid_to, tenant_id, user_id, project_id, agent_role FROM memory_claims WHERE memory_id = ?", [
			item.id,
		]);
		if (!current) return;
		const rows = await this.deps.db.all<{
			memory_id: string;
			claim_value: string;
			valid_from: string;
			valid_to: string | null;
		}>(
			`SELECT memory_id, claim_value, valid_from, valid_to
			 FROM memory_claims
			 WHERE memory_id <> ? AND entity = ? AND claim_key = ? AND retracted_at IS NULL
			 AND tenant_id = ? AND COALESCE(user_id, '') = COALESCE(?, '')
			 AND COALESCE(project_id, '') = COALESCE(?, '')
			 AND COALESCE(agent_role, '') = COALESCE(?, '')`,
			[
				item.id,
				claim.entity.trim().toLowerCase(),
				claim.key.trim().toLowerCase(),
				current.tenant_id,
				current.user_id,
				current.project_id,
				current.agent_role,
			],
		);
		const currentStart = new Date(current.valid_from).getTime();
		const currentEnd = current.valid_to
			? new Date(current.valid_to).getTime()
			: Number.POSITIVE_INFINITY;
		for (const row of rows) {
			if (row.claim_value === String(claim.value)) continue;
			const otherStart = new Date(row.valid_from).getTime();
			const otherEnd = row.valid_to
				? new Date(row.valid_to).getTime()
				: Number.POSITIVE_INFINITY;
			if (currentStart >= otherEnd || otherStart >= currentEnd) continue;
			await this.createEdge(row.memory_id, item.id, "contradicts", 0.9);
			if (otherStart < currentStart && otherEnd > currentStart) {
				await this.deps.db.run(
					"UPDATE memory_claims SET valid_to = ? WHERE memory_id = ? AND (valid_to IS NULL OR valid_to > ?)",
					[
						new Date(currentStart).toISOString(),
						row.memory_id,
						new Date(currentStart).toISOString(),
					],
				);
			}
		}
	}

	async getClaims(
		context: MemoryReadContext,
		selector: { entity?: string; key?: string } = {},
	): Promise<MemoryClaimRecord[]> {
		await this.initialize();
		const normalized = this.normalizeContext(context);
		const validAt = context.validAt ?? new Date();
		const knownAt = context.knownAt ?? new Date();
		const clauses = [
			"tenant_id = ?",
			"COALESCE(user_id, '') = COALESCE(?, '')",
			"COALESCE(project_id, '') = COALESCE(?, '')",
			"COALESCE(agent_role, '') = COALESCE(?, '')",
			"valid_from <= ?",
			"(valid_to IS NULL OR valid_to > ?)",
			"recorded_at <= ?",
			"(retracted_at IS NULL OR retracted_at > ?)",
		];
		const params: unknown[] = [
			normalized.tenantId,
			normalized.userId ?? null,
			normalized.projectId ?? null,
			normalized.agentRole ?? null,
			validAt.toISOString(),
			validAt.toISOString(),
			knownAt.toISOString(),
			knownAt.toISOString(),
		];
		if (selector.entity) {
			clauses.push("entity = ?");
			params.push(selector.entity.trim().toLowerCase());
		}
		if (selector.key) {
			clauses.push("claim_key = ?");
			params.push(selector.key.trim().toLowerCase());
		}
		const rows = await this.deps.db.all<{
			id: string;
			memory_id: string;
			entity: string;
			claim_key: string;
			claim_value: string;
			valid_from: string;
			valid_to: string | null;
			recorded_at: string;
			retracted_at: string | null;
			confidence: number;
		}>(`SELECT * FROM memory_claims WHERE ${clauses.join(" AND ")}`, params);
		return rows.map((row) => ({
			id: row.id,
			memoryId: row.memory_id,
			entity: row.entity,
			key: row.claim_key,
			value: row.claim_value,
			validFrom: row.valid_from,
			validTo: row.valid_to ?? undefined,
			recordedAt: new Date(row.recorded_at),
			retractedAt: row.retracted_at
				? new Date(row.retracted_at)
				: undefined,
			confidence: row.confidence,
		}));
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

	private async expandCandidatesByEdges(
		seeds: ScoredMemory[],
		context: MemoryReadContext,
	): Promise<ScoredMemory[]> {
		if (seeds.length === 0) return seeds;
		const allowed = new Set<MemoryRelationType>([
			"associated",
			"supports",
			"derived_from",
			"depends_on",
			"caused",
			"confirmed_by",
		]);
		const seedIds = seeds.map((seed) => seed.item.id);
		const placeholders = seedIds.map(() => "?").join(", ");
		const rows = await this.deps.db.all<{
			source_id: string;
			target_id: string;
			type: string;
			confidence: number;
		}>(
			`SELECT source_id, target_id, type, confidence FROM memory_edges
			 WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})
			 ORDER BY confidence DESC LIMIT ?`,
			[...seedIds, ...seedIds, this.config.maxReadCandidates * 4],
		);
		const byId = new Map(seeds.map((seed) => [seed.item.id, seed]));
		for (const row of rows) {
			const relationType = this.normalizeRelationType(row.type);
			if (!allowed.has(relationType)) continue;
			const seedId = byId.has(row.source_id) ? row.source_id : row.target_id;
			const neighborId = seedId === row.source_id ? row.target_id : row.source_id;
			if (byId.has(neighborId)) continue;
			const neighbor = await this.deps.ltm.getById(neighborId);
			if (!neighbor || this.getMemoryStatus(neighbor) !== "active") continue;
			if (!this.matchesContext(neighbor, context)) continue;
			const seed = byId.get(seedId);
			if (!seed) continue;
			byId.set(neighborId, {
				item: neighbor,
				score: clamp01(seed.score * clamp01(row.confidence) * 0.75),
			});
			if (byId.size >= this.config.maxReadCandidates) break;
		}
		return [...byId.values()].sort((a, b) => b.score - a.score);
	}

	private async filterTemporalClaimMemories(
		memories: ScoredMemory[],
		context: MemoryReadContext,
	): Promise<ScoredMemory[]> {
		const validAt = context.validAt ?? new Date();
		const knownAt = context.knownAt ?? new Date();
		const result: ScoredMemory[] = [];
		for (const memory of memories) {
			const count = await this.deps.db.get<{ count: number }>(
				"SELECT COUNT(*) AS count FROM memory_claims WHERE memory_id = ?",
				[memory.item.id],
			);
			if (!count?.count) {
				result.push(memory);
				continue;
			}
			const active = await this.deps.db.get<{ id: string }>(
				`SELECT id FROM memory_claims
				 WHERE memory_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
				 AND recorded_at <= ? AND (retracted_at IS NULL OR retracted_at > ?)
				 LIMIT 1`,
				[
					memory.item.id,
					validAt.toISOString(),
					validAt.toISOString(),
					knownAt.toISOString(),
					knownAt.toISOString(),
				],
			);
			if (active) result.push(memory);
		}
		return result;
	}

	private async retrieveHybrid(
		query: string,
		vectorResults: ScoredMemory[],
		exactResults: ScoredMemory[],
		filter?: (item: MemoryItem) => boolean,
	): Promise<ScoredMemory[]> {
		const ftsResults = this.ftsSearch
			? await this.ftsSearch.search(query).catch(() => [])
			: [];
		const channels: Array<{
			results: ScoredMemory[];
			weight: number;
		}> = [
			{ results: vectorResults, weight: 1 },
			{
				results: ftsResults.map((result) => ({
					item: result.item,
					score: result.ftsScore,
				})),
				weight: 1,
			},
			{ results: exactResults, weight: 1.35 },
		];
		try {
			const fused = new Map<
				string,
				{ memory: ScoredMemory; rrf: number; strongestScore: number }
			>();
			const rankConstant = 60;
			for (const channel of channels) {
				for (let index = 0; index < channel.results.length; index++) {
					const result = channel.results[index];
					if (filter && !filter(result.item)) continue;
					const previous = fused.get(result.item.id);
					const rrf = channel.weight / (rankConstant + index + 1);
					if (previous) {
						previous.rrf += rrf;
						previous.strongestScore = Math.max(
							previous.strongestScore,
							result.score,
						);
					} else {
						fused.set(result.item.id, {
							memory: result,
							rrf,
							strongestScore: result.score,
						});
					}
				}
			}
			const maxRrf = Math.max(
				...[...fused.values()].map((entry) => entry.rrf),
				Number.EPSILON,
			);
			return [...fused.values()]
				.map((entry) => ({
					...entry.memory,
					score: clamp01(
						0.85 * (entry.rrf / maxRrf) + 0.15 * clamp01(entry.strongestScore),
					),
				}))
				.sort((a, b) => b.score - a.score);
		} catch {
			return this.deduplicateScoredMemories([
				...exactResults,
				...vectorResults,
			]);
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

	private applyMmr(
		memories: ScoredMemory[],
		maxResults: number,
		lambda = 0.78,
	): ScoredMemory[] {
		if (memories.length <= 1) return memories;
		const remaining = [...memories];
		const selected: ScoredMemory[] = [];
		const limit = Math.max(1, Math.min(maxResults, memories.length));
		while (remaining.length > 0 && selected.length < limit) {
			let bestIndex = 0;
			let bestMmr = Number.NEGATIVE_INFINITY;
			for (let index = 0; index < remaining.length; index++) {
				const candidate = remaining[index];
				const redundancy = selected.reduce(
					(maximum, existing) =>
						Math.max(
							maximum,
							this.cosineSimilarity(
								candidate.item.embedding,
								existing.item.embedding,
							),
						),
					0,
				);
				const mmr = lambda * candidate.score - (1 - lambda) * redundancy;
				if (
					mmr > bestMmr ||
					(mmr === bestMmr &&
						candidate.item.id.localeCompare(remaining[bestIndex].item.id) < 0)
				) {
					bestMmr = mmr;
					bestIndex = index;
				}
			}
			selected.push(remaining.splice(bestIndex, 1)[0]);
		}
		return selected;
	}

	private cosineSimilarity(left: number[], right: number[]): number {
		if (left.length === 0 || left.length !== right.length) return 0;
		let dot = 0;
		let leftNorm = 0;
		let rightNorm = 0;
		for (let index = 0; index < left.length; index++) {
			dot += left[index] * right[index];
			leftNorm += left[index] * left[index];
			rightNorm += right[index] * right[index];
		}
		if (leftNorm === 0 || rightNorm === 0) return 0;
		return clamp01(dot / Math.sqrt(leftNorm * rightNorm));
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
		if (metadata.userId && metadata.userId !== context.userId) {
			return false;
		}
		if (metadata.projectId && metadata.projectId !== context.projectId) {
			return false;
		}
		if (metadata.agentRole && metadata.agentRole !== context.agentRole) {
			return false;
		}
		if (metadata.sessionId && metadata.sessionId !== context.sessionId) {
			return false;
		}
		if (metadata.taskId && metadata.taskId !== context.taskId) {
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

	private matchesEmbeddingDescriptor(
		item: MemoryItem,
		descriptor: EmbeddingDescriptor | undefined,
	): boolean {
		if (!descriptor) return true;
		return (
			item.metadata.embeddingVersion === descriptor.version &&
			item.metadata.embeddingDimensions === descriptor.dimensions &&
			item.metadata.embeddingQuality === descriptor.quality
		);
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
		stagedMemoryIds?: Set<string>,
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
		await this.persistMemoryItem(updated, stagedMemoryIds);
		await this.recordAudit({
			actorId: "system",
			action: `status:${status}`,
			memoryId: item.id,
			before: this.auditSnapshot(item),
			after: this.auditSnapshot(updated),
		});
	}

	private async persistMemoryItem(
		item: MemoryItem,
		stagedMemoryIds?: Set<string>,
	): Promise<void> {
		if (stagedMemoryIds) {
			await this.stageMemoryItem(item, stagedMemoryIds);
			return;
		}
		await this.deps.ltm.update(item);
	}

	private async stageMemoryItem(
		item: MemoryItem,
		stagedMemoryIds: Set<string>,
	): Promise<void> {
		await this.deps.ltm.stageStore(item);
		stagedMemoryIds.add(item.id);
	}

	private async finalizeMemoryItems(memoryIds: Set<string>): Promise<void> {
		await Promise.all(
			[...memoryIds].map((memoryId) =>
				this.deps.ltm.finalizeStore(memoryId).catch(() => {}),
			),
		);
	}

	private applyTokenBudget(
		memories: ScoredMemory[],
		budgetTokens: number,
		maxResults: number,
	): ScoredMemory[] {
		const selected: ScoredMemory[] = [];
		let used = 0;
		for (const memory of memories.slice(0, maxResults)) {
			const cost = estimateTokens(memory.item.content);
			if (used + cost > budgetTokens) continue;
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
