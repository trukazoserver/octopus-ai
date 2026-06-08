import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { nanoid } from "nanoid";
import type { DatabaseAdapter } from "../storage/database.js";
import type { EmbeddingFunction } from "./types.js";

export type KnowledgeItemSourceType = "text" | "media" | "url" | "file" | "note";
export type KnowledgeItemStatus = "pending" | "ready" | "error";
export type KnowledgeChunkModality =
	| "text"
	| "image"
	| "audio"
	| "video"
	| "document"
	| "metadata";

export interface KnowledgeCollectionRecord {
	id: string;
	name: string;
	description: string | null;
	created_at: string;
	updated_at: string;
	metadata: string | null;
}

export interface KnowledgeItemRecord {
	id: string;
	collection_id: string;
	media_id: string | null;
	source_type: KnowledgeItemSourceType;
	source_uri: string | null;
	title: string | null;
	status: KnowledgeItemStatus;
	created_at: string;
	updated_at: string;
	metadata: string | null;
}

export interface KnowledgeChunkRecord {
	id: string;
	item_id: string;
	chunk_index: number;
	content: string;
	modality: KnowledgeChunkModality;
	embedding: string | null;
	created_at: string;
	metadata: string | null;
}

type KnowledgeSearchResult = KnowledgeChunkRecord & {
	item_title: string | null;
	collection_id: string;
	score?: number;
};

export interface ExtractedKnowledgeChunk {
	content: string;
	modality: KnowledgeChunkModality;
	metadata?: Record<string, unknown>;
}

export interface KnowledgeFileExtractionInput {
	filePath: string;
	modality: KnowledgeChunkModality;
	mimeType: string;
	metadata?: Record<string, unknown>;
}

export type KnowledgeFileExtractor = (
	input: KnowledgeFileExtractionInput,
) => Promise<ExtractedKnowledgeChunk[]>;

const TEXT_EXTENSIONS = new Set([
	".txt",
	".md",
	".markdown",
	".json",
	".csv",
	".tsv",
	".log",
	".html",
	".htm",
	".xml",
	".yaml",
	".yml",
]);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".weba", ".flac"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".ogv", ".mov", ".m4v"]);
const DOCUMENT_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".rtf"]);

export class KnowledgeManager {
	constructor(
		private db: DatabaseAdapter,
		private embedFn?: EmbeddingFunction,
		private fileExtractor?: KnowledgeFileExtractor,
	) {}

	async createCollection(input: {
		name: string;
		description?: string;
		metadata?: Record<string, unknown>;
	}): Promise<KnowledgeCollectionRecord> {
		const name = input.name.trim();
		if (!name) throw new Error("Collection name is required");
		const id = nanoid(16);
		const now = new Date().toISOString();
		await this.db.run(
			"INSERT INTO knowledge_collections (id, name, description, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?)",
			[
				id,
				name,
				input.description ?? null,
				now,
				now,
				input.metadata ? JSON.stringify(input.metadata) : null,
			],
		);
		return (await this.getCollection(id)) as KnowledgeCollectionRecord;
	}

	async listCollections(): Promise<KnowledgeCollectionRecord[]> {
		return this.db.all<KnowledgeCollectionRecord>(
			"SELECT * FROM knowledge_collections ORDER BY updated_at DESC, name ASC",
		);
	}

	async getCollection(id: string): Promise<KnowledgeCollectionRecord | null> {
		return (
			(await this.db.get<KnowledgeCollectionRecord>(
				"SELECT * FROM knowledge_collections WHERE id = ?",
				[id],
			)) ?? null
		);
	}

	async deleteCollection(id: string): Promise<void> {
		const items = await this.listItems({ collectionId: id });
		for (const item of items) await this.deleteItem(item.id);
		await this.db.run("DELETE FROM knowledge_collections WHERE id = ?", [id]);
	}

	async createTextItem(input: {
		collectionId: string;
		title?: string;
		content: string;
		sourceUri?: string;
		sourceType?: KnowledgeItemSourceType;
		metadata?: Record<string, unknown>;
	}): Promise<KnowledgeItemRecord> {
		await this.requireCollection(input.collectionId);
		const content = input.content.trim();
		if (!content) throw new Error("Knowledge item content is required");
		const item = await this.createItem({
			collectionId: input.collectionId,
			sourceType: input.sourceType ?? "text",
			sourceUri: input.sourceUri,
			title: input.title,
			status: "ready",
			metadata: input.metadata,
		});
		await this.replaceChunks(
			item.id,
			this.chunkText(content).map((chunk, index) => ({
				chunkIndex: index,
				content: chunk,
				modality: "text" as const,
			})),
		);
		return (await this.getItem(item.id)) as KnowledgeItemRecord;
	}

	async createMediaItem(input: {
		collectionId: string;
		mediaId?: string;
		sourceUri: string;
		title?: string;
		modality?: KnowledgeChunkModality;
		description?: string;
		metadata?: Record<string, unknown>;
	}): Promise<KnowledgeItemRecord> {
		await this.requireCollection(input.collectionId);
		const item = await this.createItem({
			collectionId: input.collectionId,
			sourceType: "media",
			sourceUri: input.sourceUri,
			title: input.title,
			mediaId: input.mediaId,
			status: "ready",
			metadata: input.metadata,
		});
		const metadataText = [
			input.title ? `Title: ${input.title}` : null,
			`Source: ${input.sourceUri}`,
			input.mediaId ? `Media ID: ${input.mediaId}` : null,
			input.description ? `Description: ${input.description}` : null,
			input.metadata ? `Metadata: ${JSON.stringify(input.metadata)}` : null,
		]
			.filter(Boolean)
			.join("\n");
		await this.replaceChunks(item.id, [
			{
				chunkIndex: 0,
				content: metadataText,
				modality: input.modality ?? "metadata",
				metadata: { generatedFrom: "media_metadata" },
			},
		]);
		return (await this.getItem(item.id)) as KnowledgeItemRecord;
	}

	async createFileItem(input: {
		collectionId: string;
		filePath: string;
		title?: string;
		sourceUri?: string;
		metadata?: Record<string, unknown>;
	}): Promise<KnowledgeItemRecord> {
		await this.requireCollection(input.collectionId);
		const filePath = this.resolveReadableFilePath(input.filePath);
		const stat = statSync(filePath);
		if (!stat.isFile()) throw new Error(`Knowledge file is not a file: ${filePath}`);

		const extracted = await this.extractFileChunks(filePath, input.metadata);
		const item = await this.createItem({
			collectionId: input.collectionId,
			sourceType: "file",
			sourceUri: input.sourceUri ?? filePath,
			title: input.title ?? basename(filePath),
			status: "ready",
			metadata: {
				...(input.metadata ?? {}),
				filePath,
				fileSize: stat.size,
				extension: extname(filePath).toLowerCase(),
			},
		});

		await this.replaceChunks(
			item.id,
			extracted.map((chunk, index) => ({
				chunkIndex: index,
				content: chunk.content,
				modality: chunk.modality,
				metadata: chunk.metadata,
			})),
		);
		return (await this.getItem(item.id)) as KnowledgeItemRecord;
	}

	async listItems(options: { collectionId?: string } = {}): Promise<KnowledgeItemRecord[]> {
		if (options.collectionId) {
			return this.db.all<KnowledgeItemRecord>(
				"SELECT * FROM knowledge_items WHERE collection_id = ? ORDER BY updated_at DESC",
				[options.collectionId],
			);
		}
		return this.db.all<KnowledgeItemRecord>(
			"SELECT * FROM knowledge_items ORDER BY updated_at DESC",
		);
	}

	async getItem(id: string): Promise<KnowledgeItemRecord | null> {
		return (
			(await this.db.get<KnowledgeItemRecord>(
				"SELECT * FROM knowledge_items WHERE id = ?",
				[id],
			)) ?? null
		);
	}

	async deleteItem(id: string): Promise<void> {
		await this.db.run("DELETE FROM knowledge_chunks WHERE item_id = ?", [id]);
		await this.db.run("DELETE FROM knowledge_items WHERE id = ?", [id]);
	}

	async replaceChunks(
		itemId: string,
		chunks: Array<{
			chunkIndex: number;
			content: string;
			modality?: KnowledgeChunkModality;
			metadata?: Record<string, unknown>;
		}>,
	): Promise<void> {
		await this.db.run("DELETE FROM knowledge_chunks WHERE item_id = ?", [itemId]);
		const now = new Date().toISOString();
		for (const chunk of chunks) {
			if (!chunk.content.trim()) continue;
			const embedding = await this.embedChunk(chunk.content);
			await this.db.run(
				"INSERT INTO knowledge_chunks (id, item_id, chunk_index, content, modality, embedding, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				[
					nanoid(16),
					itemId,
					chunk.chunkIndex,
					chunk.content,
					chunk.modality ?? "text",
					embedding ? JSON.stringify(embedding) : null,
					now,
					chunk.metadata ? JSON.stringify(chunk.metadata) : null,
				],
			);
		}
	}

	async listChunks(itemId: string): Promise<KnowledgeChunkRecord[]> {
		return this.db.all<KnowledgeChunkRecord>(
			"SELECT * FROM knowledge_chunks WHERE item_id = ? ORDER BY chunk_index ASC",
			[itemId],
		);
	}

	async searchChunks(options: {
		query: string;
		collectionId?: string;
		limit?: number;
	}): Promise<KnowledgeSearchResult[]> {
		const query = options.query.trim();
		if (!query) return [];
		const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
		const semantic = await this.searchChunksByEmbedding(query, {
			collectionId: options.collectionId,
			limit,
		});
		if (semantic.length > 0) return semantic;

		const like = `%${query.toLowerCase()}%`;
		const params: unknown[] = [like, like, like];
		let collectionFilter = "";
		if (options.collectionId) {
			collectionFilter = " AND i.collection_id = ?";
			params.push(options.collectionId);
		}
		params.push(limit);
		return this.db.all<KnowledgeSearchResult>(
			`SELECT c.*, i.title AS item_title, i.collection_id AS collection_id
			 FROM knowledge_chunks c
			 JOIN knowledge_items i ON i.id = c.item_id
			 WHERE (LOWER(c.content) LIKE ? OR LOWER(COALESCE(i.title, '')) LIKE ? OR LOWER(COALESCE(i.metadata, '')) LIKE ?)${collectionFilter}
			 ORDER BY i.updated_at DESC, c.chunk_index ASC
			 LIMIT ?`,
			params,
		);
	}

	private async searchChunksByEmbedding(
		query: string,
		options: { collectionId?: string; limit: number },
	): Promise<KnowledgeSearchResult[]> {
		if (!this.embedFn) return [];
		const queryEmbedding = await this.embedText(query, "query");
		if (!queryEmbedding) return [];

		const params: unknown[] = [];
		let collectionFilter = "";
		if (options.collectionId) {
			collectionFilter = " WHERE i.collection_id = ?";
			params.push(options.collectionId);
		}
		const candidates = await this.db.all<KnowledgeSearchResult>(
			`SELECT c.*, i.title AS item_title, i.collection_id AS collection_id
			 FROM knowledge_chunks c
			 JOIN knowledge_items i ON i.id = c.item_id${collectionFilter}
			 ORDER BY i.updated_at DESC, c.chunk_index ASC
			 LIMIT 500`,
			params,
		);

		const scored: KnowledgeSearchResult[] = [];
		for (const chunk of candidates) {
			const embedding = this.parseEmbedding(chunk.embedding);
			if (!embedding) continue;
			scored.push({ ...chunk, score: cosineSimilarity(queryEmbedding, embedding) });
		}

		return scored
			.filter((chunk) => (chunk.score ?? 0) > 0)
			.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
			.slice(0, options.limit);
	}

	private async createItem(input: {
		collectionId: string;
		mediaId?: string;
		sourceType: KnowledgeItemSourceType;
		sourceUri?: string;
		title?: string;
		status?: KnowledgeItemStatus;
		metadata?: Record<string, unknown>;
	}): Promise<KnowledgeItemRecord> {
		const id = nanoid(16);
		const now = new Date().toISOString();
		await this.db.run(
			"INSERT INTO knowledge_items (id, collection_id, media_id, source_type, source_uri, title, status, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				id,
				input.collectionId,
				input.mediaId ?? null,
				input.sourceType,
				input.sourceUri ?? null,
				input.title ?? null,
				input.status ?? "pending",
				now,
				now,
				input.metadata ? JSON.stringify(input.metadata) : null,
			],
		);
		await this.db.run(
			"UPDATE knowledge_collections SET updated_at = ? WHERE id = ?",
			[now, input.collectionId],
		);
		return (await this.getItem(id)) as KnowledgeItemRecord;
	}

	private async requireCollection(id: string): Promise<void> {
		if (!(await this.getCollection(id))) {
			throw new Error(`Knowledge collection not found: ${id}`);
		}
	}

	private chunkText(content: string): string[] {
		const chunks: string[] = [];
		let buffer = "";
		for (const paragraph of content.split(/\n{2,}/)) {
			const cleaned = paragraph.trim();
			if (!cleaned) continue;
			if ((buffer + "\n\n" + cleaned).length > 1400 && buffer) {
				chunks.push(buffer);
				buffer = cleaned;
			} else {
				buffer = buffer ? `${buffer}\n\n${cleaned}` : cleaned;
			}
		}
		if (buffer) chunks.push(buffer);
		return chunks.length > 0 ? chunks : [content];
	}

	private resolveReadableFilePath(filePath: string): string {
		const expanded = filePath === "~" ? homedir() : filePath.startsWith(`~${sep}`) || filePath.startsWith("~/")
			? join(homedir(), filePath.slice(2))
			: filePath;
		const resolved = resolve(expanded);
		const allowedRoots = [process.cwd(), homedir(), join(homedir(), ".octopus")].map((root) => resolve(root));
		if (!allowedRoots.some((root) => isPathInside(root, resolved))) {
			throw new Error(`Access denied: '${resolved}' is outside allowed knowledge import paths`);
		}
		if (!existsSync(resolved)) throw new Error(`Knowledge file not found: ${resolved}`);
		return resolved;
	}

	private async extractFileChunks(
		filePath: string,
		metadata?: Record<string, unknown>,
	): Promise<ExtractedKnowledgeChunk[]> {
		const ext = extname(filePath).toLowerCase();
		const modality = this.modalityForExtension(ext);
		const chunks: ExtractedKnowledgeChunk[] = [];

		if (TEXT_EXTENSIONS.has(ext)) {
			const text = this.readTextFile(filePath);
			for (const chunk of this.chunkText(text)) {
				chunks.push({ content: chunk, modality: ext === ".svg" ? "image" : "text", metadata: { generatedFrom: "file_text" } });
			}
		}

		if (ext === ".svg" && chunks.length === 0) {
			const svgText = this.extractSvgText(this.readTextFile(filePath));
			if (svgText) {
				chunks.push({ content: svgText, modality: "image", metadata: { generatedFrom: "svg_text" } });
			}
		}

		for (const sidecar of this.readSidecarTexts(filePath, modality)) {
			for (const chunk of this.chunkText(sidecar.content)) {
				chunks.push({ content: chunk, modality: sidecar.modality, metadata: sidecar.metadata });
			}
		}

		if (this.fileExtractor && IMAGE_EXTENSIONS.has(ext)) {
			try {
				const extracted = await this.fileExtractor({
					filePath,
					modality,
					mimeType: mimeTypeForExtension(ext),
					metadata,
				});
				for (const chunk of extracted) {
					if (chunk.content.trim()) chunks.push(chunk);
				}
			} catch {
				/* AI extraction is best-effort; sidecars and metadata remain available. */
			}
		}

		if (chunks.length === 0) {
			chunks.push({
				content: this.buildFileMetadataText(filePath, modality, metadata),
				modality: modality === "text" ? "metadata" : modality,
				metadata: { generatedFrom: "file_metadata" },
			});
		}

		return chunks;
	}

	private modalityForExtension(ext: string): KnowledgeChunkModality {
		if (IMAGE_EXTENSIONS.has(ext)) return "image";
		if (AUDIO_EXTENSIONS.has(ext)) return "audio";
		if (VIDEO_EXTENSIONS.has(ext)) return "video";
		if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
		return "text";
	}

	private readTextFile(filePath: string): string {
		const buffer = readFileSync(filePath);
		return buffer.toString("utf-8").replace(/^\uFEFF/, "").trim();
	}

	private readSidecarTexts(
		filePath: string,
		modality: KnowledgeChunkModality,
	): ExtractedKnowledgeChunk[] {
		const dir = dirname(filePath);
		const base = basename(filePath);
		const stem = base.slice(0, base.length - extname(base).length);
		const candidates = [
			{ path: join(dir, `${base}.ocr.txt`), modality: "image" as const, generatedFrom: "ocr_sidecar" },
			{ path: join(dir, `${stem}.ocr.txt`), modality: "image" as const, generatedFrom: "ocr_sidecar" },
			{ path: join(dir, `${base}.caption.txt`), modality, generatedFrom: "caption_sidecar" },
			{ path: join(dir, `${stem}.caption.txt`), modality, generatedFrom: "caption_sidecar" },
			{ path: join(dir, `${base}.transcript.txt`), modality: modality === "video" ? "video" as const : "audio" as const, generatedFrom: "transcript_sidecar" },
			{ path: join(dir, `${stem}.transcript.txt`), modality: modality === "video" ? "video" as const : "audio" as const, generatedFrom: "transcript_sidecar" },
			{ path: join(dir, `${base}.captions.vtt`), modality, generatedFrom: "captions_vtt" },
			{ path: join(dir, `${stem}.captions.vtt`), modality, generatedFrom: "captions_vtt" },
			{ path: join(dir, `${base}.captions.srt`), modality, generatedFrom: "captions_srt" },
			{ path: join(dir, `${stem}.captions.srt`), modality, generatedFrom: "captions_srt" },
			{ path: join(dir, `${base}.keyframes.txt`), modality: "video" as const, generatedFrom: "keyframe_captions" },
			{ path: join(dir, `${stem}.keyframes.txt`), modality: "video" as const, generatedFrom: "keyframe_captions" },
			{ path: join(dir, `${base}.keyframes.json`), modality: "video" as const, generatedFrom: "keyframe_captions_json" },
			{ path: join(dir, `${stem}.keyframes.json`), modality: "video" as const, generatedFrom: "keyframe_captions_json" },
		];

		const seen = new Set<string>();
		const chunks: ExtractedKnowledgeChunk[] = [];
		for (const candidate of candidates) {
			if (seen.has(candidate.path) || !existsSync(candidate.path)) continue;
			seen.add(candidate.path);
			const raw = this.readTextFile(candidate.path);
			const content = candidate.path.endsWith(".json")
				? this.formatKeyframeJson(raw)
				: this.cleanCaptionText(raw);
			if (!content) continue;
			chunks.push({
				content,
				modality: candidate.modality,
				metadata: { generatedFrom: candidate.generatedFrom, sidecarPath: candidate.path },
			});
		}
		return chunks;
	}

	private extractSvgText(svg: string): string {
		return svg
			.replace(/<script[\s\S]*?<\/script>/gi, " ")
			.replace(/<style[\s\S]*?<\/style>/gi, " ")
			.replace(/<[^>]+>/g, " ")
			.replace(/&nbsp;/g, " ")
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/\s+/g, " ")
			.trim();
	}

	private cleanCaptionText(content: string): string {
		return content
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line && line !== "WEBVTT" && !/^\d+$/.test(line) && !/^[\d:,\.]+\s+-->\s+[\d:,\.]+/.test(line))
			.join("\n")
			.trim();
	}

	private formatKeyframeJson(content: string): string {
		try {
			const parsed = JSON.parse(content) as unknown;
			if (!Array.isArray(parsed)) return this.cleanCaptionText(content);
			return parsed
				.map((entry, index) => {
					if (!entry || typeof entry !== "object") return "";
					const record = entry as Record<string, unknown>;
					const time = record.time ?? record.timestamp ?? record.seconds ?? index;
					const caption = record.caption ?? record.description ?? record.text ?? "";
					return caption ? `Keyframe ${index + 1} @ ${String(time)}: ${String(caption)}` : "";
				})
				.filter(Boolean)
				.join("\n");
		} catch {
			return this.cleanCaptionText(content);
		}
	}

	private buildFileMetadataText(
		filePath: string,
		modality: KnowledgeChunkModality,
		metadata?: Record<string, unknown>,
	): string {
		const stat = statSync(filePath);
		return [
			`File: ${basename(filePath)}`,
			`Path: ${filePath}`,
			`Modality: ${modality}`,
			`Extension: ${extname(filePath).toLowerCase() || "unknown"}`,
			`Size: ${stat.size} bytes`,
			metadata ? `Metadata: ${JSON.stringify(metadata)}` : null,
		]
			.filter(Boolean)
			.join("\n");
	}

	private async embedChunk(content: string): Promise<number[] | null> {
		return this.embedText(content, "document");
	}

	private async embedText(
		content: string,
		task: "document" | "query",
	): Promise<number[] | null> {
		if (!this.embedFn) return null;
		try {
			const embedding = await this.embedFn(content, task);
			return Array.isArray(embedding) && embedding.length > 0
				? embedding.filter((value) => Number.isFinite(value))
				: null;
		} catch {
			return null;
		}
	}

	private parseEmbedding(value: string | null): number[] | null {
		if (!value) return null;
		try {
			const parsed = JSON.parse(value);
			return Array.isArray(parsed)
				? parsed.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
				: null;
		} catch {
			return null;
		}
	}
}

function cosineSimilarity(a: number[], b: number[]): number {
	const length = Math.min(a.length, b.length);
	if (length === 0) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function mimeTypeForExtension(ext: string): string {
	switch (ext) {
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		case ".svg":
			return "image/svg+xml";
		case ".mp3":
			return "audio/mpeg";
		case ".wav":
			return "audio/wav";
		case ".mp4":
			return "video/mp4";
		case ".webm":
			return "video/webm";
		case ".pdf":
			return "application/pdf";
		default:
			return "application/octet-stream";
	}
}

function isPathInside(basePath: string, targetPath: string): boolean {
	const base = process.platform === "win32" ? resolve(basePath).toLowerCase() : resolve(basePath);
	const target = process.platform === "win32" ? resolve(targetPath).toLowerCase() : resolve(targetPath);
	const rel = relative(base, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
