import { createHash, randomUUID } from "node:crypto";
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

export type ExternalVectorBackend = "qdrant" | "weaviate" | "milvus";

export interface ExternalVectorStoreConfig {
	backend: ExternalVectorBackend;
	url: string;
	apiKey?: string;
	collection: string;
	timeoutMs?: number;
	maxRetries?: number;
	retryBaseDelayMs?: number;
	dimension?: number;
	database?: string;
}

type RemoteSearchResult = { memoryId: string; score: number };
type RemoteCircuitState = "closed" | "open";
type VectorOutboxRow = {
	memory_id: string;
	operation: "upsert" | "delete";
	attempt_count: number;
	revision: number;
	lease_token: string;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 100;
const REMOTE_CIRCUIT_OPEN_MS = 30000;

export interface ExternalVectorStoreStatus {
	backend: ExternalVectorBackend;
	state: RemoteCircuitState;
	consecutiveFailures: number;
	lastFailureAt?: Date;
	lastError?: string;
}

export class ExternalVectorStore extends VectorStore {
	private local: SqliteVectorStore;
	private initialized = false;
	private readonly ensuredGenerations = new Map<string, number>();
	private consecutiveRemoteFailures = 0;
	private remoteCircuitOpenUntil = 0;
	private lastRemoteFailureAt?: Date;
	private lastRemoteError?: string;
	private readonly targetId: string;
	private reconciliationTimer?: ReturnType<typeof setInterval>;
	private reconciliation?: Promise<number>;
	private closing = false;

	constructor(
		db: DatabaseAdapter,
		private config: ExternalVectorStoreConfig,
	) {
		super(db);
		this.local = new SqliteVectorStore(db);
		this.targetId = createHash("sha256")
			.update(`${config.backend}|${config.url.replace(/\/$/, "")}|${config.database ?? ""}|${config.collection}`)
			.digest("hex");
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		this.closing = false;
		await this.local.initialize();
		if (this.config.dimension) {
			await this.ensureRemoteCollection(
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
		if (this.isRemoteCircuitOpen()) {
			return this.local.search(queryEmbedding, options);
		}

		let remote: RemoteSearchResult[];
		try {
			const generation = resolveVectorGeneration(
				options.constraints?.embedding,
				queryEmbedding.length,
			);
			await this.ensureRemoteCollection(generation);
			remote = await this.searchRemote(queryEmbedding, options, generation);
			this.recordRemoteSuccess();
		} catch (err) {
			this.recordRemoteFailure(err);
			return this.local.search(queryEmbedding, options);
		}
		const results: VectorSearchResult[] = [];
		for (const hit of remote) {
			const item = await this.local.getById(hit.memoryId);
			if (!item) continue;
			if (options.filter && !options.filter(item)) continue;
			if (hit.score >= options.threshold) {
				results.push({ item, similarity: hit.score });
			}
		}
		if (results.length === 0 && options.constraints) {
			return this.local.search(queryEmbedding, options);
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
					this.collectionName(generation),
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

	getStatus(): ExternalVectorStoreStatus {
		return {
			backend: this.config.backend,
			state: this.isRemoteCircuitOpen() ? "open" : "closed",
			consecutiveFailures: this.consecutiveRemoteFailures,
			lastFailureAt: this.lastRemoteFailureAt,
			lastError: this.lastRemoteError,
		};
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

	async reconcilePendingWrites(memoryId?: string): Promise<number> {
		if (this.closing) return 0;
		const previous = this.reconciliation ?? Promise.resolve(0);
		const run = previous.catch(() => 0).then(() => this.performReconciliation(memoryId));
		this.reconciliation = run;
		return run.finally(() => {
			if (this.reconciliation === run) this.reconciliation = undefined;
		});
	}

	async close(): Promise<void> {
		this.closing = true;
		if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
		this.reconciliationTimer = undefined;
		await this.reconciliation?.catch(() => 0);
		this.initialized = false;
	}

	private async performReconciliation(memoryId?: string): Promise<number> {
		const now = new Date().toISOString();
		const candidates = await this.db.all<{ memory_id: string }>(
			`SELECT memory_id FROM memory_vector_outbox WHERE target_id = ? AND available_at <= ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)${memoryId ? " AND memory_id = ?" : ""} ORDER BY created_at ASC LIMIT 100`,
			memoryId ? [this.targetId, now, now, memoryId] : [this.targetId, now, now],
		);
		let completed = 0;
		for (const candidate of candidates) {
			const leaseToken = randomUUID();
			const leaseExpiresAt = new Date(Date.now() + 300_000).toISOString();
			await this.db.run(
				"UPDATE memory_vector_outbox SET lease_token = ?, lease_expires_at = ? WHERE target_id = ? AND memory_id = ? AND available_at <= ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)",
				[leaseToken, leaseExpiresAt, this.targetId, candidate.memory_id, now, now],
			);
			const row = await this.db.get<VectorOutboxRow>(
				"SELECT memory_id, operation, attempt_count, revision, lease_token FROM memory_vector_outbox WHERE target_id = ? AND memory_id = ? AND lease_token = ?",
				[this.targetId, candidate.memory_id, leaseToken],
			);
			if (!row) continue;
			try {
				const item = row.operation === "upsert" ? await this.local.getById(row.memory_id) : undefined;
				const operation = item ? () => this.upsertRemote(item) : () => this.deleteRemote(row.memory_id);
				if (!(await this.writeRemote(operation))) {
					await this.deferRemoteWrite(row, this.lastRemoteError ?? "Transient remote failure");
					continue;
				}
				await this.db.run(
					"DELETE FROM memory_vector_outbox WHERE target_id = ? AND memory_id = ? AND revision = ? AND lease_token = ?",
					[this.targetId, row.memory_id, row.revision, leaseToken],
				);
				completed++;
			} catch (error) {
				await this.deferRemoteWrite(row, error instanceof Error ? error.message : String(error));
			} finally {
				await this.db.run(
					"UPDATE memory_vector_outbox SET lease_token = NULL, lease_expires_at = NULL WHERE target_id = ? AND memory_id = ? AND lease_token = ?",
					[this.targetId, row.memory_id, leaseToken],
				);
			}
		}
		return completed;
	}

	private async enqueueRemoteWrite(memoryId: string, operation: "upsert" | "delete"): Promise<void> {
		const now = new Date().toISOString();
		await this.db.run(
			"INSERT INTO memory_vector_outbox (target_id, memory_id, operation, attempt_count, available_at, last_error, created_at, updated_at, revision) VALUES (?, ?, ?, 0, ?, NULL, ?, ?, 1) ON CONFLICT(target_id, memory_id) DO UPDATE SET operation = excluded.operation, attempt_count = 0, available_at = excluded.available_at, last_error = NULL, updated_at = excluded.updated_at, revision = memory_vector_outbox.revision + 1",
			[this.targetId, memoryId, operation, now, now, now],
		);
	}

	private async deferRemoteWrite(row: VectorOutboxRow, error: string): Promise<void> {
		const attempts = row.attempt_count + 1;
		const delayMs = Math.min(300_000, 1_000 * 2 ** Math.min(attempts - 1, 8));
		await this.db.run(
			"UPDATE memory_vector_outbox SET attempt_count = ?, available_at = ?, last_error = ?, updated_at = ?, lease_token = NULL, lease_expires_at = NULL WHERE target_id = ? AND memory_id = ? AND revision = ? AND lease_token = ?",
			[attempts, new Date(Date.now() + delayMs).toISOString(), error.slice(0, 2000), new Date().toISOString(), this.targetId, row.memory_id, row.revision, row.lease_token],
		);
	}

	private async ensureInitialized(): Promise<void> {
		if (!this.initialized) await this.initialize();
	}

	private async ensureRemoteCollection(generation: VectorGeneration): Promise<void> {
		const collection = this.collectionName(generation);
		if (this.ensuredGenerations.get(collection) === generation.dimensions) return;
		switch (this.config.backend) {
			case "qdrant":
				await this.request(`/collections/${collection}`, {
					method: "PUT",
					body: { vectors: { size: generation.dimensions, distance: "Cosine" } },
				});
				break;
			case "weaviate":
				await this.ensureWeaviateClass(collection, generation.dimensions);
				break;
			case "milvus":
				await this.ensureMilvusCollection(collection, generation.dimensions);
				break;
		}
		this.ensuredGenerations.set(collection, generation.dimensions);
	}

	private async upsertRemote(item: MemoryItem): Promise<void> {
		const generation = resolveVectorGeneration(
			embeddingDescriptorFromMetadata(item.metadata),
			item.embedding.length,
		);
		await this.ensureRemoteCollection(generation);
		const collection = this.collectionName(generation);
		switch (this.config.backend) {
			case "qdrant":
				await this.request(`/collections/${collection}/points`, {
					method: "PUT",
					body: {
						points: [
							{
								id: this.pointId(item.id),
								vector: item.embedding,
								payload: this.remoteMetadata(item, generation),
							},
						],
					},
				});
				break;
			case "weaviate":
				await this.request(
					`/objects/${encodeURIComponent(collection)}/${this.pointId(item.id)}`,
					{
						method: "PUT",
						body: {
							class: collection,
							id: this.pointId(item.id),
							properties: this.remoteMetadata(item, generation),
							vector: item.embedding,
						},
					},
				);
				break;
			case "milvus":
				await this.request("/vectordb/entities/upsert", {
					method: "POST",
					body: {
						collectionName: collection,
						data: [{ id: item.id, vector: item.embedding, ...this.remoteMetadata(item, generation) }],
					},
				});
				break;
		}
	}

	private async searchRemote(
		queryEmbedding: number[],
		options: VectorSearchOptions,
		generation: VectorGeneration,
	): Promise<RemoteSearchResult[]> {
		const collection = this.collectionName(generation);
		switch (this.config.backend) {
			case "qdrant": {
				const response = await this.request<{
					result?: Array<{ score?: number; payload?: { memoryId?: string } }>;
				}>(`/collections/${collection}/points/search`, {
					method: "POST",
					body: {
						vector: queryEmbedding,
						limit: options.limit,
						score_threshold: options.threshold,
						with_payload: true,
						filter: this.qdrantFilter(options),
					},
				});
				return (response?.result ?? []).flatMap((hit) =>
					hit.payload?.memoryId
						? [
								{
									memoryId: hit.payload.memoryId,
									score: Number(hit.score ?? 0),
								},
							]
						: [],
				);
			}
			case "weaviate": {
				const vector = JSON.stringify(queryEmbedding);
				const response = await this.request<{
					data?: { Get?: Record<string, Array<Record<string, unknown>>> };
				}>("/graphql", {
					method: "POST",
					body: {
						query: `{ Get { ${collection}(nearVector: { vector: ${vector} certainty: ${options.threshold} }${this.weaviateWhere(options)} limit: ${options.limit}) { memoryId _additional { certainty } } } }`,
					},
				});
				const rows = response?.data?.Get?.[collection] ?? [];
				return rows.flatMap((row) => {
					const memoryId = row.memoryId;
					const additional = row._additional as
						| { certainty?: number }
						| undefined;
					return typeof memoryId === "string"
						? [{ memoryId, score: Number(additional?.certainty ?? 0) }]
						: [];
				});
			}
			case "milvus": {
				const response = await this.request<{
					data?: Array<{
						memoryId?: string;
						distance?: number;
						score?: number;
					}>;
				}>("/vectordb/entities/search", {
					method: "POST",
					body: {
						collectionName: collection,
						data: [queryEmbedding],
						limit: options.limit,
						outputFields: ["memoryId"],
						filter: this.milvusFilter(options),
					},
				});
				return (response?.data ?? []).flatMap((hit) =>
					hit.memoryId
						? [
								{
									memoryId: hit.memoryId,
									score: Number(hit.score ?? hit.distance ?? 0),
								},
							]
						: [],
				);
			}
		}
	}

	private remoteMetadata(
		item: MemoryItem,
		generation: VectorGeneration,
	): Record<string, unknown> {
		return {
			memoryId: item.id,
			scopeTenant: this.metadataString(item.metadata.tenantId),
			scopeUser: this.metadataString(item.metadata.userId),
			scopeProject: this.metadataString(item.metadata.projectId),
			scopeAgent: this.metadataString(item.metadata.agentRole),
			scopeSession: this.metadataString(item.metadata.sessionId),
			scopeTask: this.metadataString(item.metadata.taskId),
			embeddingVersion: this.metadataString(item.metadata.embeddingVersion),
			embeddingQuality: this.metadataString(item.metadata.embeddingQuality),
			embeddingDimensions: Number(item.metadata.embeddingDimensions ?? 0),
			embeddingGeneration: generation.key,
		};
	}

	private collectionName(generation: VectorGeneration): string {
		if (generation.legacy) return this.config.collection;
		const raw = `${this.config.collection}__${generation.key}`;
		if (this.config.backend !== "weaviate") return raw;
		const sanitized = raw.replace(/[^A-Za-z0-9_]/g, "_");
		return `${sanitized.charAt(0).toUpperCase()}${sanitized.slice(1)}`;
	}

	private qdrantFilter(options: VectorSearchOptions): Record<string, unknown> | undefined {
		const scope = options.constraints?.scope;
		const embedding = options.constraints?.embedding;
		if (!scope && !embedding) return undefined;
		const must: Record<string, unknown>[] = [];
		const exact = (key: string, value: unknown) => {
			if (typeof value === "string") must.push({ key, match: { value } });
		};
		exact("scopeTenant", scope?.tenantId);
		exact("scopeUser", scope?.userId);
		exact("scopeProject", scope?.projectId);
		exact("embeddingVersion", embedding?.version);
		if (embedding) must.push({ key: "embeddingDimensions", match: { value: embedding.dimensions } });
		for (const [key, value] of [
			["scopeAgent", scope?.agentRole],
			["scopeSession", scope?.sessionId],
			["scopeTask", scope?.taskId],
		] as const) {
			must.push({ key, match: { any: ["", value ?? ""] } });
		}
		return { must };
	}

	private weaviateWhere(options: VectorSearchOptions): string {
		const operands: string[] = [];
		const add = (path: string, value: unknown) => {
			if (typeof value === "string") {
				operands.push(`{ path: [${JSON.stringify(path)}] operator: Equal valueText: ${JSON.stringify(value)} }`);
			}
		};
		add("scopeTenant", options.constraints?.scope?.tenantId);
		add("scopeUser", options.constraints?.scope?.userId);
		add("scopeProject", options.constraints?.scope?.projectId);
		add("embeddingVersion", options.constraints?.embedding?.version);
		return operands.length > 0
			? ` where: { operator: And operands: [${operands.join(" ")}] }`
			: "";
	}

	private milvusFilter(options: VectorSearchOptions): string | undefined {
		const clauses: string[] = [];
		const add = (key: string, value: unknown) => {
			if (typeof value === "string") {
				clauses.push(`${key} == ${JSON.stringify(value)}`);
			}
		};
		add("scopeTenant", options.constraints?.scope?.tenantId);
		add("scopeUser", options.constraints?.scope?.userId);
		add("scopeProject", options.constraints?.scope?.projectId);
		add("embeddingVersion", options.constraints?.embedding?.version);
		return clauses.length > 0 ? clauses.join(" && ") : undefined;
	}

	private metadataString(value: unknown): string {
		return typeof value === "string" ? value : "";
	}

	private async deleteRemote(id: string): Promise<void> {
		const collections = new Set([
			this.config.collection,
			...this.ensuredGenerations.keys(),
		]);
		for (const collection of collections) {
			await this.deleteRemoteFromCollection(id, collection);
		}
	}

	private async deleteRemoteFromCollection(id: string, collection: string): Promise<void> {
		switch (this.config.backend) {
			case "qdrant":
				await this.request(
					`/collections/${collection}/points/delete`,
					{
						method: "POST",
						body: { points: [this.pointId(id)] },
					},
				);
				break;
			case "weaviate":
				await this.request(
					`/objects/${encodeURIComponent(collection)}/${this.pointId(id)}`,
					{ method: "DELETE" },
				);
				break;
			case "milvus":
				await this.request("/vectordb/entities/delete", {
					method: "POST",
					body: {
						collectionName: collection,
						filter: `id == "${id.replace(/"/g, '\\"')}"`,
					},
				});
				break;
		}
	}

	private async writeRemote(operation: () => Promise<void>): Promise<boolean> {
		try {
			await operation();
			this.recordRemoteSuccess();
			return true;
		} catch (err) {
			this.recordRemoteFailure(err);
			if (!isTransientRemoteError(err)) throw err;
			return false;
		}
	}

	private isRemoteCircuitOpen(): boolean {
		if (this.remoteCircuitOpenUntil <= Date.now()) {
			this.remoteCircuitOpenUntil = 0;
			return false;
		}
		return true;
	}

	private recordRemoteSuccess(): void {
		this.consecutiveRemoteFailures = 0;
		this.remoteCircuitOpenUntil = 0;
	}

	private recordRemoteFailure(err: unknown): void {
		this.consecutiveRemoteFailures += 1;
		this.lastRemoteFailureAt = new Date();
		this.lastRemoteError = err instanceof Error ? err.message : String(err);
		this.remoteCircuitOpenUntil = Date.now() + REMOTE_CIRCUIT_OPEN_MS;
	}

	private async ensureWeaviateClass(
		className: string,
		_dimension: number,
	): Promise<void> {
		const existing = await this.request(`/schema/${className}`, {
			method: "GET",
			allowNotFound: true,
		});
		if (existing) return;
		await this.request("/schema", {
			method: "POST",
			body: {
				class: className,
				vectorizer: "none",
				vectorIndexConfig: {
					distance: "cosine",
					vectorCacheMaxObjects: 100000,
				},
				moduleConfig: {},
				properties: [
					"memoryId",
					"scopeTenant",
					"scopeUser",
					"scopeProject",
					"scopeAgent",
					"scopeSession",
					"scopeTask",
					"embeddingVersion",
					"embeddingQuality",
					"embeddingGeneration",
				].map((name) => ({ name, dataType: ["text"] })),
			},
		});
	}

	private async ensureMilvusCollection(
		collection: string,
		dimension: number,
	): Promise<void> {
		const existing = await this.request("/vectordb/collections/describe", {
			method: "POST",
			body: { collectionName: collection },
			allowNotFound: true,
		});
		if (!existing) {
			await this.request("/vectordb/collections/create", {
				method: "POST",
				body: {
					collectionName: collection,
					schema: {
						autoId: false,
						enabledDynamicField: true,
						fields: [
							{
								fieldName: "id",
								dataType: "VarChar",
								isPrimary: true,
								elementTypeParams: { max_length: "512" },
							},
							{
								fieldName: "vector",
								dataType: "FloatVector",
								elementTypeParams: { dim: String(dimension) },
							},
							{
								fieldName: "memoryId",
								dataType: "VarChar",
								elementTypeParams: { max_length: "512" },
							},
						],
					},
					indexParams: [
						{
							fieldName: "vector",
							metricType: "COSINE",
							indexType: "AUTOINDEX",
						},
					],
				},
			});
		}
	}

	private async request<T = unknown>(
		path: string,
		options: {
			method: "GET" | "POST" | "PUT" | "DELETE";
			body?: unknown;
			allowNotFound?: boolean;
		},
	): Promise<T | undefined> {
		const url = `${this.config.url.replace(/\/$/, "")}${path}`;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (this.config.apiKey)
			headers.Authorization = `Bearer ${this.config.apiKey}`;
		if (this.config.database && this.config.backend === "milvus") {
			headers["Db-Name"] = this.config.database;
		}
		const body = options.body ? JSON.stringify(options.body) : undefined;
		const maxRetries = this.maxRetries();
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			let response: Response;
			try {
				response = await this.fetchWithTimeout(url, {
					method: options.method,
					headers,
					body,
				});
			} catch (err) {
				if (attempt < maxRetries) {
					await this.waitBeforeRetry(attempt);
					continue;
				}
				throw new RemoteVectorRequestError(
					`${this.config.backend} vector request failed: ${err instanceof Error ? err.message : String(err)}`,
					true,
				);
			}

			if (options.allowNotFound && response.status === 404) return undefined;
			if (response.ok) {
				if (response.status === 204) return undefined;
				return this.parseSuccessfulResponse<T>(
					await response.json().catch(() => undefined),
					options,
				);
			}

			if (this.shouldRetryStatus(response.status) && attempt < maxRetries) {
				await this.waitBeforeRetry(attempt);
				continue;
			}

			const responseBody = await response.text().catch(() => "");
			throw new RemoteVectorRequestError(
				`${this.config.backend} vector request failed (${response.status}): ${responseBody.slice(0, 300)}`,
				this.shouldRetryStatus(response.status),
			);
		}
		return undefined;
	}

	private parseSuccessfulResponse<T>(
		payload: unknown,
		options: { allowNotFound?: boolean },
	): T | undefined {
		if (this.config.backend !== "milvus") return payload as T | undefined;
		if (!payload || typeof payload !== "object")
			return payload as T | undefined;
		const code = (payload as { code?: unknown }).code;
		if (typeof code !== "number" || code === 0) return payload as T | undefined;
		if (options.allowNotFound) return undefined;
		const message =
			typeof (payload as { message?: unknown }).message === "string"
				? (payload as { message: string }).message
				: typeof (payload as { reason?: unknown }).reason === "string"
					? (payload as { reason: string }).reason
					: JSON.stringify(payload);
		throw new RemoteVectorRequestError(
			`milvus vector request failed (${code}): ${message}`,
			false,
		);
	}

	private async fetchWithTimeout(
		url: string,
		init: RequestInit,
	): Promise<Response> {
		const timeoutMs = this.timeoutMs();
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await fetch(url, { ...init, signal: controller.signal });
		} catch (err) {
			if (controller.signal.aborted) {
				throw new Error(
					`${this.config.backend} vector request timed out after ${timeoutMs}ms`,
				);
			}
			throw err;
		} finally {
			clearTimeout(timeout);
		}
	}

	private timeoutMs(): number {
		return positiveNumber(this.config.timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
	}

	private maxRetries(): number {
		return Math.floor(
			nonNegativeNumber(this.config.maxRetries, DEFAULT_MAX_RETRIES),
		);
	}

	private retryBaseDelayMs(): number {
		return nonNegativeNumber(
			this.config.retryBaseDelayMs,
			DEFAULT_RETRY_BASE_DELAY_MS,
		);
	}

	private shouldRetryStatus(status: number): boolean {
		return status === 408 || status === 429 || status >= 500;
	}

	private async waitBeforeRetry(attempt: number): Promise<void> {
		const delayMs = this.retryBaseDelayMs() * 2 ** attempt;
		if (delayMs <= 0) return;
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}

	private pointId(memoryId: string): string {
		const hex = createHash("sha256").update(memoryId).digest("hex");
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
	}
}

function positiveNumber(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: fallback;
}

function nonNegativeNumber(
	value: number | undefined,
	fallback: number,
): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: fallback;
}

class RemoteVectorRequestError extends Error {
	constructor(
		message: string,
		readonly transient: boolean,
	) {
		super(message);
		this.name = "RemoteVectorRequestError";
	}
}

function isTransientRemoteError(err: unknown): boolean {
	return err instanceof RemoteVectorRequestError && err.transient;
}
