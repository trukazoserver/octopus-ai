import type { ConversationTurn } from "../agent/types.js";

export type MemoryType =
	| "episodic"
	| "semantic"
	| "procedural"
	| "user"
	| "org"
	| "agent"
	| "prospective"
	| "meta";

export type MemorySourceTrustLevel =
	| "system"
	| "agent"
	| "user_explicit"
	| "user_inferred"
	| "external";

export type MemoryStatus =
	| "active"
	| "expired"
	| "superseded"
	| "contradicted"
	| "user_deleted";

export type MemoryRelationType =
	| "associated"
	| "mentions"
	| "supports"
	| "contradicts"
	| "supersedes"
	| "derived_from"
	| "depends_on"
	| "caused"
	| "blocked_by"
	| "entity_of"
	| "same_entity_as"
	| "prefers"
	| "uses"
	| "created"
	| "updated"
	| "confirmed_by";

export type MemorySensitivity = "low" | "medium" | "high" | "restricted";

export type MemoryVerificationStatus =
	| "supported"
	| "weak"
	| "unverified"
	| "conflict"
	| "expired"
	| "restricted";

export interface MemorySource {
	conversationId?: string;
	taskId?: string;
	channelId?: string;
	sourceId?: string;
	sourceType?:
		| "message"
		| "conversation"
		| "document"
		| "tool_output"
		| "task_result"
		| "user_correction"
		| "behavior_signal"
		| "api"
		| "system"
		| "agent_observation";
	title?: string;
	uri?: string;
	quotedEvidence?: string;
	authorityScore?: number;
	publishedAt?: string;
	retrievedAt?: string;
	metadata?: Record<string, unknown>;
}

export interface MemoryPermissions {
	visibleToAgents?: string[];
	hiddenFromAgents?: string[];
	visibleToUsers?: string[];
	requiresUserConfirmationBeforeUse?: boolean;
	sensitivity?: MemorySensitivity;
	retention?: {
		policy?: "none" | "expire_after_days" | "expire_at";
		days?: number;
		expiresAt?: string;
	};
}

export interface MemoryVerification {
	status: MemoryVerificationStatus;
	confidence: number;
	signals: string[];
	sourceIds: string[];
	contradictions: string[];
	recommendation: "use" | "verify" | "ask_user" | "ignore";
}

export interface MemoryVerificationReport {
	memoryId: string;
	content: string;
	type: MemoryType;
	verification: MemoryVerification;
	sensitivity: MemorySensitivity;
	sources: MemorySource[];
}

export interface MemoryGraphNode {
	id: string;
	type: string;
	name: string;
	summary?: string;
	confidence: number;
	status: string;
	metadata: Record<string, unknown>;
}

export interface MemoryGraphRelation {
	id: string;
	fromId: string;
	toId: string;
	type: MemoryRelationType;
	confidence: number;
	context?: string;
	status: string;
	metadata: Record<string, unknown>;
}

export interface MemoryGraphPath {
	fromMemoryId: string;
	toMemoryId: string;
	nodeIds: string[];
	relationIds: string[];
	depth: number;
	explanation: string;
}

export interface MemoryGraphTraversalOptions {
	maxDepth?: number;
	maxNodes?: number;
	relationTypes?: MemoryRelationType[];
}

export interface MemoryGraphSnapshot {
	memoryIds: string[];
	nodes: MemoryGraphNode[];
	relations: MemoryGraphRelation[];
	paths?: MemoryGraphPath[];
}

export interface MemoryAuditEntry {
	id: string;
	actorId: string;
	action: string;
	memoryId?: string;
	before?: Record<string, unknown>;
	after?: Record<string, unknown>;
	createdAt: Date;
	previousHash?: string;
	entryHash?: string;
}

export interface MemoryActionLogEntry {
	id: string;
	sessionId?: string;
	agentId?: string;
	actionType: string;
	input: Record<string, unknown>;
	output: Record<string, unknown>;
	status: string;
	createdAt: Date;
	previousHash?: string;
	entryHash?: string;
}

export interface MemoryLogIntegrityResult {
	table: "memory_audit_logs" | "memory_action_logs";
	valid: boolean;
	checked: number;
	legacy: number;
	missingHash: number;
	mismatches: string[];
	chainBreaks: string[];
	firstInvalidId?: string;
}

export interface MemoryAuditIntegrityReport {
	valid: boolean;
	generatedAt: Date;
	audit: MemoryLogIntegrityResult;
	actions: MemoryLogIntegrityResult;
}

export interface MemoryBackfillReport {
	scanned: number;
	sourcesLinked: number;
	permissionsCreated: number;
	nodesLinked: number;
	skipped: number;
}

export interface VectorSearchConstraints {
	scope?: MemoryScope;
	embedding?: EmbeddingDescriptor;
}

export interface VectorSearchOptions {
	limit: number;
	threshold: number;
	constraints?: VectorSearchConstraints;
	filter?: (item: MemoryItem) => boolean;
}

export interface EmbeddingReindexReport {
	mode: "preview" | "apply";
	scanned: number;
	eligible: number;
	reindexed: number;
	alreadyCurrent: number;
	blocked: number;
	failed: number;
	target?: EmbeddingDescriptor;
	nextCursor?: string;
	hasMore?: boolean;
}

export interface LegacyClaimBackfillReport {
	mode: "preview" | "apply";
	scanned: number;
	eligible: number;
	inserted: number;
	alreadyPresent: number;
	missingScope: number;
	missingValidFrom: number;
	invalid: number;
	nextCursor?: string;
	hasMore?: boolean;
	samples: Array<{ memoryId: string; outcome: string }>;
}

export interface MemoryMetricsSnapshot {
	totalMemories: number;
	versionedEmbeddings: number;
	fallbackEmbeddings: number;
	annIndexedMemories: number;
	annCoverage: number;
	annSearches: number;
	annFallbackSearches: number;
	annAverageCandidates: number;
	temporalClaims: number;
	activeInsights: number;
	invalidatedInsights: number;
	operationsByStatus: Record<string, number>;
}

export type MemoryOperationType = "embedding.reindex" | "claims.backfill";
export type MemoryOperationStatus =
	| "pending"
	| "running"
	| "paused"
	| "completed"
	| "cancelled"
	| "failed";
export type MemoryOperationControlAction = "run" | "pause" | "cancel";
export type MemoryOperationLeaseState = "none" | "active" | "expired";

export interface MemoryOperationCreateInput {
	type: MemoryOperationType;
	batchSize?: number;
	allowFallbackTarget?: boolean;
	validFromPolicy?: "require_explicit" | "created_at";
}

export interface MemoryOperationRecord {
	id: string;
	type: MemoryOperationType;
	status: MemoryOperationStatus;
	controlAction: MemoryOperationControlAction;
	fenceVersion: number;
	cursor?: string;
	request: Record<string, unknown>;
	progress: Record<string, unknown>;
	targetDescriptor?: EmbeddingDescriptor;
	attemptCount: number;
	lastError?: string;
	leaseState: MemoryOperationLeaseState;
	resumable: boolean;
	createdAt: Date;
	updatedAt: Date;
	completedAt?: Date;
}

export interface MemoryOperationListOptions {
	type?: MemoryOperationType;
	status?: MemoryOperationStatus;
	limit?: number;
	offset?: number;
}

export interface RetrievalSignals {
	semanticScore: number;
	confidence: number;
	sourceAuthority: number;
	freshness: number;
	entityMatch: number;
	contradictionPenalty: number;
	permissionPenalty: number;
}

export type MemoryUncertaintyLevel =
	| "HIGH_CONFIDENCE"
	| "LOW_CONFIDENCE"
	| "NO_COVERAGE";

export interface MemoryItem {
	id: string;
	type: MemoryType;
	content: string;
	embedding: number[];
	importance: number;
	accessCount: number;
	lastAccessed: Date;
	createdAt: Date;
	associations: string[];
	source: MemorySource;
	metadata: Record<string, unknown>;
}

export interface MemoryScope {
	tenantId: string;
	userId?: string;
	projectId?: string;
	agentRole?: string;
	sessionId?: string;
	taskId?: string;
}

export interface MemoryClaimInput {
	entity: string;
	key: string;
	value: string | number | boolean;
	validFrom?: Date | string;
	validTo?: Date | string;
}

export interface MemoryClaimRecord extends MemoryClaimInput {
	id: string;
	memoryId: string;
	recordedAt: Date;
	retractedAt?: Date;
	confidence: number;
}

export interface MemoryCandidate {
	type: MemoryType;
	content: string;
	sourceTrust: MemorySourceTrustLevel;
	scope: MemoryScope;
	confidence?: number;
	importance?: number;
	source?: MemorySource;
	permissions?: MemoryPermissions;
	claim?: MemoryClaimInput;
	metadata?: Record<string, unknown>;
	evidence?: {
		sourceType:
			| "message"
			| "task_result"
			| "tool_output"
			| "user_correction"
			| "behavior_signal";
		sourceId?: string;
		excerpt?: string;
	};
}

export interface MemoryValidationResult {
	allowed: boolean;
	candidate?: MemoryCandidate;
	reason?: string;
	detectedPatterns: string[];
	redactions: number;
	confidenceCap: number;
}

export interface MemoryPack {
	taskObjective: string;
	uncertaintyLevel: MemoryUncertaintyLevel;
	memories: ScoredMemory[];
	userMemory: ScoredMemory[];
	projectMemory: ScoredMemory[];
	similarEpisodes: ScoredMemory[];
	agentLessons: ScoredMemory[];
	prospectiveReminders: ScoredMemory[];
	knownGaps: string[];
	toolRecommendations: string[];
	knownRisks: string[];
	tokenBudgetUsed: number;
	tokenBudgetRemaining: number;
	verificationSummary?: Record<MemoryVerificationStatus, number>;
	sourceSummary?: {
		strongestSourceTrust?: MemorySourceTrustLevel;
		freshestSourceAt?: Date;
		averageAuthority: number;
	};
	entityMatches?: Array<{ entity: string; memoryIds: string[] }>;
	graphRelations?: Array<{
		sourceId: string;
		targetId: string;
		type: MemoryRelationType;
		confidence: number;
	}>;
}

export interface MemoryReadContext extends MemoryScope {
	agentRole?: string;
	timeRange?: { since?: Date; until?: Date };
	validAt?: Date;
	knownAt?: Date;
	minTrustLevel?: MemorySourceTrustLevel;
	trackUsage?: boolean;
	actorId?: string;
	includeSources?: boolean;
	includeGraph?: boolean;
	userConfirmed?: boolean;
}

export interface MemoryReadOptions {
	maxResults?: number;
}

export interface MemoryWriteResult {
	accepted: boolean;
	memoryId?: string;
	reason?: string;
	validation: MemoryValidationResult;
}

export type MemoryFeedbackType =
	| "explicit_approve"
	| "explicit_correct"
	| "explicit_delete"
	| "implicit_positive"
	| "implicit_negative"
	| "implicit_neutral"
	| "none";

export interface MemoryUsageRecord {
	memoryId: string;
	sessionId?: string;
	taskId?: string;
	agentRole?: string;
	feedbackType?: MemoryFeedbackType;
	outcome?: string;
}

export interface MemoryFeedbackInput extends MemoryUsageRecord {
	feedbackType: Exclude<MemoryFeedbackType, "none">;
	correction?: string;
	changedBy?: "system" | "user" | "agent";
}

export interface MemoryFeedbackResult {
	memoryId: string;
	previousConfidence: number;
	nextConfidence: number;
	previousStatus: MemoryStatus;
	nextStatus: MemoryStatus;
	versionCreated: boolean;
}

export interface ActiveForgettingOptions {
	now?: Date;
	unusedDays?: number;
	lowImportanceThreshold?: number;
	contradictionGraceDays?: number;
}

export interface ActiveForgettingReport {
	evaluated: number;
	compressed: number;
	expired: number;
	superseded: number;
	degraded: number;
	untouched: number;
}

export interface MemoryCoverageSnapshot {
	topicLabel: string;
	coverageScore: number;
	confidenceDistribution: Record<string, unknown>;
	knownGaps: string[];
	lastUpdated?: Date;
}

export interface MemoryUncertaintyEstimate {
	level: MemoryUncertaintyLevel;
	coverageScore: number;
	reason: string;
	knownGaps: string[];
}

export interface MemoryExplanation {
	memoryId: string;
	content: string;
	type: MemoryType;
	confidence: number;
	sourceTrust: MemorySourceTrustLevel | "unknown";
	evidence: Array<{
		sourceType: string;
		sourceId?: string;
		excerpt?: string;
		createdAt: Date;
	}>;
	usage: Array<{
		sessionId?: string;
		taskId?: string;
		agentRole?: string;
		retrievedAt: Date;
		feedbackType: string;
		outcome?: string;
	}>;
}

export interface ProspectiveReminder {
	memoryId: string;
	commitment: string;
	dueAt?: Date;
	status: "pending" | "fulfilled" | "expired";
	triggerCondition?: string;
	confidence: number;
	importance: number;
}

export interface ProactiveMemoryScanResult {
	objective: string;
	generatedAt: Date;
	reminders: ProspectiveReminder[];
	memoryPack: MemoryPack;
	notices: string[];
	relevanceDelta: number;
}

export interface ContextAssemblyInput extends MemoryReadContext {
	objective: string;
	budgetTokens: number;
	now?: Date;
	knowledgeCollectionIds?: string[];
}

export interface ContextKnowledgeChunk {
	id: string;
	itemId: string;
	collectionId: string;
	title?: string;
	content: string;
	modality: "text" | "image" | "audio" | "video" | "document" | "metadata";
	score?: number;
}

export interface ContextAssemblyResult {
	memoryPack: MemoryPack;
	proactiveNotices: string[];
	proactiveMemoryIds: string[];
	degradedSections: string[];
	mandatorySectionsPreserved: string[];
	budgetExceeded: boolean;
	knowledgeChunks: ContextKnowledgeChunk[];
}

export interface RetrieveOptions {
	maxResults: number;
	maxTokens: number;
	minRelevance: number;
	recencyWeight: number;
	frequencyWeight: number;
	relevanceWeight: number;
	types?: MemoryType[];
	since?: Date;
	constraints?: VectorSearchConstraints;
	filter?: (item: MemoryItem) => boolean;
	updateAccess?: boolean;
}

export interface ConsolidationResult {
	stored: number;
	updated: number;
	compressed: number;
	forgotten: number;
	associations: number;
}

export interface MemoryContext {
	memories: ScoredMemory[];
	totalTokens: number;
	fromSTM: ConversationTurn[];
	combined: (ConversationTurn | ScoredMemory)[];
}

export interface ScoredMemory {
	item: MemoryItem;
	score: number;
	verification?: MemoryVerification;
	signals?: RetrievalSignals;
}

export interface VectorSearchResult {
	item: MemoryItem;
	similarity: number;
}

export type EmbeddingTask = "document" | "query" | "none";

export interface EmbeddingDescriptor {
	provider: string;
	model: string;
	dimensions: number;
	version: string;
	quality: "provider" | "fallback";
}

export interface VersionedEmbedding {
	values: number[];
	descriptor: EmbeddingDescriptor;
}

export type EmbeddingFunction = {
	(text: string, task?: EmbeddingTask): Promise<number[]>;
	embedVersioned?: (
		text: string,
		task?: EmbeddingTask,
	) => Promise<VersionedEmbedding>;
	getDescriptor?: () => EmbeddingDescriptor;
};
