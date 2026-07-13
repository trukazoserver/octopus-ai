import { createHash } from "node:crypto";
import type { DatabaseAdapter } from "../storage/database.js";
import { SqliteVectorStore } from "./sqlite-vss.js";
import { VectorStore } from "./store.js";
import type { MemoryItem, VectorSearchResult } from "./types.js";

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
	private dimension?: number;
	private consecutiveRemoteFailures = 0;
	private remoteCircuitOpenUntil = 0;
	private lastRemoteFailureAt?: Date;
	private lastRemoteError?: string;
	private readonly targetId: string;
	private reconciliationTimer?: ReturnType<typeof setInterval>;
	private reconciliation?: Promise<number>;

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
		await this.local.initialize();
		if (this.dimension) await this.ensureRemoteCollection(this.dimension);
		this.initialized = true;
		await this.reconcilePendingWrites();
		this.reconciliationTimer = setInterval(() => {
			void this.reconcilePendingWrites().catch(() => {});
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
		if (this.isRemoteCircuitOpen()) {
			return this.local.search(queryEmbedding, options);
		}

		let remote: RemoteSearchResult[];
		try {
			await this.ensureRemoteCollection(queryEmbedding.length);
			remote = await this.searchRemote(queryEmbedding, options);
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
			await this.local.delete(id);
			await this.enqueueRemoteWrite(id, "delete");
		});
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

	async reconcilePendingWrites(memoryId?: string): Promise<number> {
		if (this.reconciliation) return this.reconciliation;
		this.reconciliation = this.performReconciliation(memoryId);
		try {
			return await this.reconciliation;
		} finally {
			this.reconciliation = undefined;
		}
	}

	async close(): Promise<void> {
		if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
		this.reconciliationTimer = undefined;
	}

	private async performReconciliation(memoryId?: string): Promise<number> {
		const now = new Date().toISOString();
		const rows = await this.db.all<VectorOutboxRow>(
			`SELECT memory_id, operation, attempt_count FROM memory_vector_outbox WHERE target_id = ? AND available_at <= ?${memoryId ? " AND memory_id = ?" : ""} ORDER BY created_at ASC LIMIT 100`,
			memoryId ? [this.targetId, now, memoryId] : [this.targetId, now],
		);
		let completed = 0;
		for (const row of rows) {
			try {
				const item = row.operation === "upsert" ? await this.local.getById(row.memory_id) : undefined;
				const operation = item ? () => this.upsertRemote(item) : () => this.deleteRemote(row.memory_id);
				if (!(await this.writeRemote(operation))) {
					await this.deferRemoteWrite(row, this.lastRemoteError ?? "Transient remote failure");
					continue;
				}
				await this.db.run(
					"DELETE FROM memory_vector_outbox WHERE target_id = ? AND memory_id = ? AND operation = ?",
					[this.targetId, row.memory_id, row.operation],
				);
				completed++;
			} catch (error) {
				await this.deferRemoteWrite(row, error instanceof Error ? error.message : String(error));
				throw error;
			}
		}
		return completed;
	}

	private async enqueueRemoteWrite(memoryId: string, operation: "upsert" | "delete"): Promise<void> {
		const now = new Date().toISOString();
		await this.db.run(
			"INSERT INTO memory_vector_outbox (target_id, memory_id, operation, attempt_count, available_at, last_error, created_at, updated_at) VALUES (?, ?, ?, 0, ?, NULL, ?, ?) ON CONFLICT(target_id, memory_id) DO UPDATE SET operation = excluded.operation, attempt_count = 0, available_at = excluded.available_at, last_error = NULL, updated_at = excluded.updated_at",
			[this.targetId, memoryId, operation, now, now, now],
		);
	}

	private async deferRemoteWrite(row: VectorOutboxRow, error: string): Promise<void> {
		const attempts = row.attempt_count + 1;
		const delayMs = Math.min(300_000, 1_000 * 2 ** Math.min(attempts - 1, 8));
		await this.db.run(
			"UPDATE memory_vector_outbox SET attempt_count = ?, available_at = ?, last_error = ?, updated_at = ? WHERE target_id = ? AND memory_id = ? AND operation = ?",
			[attempts, new Date(Date.now() + delayMs).toISOString(), error.slice(0, 2000), new Date().toISOString(), this.targetId, row.memory_id, row.operation],
		);
	}

	private async ensureInitialized(): Promise<void> {
		if (!this.initialized) await this.initialize();
	}

	private async ensureRemoteCollection(dimension: number): Promise<void> {
		if (this.dimension === dimension) return;
		if (this.dimension && this.dimension !== dimension) {
			throw new Error(
				`Vector dimension mismatch for ${this.config.backend}: expected ${this.dimension}, received ${dimension}`,
			);
		}
		switch (this.config.backend) {
			case "qdrant":
				await this.request(`/collections/${this.config.collection}`, {
					method: "PUT",
					body: { vectors: { size: dimension, distance: "Cosine" } },
				});
				break;
			case "weaviate":
				await this.ensureWeaviateClass(dimension);
				break;
			case "milvus":
				await this.ensureMilvusCollection(dimension);
				break;
		}
		this.dimension = dimension;
	}

	private async upsertRemote(item: MemoryItem): Promise<void> {
		await this.ensureRemoteCollection(item.embedding.length);
		switch (this.config.backend) {
			case "qdrant":
				await this.request(`/collections/${this.config.collection}/points`, {
					method: "PUT",
					body: {
						points: [
							{
								id: this.pointId(item.id),
								vector: item.embedding,
								payload: { memoryId: item.id },
							},
						],
					},
				});
				break;
			case "weaviate":
				await this.request(
					`/objects/${encodeURIComponent(this.config.collection)}/${this.pointId(item.id)}`,
					{
						method: "PUT",
						body: {
							class: this.config.collection,
							id: this.pointId(item.id),
							properties: { memoryId: item.id },
							vector: item.embedding,
						},
					},
				);
				break;
			case "milvus":
				await this.request("/vectordb/entities/upsert", {
					method: "POST",
					body: {
						collectionName: this.config.collection,
						data: [{ id: item.id, vector: item.embedding, memoryId: item.id }],
					},
				});
				break;
		}
	}

	private async searchRemote(
		queryEmbedding: number[],
		options: { limit: number; threshold: number },
	): Promise<RemoteSearchResult[]> {
		switch (this.config.backend) {
			case "qdrant": {
				const response = await this.request<{
					result?: Array<{ score?: number; payload?: { memoryId?: string } }>;
				}>(`/collections/${this.config.collection}/points/search`, {
					method: "POST",
					body: {
						vector: queryEmbedding,
						limit: options.limit,
						score_threshold: options.threshold,
						with_payload: true,
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
						query: `{ Get { ${this.config.collection}(nearVector: { vector: ${vector} certainty: ${options.threshold} } limit: ${options.limit}) { memoryId _additional { certainty } } } }`,
					},
				});
				const rows = response?.data?.Get?.[this.config.collection] ?? [];
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
						collectionName: this.config.collection,
						data: [queryEmbedding],
						limit: options.limit,
						outputFields: ["memoryId"],
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

	private async deleteRemote(id: string): Promise<void> {
		switch (this.config.backend) {
			case "qdrant":
				await this.request(
					`/collections/${this.config.collection}/points/delete`,
					{
						method: "POST",
						body: { points: [this.pointId(id)] },
					},
				);
				break;
			case "weaviate":
				await this.request(
					`/objects/${encodeURIComponent(this.config.collection)}/${this.pointId(id)}`,
					{ method: "DELETE" },
				);
				break;
			case "milvus":
				await this.request("/vectordb/entities/delete", {
					method: "POST",
					body: {
						collectionName: this.config.collection,
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

	private async ensureWeaviateClass(dimension: number): Promise<void> {
		const className = this.config.collection;
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
				properties: [{ name: "memoryId", dataType: ["text"] }],
			},
		});
	}

	private async ensureMilvusCollection(dimension: number): Promise<void> {
		const existing = await this.request("/vectordb/collections/describe", {
			method: "POST",
			body: { collectionName: this.config.collection },
			allowNotFound: true,
		});
		if (!existing) {
			await this.request("/vectordb/collections/create", {
				method: "POST",
				body: {
					collectionName: this.config.collection,
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
