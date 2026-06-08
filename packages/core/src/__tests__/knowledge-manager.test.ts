import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LLMRouter } from "../ai/router.js";
import type { LLMRequest, LLMResponse, LLMRouterConfig } from "../ai/types.js";
import {
	createConfiguredKnowledgeExtractor,
	createOpenAIKnowledgeExtractor,
} from "../memory/knowledge-extractor.js";
import { KnowledgeManager } from "../memory/knowledge-manager.js";
import {
	type DatabaseAdapter,
	createDatabaseAdapter,
} from "../storage/database.js";

describe("KnowledgeManager", () => {
	let db: DatabaseAdapter;
	let manager: KnowledgeManager;

	beforeEach(async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		manager = new KnowledgeManager(db);
	});

	afterEach(async () => {
		await db.close();
	});

	it("creates collections and text items with searchable chunks", async () => {
		const collection = await manager.createCollection({ name: "Project KB" });
		const item = await manager.createTextItem({
			collectionId: collection.id,
			title: "Spec",
			content: "Octopus durable workflows use recoverable task lanes.",
		});

		const chunks = await manager.listChunks(item.id);
		const results = await manager.searchChunks({ query: "recoverable" });

		expect(chunks).toHaveLength(1);
		expect(results[0]?.item_id).toBe(item.id);
	});

	it("creates media items as metadata chunks", async () => {
		const collection = await manager.createCollection({ name: "Media KB" });
		const item = await manager.createMediaItem({
			collectionId: collection.id,
			mediaId: "media-1",
			sourceUri: "/api/media/file/media-1.png",
			title: "Reference image",
			description: "Blueprint screenshot",
			modality: "image",
		});

		const chunks = await manager.listChunks(item.id);

		expect(item.source_type).toBe("media");
		expect(chunks[0]?.content).toContain("Blueprint screenshot");
		expect(chunks[0]?.modality).toBe("image");
	});

	it("uses embeddings for semantic search when available", async () => {
		manager = new KnowledgeManager(db, async (text, task) => {
			if (task === "query") return [1, 0];
			return /workflow|durable/i.test(text) ? [1, 0] : [0, 1];
		});
		const collection = await manager.createCollection({ name: "Semantic KB" });
		const workflow = await manager.createTextItem({
			collectionId: collection.id,
			title: "Workflow notes",
			content: "Durable task lanes resume interrupted work.",
		});
		await manager.createTextItem({
			collectionId: collection.id,
			title: "Cooking notes",
			content: "Bananas and oats make a quick breakfast.",
		});

		const results = await manager.searchChunks({
			query: "orchestration recovery",
			collectionId: collection.id,
		});

		expect(results[0]?.item_id).toBe(workflow.id);
		expect(results[0]?.score).toBeGreaterThan(0.9);
	});

	it("ingests local multimodal files with sidecar captions", async () => {
		const dir = mkdtempSync(join(tmpdir(), "octopus-kb-"));
		try {
			const videoPath = join(dir, "walkthrough.mp4");
			writeFileSync(videoPath, "fake video bytes");
			writeFileSync(
				join(dir, "walkthrough.keyframes.json"),
				JSON.stringify([
					{ time: "00:00:01", caption: "Front elevation keyframe" },
					{ time: "00:00:05", caption: "Kitchen layout keyframe" },
				]),
			);
			writeFileSync(
				join(dir, "walkthrough.transcript.txt"),
				"Narrator explains the durable workflow dashboard.",
			);
			const collection = await manager.createCollection({ name: "Video KB" });

			const item = await manager.createFileItem({
				collectionId: collection.id,
				filePath: videoPath,
				title: "Walkthrough",
			});
			const chunks = await manager.listChunks(item.id);

			expect(item.source_type).toBe("file");
			expect(chunks.map((chunk) => chunk.content).join("\n")).toContain(
				"Kitchen layout keyframe",
			);
			expect(chunks.map((chunk) => chunk.content).join("\n")).toContain(
				"durable workflow dashboard",
			);
			expect(chunks.every((chunk) => chunk.modality === "video")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("uses optional AI image extractor when no sidecar exists", async () => {
		const dir = mkdtempSync(join(tmpdir(), "octopus-kb-ai-"));
		try {
			const imagePath = join(dir, "diagram.png");
			writeFileSync(imagePath, "fake image bytes");
			manager = new KnowledgeManager(db, undefined, async (input) => [
				{
					content: `AI caption for ${input.mimeType}: visible workflow diagram`,
					modality: "image",
					metadata: { generatedFrom: "test_ai_extractor" },
				},
			]);
			const collection = await manager.createCollection({ name: "AI KB" });

			const item = await manager.createFileItem({
				collectionId: collection.id,
				filePath: imagePath,
			});
			const chunks = await manager.listChunks(item.id);

			expect(chunks[0]?.content).toContain("visible workflow diagram");
			expect(chunks[0]?.metadata).toContain("test_ai_extractor");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("deletes items with chunks", async () => {
		const collection = await manager.createCollection({ name: "Delete KB" });
		const item = await manager.createTextItem({
			collectionId: collection.id,
			content: "temporary",
		});

		await manager.deleteItem(item.id);

		expect(await manager.getItem(item.id)).toBeNull();
		expect(await manager.listChunks(item.id)).toHaveLength(0);
	});
});

describe("Knowledge image extractors", () => {
	const baseConfig: LLMRouterConfig = {
		default: "openai/gpt-4o-mini",
		providers: {
			openai: {},
			google: {},
		},
	};

	function createImageFile(): { dir: string; imagePath: string } {
		const dir = mkdtempSync(join(tmpdir(), "octopus-kb-extractor-"));
		const imagePath = join(dir, "diagram.png");
		writeFileSync(imagePath, "fake image bytes");
		return { dir, imagePath };
	}

	function response(content: string, model: string): LLMResponse {
		return {
			content,
			model,
			usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
			finishReason: "stop",
		};
	}

	it("uses OpenAI gpt-4o-mini by default when no OpenAI models are configured", async () => {
		const { dir, imagePath } = createImageFile();
		const requests: LLMRequest[] = [];
		try {
			const router = {
				chat: async (request: LLMRequest) => {
					requests.push(request);
					return response("Visible workflow diagram", request.model);
				},
			} as unknown as LLMRouter;
			const extractor = createOpenAIKnowledgeExtractor(router, baseConfig);

			const chunks = await extractor({
				filePath: imagePath,
				mimeType: "image/png",
				modality: "image",
			});

			expect(requests[0]?.model).toBe("openai/gpt-4o-mini");
			expect(chunks[0]?.metadata).toMatchObject({
				generatedFrom: "openai_image_extraction",
			});
			expect(chunks[0]?.content).toContain("Visible workflow diagram");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("respects configured OpenAI vision models", async () => {
		const { dir, imagePath } = createImageFile();
		const requests: LLMRequest[] = [];
		try {
			const router = {
				chat: async (request: LLMRequest) => {
					requests.push(request);
					return response("Configured model caption", request.model);
				},
			} as unknown as LLMRouter;
			const extractor = createOpenAIKnowledgeExtractor(router, {
				...baseConfig,
				providers: {
					openai: { models: ["gpt-4.1-mini"] },
				},
			});

			await extractor({
				filePath: imagePath,
				mimeType: "image/png",
				modality: "image",
			});

			expect(requests[0]?.model).toBe("openai/gpt-4.1-mini");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls back to Google when configured OpenAI extraction fails", async () => {
		const { dir, imagePath } = createImageFile();
		const models: string[] = [];
		try {
			const router = {
				chat: async (request: LLMRequest) => {
					models.push(request.model);
					if (request.model.startsWith("openai/")) {
						throw new Error("OpenAI extraction unavailable");
					}
					return response("Google fallback caption", request.model);
				},
			} as unknown as LLMRouter;
			const extractor = createConfiguredKnowledgeExtractor(router, {
				default: "openai/gpt-4o-mini",
				fallback: "google/gemini-2.5-flash",
				providers: {
					openai: { apiKey: "test-openai" },
					google: { apiKey: "test-google", models: ["gemini-2.5-flash"] },
				},
			});

			const chunks = await extractor({
				filePath: imagePath,
				mimeType: "image/png",
				modality: "image",
			});

			expect(models).toEqual([
				"openai/gpt-4o-mini",
				"google/gemini-2.5-flash",
			]);
			expect(chunks[0]?.content).toContain("Google fallback caption");
			expect(chunks[0]?.metadata).toMatchObject({
				generatedFrom: "google_vertex_image_extraction",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
