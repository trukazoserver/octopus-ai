import { nanoid } from "nanoid";
import type { DatabaseAdapter } from "../storage/database.js";
import type {
  EmbeddingFunction,
  MemoryItem,
  MemoryType,
  RetrieveOptions,
  ScoredMemory,
} from "./types.js";
import type { VectorStore } from "./store.js";

export class LongTermMemory {
  constructor(
    private vectorStore: VectorStore,
    private db: DatabaseAdapter
  ) {}

  async store(item: MemoryItem): Promise<void> {
    await this.vectorStore.store(item);
  }

  async retrieve(
    _query: string,
    _options: RetrieveOptions
  ): Promise<ScoredMemory[]> {
    throw new Error(
      "Use retrieveByEmbedding with a pre-computed embedding instead"
    );
  }

  async retrieveByEmbedding(
    embedding: number[],
    options: RetrieveOptions
  ): Promise<ScoredMemory[]> {
    const results = await this.vectorStore.search(embedding, {
      limit: options.maxResults * 3,
      threshold: options.minRelevance,
    });

    const scored: ScoredMemory[] = results.map((r) => {
      const item = r.item;
      const recencyScore = this.computeRecencyScore(item);
      const frequencyScore = this.computeFrequencyScore(item);
      const combinedScore =
        r.similarity * options.relevanceWeight +
        recencyScore * options.recencyWeight +
        frequencyScore * options.frequencyWeight;
      return { item, score: combinedScore };
    });

    let filtered = scored;
    if (options.types && options.types.length > 0) {
      filtered = filtered.filter((s) =>
        options.types!.includes(s.item.type)
      );
    }
    if (options.since) {
      filtered = filtered.filter(
        (s) => s.item.createdAt >= options.since!
      );
    }

    filtered.sort((a, b) => b.score - a.score);
    return filtered.slice(0, options.maxResults);
  }

  async associate(
    itemId: string,
    relatedId: string,
    strength: number
  ): Promise<void> {
    await this.db.run(
      `CREATE TABLE IF NOT EXISTS memory_associations (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        strength REAL NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    );
    await this.db.run(
      "INSERT INTO memory_associations (id, source_id, target_id, strength) VALUES (?, ?, ?, ?)",
      [nanoid(), itemId, relatedId, strength]
    );
    const item = await this.vectorStore.getById(itemId);
    if (item && !item.associations.includes(relatedId)) {
      item.associations.push(relatedId);
      await this.vectorStore.update(item);
    }
    const related = await this.vectorStore.getById(relatedId);
    if (related && !related.associations.includes(itemId)) {
      related.associations.push(itemId);
      await this.vectorStore.update(related);
    }
  }

  async getAssociations(itemId: string): Promise<string[]> {
    const rows = await this.db.all<{ target_id: string }>(
      "SELECT target_id FROM memory_associations WHERE source_id = ? ORDER BY strength DESC",
      [itemId]
    );
    return rows.map((r) => r.target_id);
  }

  async forget(itemId: string): Promise<void> {
    await this.vectorStore.delete(itemId);
    await this.db
      .run("DELETE FROM memory_associations WHERE source_id = ?", [itemId])
      .catch(() => {});
    await this.db
      .run("DELETE FROM memory_associations WHERE target_id = ?", [itemId])
      .catch(() => {});
  }

  async getById(id: string): Promise<MemoryItem | undefined> {
    return this.vectorStore.getById(id);
  }

  async search(
    query: string,
    embeddingFn: EmbeddingFunction,
    filters?: {
      types?: MemoryType[];
      minImportance?: number;
    }
  ): Promise<MemoryItem[]> {
    const embedding = await embeddingFn(query);
    const results = await this.vectorStore.search(embedding, {
      limit: 50,
      threshold: 0.5,
    });
    let items = results.map((r) => r.item);
    if (filters?.types && filters.types.length > 0) {
      items = items.filter((i) => filters.types!.includes(i.type));
    }
    if (filters?.minImportance !== undefined) {
      items = items.filter((i) => i.importance >= filters.minImportance!);
    }
    return items;
  }

  async count(): Promise<number> {
    return this.vectorStore.count();
  }

  async updateAccess(itemId: string): Promise<void> {
    const item = await this.vectorStore.getById(itemId);
    if (item) {
      item.accessCount += 1;
      item.lastAccessed = new Date();
      await this.vectorStore.update(item);
    }
  }

  private computeRecencyScore(item: MemoryItem): number {
    const now = Date.now();
    const lastAccessed = item.lastAccessed.getTime();
    const daysSince = (now - lastAccessed) / (1000 * 60 * 60 * 24);
    return Math.exp(-0.1 * daysSince);
  }

  private computeFrequencyScore(item: MemoryItem): number {
    return Math.log(1 + item.accessCount) / Math.log(1 + 100);
  }
}
