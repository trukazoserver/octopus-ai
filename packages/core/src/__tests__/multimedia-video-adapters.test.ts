import { describe, expect, it, vi } from "vitest";
import { getDefaults } from "../config/defaults.js";
import { AgentPlatformVideoAdapter } from "../multimedia/providers/agent-platform.js";
import { GeminiApiVideoAdapter } from "../multimedia/providers/gemini-api.js";
import { InteractionsVideoAdapter } from "../multimedia/providers/interactions.js";
import { VideoSubmissionError, type MediaPersistence } from "../multimedia/types.js";

const media: MediaPersistence = {
	save: vi.fn(async () => ({
		id: "saved",
		url: "/api/media/file/saved.mp4",
		filename: "saved.mp4",
		size: 16,
		mimetype: "video/mp4",
	})),
	resolve: vi.fn(async () => ({
		buffer: Buffer.from("89504e470d0a1a0a", "hex"),
		mimeType: "image/png",
	})),
};

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("video provider adapters", () => {
	it("uses Agent Platform regional submit and fetchPredictOperation endpoints", async () => {
		const config = getDefaults();
		config.ai.providers.vertex.projectId = "project-123";
		config.ai.providers.vertex.location = "global";
		config.ai.providers.vertex.accessToken = "vertex-token";
		const video = Buffer.from("00000018667479706d703432", "hex");
		const secondVideo = Buffer.from("000000186674797069736f6d", "hex");
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				jsonResponse({
					name: "projects/project-123/locations/us-central1/publishers/google/models/veo-3.1-generate-001/operations/op-1",
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					done: true,
					response: {
						videos: [
							{
								video: {
									bytesBase64Encoded: video.toString("base64"),
									mimeType: "video/mp4",
								},
							},
							{
								video: {
									bytesBase64Encoded: secondVideo.toString("base64"),
									mimeType: "video/mp4",
								},
							},
						],
					},
				}),
			);
		const adapter = new AgentPlatformVideoAdapter(
			config.ai.providers.vertex,
			media,
			fetchMock,
		);
		const route = {
			provider: "vertex" as const,
			model: "veo-3.1-generate-001",
			transport: "video-lro" as const,
		};
		const request = {
			action: "first_last_frame" as const,
			prompt: "A camera move",
			imageUrl: "/api/media/file/first.png",
			lastFrameUrl: "/api/media/file/last.png",
			durationSeconds: 8,
			generateAudio: true,
		};

		const submitted = await adapter.submit(route, request);
		const polled = await adapter.poll(route, submitted.operationName, request);

		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"https://us-central1-aiplatform.googleapis.com/v1/projects/project-123/locations/us-central1/publishers/google/models/veo-3.1-generate-001:predictLongRunning",
		);
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			"https://us-central1-aiplatform.googleapis.com/v1/projects/project-123/locations/us-central1/publishers/google/models/veo-3.1-generate-001:fetchPredictOperation",
		);
		const submitBody = JSON.parse(
			String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
		) as Record<string, unknown>;
		const instance = (submitBody.instances as Array<Record<string, unknown>>)[0];
		expect(instance?.image).toBeDefined();
		expect(instance?.lastFrame).toBeDefined();
		expect(polled.done).toBe(true);
		expect(polled.outputs?.[0]?.buffer).toEqual(video);
		expect(polled.outputs?.[1]?.buffer).toEqual(secondVideo);
	});

	it("uses Gemini Developer API v1beta operation endpoints and omits Vertex-only fields", async () => {
		const config = getDefaults();
		config.ai.providers.gemini.apiKey = "gemini-key";
		config.ai.providers.gemini.baseUrl =
			"https://generativelanguage.googleapis.com/v1beta";
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ name: "operations/gemini-op" }))
			.mockResolvedValueOnce(
				jsonResponse({
					done: true,
					response: {
						generateVideoResponse: {
							generatedSamples: [
								{
									video: {
										bytesBase64Encoded: Buffer.from("video").toString("base64"),
										mimeType: "video/mp4",
									},
								},
							],
						},
					},
				}),
			);
		const adapter = new GeminiApiVideoAdapter(
			config.ai.providers.gemini,
			media,
			fetchMock,
		);
		const route = {
			provider: "gemini" as const,
			model: "veo-3.1-fast-generate-preview",
			transport: "video-lro" as const,
		};
		const request = {
			action: "text_to_video" as const,
			prompt: "A small boat at sunrise",
			durationSeconds: 6,
		};

		const submitted = await adapter.submit(route, request);
		await adapter.poll(route, submitted.operationName, request);

		expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-fast-generate-preview:predictLongRunning?key=gemini-key",
		);
		expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
			"https://generativelanguage.googleapis.com/v1beta/operations/gemini-op?key=gemini-key",
		);
		const submitBody = JSON.parse(
			String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
		) as { parameters: Record<string, unknown> };
		expect(submitBody.parameters.generateAudio).toBeUndefined();
		expect(submitBody.parameters.seed).toBeUndefined();
	});

	it("submits and resumes Omni video through background Interactions", async () => {
		const config = getDefaults();
		config.ai.providers.gemini.apiKey = "gemini-key";
		const create = vi.fn(async () => ({
			id: "interaction-1",
			status: "in_progress" as const,
		}));
		const get = vi.fn(async () => ({
			id: "interaction-1",
			status: "completed" as const,
			steps: [
				{
					type: "model_output",
					content: [
						{
							type: "video",
							data: Buffer.from("omni-video").toString("base64"),
							mime_type: "video/mp4",
						},
					],
				},
			],
		}));
		const cancel = vi.fn(async () => ({
			id: "interaction-1",
			status: "cancelled" as const,
		}));
		const adapter = new InteractionsVideoAdapter(
			"gemini",
			config,
			fetch,
			() => ({ create, get, cancel }),
		);
		const route = {
			provider: "gemini" as const,
			model: "gemini-omni-flash-preview",
			transport: "interactions" as const,
		};
		const request = {
			action: "text_to_video" as const,
			prompt: "A firefly crossing a quiet forest",
			durationSeconds: 8,
			aspectRatio: "16:9" as const,
		};

		const submitted = await adapter.submit(route, request);
		const polled = await adapter.poll(route, submitted.operationName, request);

		expect(submitted.operationName).toBe("interaction-1");
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				model: route.model,
				background: true,
				store: true,
				response_modalities: ["video"],
			}),
		);
		expect(get).toHaveBeenCalledWith("interaction-1");
		expect(polled.outputs?.[0]?.buffer?.toString()).toBe("omni-video");
	});

	it("treats submit 408 responses as ambiguous and unsafe to fallback", async () => {
		const config = getDefaults();
		config.ai.providers.gemini.apiKey = "gemini-key";
		const adapter = new GeminiApiVideoAdapter(
			config.ai.providers.gemini,
			media,
			vi.fn(async () => jsonResponse({ error: "timeout" }, 408)),
		);

		const error = await adapter
			.submit(
				{
					provider: "gemini",
					model: "veo-3.1-fast-generate-preview",
					transport: "video-lro",
				},
				{ action: "text_to_video", prompt: "Ambiguous timeout" },
			)
			.catch((caught) => caught);

		expect(error).toBeInstanceOf(VideoSubmissionError);
		expect((error as VideoSubmissionError).safeToFallback).toBe(false);
	});

	it("rejects untrusted output hosts before attaching Google credentials", async () => {
		const config = getDefaults();
		config.ai.providers.gemini.apiKey = "gemini-key";
		const fetchMock = vi.fn<typeof fetch>();
		const adapter = new GeminiApiVideoAdapter(
			config.ai.providers.gemini,
			media,
			fetchMock,
		);

		await expect(
			adapter.download({ uri: "https://attacker.example/video.mp4", mimeType: "video/mp4" }),
		).rejects.toThrow(/untrusted google media download/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("downloads Google-hosted public media without attaching an API key", async () => {
		const config = getDefaults();
		config.ai.providers.gemini.apiKey = "gemini-key";
		const fetchMock = vi.fn<typeof fetch>(async () =>
			new Response(Buffer.from("video"), {
				headers: { "content-type": "video/mp4" },
			}),
		);
		const adapter = new GeminiApiVideoAdapter(
			config.ai.providers.gemini,
			media,
			fetchMock,
		);

		await adapter.download({
			uri: "https://media.googleusercontent.com/generated/video.mp4",
			mimeType: "video/mp4",
		});

		const requested = fetchMock.mock.calls[0]?.[0] as URL;
		expect(requested.searchParams.has("key")).toBe(false);
	});

	it("bounds stalled Interactions SDK calls with the abort signal", async () => {
		const config = getDefaults();
		const controller = new AbortController();
		const adapter = new InteractionsVideoAdapter(
			"gemini",
			config,
			fetch,
			() => ({
				create: vi.fn(async () => ({ id: "interaction", status: "in_progress" as const })),
				get: vi.fn(() => new Promise(() => undefined)),
				cancel: vi.fn(async () => ({ id: "interaction", status: "cancelled" as const })),
			}),
		);
		const polling = adapter.poll(
			{
				provider: "gemini",
				model: "gemini-omni-flash-preview",
				transport: "interactions",
			},
			"interaction-1",
			{ action: "text_to_video", prompt: "Abort me" },
			controller.signal,
		);
		controller.abort(new Error("test abort"));

		await expect(polling).rejects.toThrow("test abort");
	});
});
