import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	provider: "gemini-api" as "gemini-api" | "vertex",
	geminiApiKey: "gemini-test-key",
}));

vi.mock("../config/loader.js", () => ({
	ConfigLoader: class {
		load() {
			return {
				ai: {
					providers: {
						gemini: { apiKey: state.geminiApiKey },
						vertex: {
							projectId: "vertex-project",
							location: "global",
							accessToken: "vertex-test-token",
						},
					},
				},
				tools: {
					imageGeneration: {
						nanoBanana: {
							provider: state.provider,
							model: "gemini-3.1-flash-image",
						},
					},
				},
			};
		}
	},
}));

async function chromaFixture(): Promise<Buffer> {
	const width = 32;
	const height = 32;
	const pixels = Buffer.alloc(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const offset = (y * width + x) * 3;
			pixels[offset] = 0;
			pixels[offset + 1] = 255;
			pixels[offset + 2] = 0;
			if (x >= 8 && x < 24 && y >= 8 && y < 24) {
				pixels[offset] = 130;
				pixels[offset + 1] = 40;
				pixels[offset + 2] = 210;
			}
			if (x >= 12 && x < 16 && y >= 12 && y < 16) {
				pixels[offset] = 255;
				pixels[offset + 1] = 255;
				pixels[offset + 2] = 255;
			}
		}
	}
	return sharp(pixels, { raw: { width, height, channels: 3 } })
		.png()
		.toBuffer();
}

describe("nano-banana-generate providers", () => {
	let responseImage: Buffer;
	let savedBuffer: Buffer | undefined;
	let savedMetadata: Record<string, unknown> | undefined;

	beforeEach(async () => {
		state.provider = "gemini-api";
		state.geminiApiKey = "gemini-test-key";
		responseImage = await chromaFixture();
		savedBuffer = undefined;
		savedMetadata = undefined;
		globalThis.fetch = vi.fn(async () =>
			Response.json({
				candidates: [
					{
						content: {
							parts: [
								{
									inlineData: {
										mimeType: "image/png",
										data: responseImage.toString("base64"),
									},
								},
							],
						},
					},
				],
			}),
		) as typeof fetch;
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	function context() {
		return {
			media: {
				save: async (
					buffer: Buffer,
					_mimeType: string,
					_description?: string,
					metadata?: Record<string, unknown>,
				) => {
					savedBuffer = buffer;
					savedMetadata = metadata;
					return {
						id: "media-1",
						filename: "media-1.png",
						mimetype: "image/png",
						size: buffer.length,
						createdAt: new Date().toISOString(),
						url: "/api/media/file/media-1.png",
					};
				},
				resolve: async () => {
					throw new Error("not used");
				},
			},
		};
	}

	it("uses the Gemini API endpoint and creates real alpha", async () => {
		const { createNanoBananaImageTools } = await import(
			"../tools/nano-banana-image.js"
		);
		const result = await createNanoBananaImageTools()[0].handler(
			{
				prompt: "Calamar morado con ojos blancos y fondo transparente",
				background: "transparent",
				aspect_ratio: "1:1",
				resolution: "2K",
			},
			context() as never,
		);

		expect(result.success).toBe(true);
		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			"https://generativelanguage.googleapis.com/v1/models/gemini-3.1-flash-image:generateContent",
		);
		expect(new Headers(init.headers).get("x-goog-api-key")).toBe(
			"gemini-test-key",
		);
		const body = JSON.parse(String(init.body));
		expect(body.generationConfig.imageConfig).toEqual({
			aspectRatio: "1:1",
			imageSize: "2K",
		});
		expect(body.responseFormat).toBeUndefined();
		expect(body.contents[0].parts[0].text).toContain("#00FF00");
		expect((await sharp(savedBuffer).stats()).isOpaque).toBe(false);
		expect(savedMetadata).toMatchObject({
			provider: "gemini-api",
			model: "gemini-3.1-flash-image",
			background: "transparent",
			chromaKey: "#00FF00",
		});
	});

	it("uses the Vertex AI endpoint and bearer authentication", async () => {
		state.provider = "vertex";
		const { createNanoBananaImageTools } = await import(
			"../tools/nano-banana-image.js"
		);
		const result = await createNanoBananaImageTools()[0].handler(
			{ prompt: "A purple squid", aspect_ratio: "16:9", resolution: "1K" },
			context() as never,
		);

		expect(result.success).toBe(true);
		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toContain(
			"aiplatform.googleapis.com/v1/projects/vertex-project/locations/global/publishers/google/models/gemini-3.1-flash-image:generateContent",
		);
		expect(new Headers(init.headers).get("authorization")).toBe(
			"Bearer vertex-test-token",
		);
		const body = JSON.parse(String(init.body));
		expect(body.generationConfig.imageConfig).toEqual({
			aspectRatio: "16:9",
			imageSize: "1K",
		});
		expect(savedMetadata).toMatchObject({ provider: "vertex" });
	});

	it("falls back to GEMINI_API_KEY when the config field is empty", async () => {
		state.geminiApiKey = "";
		vi.stubEnv("GEMINI_API_KEY", "gemini-env-key");
		const { createNanoBananaImageTools } = await import(
			"../tools/nano-banana-image.js"
		);
		const result = await createNanoBananaImageTools()[0].handler(
			{ prompt: "A green triangle" },
			context() as never,
		);

		expect(result.success).toBe(true);
		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(new Headers(init.headers).get("x-goog-api-key")).toBe(
			"gemini-env-key",
		);
	});
});
