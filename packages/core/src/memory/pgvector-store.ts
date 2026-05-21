import { Client } from "pg";
import type { DatabaseAdapter } from "../storage/database.js";
import { SqliteVectorStore } from "./sqlite-vss.js";
import { VectorStore } from "./store.js";
import type { MemoryItem, VectorSearchResult } from "./types.js";

export interface PgVectorStoreConfig {
	connectionString: string;
	table: string;
	dimension?: number;
	ssl?:
		| boolean
		| {
				rejectUnauthorized?: boolean;
				ca?: string;
				cert?: string;
				key?: string;
		  };
}

export class PgVectorStore extends VectorStore {
	private local: SqliteVectorStore;
	private client?: Client;
	private initialized = false;
	private dimension?: number;
	private tableName: string;

	constructor(
		db: DatabaseAdapter,
		private config: PgVectorStoreConfig,
	) {
		super(db);
		this.local = new SqliteVectorStore(db);
		this.tableName = sanitizeIdentifier(
			config.table || "octopus_memory_vectors",
		);
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		await this.local.initialize();
		this.client = new Client({
			connectionString: this.config.connectionString,
			ssl: this.config.ssl,
		});
		await this.client.connect();
		if (this.config.dimension) {
			await this.ensureRemoteTable(this.config.dimension);
		}
		this.initialized = true;
	}

	async store(item: MemoryItem): Promise<void> {
		await this.ensureInitialized();
		await this.ensureRemoteTable(item.embedding.length);
		await this.local.store(item);
		await this.upsertRemote(item);
	}

	async search(
		queryEmbedding: number[],
		options: {
			limit: number;
			threshold: number;
			filter?: (item: MemoryItem) => boolean;
		},
	): Promise<VectorSearchResult[]> {
		await this.ensureInitialized();
		await this.ensureRemoteTable(queryEmbedding.length);
		const client = this.requireClient();
		const rows = await client.query<{
			memory_id: string;
			score: number | string;
		}>(
			`SELECT memory_id, 1 - (embedding <=> $1::vector) AS score
				FROM ${this.tableName}
				ORDER BY embedding <=> $1::vector
				LIMIT $2`,
			[this.vectorLiteral(queryEmbedding), options.limit],
		);
		const results: VectorSearchResult[] = [];
		for (const row of rows.rows) {
			const score = Number(row.score);
			if (!Number.isFinite(score) || score < options.threshold) continue;
			const item = await this.local.getById(row.memory_id);
			if (!item) continue;
			if (options.filter && !options.filter(item)) continue;
			results.push({ item, similarity: score });
		}
		return results.slice(0, options.limit);
	}

	async getById(id: string): Promise<MemoryItem | undefined> {
		await this.ensureInitialized();
		return this.local.getById(id);
	}

	async getByIds(ids: string[]): Promise<MemoryItem[]> {
		await this.ensureInitialized();
		return this.local.getByIds(ids);
	}

	async listRecent(limit: number): Promise<MemoryItem[]> {
		await this.ensureInitialized();
		return this.local.listRecent(limit);
	}

	async listAll(limit?: number): Promise<MemoryItem[]> {
		await this.ensureInitialized();
		return this.local.listAll(limit);
	}

	async update(item: MemoryItem): Promise<void> {
		await this.ensureInitialized();
		await this.ensureRemoteTable(item.embedding.length);
		await this.local.update(item);
		await this.upsertRemote(item);
	}

	async delete(id: string): Promise<void> {
		await this.ensureInitialized();
		await this.local.delete(id);
		await this.requireClient().query(
			`DELETE FROM ${this.tableName} WHERE memory_id = $1`,
			[id],
		);
	}

	async count(): Promise<number> {
		await this.ensureInitialized();
		return this.local.count();
	}

	async close(): Promise<void> {
		await this.client?.end();
		this.client = undefined;
		this.initialized = false;
	}

	private async ensureInitialized(): Promise<void> {
		if (!this.initialized) await this.initialize();
	}

	private async ensureRemoteTable(dimension: number): Promise<void> {
		if (this.dimension === dimension) return;
		if (this.dimension && this.dimension !== dimension) {
			throw new Error(
				`Vector dimension mismatch for pgvector: expected ${this.dimension}, received ${dimension}`,
			);
		}
		const client = this.requireClient();
		await client.query("CREATE EXTENSION IF NOT EXISTS vector");
		await client.query(
			`CREATE TABLE IF NOT EXISTS ${this.tableName} (
				id TEXT PRIMARY KEY,
				memory_id TEXT NOT NULL UNIQUE,
				embedding vector(${dimension}) NOT NULL,
				created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
			)`,
		);
		await client.query(
			`CREATE INDEX IF NOT EXISTS ${this.tableName}_embedding_idx
				ON ${this.tableName}
				USING ivfflat (embedding vector_cosine_ops)
				WITH (lists = 100)`,
		);
		this.dimension = dimension;
	}

	private async upsertRemote(item: MemoryItem): Promise<void> {
		await this.requireClient().query(
			`INSERT INTO ${this.tableName} (id, memory_id, embedding, updated_at)
				VALUES ($1, $2, $3::vector, now())
				ON CONFLICT (id) DO UPDATE SET
					memory_id = EXCLUDED.memory_id,
					embedding = EXCLUDED.embedding,
					updated_at = now()`,
			[this.pointId(item.id), item.id, this.vectorLiteral(item.embedding)],
		);
	}

	private requireClient(): Client {
		if (!this.client) {
			throw new Error("pgvector store is not initialized");
		}
		return this.client;
	}

	private pointId(memoryId: string): string {
		return `memory:${memoryId}`;
	}

	private vectorLiteral(embedding: number[]): string {
		return `[${embedding.map((value) => Number(value) || 0).join(",")}]`;
	}
}

function sanitizeIdentifier(value: string): string {
	const identifier = value.trim().replace(/[^a-zA-Z0-9_]/g, "_");
	if (!identifier || /^\d/.test(identifier)) {
		throw new Error(`Invalid pgvector table name: ${value}`);
	}
	return identifier;
}
