import type { ConversationTurn } from "../agent/types.js";

export type MemoryType = "episodic" | "semantic" | "procedural";

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

export interface RetrieveOptions {
	maxResults: number;
	maxTokens: number;
	minRelevance: number;
	recencyWeight: number;
	frequencyWeight: number;
	relevanceWeight: number;
	types?: MemoryType[];
	since?: Date;
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
