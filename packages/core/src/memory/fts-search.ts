import type { DatabaseAdapter } from "../storage/database.js";
import { createLogger } from "../utils/logger.js";
import { isAssistantMemoryDenialEcho } from "./denial-echo.js";
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
			logger.warn(`FTS5 unavailable; using lexical fallback: ${String(err)}`);
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
			if (!this.isVisible(item)) return;

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
		if (!this.initialized) return this.fallbackSearch(query);

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
				[sanitized, this.config.maxFTSResults * 100],
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
					const embedding = this.deserializeEmbedding(fullRow.embedding);
					const item: MemoryItem = {
						id: fullRow.id,
						type: fullRow.type as MemoryItem["type"],
						content: fullRow.content,
						embedding,
						importance: fullRow.importance,
						accessCount: fullRow.access_count,
						lastAccessed: new Date(fullRow.last_accessed),
						createdAt: new Date(fullRow.created_at),
						associations: JSON.parse(fullRow.associations),
						source: JSON.parse(fullRow.source),
						metadata: JSON.parse(fullRow.metadata),
					};
					if (!this.isVisible(item)) continue;

					// Normalize BM25 rank (negative; more negative = better match) to a
					// 0-1 score where HIGHER = better match. This composes correctly with
					// the memory-type/denial-echo ranking signals below and with
					// hybridSearch (which sorts descending by combined score). The previous
					// formula 1/(1+|rank|) inverted the ranking (better matches scored
					// lower), which silently devalued FTS hits in hybrid search.
					const absRank = Math.abs(row.rank);
					const normalizedScore = Math.max(
						0,
						Math.min(1, absRank / (1 + absRank)),
					);

					results.push({
						item,
						ftsScore: this.applyRankingSignals(item, normalizedScore),
					});
				}
			}

			// Order by the final ftsScore (BM25 + memory-type boost + denial-echo
			// penalty), mirroring fallbackSearch so both paths agree on ranking.
			// The raw SQL ORDER BY rank alone ignores those signals, which let a
			// denial-echo outrank a direct semantic match.
			results.sort((a, b) => b.ftsScore - a.ftsScore);
			return results.slice(0, this.config.maxFTSResults);
		} catch (err) {
			logger.error(`FTS search failed: ${String(err)}`);
			return this.fallbackSearch(query);
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
			await this.db.run("DELETE FROM memory_fts");
			const rows = await this.db.all<{
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
			}>("SELECT * FROM memory_items");

			if (rows.length > 0) {
				logger.info("Syncing memory items to FTS5 index...");
				let indexed = 0;
				for (const row of rows) {
					const item: MemoryItem = {
						id: row.id,
						type: row.type as MemoryItem["type"],
						content: row.content,
						embedding: this.deserializeEmbedding(row.embedding),
						importance: row.importance,
						accessCount: row.access_count,
						lastAccessed: new Date(row.last_accessed),
						createdAt: new Date(row.created_at),
						associations: JSON.parse(row.associations),
						source: JSON.parse(row.source),
						metadata: JSON.parse(row.metadata),
					};
					if (!this.isVisible(item)) continue;
					await this.index(item);
					indexed += 1;
				}

				logger.info(`Synced ${indexed} active items to FTS5`);
			}
		} catch (err) {
			logger.warn(`FTS sync from memory_items failed: ${String(err)}`);
		}
	}

	private deserializeEmbedding(buffer: Buffer): number[] {
		const float32 = new Float32Array(
			buffer.buffer,
			buffer.byteOffset,
			buffer.byteLength / 4,
		);
		return Array.from(float32);
	}

	private async fallbackSearch(query: string): Promise<FTSResult[]> {
		const words = this.queryWords(query);
		if (words.length === 0) return [];
		const exactTokens = new Set(words.filter((word) => word.length >= 8));

		try {
			const rows = await this.db.all<{
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
			}>("SELECT * FROM memory_items");

			return rows
				.map((row) => {
					const embedding = this.deserializeEmbedding(row.embedding);
					const item: MemoryItem = {
						id: row.id,
						type: row.type as MemoryItem["type"],
						content: row.content,
						embedding,
						importance: row.importance,
						accessCount: row.access_count,
						lastAccessed: new Date(row.last_accessed),
						createdAt: new Date(row.created_at),
						associations: JSON.parse(row.associations),
						source: JSON.parse(row.source),
						metadata: JSON.parse(row.metadata),
					};
					if (!this.isVisible(item)) return null;
					const searchable =
						`${row.content} ${row.type} ${row.source} ${row.metadata}`.toLowerCase();
					const matchedWords = words.filter((word) =>
						searchable.includes(word),
					);
					if (matchedWords.length === 0) return null;
					const exactTokenBoost = matchedWords.filter((word) =>
						exactTokens.has(word),
					).length;
					return {
						item,
						ftsScore: this.applyRankingSignals(
							item,
							matchedWords.length / words.length + exactTokenBoost,
						),
					} satisfies FTSResult;
				})
				.filter((result): result is FTSResult => result !== null)
				.sort((a, b) => b.ftsScore - a.ftsScore)
				.slice(0, this.config.maxFTSResults);
		} catch (err) {
			logger.warn(`Fallback FTS search failed: ${String(err)}`);
			return [];
		}
	}

	/**
	 * Sanitize a query string for FTS5 MATCH syntax.
	 */
	private sanitizeQuery(query: string): string {
		// FTS5 matches whole tokens exactly, so a discriminative identifier
		// (e.g. "FocusCobaltPublic", an API key, a username) is what makes a
		// relevant document surface. Tokenize, then keep the LONGEST tokens
		// (most discriminative) instead of the first N, so a long identifier
		// sitting at the tail of the query is not dropped by the cap — otherwise
		// the only document that contains it never matches and cannot rank.
		const tokens = this.tokenizeQuery(query)
			.sort((a, b) => b.length - a.length)
			.slice(0, 10);

		if (tokens.length === 0) return "";

		// Use OR matching for flexibility
		return tokens.map((w) => `"${w}"`).join(" OR ");
	}

	private tokenizeQuery(query: string): string[] {
		return query
			.toLowerCase()
			.replace(/[^\w\sáéíóúñü]/g, " ")
			.split(/\s+/)
			.filter((w) => w.length > 1);
	}

	private queryWords(query: string): string[] {
		return this.tokenizeQuery(query).slice(0, 10);
	}

	private applyRankingSignals(item: MemoryItem, score: number): number {
		const denialPenalty = isAssistantMemoryDenialEcho(item.content) ? 0.75 : 0;
		return Math.max(
			0.01,
			score + this.directMemoryTypeBoost(item) - denialPenalty,
		);
	}

	private directMemoryTypeBoost(item: MemoryItem): number {
		return item.type === "semantic" ||
			item.type === "user" ||
			item.type === "org"
			? 0.75
			: item.type === "episodic"
				? -0.2
				: 0;
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

	isAvailable(): boolean {
		return this.initialized;
	}
}
