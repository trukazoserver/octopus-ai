import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub ConfigLoader so the tool believes it has a valid Codex login without
// touching the real config file.
vi.mock("../config/loader.js", () => ({
	ConfigLoader: class {
		load() {
			return {
				ai: {
					providers: {
						openai: {
							accessToken: "test-token",
							accountId: "acct-1",
							authMode: "codex",
						},
					},
				},
				tools: {
					imageGeneration: {
						openai: { provider: "codex", model: "gpt-image-2" },
					},
				},
			};
		}
	},
}));

const WORKSPACE = join(homedir(), ".octopus", "workspace");
const TEST_SUB = "__codex_image_test__";

describe("codex_generate_image workspace-path save", () => {
	const originalFetch = globalThis.fetch;
	let responseBytes: Buffer;

	beforeEach(() => {
		responseBytes = Buffer.from("fake-png-bytes");
		// Mock the Codex image endpoint to return one tiny base64 image.
		globalThis.fetch = vi.fn(async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			headers: new Headers(),
			text: async () => "",
			json: async () => ({
				data: [{ b64_json: responseBytes.toString("base64") }],
			}),
		})) as unknown as typeof fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
		rmSync(join(WORKSPACE, TEST_SUB), { recursive: true, force: true });
	});

	it("saves the image into the workspace and returns a relative path (no base64)", async () => {
		const { createCodexImageTools } = await import("../tools/codex-image.js");
		const tool = createCodexImageTools()[0];
		const res = await tool.handler({
			prompt: "hero image",
			path: `${TEST_SUB}/hero.png`,
		});

		expect(res.success).toBe(true);
		// Returned a workspace-relative path with forward slashes...
		expect(res.output).toContain(`${TEST_SUB}/hero.png`);
		// ...and never leaked the base64 payload.
		expect(res.output).not.toContain("base64");
		// The file actually landed next to where an HTML would be written.
		expect(existsSync(join(WORKSPACE, TEST_SUB, "hero.png"))).toBe(true);
	});

	it("retries a transient server error at medium quality", async () => {
		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		fetchMock
			.mockReset()
			.mockResolvedValueOnce(
				new Response('{"error":{"message":"temporary failure"}}', {
					status: 500,
					headers: { "retry-after": "0" },
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					data: [{ b64_json: responseBytes.toString("base64") }],
				}),
			);
		const { createCodexImageTools } = await import("../tools/codex-image.js");
		const result = await createCodexImageTools()[0].handler({
			prompt: "friendly crab",
			background: "opaque",
			quality: "high",
			path: `${TEST_SUB}/retry.png`,
		});

		expect(result.success).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const retryBody = JSON.parse(
			String((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body),
		);
		expect(retryBody.quality).toBe("medium");
		expect(result.metadata).toMatchObject({
			quality: "medium",
			requestedQuality: "high",
			retried: true,
		});
		expect(existsSync(join(WORKSPACE, TEST_SUB, "retry.png"))).toBe(true);
	});

	it("retries a timed-out high-quality request at medium quality", async () => {
		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		fetchMock
			.mockReset()
			.mockRejectedValueOnce(
				new DOMException(
					"The operation was aborted due to timeout",
					"TimeoutError",
				),
			)
			.mockResolvedValueOnce(
				Response.json({
					data: [{ b64_json: responseBytes.toString("base64") }],
				}),
			);
		const { createCodexImageTools } = await import("../tools/codex-image.js");
		const result = await createCodexImageTools()[0].handler({
			prompt: "friendly crab",
			background: "opaque",
			quality: "high",
			path: `${TEST_SUB}/timeout-retry.png`,
		});

		expect(result.success).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const retryBody = JSON.parse(
			String((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body),
		);
		expect(retryBody.quality).toBe("medium");
		expect(result.metadata).toMatchObject({ retried: true });
	});

	it("rejects a destination path that escapes the workspace", async () => {
		const { createCodexImageTools } = await import("../tools/codex-image.js");
		const tool = createCodexImageTools()[0];
		const res = await tool.handler({
			prompt: "x",
			path: "../../etc/evil.png",
		});

		expect(res.success).toBe(false);
		expect(res.error ?? "").toMatch(/escapes the Octopus workspace/i);
		expect(existsSync(join(WORKSPACE, "..", "etc", "evil.png"))).toBe(false);
	});

	it("requests transparency and preserves native alpha when returned", async () => {
		responseBytes = await sharp({
			create: {
				width: 2,
				height: 2,
				channels: 4,
				background: { r: 255, g: 0, b: 0, alpha: 0 },
			},
		})
			.png()
			.toBuffer();
		const { createCodexImageTools } = await import("../tools/codex-image.js");
		const tool = createCodexImageTools()[0];
		const outputPath = join(WORKSPACE, TEST_SUB, "transparent.png");
		const res = await tool.handler({
			prompt: "Un icono rojo sin fondo",
			path: `${TEST_SUB}/transparent.png`,
		});

		expect(res.success).toBe(true);
		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const requestBody = JSON.parse(
			String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
		);
		expect(requestBody).toMatchObject({
			model: "gpt-image-2",
			background: "transparent",
		});
		expect(requestBody.prompt).toContain("#00FF00");
		expect((await sharp(readFileSync(outputPath)).stats()).isOpaque).toBe(
			false,
		);
	});

	it("converts a chroma background into real alpha", async () => {
		const width = 96;
		const height = 64;
		const pixels = Buffer.alloc(width * height * 3);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const offset = (y * width + x) * 3;
				pixels[offset] = 0;
				pixels[offset + 1] = 255;
				pixels[offset + 2] = 0;
				if (x >= 18 && x < 78 && y >= 10 && y < 54) {
					const edge = x === 18 || x === 77 || y === 10 || y === 53;
					pixels[offset] = edge ? 65 : 130;
					pixels[offset + 1] = edge ? 148 : 40;
					pixels[offset + 2] = edge ? 105 : 210;
				}
				// Enclosed chroma gap, similar to the space inside a claw.
				if (x >= 30 && x < 38 && y >= 20 && y < 32) {
					pixels[offset] = 0;
					pixels[offset + 1] = 255;
					pixels[offset + 2] = 0;
				}
				// A larger intentional white detail, similar to an eye, must survive.
				if (x >= 55 && x < 71 && y >= 20 && y < 36) {
					pixels[offset] = 255;
					pixels[offset + 1] = 255;
					pixels[offset + 2] = 255;
				}
				// Detached green spill inside the subject must also be decontaminated.
				if (x === 45 && y === 40) {
					pixels[offset] = 60;
					pixels[offset + 1] = 180;
					pixels[offset + 2] = 60;
				}
			}
		}
		responseBytes = await sharp(pixels, {
			raw: { width, height, channels: 3 },
		})
			.png()
			.toBuffer();
		const { createCodexImageTools } = await import("../tools/codex-image.js");
		const tool = createCodexImageTools()[0];
		const outputPath = join(WORKSPACE, TEST_SUB, "recovered.png");
		const res = await tool.handler({
			prompt: "Mascota con fondo transparente",
			path: `${TEST_SUB}/recovered.png`,
		});

		expect(res.success).toBe(true);
		expect(res.metadata?.alphaPostProcessed).toBe(true);
		expect(res.metadata?.chromaKey).toBe("#00FF00");
		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const requestBody = JSON.parse(
			String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
		);
		expect(requestBody.prompt).toContain("#00FF00");
		const { data, info } = await sharp(readFileSync(outputPath))
			.ensureAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true });
		expect(info.channels).toBe(4);
		expect(data[3]).toBe(0);
		expect(data[(40 * width + 40) * 4 + 3]).toBe(255);
		expect(data[(24 * width + 33) * 4 + 3]).toBe(0);
		expect(data[(25 * width + 60) * 4 + 3]).toBe(255);
		const edgeOffset = (30 * width + 18) * 4;
		expect(data[edgeOffset + 3]).toBeGreaterThan(0);
		expect(data[edgeOffset + 3]).toBeLessThan(255);
		expect(data[edgeOffset + 1]).toBeLessThan(
			pixels[(30 * width + 18) * 3 + 1],
		);
		const spillOffset = (40 * width + 45) * 4;
		expect(data[spillOffset + 3]).toBeGreaterThan(0);
		expect(data[spillOffset + 3]).toBeLessThan(255);
		expect(data[spillOffset + 1]).toBeLessThan(
			pixels[(40 * width + 45) * 3 + 1],
		);
	});

	it("preserves enclosed white details when the backend ignores chroma", async () => {
		const width = 96;
		const height = 64;
		const pixels = Buffer.alloc(width * height * 3, 255);
		for (let y = 10; y < 54; y++) {
			for (let x = 18; x < 78; x++) {
				const offset = (y * width + x) * 3;
				pixels[offset] = 130;
				pixels[offset + 1] = 40;
				pixels[offset + 2] = 210;
			}
		}
		for (let y = 22; y < 34; y++) {
			for (let x = 32; x < 40; x++) {
				const offset = (y * width + x) * 3;
				pixels[offset] = 255;
				pixels[offset + 1] = 255;
				pixels[offset + 2] = 255;
			}
		}
		responseBytes = await sharp(pixels, {
			raw: { width, height, channels: 3 },
		})
			.png()
			.toBuffer();
		const { createCodexImageTools } = await import("../tools/codex-image.js");
		const tool = createCodexImageTools()[0];
		const outputPath = join(WORKSPACE, TEST_SUB, "white-eye.png");
		const res = await tool.handler({
			prompt: "Personaje con un ojo blanco y fondo transparente",
			path: `${TEST_SUB}/white-eye.png`,
		});

		expect(res.success).toBe(true);
		const { data } = await sharp(readFileSync(outputPath))
			.ensureAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true });
		expect(data[3]).toBe(0);
		expect(data[(28 * width + 35) * 4 + 3]).toBe(255);
	});

	it("chooses a different chroma when the subject is green", async () => {
		responseBytes = await sharp({
			create: {
				width: 2,
				height: 2,
				channels: 4,
				background: { r: 0, g: 255, b: 0, alpha: 0 },
			},
		})
			.png()
			.toBuffer();
		const { createCodexImageTools } = await import("../tools/codex-image.js");
		const tool = createCodexImageTools()[0];
		const res = await tool.handler({
			prompt: "Un dragón verde con fondo transparente",
			path: `${TEST_SUB}/green-subject.png`,
		});

		expect(res.success).toBe(true);
		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const requestBody = JSON.parse(
			String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
		);
		expect(requestBody.prompt).toContain("#0000FF");
		expect(res.metadata?.chromaKey).toBe("#0000FF");
	});

	it("does not save an opaque result for a transparent request", async () => {
		responseBytes = await sharp({
			create: {
				width: 2,
				height: 2,
				channels: 3,
				background: { r: 128, g: 128, b: 128 },
			},
		})
			.png()
			.toBuffer();
		const { createCodexImageTools } = await import("../tools/codex-image.js");
		const tool = createCodexImageTools()[0];
		const outputPath = join(WORKSPACE, TEST_SUB, "opaque.png");
		const res = await tool.handler({
			prompt: "Logo",
			background: "transparent",
			path: `${TEST_SUB}/opaque.png`,
		});

		expect(res.success).toBe(false);
		expect(res.error).toMatch(/image is opaque/i);
		expect(existsSync(outputPath)).toBe(false);
	});
});
