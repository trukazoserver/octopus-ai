import type { DatabaseAdapter } from "../storage/database.js";
import {
	type ExternalVectorBackend,
	ExternalVectorStore,
	type ExternalVectorStoreConfig,
} from "./external-vector-store.js";
import { PgVectorStore, type PgVectorStoreConfig } from "./pgvector-store.js";
import { SqliteVectorStore } from "./sqlite-vss.js";
import type { VectorStore } from "./store.js";

export type VectorStoreFactoryOptions = Partial<
	Omit<ExternalVectorStoreConfig, "backend">
> &
	Partial<PgVectorStoreConfig>;

const EXTERNAL_BACKENDS = new Set<string>(["qdrant", "weaviate", "milvus"]);

export function createVectorStore(
	backend: string,
	db: DatabaseAdapter,
	options: VectorStoreFactoryOptions = {},
): VectorStore {
	const normalized = backend.toLowerCase();
	if (normalized === "sqlite-vss" || normalized === "sqlite") {
		return new SqliteVectorStore(db);
	}
	if (EXTERNAL_BACKENDS.has(normalized)) {
		return new ExternalVectorStore(db, {
			backend: normalized as ExternalVectorBackend,
			url: requireExternalUrl(normalized, options),
			apiKey: firstNonEmpty(
				options.apiKey,
				process.env[`OCTOPUS_${normalized.toUpperCase()}_API_KEY`],
				process.env.OCTOPUS_VECTOR_API_KEY,
			),
			collection:
				firstNonEmpty(
					options.collection,
					process.env[`OCTOPUS_${normalized.toUpperCase()}_COLLECTION`],
					process.env.OCTOPUS_VECTOR_COLLECTION,
				) ?? "octopus_memory",
			timeoutMs: firstPositiveNumber(
				options.timeoutMs,
				process.env[`OCTOPUS_${normalized.toUpperCase()}_TIMEOUT_MS`],
				process.env.OCTOPUS_VECTOR_TIMEOUT_MS,
			),
			maxRetries: firstPositiveNumber(
				options.maxRetries,
				process.env[`OCTOPUS_${normalized.toUpperCase()}_MAX_RETRIES`],
				process.env.OCTOPUS_VECTOR_MAX_RETRIES,
			),
			retryBaseDelayMs: firstPositiveNumber(
				options.retryBaseDelayMs,
				process.env[`OCTOPUS_${normalized.toUpperCase()}_RETRY_BASE_DELAY_MS`],
				process.env.OCTOPUS_VECTOR_RETRY_BASE_DELAY_MS,
			),
			dimension: options.dimension,
			database: firstNonEmpty(
				options.database,
				process.env[`OCTOPUS_${normalized.toUpperCase()}_DATABASE`],
				process.env.OCTOPUS_VECTOR_DATABASE,
			),
		});
	}
	if (normalized === "pgvector") {
		return new PgVectorStore(db, {
			connectionString: requirePgConnectionString(options),
			table:
				firstNonEmpty(
					options.table,
					options.collection,
					process.env.OCTOPUS_PGVECTOR_TABLE,
					process.env.OCTOPUS_VECTOR_COLLECTION,
				) ?? "octopus_memory_vectors",
			dimension: options.dimension,
			ssl: options.ssl,
		});
	}
	throw new Error(`Unknown vector store backend: ${backend}`);
}

function requireExternalUrl(
	backend: string,
	options: VectorStoreFactoryOptions,
): string {
	const url = firstNonEmpty(
		options.url,
		process.env[`OCTOPUS_${backend.toUpperCase()}_URL`],
		process.env.OCTOPUS_VECTOR_URL,
	);
	if (!url) {
		throw new Error(
			`Vector store backend '${backend}' requires memory.longTerm.vectorStore.url or OCTOPUS_${backend.toUpperCase()}_URL.`,
		);
	}
	return url;
}

function requirePgConnectionString(options: VectorStoreFactoryOptions): string {
	const connectionString = firstNonEmpty(
		options.connectionString,
		options.url,
		process.env.OCTOPUS_PGVECTOR_URL,
		process.env.OCTOPUS_VECTOR_URL,
	);
	if (!connectionString) {
		throw new Error(
			"Vector store backend 'pgvector' requires memory.longTerm.vectorStore.url or OCTOPUS_PGVECTOR_URL.",
		);
	}
	return connectionString;
}

function firstNonEmpty(
	...values: Array<string | undefined | null>
): string | undefined {
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

function firstPositiveNumber(
	...values: Array<number | string | undefined | null>
): number | undefined {
	for (const value of values) {
		if (value === undefined || value === null) continue;
		const parsed = typeof value === "number" ? value : Number(value);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	return undefined;
}
