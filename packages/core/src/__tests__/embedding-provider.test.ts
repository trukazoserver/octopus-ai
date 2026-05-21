import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddingProvider } from "../memory/embedding-provider.js";

describe("EmbeddingProvider", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("retries the embedding API after a transient failure window", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: false,
				text: async () => "temporary failure",
			})
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					data: [{ embedding: [3, 4], index: 0 }],
				}),
			});
		vi.stubGlobal("fetch", fetchMock);

		const provider = new EmbeddingProvider({
			apiKey: "test-key",
			baseUrl: "https://example.test/v1",
			model: "test-embedding",
			apiType: "openai",
			dimensions: 2,
			maxBatchSize: 1,
			maxTextLength: 100,
			cacheSize: 10,
			failureRetryMs: 0,
		});

		const fallback = await provider.embed("first text");
		expect(fallback).toHaveLength(2);
		expect(provider.getStats().apiAvailable).toBe(false);

		const apiEmbedding = await provider.embed("second text");
		expect(apiEmbedding).toEqual([0.6, 0.8]);
		expect(provider.getStats().apiAvailable).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("sends OpenAI embeddings payloads with configured dimensions", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				data: [{ embedding: [1, 0], index: 0 }],
			}),
		});
		vi.stubGlobal("fetch", fetchMock);

		const provider = new EmbeddingProvider({
			apiKey: "openai-key",
			baseUrl: "https://api.openai.com/v1",
			model: "text-embedding-3-small",
			apiType: "openai",
			dimensions: 1536,
			maxBatchSize: 1,
			maxTextLength: 100,
			cacheSize: 10,
			failureRetryMs: 0,
		});

		await provider.embed("OpenAI document", "document");

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.openai.com/v1/embeddings",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer openai-key",
				}),
			}),
		);
		const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
		expect(body).toEqual({
			model: "text-embedding-3-small",
			input: "OpenAI document",
			dimensions: 1536,
		});
	});

	it("sends Google Gemini embedding requests with retrieval prefixes", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				embedding: { values: [0, 2] },
			}),
		});
		vi.stubGlobal("fetch", fetchMock);

		const provider = new EmbeddingProvider({
			apiKey: "gemini-key",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			model: "gemini-embedding-2",
			apiType: "google",
			dimensions: 768,
			maxBatchSize: 1,
			maxTextLength: 100,
			cacheSize: 10,
			failureRetryMs: 0,
		});

		const embedding = await provider.embed("needle", "query");

		expect(embedding).toEqual([0, 1]);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					"x-goog-api-key": "gemini-key",
				}),
			}),
		);
		const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
		expect(body).toEqual({
			content: { parts: [{ text: "task: search result | query: needle" }] },
			output_dimensionality: 768,
		});
	});

	it("sends Google Vertex embedding requests with bearer auth", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				embedding: { values: [3, 4] },
			}),
		});
		vi.stubGlobal("fetch", fetchMock);

		const provider = new EmbeddingProvider({
			apiKey: "vertex",
			authMode: "vertex",
			accessToken: "vertex-token",
			projectId: "octopus-project",
			location: "us-central1",
			model: "gemini-embedding-2",
			apiType: "google",
			dimensions: 768,
			maxBatchSize: 1,
			maxTextLength: 100,
			cacheSize: 10,
			failureRetryMs: 0,
		});

		const embedding = await provider.embed("memory", "document");

		expect(embedding).toEqual([0.6, 0.8]);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://us-central1-aiplatform.googleapis.com/v1/projects/octopus-project/locations/us-central1/publishers/google/models/gemini-embedding-2:embedContent",
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "Bearer vertex-token",
				}),
			}),
		);
		const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
		expect(body).toEqual({
			content: { parts: [{ text: "title: none | text: memory" }] },
			embedContentConfig: { outputDimensionality: 768 },
		});
	});
});
