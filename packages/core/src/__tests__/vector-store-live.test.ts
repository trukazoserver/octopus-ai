import { describe, expect, it } from "vitest";
import { createVectorStore } from "../memory/factory.js";
import type { VectorStore } from "../memory/store.js";
import type { MemoryItem } from "../memory/types.js";
import { createDatabaseAdapter } from "../storage/database.js";

function firstEnv(...names: string[]): string {
	for (const name of names) {
		const value = process.env[name]?.trim();
		if (value) return value;
	}
	return "";
}

function optionalEnv(...names: string[]): string | undefined {
	return firstEnv(...names) || undefined;
}

function booleanEnv(...names: string[]): boolean {
	return firstEnv(...names).toLowerCase() === "true";
}

function createMemory(id: string, embedding: number[]): MemoryItem {
	return {
		id,
		type: "semantic",
		content: `Integration vector memory ${id}`,
		embedding,
		importance: 0.8,
		accessCount: 0,
		lastAccessed: new Date(0),
		createdAt: new Date(0),
		associations: [],
		source: { sourceType: "system", sourceId: "integration-test" },
		metadata: { tenantId: "integration" },
	};
}

async function closeStore(store: VectorStore): Promise<void> {
	const maybeClosable = store as VectorStore & { close?: () => Promise<void> };
	await maybeClosable.close?.();
}

async function expectVectorRoundTrip(store: VectorStore): Promise<void> {
	const item = createMemory(`memory-${crypto.randomUUID()}`, [1, 0, 0]);
	await store.initialize();
	await store.store(item);
	const results = await store.search([1, 0, 0], { limit: 3, threshold: 0.1 });
	expect(results.some((result) => result.item.id === item.id)).toBe(true);
	await store.delete(item.id);
}

const qdrantUrl = firstEnv("OCTOPUS_QDRANT_TEST_URL", "OCTOPUS_QDRANT_URL");
const weaviateUrl = firstEnv(
	"OCTOPUS_WEAVIATE_TEST_URL",
	"OCTOPUS_WEAVIATE_URL",
);
const milvusUrl = firstEnv("OCTOPUS_MILVUS_TEST_URL", "OCTOPUS_MILVUS_URL");
const pgvectorUrl = firstEnv(
	"OCTOPUS_PGVECTOR_TEST_URL",
	"OCTOPUS_PGVECTOR_URL",
);

describe.skipIf(!qdrantUrl)("Qdrant vector store integration", () => {
	it("stores, searches, and deletes a memory vector", async () => {
		const db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const store = createVectorStore("qdrant", db, {
			url: qdrantUrl,
			apiKey: optionalEnv(
				"OCTOPUS_QDRANT_TEST_API_KEY",
				"OCTOPUS_QDRANT_API_KEY",
			),
			collection: `octopus_integration_${crypto.randomUUID().replace(/-/g, "_")}`,
			dimension: 3,
			timeoutMs: 15000,
			maxRetries: 1,
		});

		try {
			await expectVectorRoundTrip(store);
		} finally {
			await closeStore(store);
			await db.close();
		}
	}, 60000);
});

describe.skipIf(!weaviateUrl)("Weaviate vector store integration", () => {
	it("stores, searches, and deletes a memory vector", async () => {
		const db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const store = createVectorStore("weaviate", db, {
			url: weaviateUrl,
			apiKey: optionalEnv(
				"OCTOPUS_WEAVIATE_TEST_API_KEY",
				"OCTOPUS_WEAVIATE_API_KEY",
			),
			collection: `OctopusIntegration${crypto.randomUUID().replace(/-/g, "")}`,
			dimension: 3,
			timeoutMs: 15000,
			maxRetries: 1,
		});

		try {
			await expectVectorRoundTrip(store);
		} finally {
			await closeStore(store);
			await db.close();
		}
	}, 60000);
});

describe.skipIf(!milvusUrl)("Milvus vector store integration", () => {
	it("stores, searches, and deletes a memory vector", async () => {
		const db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const store = createVectorStore("milvus", db, {
			url: milvusUrl,
			apiKey: optionalEnv(
				"OCTOPUS_MILVUS_TEST_API_KEY",
				"OCTOPUS_MILVUS_API_KEY",
			),
			database: optionalEnv(
				"OCTOPUS_MILVUS_TEST_DATABASE",
				"OCTOPUS_MILVUS_DATABASE",
			),
			collection: `octopus_integration_${crypto.randomUUID().replace(/-/g, "_")}`,
			dimension: 3,
			timeoutMs: 15000,
			maxRetries: 1,
		});

		try {
			await expectVectorRoundTrip(store);
		} finally {
			await closeStore(store);
			await db.close();
		}
	}, 60000);
});

describe.skipIf(!pgvectorUrl)("pgvector store integration", () => {
	it("stores, searches, and deletes a memory vector", async () => {
		const db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const store = createVectorStore("pgvector", db, {
			url: pgvectorUrl,
			collection: `octopus_integration_${crypto.randomUUID().replace(/-/g, "_")}`,
			dimension: 3,
			ssl: booleanEnv("OCTOPUS_PGVECTOR_TEST_SSL", "OCTOPUS_PGVECTOR_SSL"),
		});

		try {
			await expectVectorRoundTrip(store);
		} finally {
			await closeStore(store);
			await db.close();
		}
	}, 60000);
});
