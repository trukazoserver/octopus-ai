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
export { SqliteVectorStore } from "./sqlite-vss.js";
export { VectorStore } from "./store.js";
export { createVectorStore } from "./factory.js";
export { KnowledgeGraph } from "./knowledge-graph.js";
export { MemoryDecayEngine } from "./decay.js";
export { FTSSearchEngine } from "./fts-search.js";
export type { FTSSearchConfig, FTSResult } from "./fts-search.js";
export { UserProfileManager } from "./user-profile.js";
export type { UserProfile, UserModelingConfig, UserDecision, WorkflowPattern } from "./user-profile.js";

export { GlobalDailyMemory } from "./daily.js";
export type { GlobalDailyMemoryConfig } from "./daily.js";
