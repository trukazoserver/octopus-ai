import type { DatabaseAdapter } from "../storage/database.js";
import { createLogger } from "../utils/logger.js";
import type { EmbeddingFunction, MemoryItem, ScoredMemory } from "./types.js";

/**
 * FTSSearch — Full-Text Search complement for memory
 *
 * Uses SQLite FTS5 for exact full-text search over memory items.
 * This complements the vector (embedding) search in LTM:
 *
 * - **Vector search** = good for semantic similarity ("show me things about coding")
 * - **FTS5 search** = good for exact recall ("what was the API key for Stripe?")
 *
 * Both results are combined with configurable weighting for hybrid search.
 */

const logger = createLogger("fts-search");

export interface FTSSearchConfig {
	/** Weight for FTS5 results in hybrid search (0-1) */
	ftsWeight: number;
	/** Weight for vector results in hybrid search (0-1) */
	vectorWeight: number;
	/** Maximum results from FTS */
	maxFTSResults: number;
}

export const DEFAULT_FTS_CONFIG: FTSSearchConfig = {
	ftsWeight: 0.4,
	vectorWeight: 0.6,
	maxFTSResults: 20,
};

export interface FTSResult {
	item: MemoryItem;
	/** BM25 rank score (lower = more relevant, normalized to 0-1) */
	ftsScore: number;
}

export class FTSSearchEngine {
	private config: FTSSearchConfig;
	private db: DatabaseAdapter;
	private initialized = false;

	constructor(db: DatabaseAdapter, config: Partial<FTSSearchConfig> = {}) {
		this.config = { ...DEFAULT_FTS_CONFIG, ...config };
		this.db = db;
	}

	/**
	 * Initialize FTS5 virtual table.
	 * Must be called after memory_items table exists.
	 */
	async initialize(): Promise<void> {
		if (this.initialized) return;

		try {
			// Create FTS5 virtual table mirroring memory_items content
			await this.db.run(
				`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
					id UNINDEXED,
					content,
					type UNINDEXED,
					source_info,
					tokenize = 'unicode61 remove_diacritics 2'
				)`,
			);

			// Sync existing data from memory_items to FTS
			await this.syncFromMemoryItems();

			this.initialized = true;
			logger.info("FTS5 search engine initialized");
		} catch (err) {
			logger.error(`Failed to initialize FTS5: ${String(err)}`);
			// FTS5 may not be available in all SQLite builds
			// Gracefully degrade — hybrid search will just use vector
			this.initialized = false;
		}
	}

	/**
	 * Index a memory item in the FTS table.
	 */
	async index(item: MemoryItem): Promise<void> {
		if (!this.initialized) return;

		const sourceInfo = [
			item.source.conversationId ?? "",
			item.source.channelId ?? "",
			item.source.taskId ?? "",
		]
			.filter(Boolean)
			.join(" ");

		try {
			// Delete existing entry first (upsert)
			await this.db.run("DELETE FROM memory_fts WHERE id = ?", [item.id]);

			await this.db.run(
				"INSERT INTO memory_fts (id, content, type, source_info) VALUES (?, ?, ?, ?)",
				[item.id, item.content, item.type, sourceInfo],
			);
		} catch (err) {
			logger.error(`Failed to index item in FTS: ${String(err)}`);
		}
	}

	/**
	 * Remove a memory item from FTS index.
	 */
	async remove(itemId: string): Promise<void> {
		if (!this.initialized) return;

		try {
			await this.db.run("DELETE FROM memory_fts WHERE id = ?", [itemId]);
		} catch {
			// Non-critical
		}
	}

	/**
	 * Search using FTS5 full-text search.
	 * Returns items ranked by BM25 relevance.
	 */
	async search(query: string): Promise<FTSResult[]> {
		if (!this.initialized) return [];

		try {
			// Sanitize query for FTS5
			const sanitized = this.sanitizeQuery(query);
			if (!sanitized) return [];

			const rows = await this.db.all<{
				id: string;
				content: string;
				type: string;
				source_info: string;
				rank: number;
			}>(
				`SELECT id, content, type, source_info, rank
				 FROM memory_fts
				 WHERE memory_fts MATCH ?
				 ORDER BY rank
				 LIMIT ?`,
				[sanitized, this.config.maxFTSResults],
			);

			// We need to fetch full MemoryItem data from memory_items
			const results: FTSResult[] = [];
			for (const row of rows) {
				const fullRow = await this.db.get<{
					id: string;
					type: string;
					content: string;
					embedding: Buffer;
					importance: number;
					access_count: number;
					last_accessed: string;
					created_at: string;
					associations: string;
					source: string;
					metadata: string;
				}>("SELECT * FROM memory_items WHERE id = ?", [row.id]);

				if (fullRow) {
					const item: MemoryItem = {
						id: fullRow.id,
						type: fullRow.type as MemoryItem["type"],
						content: fullRow.content,
						embedding: [], // Don't load embedding for FTS results
						importance: fullRow.importance,
						accessCount: fullRow.access_count,
						lastAccessed: new Date(fullRow.last_accessed),
						createdAt: new Date(fullRow.created_at),
						associations: JSON.parse(fullRow.associations),
						source: JSON.parse(fullRow.source),
						metadata: JSON.parse(fullRow.metadata),
					};

					// Normalize rank to 0-1 (BM25 rank is negative, lower = better)
					const normalizedScore = Math.max(0, Math.min(1, 1 / (1 + Math.abs(row.rank))));

					results.push({ item, ftsScore: normalizedScore });
				}
			}

			return results;
		} catch (err) {
			logger.error(`FTS search failed: ${String(err)}`);
			return [];
		}
	}

	/**
	 * Hybrid search: combine FTS5 and vector search results.
	 */
	async hybridSearch(
		query: string,
		vectorResults: ScoredMemory[],
	): Promise<ScoredMemory[]> {
		const ftsResults = await this.search(query);

		if (ftsResults.length === 0) return vectorResults;

		// Build a map of all items by ID
		const combinedMap = new Map<string, { item: MemoryItem; score: number }>();

		// Add vector results
		for (const vr of vectorResults) {
			combinedMap.set(vr.item.id, {
				item: vr.item,
				score: vr.score * this.config.vectorWeight,
			});
		}

		// Merge FTS results
		for (const fr of ftsResults) {
			const existing = combinedMap.get(fr.item.id);
			if (existing) {
				// Item found in both — boost score
				existing.score += fr.ftsScore * this.config.ftsWeight;
			} else {
				// Item only in FTS — add with FTS weight
				combinedMap.set(fr.item.id, {
					item: fr.item,
					score: fr.ftsScore * this.config.ftsWeight,
				});
			}
		}

		// Sort by combined score
		const results = Array.from(combinedMap.values())
			.sort((a, b) => b.score - a.score)
			.map(({ item, score }) => ({ item, score }));

		return results;
	}

	/**
	 * Sync existing memory_items into the FTS index.
	 */
	private async syncFromMemoryItems(): Promise<void> {
		try {
			// Check if FTS table has data
			const ftsCount = await this.db.get<{ count: number }>(
				"SELECT COUNT(*) as count FROM memory_fts",
			);

			const memCount = await this.db.get<{ count: number }>(
				"SELECT COUNT(*) as count FROM memory_items",
			);

			// Only sync if FTS is empty but memory_items has data
			if (
				(ftsCount?.count ?? 0) === 0 &&
				(memCount?.count ?? 0) > 0
			) {
				logger.info("Syncing existing memory items to FTS5 index...");

				await this.db.run(
					`INSERT INTO memory_fts (id, content, type, source_info)
					 SELECT id, content, type, COALESCE(source, '{}')
					 FROM memory_items`,
				);

				logger.info(`Synced ${memCount?.count ?? 0} items to FTS5`);
			}
		} catch (err) {
			logger.warn(`FTS sync from memory_items failed: ${String(err)}`);
		}
	}

	/**
	 * Sanitize a query string for FTS5 MATCH syntax.
	 */
	private sanitizeQuery(query: string): string {
		// Remove FTS5 special characters, keep words
		const words = query
			.replace(/[^\w\sáéíóúñü]/g, " ")
			.split(/\s+/)
			.filter((w) => w.length > 1)
			.slice(0, 10);

		if (words.length === 0) return "";

		// Use OR matching for flexibility
		return words.map((w) => `"${w}"`).join(" OR ");
	}

	isAvailable(): boolean {
		return this.initialized;
	}
}
