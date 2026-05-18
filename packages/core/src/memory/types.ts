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
	source: { conversationId?: string; taskId?: string; channelId?: string };
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

export interface MemoryCandidate {
	type: MemoryType;
	content: string;
	sourceTrust: MemorySourceTrustLevel;
	scope: MemoryScope;
	confidence?: number;
	importance?: number;
	source?: { conversationId?: string; taskId?: string; channelId?: string };
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
}

export interface MemoryReadContext extends MemoryScope {
	agentRole?: string;
	timeRange?: { since?: Date; until?: Date };
	minTrustLevel?: MemorySourceTrustLevel;
	trackUsage?: boolean;
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
}

export interface ContextAssemblyResult {
	memoryPack: MemoryPack;
	proactiveNotices: string[];
	proactiveMemoryIds: string[];
	degradedSections: string[];
	mandatorySectionsPreserved: string[];
	budgetExceeded: boolean;
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
}

export interface VectorSearchResult {
	item: MemoryItem;
	similarity: number;
}

export type EmbeddingFunction = (text: string) => Promise<number[]>;
