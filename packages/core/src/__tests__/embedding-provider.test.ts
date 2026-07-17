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

		const fallback = await provider.embed("same text");
		expect(fallback).toHaveLength(2);
		expect(provider.getStats().apiAvailable).toBe(false);
		expect(provider.getStats().quality).toBe("fallback");

		const apiEmbedding = await provider.embed("same text");
		expect(apiEmbedding).toEqual([0.6, 0.8]);
		expect(provider.getStats().apiAvailable).toBe(true);
		expect(provider.getStats().quality).toBe("provider");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("sends OpenAI embeddings payloads with configured dimensions", async () => {
		const openAiEmbedding = new Array(1536).fill(0);
		openAiEmbedding[0] = 1;
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				data: [{ embedding: openAiEmbedding, index: 0 }],
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
			dimensions: 2,
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
			output_dimensionality: 2,
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
			dimensions: 2,
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
			embedContentConfig: { outputDimensionality: 2 },
		});
	});

	it("rejects incomplete batches and retries instead of caching fallbacks", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					data: [{ embedding: [1, 0], index: 0 }],
				}),
			})
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					data: [
						{ embedding: [1, 0], index: 0 },
						{ embedding: [0, 1], index: 1 },
					],
				}),
			});
		vi.stubGlobal("fetch", fetchMock);
		const provider = new EmbeddingProvider({
			apiKey: "test-key",
			baseUrl: "https://example.test/v1",
			model: "strict-embedding",
			apiType: "openai",
			dimensions: 2,
			failureRetryMs: 0,
		});

		const degraded = await provider.embedBatch(["alpha", "beta"]);
		expect(degraded).toHaveLength(2);
		expect(provider.getStats().quality).toBe("fallback");
		const recovered = await provider.embedBatch(["alpha", "beta"]);
		expect(recovered).toEqual([
			[1, 0],
			[0, 1],
		]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("rejects wrong dimensions and non-finite provider values", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					data: [{ embedding: [1, 0, 0], index: 0 }],
				}),
			})
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					data: [{ embedding: [Number.NaN, 1], index: 0 }],
				}),
			});
		vi.stubGlobal("fetch", fetchMock);
		const provider = new EmbeddingProvider({
			apiKey: "test-key",
			baseUrl: "https://example.test/v1",
			model: "strict-embedding",
			apiType: "openai",
			dimensions: 2,
			failureRetryMs: 0,
		});

		expect(await provider.embed("wrong dimensions")).toHaveLength(2);
		expect(await provider.embed("non finite")).toHaveLength(2);
		expect(provider.getStats().totalFallbacks).toBe(2);
		expect(provider.getStats().cacheSize).toBe(0);
	});

	it("exposes a stable versioned descriptor on embedding functions", async () => {
		const provider = new EmbeddingProvider({ dimensions: 8 });
		const embed = provider.getEmbedFunction();
		await embed("offline document");
		expect(embed.getDescriptor?.()).toEqual(
			expect.objectContaining({
				provider: "hash-bow",
				model: "hash-bow-v1",
				dimensions: 8,
				version: "hash-bow-v1:8",
				quality: "fallback",
			}),
		);
	});

	it("returns the descriptor atomically for cached provider embeddings", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ data: [{ embedding: [1, 0], index: 0 }] }),
			})
			.mockResolvedValueOnce({
				ok: false,
				text: async () => "provider outage",
			});
		vi.stubGlobal("fetch", fetchMock);
		const provider = new EmbeddingProvider({
			apiKey: "test-key",
			baseUrl: "https://example.test/v1",
			model: "atomic-v1",
			apiType: "openai",
			dimensions: 2,
			failureRetryMs: 0,
		});
		const first = await provider.embedVersioned("cached provider text");
		expect(first.descriptor.quality).toBe("provider");
		expect((await provider.embedVersioned("outage text")).descriptor.quality).toBe(
			"fallback",
		);
		const cached = await provider.embedVersioned("cached provider text");
		expect(cached.values).toEqual([1, 0]);
		expect(cached.descriptor).toMatchObject({
			provider: "openai",
			model: "atomic-v1",
			quality: "provider",
		});
	});
});
