import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ apiKey: "openai-test-key" }));

vi.mock("../config/loader.js", () => ({
	ConfigLoader: class {
		load() {
			return {
				ai: {
					providers: {
						openai: {
							apiKey: state.apiKey,
							baseUrl: "https://api.openai.com/v1",
						},
					},
				},
				tools: {
					imageGeneration: {
						openai: { provider: "openai-api", model: "gpt-image-2" },
					},
				},
			};
		}
	},
}));

const WORKSPACE = join(homedir(), ".octopus", "workspace");
const TEST_DIR = "__openai_image_api_test__";

describe("OpenAI image API provider", () => {
	let responseImage: Buffer;
	const originalFetch = globalThis.fetch;

	beforeEach(async () => {
		state.apiKey = "openai-test-key";
		mkdirSync(join(WORKSPACE, TEST_DIR), { recursive: true });
		responseImage = await sharp({
			create: {
				width: 2,
				height: 2,
				channels: 4,
				background: { r: 130, g: 40, b: 210, alpha: 0 },
			},
		})
			.png()
			.toBuffer();
		globalThis.fetch = vi.fn(async () =>
			Response.json({
				data: [{ b64_json: responseImage.toString("base64") }],
			}),
		) as typeof fetch;
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		globalThis.fetch = originalFetch;
		rmSync(join(WORKSPACE, TEST_DIR), { recursive: true, force: true });
	});

	it("uses the public generations endpoint with native transparency", async () => {
		const { createCodexImageTools } = await import("../tools/codex-image.js");
		const result = await createCodexImageTools()[0].handler({
			prompt: "A purple octopus with transparent background",
			background: "transparent",
			size: "1920x1080",
			quality: "high",
			path: `${TEST_DIR}/generated.png`,
		});

		expect(result.success).toBe(true);
		expect(result.metadata).toMatchObject({
			provider: "openai-api",
			model: "gpt-image-2",
			alphaPostProcessed: false,
		});
		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.openai.com/v1/images/generations");
		expect(new Headers(init.headers).get("authorization")).toBe(
			"Bearer openai-test-key",
		);
		const body = JSON.parse(String(init.body));
		expect(body).toMatchObject({
			model: "gpt-image-2",
			size: "1920x1080",
			quality: "high",
			background: "transparent",
			output_format: "png",
		});
		expect(body.prompt).not.toContain("INTERMEDIATE RENDER REQUIREMENT");
		expect(existsSync(join(WORKSPACE, TEST_DIR, "generated.png"))).toBe(true);
	});

	it("uses multipart form data for the public edits endpoint", async () => {
		const input = join(WORKSPACE, TEST_DIR, "input.png");
		const output = `${TEST_DIR}/edited.png`;
		writeFileSync(input, responseImage, { flush: true });
		const { createCodexImageTools } = await import("../tools/codex-image.js");
		const result = await createCodexImageTools()[1].handler({
			image: `${TEST_DIR}/input.png`,
			prompt: "Add a red hat",
			path: output,
		});

		expect(result.success).toBe(true);
		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.openai.com/v1/images/edits");
		expect(init.body).toBeInstanceOf(FormData);
		const form = init.body as FormData;
		expect(form.get("prompt")).toBe("Add a red hat");
		expect(form.get("model")).toBe("gpt-image-2");
		expect(form.get("image[]")).toBeInstanceOf(Blob);
		expect(new Headers(init.headers).has("content-type")).toBe(false);
		expect(result.metadata).toMatchObject({ provider: "openai-api" });
	});

	it("falls back to OPENAI_API_KEY when the config field is empty", async () => {
		state.apiKey = "";
		vi.stubEnv("OPENAI_API_KEY", "openai-env-key");
		const { createCodexImageTools } = await import("../tools/codex-image.js");
		const result = await createCodexImageTools()[0].handler({
			prompt: "A blue circle",
			path: `${TEST_DIR}/env-generated.png`,
		});

		expect(result.success).toBe(true);
		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(new Headers(init.headers).get("authorization")).toBe(
			"Bearer openai-env-key",
		);
	});
});
