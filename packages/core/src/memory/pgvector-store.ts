import { createHash } from "node:crypto";
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
	private readonly targetId: string;
	private reconciliationTimer?: ReturnType<typeof setInterval>;

	constructor(
		db: DatabaseAdapter,
		private config: PgVectorStoreConfig,
	) {
		super(db);
		this.local = new SqliteVectorStore(db);
		this.tableName = sanitizeIdentifier(
			config.table || "octopus_memory_vectors",
		);
		this.targetId = createHash("sha256")
			.update(`pgvector|${sanitizeConnectionIdentity(config.connectionString)}|${this.tableName}`)
			.digest("hex");
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		await this.local.initialize();
		await this.connectRemote();
		if (this.client && this.config.dimension) await this.ensureRemoteTable(this.config.dimension);
		this.initialized = true;
		await this.reconcilePendingWrites();
		this.reconciliationTimer = setInterval(() => {
			void this.reconcilePendingWrites();
		}, 30_000);
		this.reconciliationTimer.unref?.();
	}

	async store(item: MemoryItem): Promise<void> {
		await this.ensureInitialized();
		await this.db.transaction(async () => {
			await this.local.store(item);
			await this.enqueueRemoteWrite(item.id, "upsert");
		});
		await this.reconcilePendingWrites(item.id);
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
		if (!this.client) return this.local.search(queryEmbedding, options);
		try {
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
		} catch {
			return this.local.search(queryEmbedding, options);
		}
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
		await this.db.transaction(async () => {
			await this.local.update(item);
			await this.enqueueRemoteWrite(item.id, "upsert");
		});
		await this.reconcilePendingWrites(item.id);
	}

	async delete(id: string): Promise<void> {
		await this.ensureInitialized();
		await this.db.transaction(async () => {
			await this.local.delete(id);
			await this.enqueueRemoteWrite(id, "delete");
		});
		await this.reconcilePendingWrites(id);
	}

	async count(): Promise<number> {
		await this.ensureInitialized();
		return this.local.count();
	}

	async close(): Promise<void> {
		if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
		this.reconciliationTimer = undefined;
		await this.client?.end();
		this.client = undefined;
		this.initialized = false;
	}

	async reconcilePendingWrites(memoryId?: string): Promise<number> {
		if (!this.client && !(await this.connectRemote())) return 0;
		const now = new Date().toISOString();
		const rows = await this.db.all<{ memory_id: string; operation: "upsert" | "delete"; attempt_count: number }>(
			`SELECT memory_id, operation, attempt_count FROM memory_vector_outbox WHERE target_id = ? AND available_at <= ?${memoryId ? " AND memory_id = ?" : ""} ORDER BY created_at ASC LIMIT 100`,
			memoryId ? [this.targetId, now, memoryId] : [this.targetId, now],
		);
		let completed = 0;
		for (const row of rows) {
			try {
				const item = row.operation === "upsert" ? await this.local.getById(row.memory_id) : undefined;
				if (item) {
					await this.ensureRemoteTable(item.embedding.length);
					await this.upsertRemote(item);
				} else {
					await this.requireClient().query(`DELETE FROM ${this.tableName} WHERE memory_id = $1`, [row.memory_id]);
				}
				await this.db.run("DELETE FROM memory_vector_outbox WHERE target_id = ? AND memory_id = ? AND operation = ?", [this.targetId, row.memory_id, row.operation]);
				completed++;
			} catch (error) {
				const attempts = row.attempt_count + 1;
				await this.db.run("UPDATE memory_vector_outbox SET attempt_count = ?, available_at = ?, last_error = ?, updated_at = ? WHERE target_id = ? AND memory_id = ? AND operation = ?", [attempts, new Date(Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(attempts - 1, 8))).toISOString(), String(error).slice(0, 2000), now, this.targetId, row.memory_id, row.operation]);
			}
		}
		return completed;
	}

	private async enqueueRemoteWrite(memoryId: string, operation: "upsert" | "delete"): Promise<void> {
		const now = new Date().toISOString();
		await this.db.run("INSERT INTO memory_vector_outbox (target_id, memory_id, operation, attempt_count, available_at, last_error, created_at, updated_at) VALUES (?, ?, ?, 0, ?, NULL, ?, ?) ON CONFLICT(target_id, memory_id) DO UPDATE SET operation = excluded.operation, attempt_count = 0, available_at = excluded.available_at, last_error = NULL, updated_at = excluded.updated_at", [this.targetId, memoryId, operation, now, now, now]);
	}

	private async ensureInitialized(): Promise<void> {
		if (!this.initialized) await this.initialize();
	}

	private async connectRemote(): Promise<boolean> {
		if (this.client) return true;
		const client = new Client({
			connectionString: this.config.connectionString,
			ssl: this.config.ssl,
		});
		try {
			await client.connect();
			this.client = client;
			return true;
		} catch {
			await client.end().catch(() => {});
			return false;
		}
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

function sanitizeConnectionIdentity(connectionString: string): string {
	try {
		const url = new URL(connectionString);
		url.username = "";
		url.password = "";
		return url.toString();
	} catch {
		return connectionString.replace(/\/\/[^@/]+@/, "//");
	}
}
