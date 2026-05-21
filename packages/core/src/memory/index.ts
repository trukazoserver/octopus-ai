export type {
	MemoryType,
	MemoryItem,
	RetrieveOptions,
	ConsolidationResult,
	MemoryContext,
	ScoredMemory,
	VectorSearchResult,
	EmbeddingFunction,
} from "./types.js";

export { ShortTermMemory } from "./stm.js";
export { LongTermMemory } from "./ltm.js";
export { MemoryRetrieval } from "./retrieval.js";
export { MemoryConsolidator } from "./consolidator.js";
export type { LLMExtractCallback } from "./consolidator.js";
export { SqliteVectorStore } from "./sqlite-vss.js";
export { ExternalVectorStore } from "./external-vector-store.js";
export type {
	ExternalVectorBackend,
	ExternalVectorStoreConfig,
} from "./external-vector-store.js";
export { PgVectorStore } from "./pgvector-store.js";
export type { PgVectorStoreConfig } from "./pgvector-store.js";
export { VectorStore } from "./store.js";
export { createVectorStore } from "./factory.js";
export type { VectorStoreFactoryOptions } from "./factory.js";
export { KnowledgeGraph } from "./knowledge-graph.js";
export { MemoryDecayEngine } from "./decay.js";
export { FTSSearchEngine } from "./fts-search.js";
export type { FTSSearchConfig, FTSResult } from "./fts-search.js";
export { UserProfileManager } from "./user-profile.js";
export type {
	UserProfile,
	UserModelingConfig,
	UserDecision,
	WorkflowPattern,
} from "./user-profile.js";

export { GlobalDailyMemory } from "./daily.js";
export type { GlobalDailyMemoryConfig } from "./daily.js";

export { EmbeddingProvider } from "./embedding-provider.js";
export type {
	EmbeddingProviderConfig,
	EmbeddingResult,
	EmbeddingApiType,
} from "./embedding-provider.js";

export { WorkingMemory } from "./working-memory.js";
export type { WorkingState } from "./working-memory.js";
export type { CondensationCallback } from "./stm.js";
export { ContextAssembler } from "./context-assembler.js";
export type { ContextAssemblerConfig } from "./context-assembler.js";
export { MemoryIntegrityLayer } from "./integrity.js";
export { MemoryOrchestrator } from "./orchestrator.js";
export { MemoryRetentionScheduler } from "./retention-scheduler.js";
export type {
	MemoryRetentionRunner,
	MemoryRetentionScheduleConfig,
	MemoryRetentionSchedulerLike,
	MemoryRetentionSchedulerLogger,
} from "./retention-scheduler.js";
export { ProactiveMemoryScanner } from "./proactive-scanner.js";
export type { ProactiveMemoryScannerConfig } from "./proactive-scanner.js";
export { UncertaintyEstimator } from "./uncertainty.js";
export type { UncertaintyEstimatorConfig } from "./uncertainty.js";
export type {
	MemorySourceTrustLevel,
	MemoryRelationType,
	MemorySensitivity,
	MemoryPermissions,
	MemorySource,
	MemoryVerification,
	MemoryVerificationReport,
	MemoryVerificationStatus,
	MemoryGraphNode,
	MemoryGraphRelation,
	MemoryGraphPath,
	MemoryGraphTraversalOptions,
	MemoryGraphSnapshot,
	MemoryAuditEntry,
	MemoryActionLogEntry,
	MemoryBackfillReport,
	MemoryAuditIntegrityReport,
	MemoryLogIntegrityResult,
	RetrievalSignals,
	MemoryStatus,
	MemoryUncertaintyLevel,
	MemoryScope,
	MemoryCandidate,
	MemoryValidationResult,
	MemoryPack,
	MemoryReadContext,
	MemoryWriteResult,
	MemoryFeedbackType,
	MemoryFeedbackInput,
	MemoryFeedbackResult,
	ActiveForgettingOptions,
	ActiveForgettingReport,
	MemoryUsageRecord,
	MemoryCoverageSnapshot,
	MemoryUncertaintyEstimate,
	MemoryExplanation,
	ProspectiveReminder,
	ProactiveMemoryScanResult,
	ContextAssemblyInput,
	ContextAssemblyResult,
} from "./types.js";
