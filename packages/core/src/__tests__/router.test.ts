import { describe, expect, it } from "vitest";
import { BaseLLMProvider } from "../ai/providers/base.js";
import {
	LLMRouter,
	computeBackoffDelay,
	isRetryableProviderError,
	isSchemaValidationError,
	isZaiOverloadError,
	providerModelSupportsNativeVision,
	sanitizeToolResultMedia,
} from "../ai/router.js";
import type {
	LLMChunk,
	LLMRequest,
	LLMResponse,
	ProviderConfig,
} from "../ai/types.js";

class CapturingProvider extends BaseLLMProvider {
	requests: LLMRequest[] = [];
	fail = false;

	constructor() {
		super({} as ProviderConfig);
	}

	async chat(request: LLMRequest): Promise<LLMResponse> {
		this.requests.push(request);
		if (this.fail) throw new Error("HTTP 400 primary failed");
		return {
			content: "ok",
			model: request.model,
			usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
			finishReason: "stop",
		};
	}

	async *chatStream(request: LLMRequest): AsyncIterable<LLMChunk> {
		this.requests.push(request);
		if (this.fail) throw new Error("HTTP 400 primary failed");
		yield { content: "ok", finishReason: "stop" };
	}

	async isAvailable(): Promise<boolean> {
		return true;
	}
}

describe("sanitizeToolResultMedia", () => {
	const imageDataUrl = `data:image/png;base64,${"A".repeat(2_000_000)}`;
	const request: LLMRequest = {
		model: "fake/model",
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "Inspect this user attachment" },
					{ type: "image_url", image_url: { url: imageDataUrl } },
				],
			},
			{
				role: "assistant",
				content: "",
				toolCalls: [
					{
						id: "call_123",
						type: "function",
						function: { name: "generate_image", arguments: "{}" },
					},
				],
			},
			{
				role: "tool",
				toolCallId: "call_123",
				content: [
					{
						type: "text",
						text: "Generated: /api/media/file/image.png",
					},
					{ type: "image_url", image_url: { url: imageDataUrl } },
				],
			},
		],
	};

	it("removes generated media bytes while preserving text, ids, and user images", () => {
		const sanitized = sanitizeToolResultMedia(request);

		expect(sanitized.messages[0]).toBe(request.messages[0]);
		expect(sanitized.messages[1]).toBe(request.messages[1]);
		expect(sanitized.messages[2]).toMatchObject({
			role: "tool",
			toolCallId: "call_123",
			content: "Generated: /api/media/file/image.png",
		});
		expect(JSON.stringify(sanitized.messages[0])).toContain(imageDataUrl);
		expect(JSON.stringify(sanitized.messages[2])).not.toContain("base64");
		expect(JSON.stringify(sanitized.messages[2]).length).toBeLessThan(200);
	});

	it("also removes data URIs embedded directly in tool-result text", () => {
		const sanitized = sanitizeToolResultMedia({
			model: "fake/model",
			messages: [
				{
					role: "tool",
					toolCallId: "call_1",
					content: `result=${imageDataUrl}`,
				},
			],
		});

		expect(String(sanitized.messages[0].content)).toContain(
			"Generated media bytes omitted",
		);
		expect(String(sanitized.messages[0].content)).not.toContain("base64");
	});

	it("removes raw base64 and bounds unknown oversized tool results", () => {
		const sanitized = sanitizeToolResultMedia({
			model: "fake/model",
			messages: [
				{
					role: "tool",
					toolCallId: "call_1",
					content: JSON.stringify({ image_base64: "B".repeat(2_000_000) }),
				},
				{
					role: "tool",
					toolCallId: "call_2",
					content: `%64%61%74%61${"x".repeat(2_000_000)}`,
				},
			],
		});

		for (const message of sanitized.messages) {
			expect(String(message.content).length).toBeLessThan(101_000);
		}
		expect(String(sanitized.messages[0].content)).not.toContain(
			"B".repeat(100_000),
		);
	});

	it("enforces an aggregate bound across many tool results", () => {
		const sanitized = sanitizeToolResultMedia({
			model: "fake/model",
			messages: Array.from({ length: 5 }, (_, index) => ({
				role: "tool" as const,
				toolCallId: `call_${index}`,
				content: `%encoded-${index}-${"!".repeat(150_000)}`,
			})),
		});

		const totalChars = sanitized.messages.reduce(
			(total, message) => total + String(message.content).length,
			0,
		);
		expect(totalChars).toBeLessThan(201_000);
		expect(String(sanitized.messages.at(-1)?.content)).toContain(
			"aggregate provider safety limit reached",
		);
	});

	it("preserves non-embedded media URLs returned by tools", () => {
		const sanitized = sanitizeToolResultMedia({
			model: "fake/model",
			messages: [
				{
					role: "tool",
					toolCallId: "call_1",
					content: [
						{
							type: "image_url",
							image_url: { url: "https://cdn.example.com/image.png" },
						},
					],
				},
			],
		});

		expect(sanitized.messages[0].content).toBe(
			"Media: https://cdn.example.com/image.png",
		);
	});

	it("applies the guard before both provider chat paths", async () => {
		const provider = new CapturingProvider();
		const router = new LLMRouter({
			default: "fake",
			providers: {},
		});
		router.addProvider("fake", provider);

		await router.chat(request);
		for await (const _chunk of router.chatStream(request)) {
			// Consume the stream so the provider receives the request.
		}

		expect(provider.requests).toHaveLength(2);
		for (const received of provider.requests) {
			const body = JSON.stringify(received.messages[2]);
			expect(body).toContain("/api/media/file/image.png");
			expect(body).not.toContain("base64");
			expect(received.messages[2].toolCallId).toBe("call_123");
		}
	});

	it("passes the same sanitized request to the fallback provider", async () => {
		const primary = new CapturingProvider();
		primary.fail = true;
		const fallback = new CapturingProvider();
		const router = new LLMRouter({
			default: "primary",
			fallback: "fallback/model",
			providers: {},
		});
		router.addProvider("primary", primary);
		router.addProvider("fallback", fallback);

		await router.chat({ ...request, model: "primary/model" });

		expect(primary.requests).toHaveLength(1);
		expect(fallback.requests).toHaveLength(1);
		for (const received of [primary.requests[0], fallback.requests[0]]) {
			const body = JSON.stringify(received.messages[2]);
			expect(body).toContain("/api/media/file/image.png");
			expect(body).not.toContain("base64");
		}
	});

	it("passes the same sanitized request to the streaming fallback", async () => {
		const primary = new CapturingProvider();
		primary.fail = true;
		const fallback = new CapturingProvider();
		const router = new LLMRouter({
			default: "primary",
			fallback: "fallback/model",
			providers: {},
		});
		router.addProvider("primary", primary);
		router.addProvider("fallback", fallback);

		for await (const _chunk of router.chatStream({
			...request,
			model: "primary/model",
		})) {
			// Consume the fallback stream.
		}

		expect(primary.requests).toHaveLength(1);
		expect(fallback.requests).toHaveLength(1);
		const body = JSON.stringify(fallback.requests[0].messages[2]);
		expect(body).toContain("/api/media/file/image.png");
		expect(body).not.toContain("base64");
	});
});

describe("providerModelSupportsNativeVision", () => {
	it("routes known text-only and unsupported adapters through external vision", () => {
		expect(providerModelSupportsNativeVision("zhipu", "glm-5.2", true)).toBe(
			false,
		);
		expect(
			providerModelSupportsNativeVision("mistral", "codestral-25-08", true),
		).toBe(false);
		expect(providerModelSupportsNativeVision("local", "llama3.1", true)).toBe(
			false,
		);
		expect(
			providerModelSupportsNativeVision(
				"cohere",
				"command-a-vision-07-2025",
				true,
			),
		).toBe(false);
	});

	it("uses native vision only for recognized multimodal OpenRouter models", () => {
		expect(
			providerModelSupportsNativeVision(
				"openrouter",
				"google/gemini-2.5-pro",
				true,
			),
		).toBe(true);
		expect(
			providerModelSupportsNativeVision(
				"openrouter",
				"meta-llama/llama-3.3-70b-instruct",
				true,
			),
		).toBe(false);
	});
});

describe("isRetryableProviderError", () => {
	it("retries network/transient errors", () => {
		expect(isRetryableProviderError(new Error("fetch failed"))).toBe(true);
		expect(isRetryableProviderError(new Error("ETIMEDOUT"))).toBe(true);
		expect(isRetryableProviderError(new Error("socket hang up"))).toBe(true);
	});

	it("retries provider rate-limit (HTTP 429 / 503) errors so parallel workers back off instead of dying", () => {
		expect(
			isRetryableProviderError(
				new Error('Z.ai API error (coding-plan): 429 {"error":{"code":"429"}}'),
			),
		).toBe(true);
		expect(
			isRetryableProviderError(new Error("HTTP 503 Service Unavailable")),
		).toBe(true);
		expect(isRetryableProviderError(new Error("rate limit exceeded"))).toBe(
			true,
		);
		expect(isRetryableProviderError(new Error("Too Many Requests"))).toBe(true);
	});

	it("does not retry non-transient errors", () => {
		expect(isRetryableProviderError(new Error("HTTP 400 Bad Request"))).toBe(
			false,
		);
		expect(isRetryableProviderError(new Error("Invalid API key"))).toBe(false);
		expect(isRetryableProviderError(null)).toBe(false);
		expect(isRetryableProviderError(undefined)).toBe(false);
	});
});

describe("isZaiOverloadError", () => {
	it("detects Z.ai coding-plan 429 with body code 1305 (overload)", () => {
		expect(
			isZaiOverloadError(
				new Error(
					'Z.ai API error (coding-plan): 429 {"error":{"code":1305,"message":"The service may be temporarily overloaded"}}',
				),
			),
		).toBe(true);
	});

	it("does not classify a generic 429 (quota) as overload", () => {
		expect(
			isZaiOverloadError(
				new Error('Z.ai API error (coding-plan): 429 {"error":{"code":"429"}}'),
			),
		).toBe(false);
		expect(isZaiOverloadError(new Error("HTTP 503 Service Unavailable"))).toBe(
			false,
		);
	});
});

describe("isSchemaValidationError", () => {
	it("detects payload/schema rejections", () => {
		expect(
			isSchemaValidationError(
				new Error("API error (openrouter): 400 Extra inputs are not permitted"),
			),
		).toBe(true);
		expect(isSchemaValidationError(new Error("invalid schema"))).toBe(true);
		expect(
			isSchemaValidationError(new Error("HTTP 400 Bad Request: bad prompt")),
		).toBe(false);
	});
});

describe("computeBackoffDelay", () => {
	const base = 1500;

	it("fails fast (-1) on schema-validation errors", () => {
		expect(
			computeBackoffDelay(
				new Error("Extra inputs are not permitted, field: foo"),
				0,
				base,
			),
		).toBe(-1);
	});

	it("uses the escalating schedule for z.ai overload (30/60/90/120s + jitter)", () => {
		const d0 = computeBackoffDelay(
			new Error('Z.ai API error (coding-plan): 429 {"error":{"code":1305}}'),
			0,
			base,
		);
		const d1 = computeBackoffDelay(
			new Error(
				'Z.ai API error (coding-global): 429 {"error":{"code":1305,"message":"temporarily overloaded"}}',
			),
			1,
			base,
		);
		expect(d0).toBeGreaterThanOrEqual(30_000);
		expect(d0).toBeLessThan(35_000);
		expect(d1).toBeGreaterThanOrEqual(60_000);
		expect(d1).toBeLessThan(65_000);
	});

	it("applies decorrelated full jitter in [exp/2, exp] for normal transient errors", () => {
		for (let i = 0; i < 500; i++) {
			const delay = computeBackoffDelay(new Error("fetch failed"), 1, base);
			// attempt 1 → exp = min(1500*2, 30000) = 3000; jitter in [1500, 3000]
			expect(delay).toBeGreaterThanOrEqual(1500);
			expect(delay).toBeLessThanOrEqual(3000);
		}
	});

	it("caps exponential growth at 30s", () => {
		for (let i = 0; i < 200; i++) {
			const delay = computeBackoffDelay(new Error("ETIMEDOUT"), 8, base);
			expect(delay).toBeGreaterThanOrEqual(15_000); // cap/2
			expect(delay).toBeLessThanOrEqual(30_000); // cap
		}
	});
});
