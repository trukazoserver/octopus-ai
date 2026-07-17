import type { DatabaseAdapter } from "../storage/database.js";
import { VectorStore } from "./store.js";
import type {
	MemoryItem,
	VectorSearchOptions,
	VectorSearchResult,
} from "./types.js";

const LSH_TABLES = 4;
const LSH_BITS = 12;

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
	private annSearches = 0;
	private annFallbackSearches = 0;
	private annCandidates = 0;

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
		await this.db.run(`CREATE TABLE IF NOT EXISTS memory_vector_lsh (
			memory_id TEXT NOT NULL, embedding_version TEXT NOT NULL, dimensions INTEGER NOT NULL,
			table_no INTEGER NOT NULL, bucket TEXT NOT NULL, scope_tenant TEXT NOT NULL,
			scope_user TEXT NOT NULL, scope_project TEXT NOT NULL, scope_agent TEXT NOT NULL,
			scope_session TEXT NOT NULL, scope_task TEXT NOT NULL,
			PRIMARY KEY (memory_id, table_no)
		)`);
		await this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_memory_vector_lsh_lookup ON memory_vector_lsh (embedding_version, dimensions, scope_tenant, scope_user, scope_project, table_no, bucket)",
		);

		// Migrations
		try {
			await this.db.run(
				"ALTER TABLE memory_items ADD COLUMN associations TEXT NOT NULL DEFAULT '[]'",
			);
		} catch {}
		try {
			await this.db.run(
				"ALTER TABLE memory_items ADD COLUMN source TEXT NOT NULL DEFAULT '{}'",
			);
		} catch {}
		try {
			await this.db.run(
				"ALTER TABLE memory_items ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'",
			);
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
		await this.syncLsh(item);
		await this.syncFts(item);
	}

	async search(
		queryEmbedding: number[],
		options: VectorSearchOptions,
	): Promise<VectorSearchResult[]> {
		await this.ensureInitialized();

		const rows = await this.getSearchCandidates(queryEmbedding, options);
		const results: VectorSearchResult[] = [];
		for (const row of rows) {
			const embedding = this.deserializeEmbedding(row.embedding);
			const item = this.rowToItem(row, embedding);
			if (options.filter && !options.filter(item)) continue;
			const similarity = this.cosineSimilarity(queryEmbedding, embedding);
			if (similarity >= options.threshold) {
				results.push({
					item,
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

	async listRecent(limit: number): Promise<MemoryItem[]> {
		await this.ensureInitialized();
		const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 500));
		const rows = await this.db.all<MemoryItemRow>(
			"SELECT * FROM memory_items ORDER BY created_at DESC LIMIT ?",
			[safeLimit],
		);
		return rows.map((row) =>
			this.rowToItem(row, this.deserializeEmbedding(row.embedding)),
		);
	}

	async listAll(limit = 1000): Promise<MemoryItem[]> {
		await this.ensureInitialized();
		const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 5000));
		const rows = await this.db.all<MemoryItemRow>(
			"SELECT * FROM memory_items ORDER BY importance DESC, created_at DESC LIMIT ?",
			[safeLimit],
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
		await this.syncLsh(item);
		await this.syncFts(item);
	}

	async delete(id: string): Promise<void> {
		await this.ensureInitialized();

		await this.db.run("DELETE FROM memory_items WHERE id = ?", [id]);
		await this.db.run("DELETE FROM memory_vector_lsh WHERE memory_id = ?", [id]);
		await this.db
			.run("DELETE FROM memory_fts WHERE id = ?", [id])
			.catch(() => {});
	}

	private async syncFts(item: MemoryItem): Promise<void> {
		const sourceInfo = [
			item.source.conversationId ?? "",
			item.source.channelId ?? "",
			item.source.taskId ?? "",
		]
			.filter(Boolean)
			.join(" ");

		try {
			await this.db.run("DELETE FROM memory_fts WHERE id = ?", [item.id]);
			if (!this.isVisible(item)) return;
			await this.db.run(
				"INSERT INTO memory_fts (id, content, type, source_info) VALUES (?, ?, ?, ?)",
				[item.id, item.content, item.type, sourceInfo],
			);
		} catch {
			// FTS is optional and may not be initialized for this store.
		}
	}

	private async syncLsh(item: MemoryItem): Promise<void> {
		await this.db.run("DELETE FROM memory_vector_lsh WHERE memory_id = ?", [item.id]);
		const version = item.metadata.embeddingVersion;
		const dimensions = Number(item.metadata.embeddingDimensions);
		if (
			typeof version !== "string" ||
			!version ||
			!Number.isInteger(dimensions) ||
			dimensions !== item.embedding.length
		) {
			return;
		}
		const scope = {
			tenant: this.scopeValue(item.metadata.tenantId),
			user: this.scopeValue(item.metadata.userId),
			project: this.scopeValue(item.metadata.projectId),
			agent: this.scopeValue(item.metadata.agentRole),
			session: this.scopeValue(item.metadata.sessionId),
			task: this.scopeValue(item.metadata.taskId),
		};
		for (let table = 0; table < LSH_TABLES; table++) {
			await this.db.run(
				`INSERT INTO memory_vector_lsh
				 (memory_id, embedding_version, dimensions, table_no, bucket, scope_tenant, scope_user, scope_project, scope_agent, scope_session, scope_task)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					item.id,
					version,
					dimensions,
					table,
					this.lshBucket(item.embedding, table),
					scope.tenant,
					scope.user,
					scope.project,
					scope.agent,
					scope.session,
					scope.task,
				],
			);
		}
	}

	private async getSearchCandidates(
		queryEmbedding: number[],
		options: VectorSearchOptions,
	): Promise<MemoryItemRow[]> {
		const descriptor = options.constraints?.embedding;
		const scope = options.constraints?.scope;
		if (!descriptor || !scope || descriptor.dimensions !== queryEmbedding.length) {
			this.annFallbackSearches++;
			return this.db.all<MemoryItemRow>("SELECT * FROM memory_items");
		}
		const totals = await this.db.get<{ memories: number; indexed: number }>(
			"SELECT (SELECT COUNT(*) FROM memory_items) AS memories, (SELECT COUNT(DISTINCT memory_id) FROM memory_vector_lsh) AS indexed",
		);
		if (!totals || totals.memories === 0 || totals.indexed < totals.memories) {
			this.annFallbackSearches++;
			return this.db.all<MemoryItemRow>("SELECT * FROM memory_items");
		}
		this.annSearches++;
		const bucketClauses: string[] = [];
		const params: unknown[] = [
			descriptor.version,
			descriptor.dimensions,
			this.scopeValue(scope.tenantId),
			this.scopeValue(scope.userId),
			this.scopeValue(scope.projectId),
			this.scopeValue(scope.agentRole),
			this.scopeValue(scope.sessionId),
			this.scopeValue(scope.taskId),
		];
		for (let table = 0; table < LSH_TABLES; table++) {
			for (const bucket of this.lshProbeBuckets(queryEmbedding, table)) {
				bucketClauses.push("(table_no = ? AND bucket = ?)");
				params.push(table, bucket);
			}
		}
		params.push(Math.max(options.limit * 8, 64));
		const ids = await this.db.all<{ memory_id: string }>(
			`SELECT DISTINCT memory_id FROM memory_vector_lsh
			 WHERE embedding_version = ? AND dimensions = ? AND scope_tenant = ?
			 AND (scope_user = '' OR scope_user = ?) AND (scope_project = '' OR scope_project = ?)
			 AND (scope_agent = '' OR scope_agent = ?) AND (scope_session = '' OR scope_session = ?)
			 AND (scope_task = '' OR scope_task = ?) AND (${bucketClauses.join(" OR ")}) LIMIT ?`,
			params,
		);
		this.annCandidates += ids.length;
		if (ids.length === 0) return [];
		const placeholders = ids.map(() => "?").join(", ");
		return this.db.all<MemoryItemRow>(
			`SELECT * FROM memory_items WHERE id IN (${placeholders})`,
			ids.map((row) => row.memory_id),
		);
	}

	private lshBucket(embedding: number[], table: number): string {
		let bits = 0;
		for (let bit = 0; bit < LSH_BITS; bit++) {
			let projection = 0;
			for (let index = 0; index < embedding.length; index++) {
				let seed =
					Math.imul(table + 1, 73856093) ^
					Math.imul(bit + 1, 19349663) ^
					Math.imul(index + 1, 83492791);
				seed ^= seed >>> 16;
				seed = Math.imul(seed, 0x7feb352d);
				seed ^= seed >>> 15;
				const weight = (seed & 1) === 0 ? 1 : -1;
				projection += embedding[index] * weight;
			}
			if (projection >= 0) bits |= 1 << bit;
		}
		return bits.toString(16).padStart(Math.ceil(LSH_BITS / 4), "0");
	}

	private lshProbeBuckets(embedding: number[], table: number): string[] {
		const base = Number.parseInt(this.lshBucket(embedding, table), 16);
		const buckets = [base];
		for (let bit = 0; bit < LSH_BITS; bit++) buckets.push(base ^ (1 << bit));
		return buckets.map((value) =>
			value.toString(16).padStart(Math.ceil(LSH_BITS / 4), "0"),
		);
	}

	private scopeValue(value: unknown): string {
		return typeof value === "string" ? value : "";
	}

	getDiagnostics(): Record<string, number> {
		return {
			annSearches: this.annSearches,
			annFallbackSearches: this.annFallbackSearches,
			annAverageCandidates:
				this.annSearches > 0 ? this.annCandidates / this.annSearches : 0,
		};
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

	private deserializeEmbedding(buffer: Buffer | null): number[] {
		if (!buffer) return [];
		const float32 = new Float32Array(
			buffer.buffer,
			buffer.byteOffset,
			buffer.byteLength / 4,
		);
		return Array.from(float32);
	}
}
