import type { DatabaseAdapter } from "../storage/database.js";
import { VectorStore } from "./store.js";
import type { MemoryItem, VectorSearchResult } from "./types.js";

interface MemoryItemRow {
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
}

export class SqliteVectorStore extends VectorStore {
	private initialized = false;

	async initialize(): Promise<void> {
		if (this.initialized) return;

		await this.db.run(
			`CREATE TABLE IF NOT EXISTS memory_items (
	        id TEXT PRIMARY KEY,
	        type TEXT NOT NULL,
	        content TEXT NOT NULL,
	        embedding BLOB NOT NULL,
	        importance REAL NOT NULL DEFAULT 0,
	        access_count INTEGER NOT NULL DEFAULT 0,
	        last_accessed TEXT NOT NULL,
	        created_at TEXT NOT NULL,
	        associations TEXT NOT NULL DEFAULT '[]',
	        source TEXT NOT NULL DEFAULT '{}',
	        metadata TEXT NOT NULL DEFAULT '{}'
	      )`,
		);

		// Create index for faster searches
		await this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_memory_items_type ON memory_items(type)",
		);

		await this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_memory_items_importance ON memory_items(importance)",
		);

		// Migrations
		try {
			await this.db.run("ALTER TABLE memory_items ADD COLUMN associations TEXT NOT NULL DEFAULT '[]'");
		} catch {}
		try {
			await this.db.run("ALTER TABLE memory_items ADD COLUMN source TEXT NOT NULL DEFAULT '{}'");
		} catch {}
		try {
			await this.db.run("ALTER TABLE memory_items ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'");
		} catch {}

		this.initialized = true;
	}

	private async ensureInitialized(): Promise<void> {
		if (!this.initialized) {
			await this.initialize();
		}
	}

	async store(item: MemoryItem): Promise<void> {
		await this.ensureInitialized();

		const embedding = this.serializeEmbedding(item.embedding);
		await this.db.run(
			`INSERT OR REPLACE INTO memory_items (id, type, content, embedding, importance, access_count, last_accessed, created_at, associations, source, metadata)
	       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				item.id,
				item.type,
				item.content,
				embedding,
				item.importance,
				item.accessCount,
				item.lastAccessed.toISOString(),
				item.createdAt.toISOString(),
				JSON.stringify(item.associations),
				JSON.stringify(item.source),
				JSON.stringify(item.metadata),
			],
		);
	}

	async search(
		queryEmbedding: number[],
		options: { limit: number; threshold: number },
	): Promise<VectorSearchResult[]> {
		await this.ensureInitialized();

		const rows = await this.db.all<MemoryItemRow>("SELECT * FROM memory_items");
		const results: VectorSearchResult[] = [];
		for (const row of rows) {
			const embedding = this.deserializeEmbedding(row.embedding);
			const similarity = this.cosineSimilarity(queryEmbedding, embedding);
			if (similarity >= options.threshold) {
				results.push({
					item: this.rowToItem(row, embedding),
					similarity,
				});
			}
		}
		results.sort((a, b) => b.similarity - a.similarity);
		return results.slice(0, options.limit);
	}

	async getById(id: string): Promise<MemoryItem | undefined> {
		await this.ensureInitialized();

		const row = await this.db.get<MemoryItemRow>(
			"SELECT * FROM memory_items WHERE id = ?",
			[id],
		);
		if (!row) return undefined;
		return this.rowToItem(row, this.deserializeEmbedding(row.embedding));
	}

	async getByIds(ids: string[]): Promise<MemoryItem[]> {
		await this.ensureInitialized();

		if (ids.length === 0) return [];
		const placeholders = ids.map(() => "?").join(", ");
		const rows = await this.db.all<MemoryItemRow>(
			`SELECT * FROM memory_items WHERE id IN (${placeholders})`,
			ids,
		);
		return rows.map((row) =>
			this.rowToItem(row, this.deserializeEmbedding(row.embedding)),
		);
	}

	async update(item: MemoryItem): Promise<void> {
		await this.ensureInitialized();

		const embedding = this.serializeEmbedding(item.embedding);
		await this.db.run(
			"UPDATE memory_items SET type = ?, content = ?, embedding = ?, importance = ?, access_count = ?, last_accessed = ?, created_at = ?, associations = ?, source = ?, metadata = ? WHERE id = ?",
			[
				item.type,
				item.content,
				embedding,
				item.importance,
				item.accessCount,
				item.lastAccessed.toISOString(),
				item.createdAt.toISOString(),
				JSON.stringify(item.associations),
				JSON.stringify(item.source),
				JSON.stringify(item.metadata),
				item.id,
			],
		);
	}

	async delete(id: string): Promise<void> {
		await this.ensureInitialized();

		await this.db.run("DELETE FROM memory_items WHERE id = ?", [id]);
	}

	async count(): Promise<number> {
		await this.ensureInitialized();

		const row = await this.db.get<{ count: number }>(
			"SELECT COUNT(*) as count FROM memory_items",
		);
		return row?.count ?? 0;
	}

	private rowToItem(row: MemoryItemRow, embedding: number[]): MemoryItem {
		return {
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
	}

	private cosineSimilarity(a: number[], b: number[]): number {
		if (a.length !== b.length || a.length === 0) return 0;
		let dotProduct = 0;
		let normA = 0;
		let normB = 0;
		for (let i = 0; i < a.length; i++) {
			dotProduct += a[i] * b[i];
			normA += a[i] * a[i];
			normB += b[i] * b[i];
		}
		const denominator = Math.sqrt(normA) * Math.sqrt(normB);
		if (denominator === 0) return 0;
		return dotProduct / denominator;
	}

	private serializeEmbedding(embedding: number[]): Buffer {
		const float32 = new Float32Array(embedding);
		return Buffer.from(float32.buffer, float32.byteOffset, float32.byteLength);
	}

	private deserializeEmbedding(buffer: Buffer): number[] {
		const float32 = new Float32Array(
			buffer.buffer,
			buffer.byteOffset,
			buffer.byteLength / 4,
		);
		return Array.from(float32);
	}
}
