import type { DatabaseAdapter } from "../storage/database.js";
import type { MemoryItem, VectorSearchResult } from "./types.js";

export abstract class VectorStore {
	constructor(protected db: DatabaseAdapter) {}

	/**
	 * Initialize the vector store (create tables, indexes, etc.)
	 * Should be called before any other operations
	 */
	abstract initialize(): Promise<void>;

	abstract store(item: MemoryItem): Promise<void>;
	abstract search(
		queryEmbedding: number[],
		options: { limit: number; threshold: number },
	): Promise<VectorSearchResult[]>;
	abstract getById(id: string): Promise<MemoryItem | undefined>;
	abstract getByIds(ids: string[]): Promise<MemoryItem[]>;
	abstract update(item: MemoryItem): Promise<void>;
	abstract delete(id: string): Promise<void>;
	abstract count(): Promise<number>;
}
