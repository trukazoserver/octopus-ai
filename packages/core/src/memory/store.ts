import { createHash } from "node:crypto";
import type { DatabaseAdapter } from "../storage/database.js";
import type {
	EmbeddingDescriptor,
	MemoryItem,
	VectorSearchOptions,
	VectorSearchResult,
} from "./types.js";

export interface VectorGeneration {
	key: string;
	dimensions: number;
	descriptor?: EmbeddingDescriptor;
	legacy: boolean;
}

export interface LegacyVectorPayloadMigrationInput {
	mode: "preview" | "apply";
	limit?: number;
	cursor?: string;
	upperBoundId?: string;
}

export interface LegacyVectorPayloadMigrationReport {
	supported: boolean;
	mode: "preview" | "apply";
	scanned: number;
	eligible: number;
	migrated: number;
	queued: number;
	missingDescriptor: number;
	invalidDescriptor: number;
	failed: number;
	nextCursor?: string;
	hasMore?: boolean;
}

export function resolveVectorGeneration(
	descriptor: EmbeddingDescriptor | undefined,
	actualDimensions: number,
): VectorGeneration {
	if (!descriptor) {
		return { key: "legacy", dimensions: actualDimensions, legacy: true };
	}
	if (descriptor.dimensions !== actualDimensions) {
		throw new Error(
			`Embedding descriptor dimension mismatch: declared ${descriptor.dimensions}, received ${actualDimensions}`,
		);
	}
	const identity = [
		descriptor.provider,
		descriptor.model,
		descriptor.version,
		descriptor.quality,
		String(descriptor.dimensions),
	].join("\u0000");
	const hash = createHash("sha256").update(identity).digest("hex").slice(0, 12);
	return {
		key: `g_${actualDimensions}_${hash}`,
		dimensions: actualDimensions,
		descriptor,
		legacy: false,
	};
}

export function embeddingDescriptorFromMetadata(
	metadata: Record<string, unknown>,
): EmbeddingDescriptor | undefined {
	const { embeddingProvider, embeddingModel, embeddingVersion, embeddingQuality } =
		metadata;
	const embeddingDimensions = Number(metadata.embeddingDimensions);
	if (
		typeof embeddingProvider !== "string" ||
		typeof embeddingModel !== "string" ||
		typeof embeddingVersion !== "string" ||
		(embeddingQuality !== "provider" && embeddingQuality !== "fallback") ||
		!Number.isInteger(embeddingDimensions) ||
		embeddingDimensions <= 0
	) {
		return undefined;
	}
	return {
		provider: embeddingProvider,
		model: embeddingModel,
		version: embeddingVersion,
		quality: embeddingQuality,
		dimensions: embeddingDimensions,
	};
}

export abstract class VectorStore {
	constructor(protected db: DatabaseAdapter) {}

	/**
	 * Initialize the vector store (create tables, indexes, etc.)
	 * Should be called before any other operations
	 */
	abstract initialize(): Promise<void>;

	abstract store(item: MemoryItem): Promise<void>;
	abstract search(
		queryEmbedding: number[],
		options: VectorSearchOptions,
	): Promise<VectorSearchResult[]>;
	abstract getById(id: string): Promise<MemoryItem | undefined>;
	abstract getByIds(ids: string[]): Promise<MemoryItem[]>;
	abstract listRecent(limit: number): Promise<MemoryItem[]>;
	abstract listAll(limit?: number): Promise<MemoryItem[]>;
	abstract update(item: MemoryItem): Promise<void>;
	abstract delete(id: string): Promise<void>;
	abstract count(): Promise<number>;
	async updateAccess(id: string): Promise<void> {
		await this.db.run(
			"UPDATE memory_items SET access_count = access_count + 1, last_accessed = ? WHERE id = ?",
			[new Date().toISOString(), id],
		);
	}
	getDiagnostics(): Record<string, number> {
		return {};
	}
	async stageStore(item: MemoryItem): Promise<void> {
		await this.store(item);
	}
	async finalizeStore(_id: string): Promise<void> {}
	async stageDelete(id: string): Promise<void> {
		await this.delete(id);
	}
	async finalizeDelete(_id: string): Promise<void> {}
	async migrateLegacyPayloads(
		input: LegacyVectorPayloadMigrationInput,
	): Promise<LegacyVectorPayloadMigrationReport> {
		return {
			supported: false,
			mode: input.mode,
			scanned: 0,
			eligible: 0,
			migrated: 0,
			queued: 0,
			missingDescriptor: 0,
			invalidDescriptor: 0,
			failed: 0,
		};
	}

	async close(): Promise<void> {}
}
