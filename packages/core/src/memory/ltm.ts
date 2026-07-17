import { nanoid } from "nanoid";
import type { DatabaseAdapter } from "../storage/database.js";
import type {
	LegacyVectorPayloadMigrationInput,
	LegacyVectorPayloadMigrationReport,
	VectorStore,
} from "./store.js";
import type {
	EmbeddingFunction,
	MemoryItem,
	MemoryType,
	RetrieveOptions,
	ScoredMemory,
} from "./types.js";

export class LongTermMemory {
	constructor(
		private vectorStore: VectorStore,
		private db: DatabaseAdapter,
	) {}

	async store(item: MemoryItem): Promise<void> {
		await this.db.transaction(async () => this.stageStore(item));
		await this.finalizeStore(item.id);
	}

	async stageStore(item: MemoryItem): Promise<void> {
		await this.vectorStore.stageStore(item);
	}

	async finalizeStore(itemId: string): Promise<void> {
		await this.vectorStore.finalizeStore(itemId);
	}

	async migrateLegacyPayloads(
		input: LegacyVectorPayloadMigrationInput,
	): Promise<LegacyVectorPayloadMigrationReport> {
		return this.vectorStore.migrateLegacyPayloads(input);
	}

	async retrieve(
		_query: string,
		_options: RetrieveOptions,
	): Promise<ScoredMemory[]> {
		throw new Error(
			"Use retrieveByEmbedding with a pre-computed embedding instead",
		);
	}

	async retrieveByEmbedding(
		embedding: number[],
		options: RetrieveOptions,
	): Promise<ScoredMemory[]> {
		const results = await this.vectorStore.search(embedding, {
			limit: Math.max(options.maxResults * 20, options.maxResults),
			threshold: options.minRelevance,
			constraints: options.constraints,
			filter: (item) =>
				this.isVisible(item) && (!options.filter || options.filter(item)),
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
			filtered = filtered.filter((s) => options.types?.includes(s.item.type));
		}
		if (options.since) {
			const since = options.since;
			filtered = filtered.filter((s) => s.item.createdAt >= since);
		}

		filtered.sort((a, b) => b.score - a.score);
		const selected = filtered.slice(0, options.maxResults);
		if (options.updateAccess !== false) {
			await Promise.all(
				selected.map((result) => this.updateAccess(result.item.id)),
			);
		}
		return selected;
	}

	async associate(
		itemId: string,
		relatedId: string,
		strength: number,
	): Promise<void> {
		await this.db.run(
			`CREATE TABLE IF NOT EXISTS memory_associations (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation TEXT NOT NULL DEFAULT 'associated',
        strength REAL NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
		);
		await this.db.run(
			"INSERT INTO memory_associations (id, source_id, target_id, strength) VALUES (?, ?, ?, ?)",
			[nanoid(), itemId, relatedId, strength],
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
			[itemId],
		);
		return rows.map((r) => r.target_id);
	}

	async forget(itemId: string): Promise<void> {
		await this.db.transaction(async () => this.stageForget(itemId));
		await this.finalizeForget(itemId);
	}

	async stageForget(itemId: string): Promise<void> {
		await this.vectorStore.stageDelete(itemId);
		await this.db
			.run("DELETE FROM memory_associations WHERE source_id = ?", [itemId])
			.catch(() => {});
		await this.db
			.run("DELETE FROM memory_associations WHERE target_id = ?", [itemId])
			.catch(() => {});
	}

	async finalizeForget(itemId: string): Promise<void> {
		await this.vectorStore.finalizeDelete(itemId);
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
		},
	): Promise<MemoryItem[]> {
		const normalizedQuery = query.trim();
		if (!normalizedQuery) return [];

		const embedding = await embeddingFn(query, "query");
		const results = await this.vectorStore.search(embedding, {
			limit: 50,
			threshold: 0.5,
			filter: (item) => this.isVisible(item),
		});
		let items = results.map((r) => r.item);
		items = await this.appendLexicalMatches(normalizedQuery, items);
		if (filters?.types && filters.types.length > 0) {
			items = items.filter((i) => filters.types?.includes(i.type));
		}
		if (filters?.minImportance !== undefined) {
			const minImp = filters.minImportance;
			items = items.filter((i) => i.importance >= minImp);
		}
		const selected = items.slice(0, 50);
		await Promise.all(selected.map((item) => this.updateAccess(item.id)));
		return selected;
	}

	private async appendLexicalMatches(
		query: string,
		items: MemoryItem[],
	): Promise<MemoryItem[]> {
		const words = query
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s_-]/gu, " ")
			.split(/\s+/)
			.filter((word) => word.length > 1)
			.slice(0, 10);
		if (words.length === 0) return items;

		const seen = new Set(items.map((item) => item.id));
		const allItems = await this.listAll(5000);
		const lexicalMatches = allItems
			.filter((item) => !seen.has(item.id))
			.map((item) => {
				const searchable =
					`${item.content} ${JSON.stringify(item.source)} ${JSON.stringify(item.metadata)}`.toLowerCase();
				const exactBoost = searchable.includes(query.toLowerCase()) ? 1 : 0;
				const matchedWords = words.filter((word) => searchable.includes(word));
				return { item, score: exactBoost + matchedWords.length / words.length };
			})
			.filter((match) => match.score > 0)
			.sort(
				(a, b) => b.score - a.score || b.item.importance - a.item.importance,
			)
			.map((match) => match.item);

		return [...items, ...lexicalMatches];
	}

	async listRecent(limit: number): Promise<MemoryItem[]> {
		const items = await this.vectorStore.listRecent(limit * 5);
		return items.filter((item) => this.isVisible(item)).slice(0, limit);
	}

	async listAll(
		limit?: number,
		options: { includeInactive?: boolean } = {},
	): Promise<MemoryItem[]> {
		const items = await this.vectorStore.listAll(limit);
		return options.includeInactive
			? items
			: items.filter((item) => this.isVisible(item));
	}

	async update(item: MemoryItem): Promise<void> {
		await this.vectorStore.update(item);
	}

	async count(): Promise<number> {
		return this.vectorStore.count();
	}

	getDiagnostics(): Record<string, number> {
		return this.vectorStore.getDiagnostics();
	}

	async updateAccess(itemId: string): Promise<void> {
		await this.vectorStore.updateAccess(itemId);
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

	private isVisible(item: MemoryItem): boolean {
		const status = item.metadata.status;
		if (status && status !== "active") return false;
		const expiresAt = item.metadata.expiresAt;
		if (typeof expiresAt === "string") {
			const parsed = new Date(expiresAt);
			if (!Number.isNaN(parsed.getTime()) && parsed.getTime() <= Date.now()) {
				return false;
			}
		}
		return true;
	}
}
