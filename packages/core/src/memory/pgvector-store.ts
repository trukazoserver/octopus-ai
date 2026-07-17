import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import type { DatabaseAdapter } from "../storage/database.js";
import { SqliteVectorStore } from "./sqlite-vss.js";
import {
	embeddingDescriptorFromMetadata,
	resolveVectorGeneration,
	type VectorGeneration,
	type LegacyVectorPayloadMigrationInput,
	type LegacyVectorPayloadMigrationReport,
	VectorStore,
} from "./store.js";
import type {
	MemoryItem,
	VectorSearchOptions,
	VectorSearchResult,
} from "./types.js";

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
	private readonly ensuredGenerations = new Map<string, number>();
	private tableName: string;
	private readonly targetId: string;
	private reconciliationTimer?: ReturnType<typeof setInterval>;
	private reconciliation?: Promise<number>;
	private closing = false;

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
		this.closing = false;
		await this.local.initialize();
		await this.connectRemote();
		if (this.client && this.config.dimension) {
			await this.ensureRemoteTable(
				resolveVectorGeneration(undefined, this.config.dimension),
			);
		}
		this.initialized = true;
		await this.reconcilePendingWrites().catch(() => 0);
		this.reconciliationTimer = setInterval(() => {
			void this.reconcilePendingWrites().catch(() => {});
		}, 30_000);
		this.reconciliationTimer.unref?.();
	}

	async store(item: MemoryItem): Promise<void> {
		await this.ensureInitialized();
		await this.db.transaction(async () => {
			await this.stageStore(item);
		});
		await this.finalizeStore(item.id);
	}

	async stageStore(item: MemoryItem): Promise<void> {
		await this.ensureInitialized();
		await this.local.store(item);
		await this.enqueueRemoteWrite(item.id, "upsert");
	}

	async finalizeStore(id: string): Promise<void> {
		await this.reconcilePendingWrites(id);
	}

	async search(
		queryEmbedding: number[],
		options: VectorSearchOptions,
	): Promise<VectorSearchResult[]> {
		await this.ensureInitialized();
		if (!this.client) return this.local.search(queryEmbedding, options);
		try {
			const generation = resolveVectorGeneration(
				options.constraints?.embedding,
				queryEmbedding.length,
			);
			await this.ensureRemoteTable(generation);
			const tableName = this.generationTableName(generation);
		const client = this.requireClient();
		const params: unknown[] = [this.vectorLiteral(queryEmbedding)];
		const clauses: string[] = [];
		const addExact = (column: string, value: unknown) => {
			if (typeof value !== "string") return;
			params.push(value);
			clauses.push(`${column} = $${params.length}`);
		};
		addExact("scope_tenant", options.constraints?.scope?.tenantId);
		addExact("scope_user", options.constraints?.scope?.userId);
		addExact("scope_project", options.constraints?.scope?.projectId);
		addExact("embedding_version", options.constraints?.embedding?.version);
		for (const [column, value] of [
			["scope_agent", options.constraints?.scope?.agentRole],
			["scope_session", options.constraints?.scope?.sessionId],
			["scope_task", options.constraints?.scope?.taskId],
		] as const) {
			params.push(value ?? "");
			clauses.push(`(${column} = '' OR ${column} = $${params.length})`);
		}
		params.push(options.limit);
		const rows = await client.query<{
			memory_id: string;
			score: number | string;
		}>(
			`SELECT memory_id, 1 - (embedding <=> $1::vector) AS score
				FROM ${tableName}${clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : ""}
				ORDER BY embedding <=> $1::vector
				LIMIT $${params.length}`,
			params,
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
		if (results.length === 0 && options.constraints) {
			return this.local.search(queryEmbedding, options);
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
			await this.stageDelete(id);
		});
		await this.finalizeDelete(id);
	}

	async stageDelete(id: string): Promise<void> {
		const existing = await this.local.getById(id);
		if (existing) {
			const descriptor = embeddingDescriptorFromMetadata(existing.metadata);
			if (descriptor) {
				const generation = resolveVectorGeneration(descriptor, existing.embedding.length);
				this.ensuredGenerations.set(
					this.generationTableName(generation),
					generation.dimensions,
				);
			}
		}
		await this.local.delete(id);
		await this.enqueueRemoteWrite(id, "delete");
	}

	async finalizeDelete(id: string): Promise<void> {
		await this.reconcilePendingWrites(id);
	}

	async count(): Promise<number> {
		await this.ensureInitialized();
		return this.local.count();
	}

	getDiagnostics(): Record<string, number> {
		return this.local.getDiagnostics();
	}

	async migrateLegacyPayloads(
		input: LegacyVectorPayloadMigrationInput,
	): Promise<LegacyVectorPayloadMigrationReport> {
		await this.ensureInitialized();
		const limit = Math.max(1, Math.min(input.limit ?? 100, 1000));
		const rows = await this.db.all<{ id: string }>(
			`SELECT id FROM memory_items WHERE id > ?${input.upperBoundId ? " AND id <= ?" : ""} ORDER BY id ASC LIMIT ?`,
			input.upperBoundId
				? [input.cursor ?? "", input.upperBoundId, limit + 1]
				: [input.cursor ?? "", limit + 1],
		);
		const report: LegacyVectorPayloadMigrationReport = {
			supported: true,
			mode: input.mode,
			scanned: 0,
			eligible: 0,
			migrated: 0,
			queued: 0,
			missingDescriptor: 0,
			invalidDescriptor: 0,
			failed: 0,
			hasMore: rows.length > limit,
		};
		for (const row of rows.slice(0, limit)) {
			report.scanned++;
			report.nextCursor = row.id;
			const item = await this.local.getById(row.id);
			if (!item) {
				report.failed++;
				continue;
			}
			const descriptor = embeddingDescriptorFromMetadata(item.metadata);
			if (!descriptor) {
				if (item.metadata.embeddingVersion) report.invalidDescriptor++;
				else report.missingDescriptor++;
				continue;
			}
			try {
				resolveVectorGeneration(descriptor, item.embedding.length);
			} catch {
				report.invalidDescriptor++;
				continue;
			}
			report.eligible++;
			if (input.mode === "preview") continue;
			await this.enqueueRemoteWrite(item.id, "upsert");
			await this.reconcilePendingWrites(item.id);
			const pending = await this.db.get(
				"SELECT memory_id FROM memory_vector_outbox WHERE target_id = ? AND memory_id = ?",
				[this.targetId, item.id],
			);
			if (pending) report.queued++;
			else report.migrated++;
		}
		return report;
	}

	async close(): Promise<void> {
		this.closing = true;
		if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
		this.reconciliationTimer = undefined;
		await this.reconciliation?.catch(() => 0);
		await this.client?.end();
		this.client = undefined;
		this.initialized = false;
	}

	async reconcilePendingWrites(memoryId?: string): Promise<number> {
		if (this.closing) return 0;
		const previous = this.reconciliation ?? Promise.resolve(0);
		const run = previous.catch(() => 0).then(() => this.performReconciliation(memoryId));
		this.reconciliation = run;
		return run.finally(() => {
			if (this.reconciliation === run) this.reconciliation = undefined;
		});
	}

	private async performReconciliation(memoryId?: string): Promise<number> {
		if (!this.client && !(await this.connectRemote())) return 0;
		const now = new Date().toISOString();
		const candidates = await this.db.all<{ memory_id: string }>(
			`SELECT memory_id FROM memory_vector_outbox WHERE target_id = ? AND available_at <= ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)${memoryId ? " AND memory_id = ?" : ""} ORDER BY created_at ASC LIMIT 100`,
			memoryId ? [this.targetId, now, now, memoryId] : [this.targetId, now, now],
		);
		let completed = 0;
		for (const candidate of candidates) {
			const leaseToken = randomUUID();
			await this.db.run("UPDATE memory_vector_outbox SET lease_token = ?, lease_expires_at = ? WHERE target_id = ? AND memory_id = ? AND available_at <= ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)", [leaseToken, new Date(Date.now() + 300_000).toISOString(), this.targetId, candidate.memory_id, now, now]);
			const row = await this.db.get<{ memory_id: string; operation: "upsert" | "delete"; attempt_count: number; revision: number; lease_token: string }>("SELECT memory_id, operation, attempt_count, revision, lease_token FROM memory_vector_outbox WHERE target_id = ? AND memory_id = ? AND lease_token = ?", [this.targetId, candidate.memory_id, leaseToken]);
			if (!row) continue;
			try {
				const item = row.operation === "upsert" ? await this.local.getById(row.memory_id) : undefined;
				if (item) {
					await this.upsertRemote(item);
				} else {
					for (const tableName of new Set([this.tableName, ...this.ensuredGenerations.keys()])) {
						await this.requireClient().query(`DELETE FROM ${tableName} WHERE memory_id = $1`, [row.memory_id]);
					}
				}
				await this.db.run("DELETE FROM memory_vector_outbox WHERE target_id = ? AND memory_id = ? AND revision = ? AND lease_token = ?", [this.targetId, row.memory_id, row.revision, leaseToken]);
				completed++;
			} catch (error) {
				const attempts = row.attempt_count + 1;
				await this.db.run("UPDATE memory_vector_outbox SET attempt_count = ?, available_at = ?, last_error = ?, updated_at = ?, lease_token = NULL, lease_expires_at = NULL WHERE target_id = ? AND memory_id = ? AND revision = ? AND lease_token = ?", [attempts, new Date(Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(attempts - 1, 8))).toISOString(), String(error).slice(0, 2000), now, this.targetId, row.memory_id, row.revision, leaseToken]);
			} finally {
				await this.db.run("UPDATE memory_vector_outbox SET lease_token = NULL, lease_expires_at = NULL WHERE target_id = ? AND memory_id = ? AND lease_token = ?", [this.targetId, row.memory_id, leaseToken]);
			}
		}
		return completed;
	}

	private async enqueueRemoteWrite(memoryId: string, operation: "upsert" | "delete"): Promise<void> {
		const now = new Date().toISOString();
		await this.db.run("INSERT INTO memory_vector_outbox (target_id, memory_id, operation, attempt_count, available_at, last_error, created_at, updated_at, revision) VALUES (?, ?, ?, 0, ?, NULL, ?, ?, 1) ON CONFLICT(target_id, memory_id) DO UPDATE SET operation = excluded.operation, attempt_count = 0, available_at = excluded.available_at, last_error = NULL, updated_at = excluded.updated_at, revision = memory_vector_outbox.revision + 1", [this.targetId, memoryId, operation, now, now, now]);
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

	private async ensureRemoteTable(generation: VectorGeneration): Promise<void> {
		const tableName = this.generationTableName(generation);
		if (this.ensuredGenerations.get(tableName) === generation.dimensions) return;
		const client = this.requireClient();
		await client.query("CREATE EXTENSION IF NOT EXISTS vector");
		await client.query(
			`CREATE TABLE IF NOT EXISTS ${tableName} (
				id TEXT PRIMARY KEY,
				memory_id TEXT NOT NULL UNIQUE,
				embedding vector(${generation.dimensions}) NOT NULL,
				created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
			)`,
		);
		for (const column of [
			"scope_tenant",
			"scope_user",
			"scope_project",
			"scope_agent",
			"scope_session",
			"scope_task",
			"embedding_version",
			"embedding_quality",
		] as const) {
			await client.query(
				`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${column} TEXT NOT NULL DEFAULT ''`,
			);
		}
		await client.query(
			`CREATE INDEX IF NOT EXISTS ${tableName}_scope_idx ON ${tableName} (scope_tenant, scope_user, scope_project, embedding_version)`,
		);
		await client.query(
			`CREATE INDEX IF NOT EXISTS ${tableName}_embedding_idx
				ON ${tableName}
				USING ivfflat (embedding vector_cosine_ops)
				WITH (lists = 100)`,
		);
		this.ensuredGenerations.set(tableName, generation.dimensions);
	}

	private async upsertRemote(item: MemoryItem): Promise<void> {
		const generation = resolveVectorGeneration(
			embeddingDescriptorFromMetadata(item.metadata),
			item.embedding.length,
		);
		await this.ensureRemoteTable(generation);
		const tableName = this.generationTableName(generation);
		await this.requireClient().query(
			`INSERT INTO ${tableName} (id, memory_id, embedding, scope_tenant, scope_user, scope_project, scope_agent, scope_session, scope_task, embedding_version, embedding_quality, updated_at)
				VALUES ($1, $2, $3::vector, $4, $5, $6, $7, $8, $9, $10, $11, now())
				ON CONFLICT (id) DO UPDATE SET
					memory_id = EXCLUDED.memory_id,
					embedding = EXCLUDED.embedding,
					scope_tenant = EXCLUDED.scope_tenant,
					scope_user = EXCLUDED.scope_user,
					scope_project = EXCLUDED.scope_project,
					scope_agent = EXCLUDED.scope_agent,
					scope_session = EXCLUDED.scope_session,
					scope_task = EXCLUDED.scope_task,
					embedding_version = EXCLUDED.embedding_version,
					embedding_quality = EXCLUDED.embedding_quality,
					updated_at = now()`,
			[
				this.pointId(item.id), item.id, this.vectorLiteral(item.embedding),
				this.metadataString(item.metadata.tenantId),
				this.metadataString(item.metadata.userId),
				this.metadataString(item.metadata.projectId),
				this.metadataString(item.metadata.agentRole),
				this.metadataString(item.metadata.sessionId),
				this.metadataString(item.metadata.taskId),
				this.metadataString(item.metadata.embeddingVersion),
				this.metadataString(item.metadata.embeddingQuality),
			],
		);
	}

	private metadataString(value: unknown): string {
		return typeof value === "string" ? value : "";
	}

	private generationTableName(generation: VectorGeneration): string {
		if (generation.legacy) return this.tableName;
		const suffix = `__${generation.key}`;
		return `${this.tableName.slice(0, Math.max(1, 45 - suffix.length))}${suffix}`;
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
