import { afterEach, describe, expect, it, vi } from "vitest";
import { ExternalVectorStore } from "../memory/external-vector-store.js";
import { createVectorStore } from "../memory/factory.js";
import { PgVectorStore } from "../memory/pgvector-store.js";
import type { MemoryItem } from "../memory/types.js";
import {
	type DatabaseAdapter,
	createDatabaseAdapter,
} from "../storage/database.js";

const pgMock = vi.hoisted(() => ({
	instances: [] as Array<{
		config: unknown;
		connect: ReturnType<typeof vi.fn>;
		query: ReturnType<typeof vi.fn>;
		end: ReturnType<typeof vi.fn>;
	}>,
}));

vi.mock("pg", () => ({
	Client: class {
		config: unknown;
		connect = vi.fn(async () => undefined);
		query = vi.fn(async (sql: string) => {
			if (sql.includes("SELECT memory_id")) {
				return { rows: [{ memory_id: "memory-1", score: 0.94 }] };
			}
			return { rows: [] };
		});
		end = vi.fn(async () => undefined);

		constructor(config: unknown) {
			this.config = config;
			pgMock.instances.push(this);
		}
	},
}));

function createMemory(partial: Partial<MemoryItem> = {}): MemoryItem {
	return {
		id: partial.id ?? "memory-1",
		type: partial.type ?? "semantic",
		content: partial.content ?? "External vector memory",
		embedding: partial.embedding ?? [1, 0, 0],
		importance: partial.importance ?? 0.8,
		accessCount: partial.accessCount ?? 0,
		lastAccessed: partial.lastAccessed ?? new Date(0),
		createdAt: partial.createdAt ?? new Date(0),
		associations: partial.associations ?? [],
		source: partial.source ?? {},
		metadata: partial.metadata ?? {},
	};
}

describe("external vector stores", () => {
	let db: DatabaseAdapter | undefined;

	afterEach(async () => {
		await db?.close();
		db = undefined;
		vi.unstubAllGlobals();
		pgMock.instances.length = 0;
	});

	it("requires a URL for HTTP vector backends", () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });

		expect(() => createVectorStore("qdrant", db as DatabaseAdapter)).toThrow(
			/requires memory\.longTerm\.vectorStore\.url/,
		);
	});

	it("requires a connection string for pgvector", () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });

		expect(() => createVectorStore("pgvector", db as DatabaseAdapter)).toThrow(
			/requires memory\.longTerm\.vectorStore\.url/,
		);
	});

	it("stores locally while using Qdrant for vector upsert and search", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const item = createMemory();
		const fetchMock = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = input.toString();
				if (url.endsWith("/points/search")) {
					return new Response(
						JSON.stringify({
							result: [{ score: 0.92, payload: { memoryId: item.id } }],
						}),
						{ status: 200 },
					);
				}

				expect(init?.headers).toMatchObject({ Authorization: "Bearer token" });
				return new Response(JSON.stringify({ result: true }), { status: 200 });
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		const store = createVectorStore("qdrant", db, {
			url: "http://qdrant.local",
			apiKey: "token",
			collection: "memories",
			dimension: 3,
		});

		expect(store).toBeInstanceOf(ExternalVectorStore);
		await store.initialize();
		await store.store(item);
		const results = await store.search([1, 0, 0], { limit: 5, threshold: 0.5 });

		expect(results).toHaveLength(1);
		expect(results[0]?.item.id).toBe(item.id);
		expect(results[0]?.similarity).toBe(0.92);
		expect(await store.getById(item.id)).toMatchObject({ id: item.id });
		expect(fetchMock).toHaveBeenCalledWith(
			"http://qdrant.local/collections/memories",
			expect.objectContaining({ method: "PUT" }),
		);
		expect(fetchMock).toHaveBeenCalledWith(
			"http://qdrant.local/collections/memories/points",
			expect.objectContaining({ method: "PUT" }),
		);
	});

	it("retries transient HTTP failures for external vector requests", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		let collectionAttempts = 0;
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = input.toString();
			if (url.endsWith("/collections/memories")) {
				collectionAttempts += 1;
				if (collectionAttempts === 1) {
					return new Response("temporary unavailable", { status: 503 });
				}
			}
			return new Response(JSON.stringify({ result: true }), { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const store = createVectorStore("qdrant", db, {
			url: "http://qdrant.local",
			collection: "memories",
			maxRetries: 1,
			retryBaseDelayMs: 0,
		});

		await store.store(createMemory());

		expect(collectionAttempts).toBe(2);
		expect(await store.count()).toBe(1);
	});

	it("falls back to local vector search when remote search fails", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const item = createMemory();
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = input.toString();
			if (url.endsWith("/points/search")) {
				return new Response("temporary unavailable", { status: 503 });
			}
			return new Response(JSON.stringify({ result: true }), { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const store = createVectorStore("qdrant", db, {
			url: "http://qdrant.local",
			collection: "memories",
			maxRetries: 0,
		}) as ExternalVectorStore;

		await store.store(item);
		const results = await store.search([1, 0, 0], { limit: 5, threshold: 0.5 });

		expect(results).toHaveLength(1);
		expect(results[0]?.item.id).toBe(item.id);
		expect(results[0]?.similarity).toBe(1);
		expect(store.getStatus()).toMatchObject({
			backend: "qdrant",
			state: "open",
			consecutiveFailures: 1,
		});
	});

	it("keeps local data canonical when transient remote writes fail", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const item = createMemory();
		let remoteFails = true;
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = input.toString();
			if (remoteFails && (url.endsWith("/points") || url.endsWith("/points/delete"))) {
				return new Response("temporary unavailable", { status: 503 });
			}
			return new Response(JSON.stringify({ result: true }), { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const store = createVectorStore("qdrant", db, {
			url: "http://qdrant.local",
			collection: "memories",
			maxRetries: 0,
		}) as ExternalVectorStore;

		await store.store(item);
		expect(await store.getById(item.id)).toMatchObject({ id: item.id });
		expect(store.getStatus()).toMatchObject({ state: "open" });
		expect(
			await db.get<{ operation: string }>(
				"SELECT operation FROM memory_vector_outbox WHERE memory_id = ?",
				[item.id],
			),
		).toMatchObject({ operation: "upsert" });

		await store.delete(item.id);

		expect(await store.getById(item.id)).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledWith(
			"http://qdrant.local/collections/memories/points/delete",
			expect.objectContaining({ method: "POST" }),
		);
		expect(
			await db.get<{ operation: string }>(
				"SELECT operation FROM memory_vector_outbox WHERE memory_id = ?",
				[item.id],
			),
		).toMatchObject({ operation: "delete" });

		remoteFails = false;
		await db.run(
			"UPDATE memory_vector_outbox SET available_at = ? WHERE memory_id = ?",
			[new Date(0).toISOString(), item.id],
		);
		expect(await store.reconcilePendingWrites()).toBe(1);
		expect(
			await db.get("SELECT operation FROM memory_vector_outbox WHERE memory_id = ?", [item.id]),
		).toBeUndefined();
	});

	it("stores locally while using pgvector for vector upsert and search", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const item = createMemory();
		const store = createVectorStore("pgvector", db, {
			url: "postgresql://user:pass@localhost/octopus",
			collection: "memory-vectors",
			dimension: 3,
		});

		expect(store).toBeInstanceOf(PgVectorStore);
		await store.initialize();
		await store.store(item);
		const results = await store.search([1, 0, 0], { limit: 5, threshold: 0.5 });

		expect(results).toHaveLength(1);
		expect(results[0]?.item.id).toBe(item.id);
		expect(results[0]?.similarity).toBe(0.94);
		expect(await store.getById(item.id)).toMatchObject({ id: item.id });
		const client = pgMock.instances[0];
		expect(client?.config).toMatchObject({ ssl: undefined });
		expect(client?.connect).toHaveBeenCalled();
		expect(client?.query).toHaveBeenCalledWith(
			"CREATE EXTENSION IF NOT EXISTS vector",
		);
		expect(
			client?.query.mock.calls.some((call) =>
				String(call[0]).includes("CREATE TABLE IF NOT EXISTS memory_vectors"),
			),
		).toBe(true);
		expect(
			client?.query.mock.calls.some((call) =>
				String(call[0]).includes("INSERT INTO memory_vectors"),
			),
		).toBe(true);
	});
});
