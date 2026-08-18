import { describe, expect, it, vi } from "vitest";
import type { MediaUsageSink } from "../ai/usage-store.js";
import { getDefaults } from "../config/defaults.js";
import { getMultimediaCatalog } from "../multimedia/catalog.js";
import { createImageGenerationTools } from "../tools/image-generation.js";
import {
	ToolRegistry,
	type ToolContext,
	type ToolDefinition,
	type ToolResult,
} from "../tools/registry.js";

function implementation(name: string, result: ToolResult): ToolDefinition {
	return {
		name,
		description: name,
		parameters: {},
		handler: vi.fn(async () => result),
	};
}

function setup(usage?: MediaUsageSink) {
	const config = getDefaults();
	config.ai.providers.openai.apiKey = "openai-test-key";
	config.ai.providers.gemini.apiKey = "gemini-test-key";
	config.multimedia!.image.primary = {
		provider: "openai",
		model: "gpt-image-2",
		transport: "openai-images",
	};
	config.multimedia!.image.fallbacks = [
		{
			provider: "gemini",
			model: "gemini-3.1-flash-image",
			transport: "generate-content",
		},
	];
	const openaiGenerate = implementation("codex_generate_image", {
		success: true,
		output: "Image 1: /api/media/file/openai.png",
	});
	const openaiEdit = implementation("codex_edit_image", {
		success: true,
		output: "Edited image 1: /api/media/file/edit.png",
	});
	const google = implementation("nano-banana-generate", {
		success: true,
		output: "Image 1: /api/media/file/google.png",
	});
	const tools = createImageGenerationTools({
		getConfig: () => config,
		implementations: { openaiGenerate, openaiEdit, google },
		usage,
	});
	const tool = tools[0];
	if (!tool) throw new Error("generate_image was not created");
	return { config, tool, tools, openaiGenerate, openaiEdit, google };
}

describe("generate_image router", () => {
	it("keeps other routes available when Vertex credentials are malformed", () => {
		const config = getDefaults();
		config.ai.providers.openai.apiKey = "openai-test-key";
		config.ai.providers.vertex.credentialsJson = "{malformed";

		expect(() => getMultimediaCatalog(config)).not.toThrow();
		expect(
			getMultimediaCatalog(config).routes.find(
				(route) => route.provider === "openai" && route.mediaType === "image",
			)?.available,
		).toBe(true);
	});

	it("advertises only the canonical image tool", () => {
		const { tools } = setup();
		const registry = new ToolRegistry();
		for (const tool of tools) registry.register(tool);

		expect(registry.toLLMTools().map((entry) => entry.function.name)).toEqual([
			"generate_image",
		]);
		expect(registry.get("codex_generate_image")).toBeDefined();
		expect(registry.get("nano-banana-generate")).toBeDefined();
	});

	it("routes legacy edit aliases through the canonical configuration", async () => {
		const { tools, openaiEdit } = setup();
		const alias = tools.find((tool) => tool.name === "codex_edit_image");
		if (!alias) throw new Error("codex_edit_image alias was not created");

		await alias.handler(
			{
				prompt: "Replace the sky",
				image: "/api/media/file/base.png",
				images: ["/api/media/file/style.png"],
			},
			{} as ToolContext,
		);

		expect(openaiEdit.handler).toHaveBeenCalledWith(
			expect.objectContaining({
				image: "/api/media/file/base.png",
				images: ["/api/media/file/style.png"],
			}),
			expect.anything(),
		);
	});

	it("disables compatibility aliases with the canonical tool policy", async () => {
		const { config, tools, openaiGenerate } = setup();
		config.tools.disabled.push("generate_image");
		const alias = tools.find((tool) => tool.name === "codex_generate_image");
		if (!alias) throw new Error("codex_generate_image alias was not created");

		const result = await alias.handler(
			{ prompt: "Blocked alias request" },
			{} as ToolContext,
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain("disabled by the tools policy");
		expect(openaiGenerate.handler).not.toHaveBeenCalled();
	});

	it("uses the configured primary route and model", async () => {
		const { tool, openaiGenerate, google } = setup();

		const result = await tool.handler(
			{ prompt: "A precise icon", aspect_ratio: "1:1" },
			{} as ToolContext,
		);

		expect(result.success).toBe(true);
		expect(openaiGenerate.handler).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "gpt-image-2",
				size: "1024x1024",
			}),
			expect.anything(),
		);
		expect(google.handler).not.toHaveBeenCalled();
		expect(result.metadata?.route).toMatchObject({ provider: "openai" });
	});

	it("records accepted image usage without inventing a cost", async () => {
		const usage = { recordMedia: vi.fn(async () => undefined) };
		const { tool, openaiGenerate } = setup(usage);
		vi.mocked(openaiGenerate.handler).mockResolvedValue({
			success: true,
			output: "Image 1: /api/media/file/openai.png",
			metadata: {
				submissionState: "accepted",
				urls: ["/api/media/file/openai.png"],
			},
		});

		await tool.handler(
			{ prompt: "Usage image", n: 1 },
			{ agent: { agentId: "agent-1", idempotencyKey: "request-1" } } as ToolContext,
		);

		expect(usage.recordMedia).toHaveBeenCalledWith({
			id: "image:request-1:route:1",
			mediaType: "image",
			provider: "openai",
			model: "gpt-image-2",
			transport: "openai-images",
			status: "succeeded",
			toolName: "generate_image",
			agentId: "agent-1",
			conversationId: undefined,
			requestedOutputs: 1,
			outputCount: 1,
			estimatedCost: undefined,
			costSource: undefined,
		});
	});

	it("does not dispatch a provider request when the pending usage receipt cannot persist", async () => {
		const usage: MediaUsageSink = {
			recordMedia: vi.fn(async () => {
				throw new Error("usage database unavailable");
			}),
		};
		const { tool, openaiGenerate } = setup(usage);

		await expect(
			tool.handler({ prompt: "Fail closed" }, {} as ToolContext),
		).rejects.toThrow("usage database unavailable");
		expect(openaiGenerate.handler).not.toHaveBeenCalled();
	});

	it("maps reference images to the OpenAI edit implementation", async () => {
		const { tool, openaiEdit, openaiGenerate } = setup();

		await tool.handler(
			{
				prompt: "Replace the sky",
				reference_images: ["/api/media/file/base.png", "/api/media/file/style.png"],
			},
			{} as ToolContext,
		);

		expect(openaiEdit.handler).toHaveBeenCalledWith(
			expect.objectContaining({
				image: "/api/media/file/base.png",
				images: ["/api/media/file/style.png"],
			}),
			expect.anything(),
		);
		expect(openaiGenerate.handler).not.toHaveBeenCalled();
	});

	it("rejects explicit generate actions that would discard references", async () => {
		const { tool, openaiEdit, openaiGenerate } = setup();

		const result = await tool.handler(
			{
				action: "generate",
				prompt: "Use this composition",
				reference_images: ["/api/media/file/base.png"],
			},
			{} as ToolContext,
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain("require action edit");
		expect(openaiEdit.handler).not.toHaveBeenCalled();
		expect(openaiGenerate.handler).not.toHaveBeenCalled();
	});

	it("falls back after a definitive rejection", async () => {
		const usage = { recordMedia: vi.fn(async () => undefined) };
		const { tool, openaiGenerate, google } = setup(usage);
		vi.mocked(openaiGenerate.handler).mockResolvedValue({
			success: false,
			output: "",
			error: "OpenAI image API error (429): quota exhausted",
			metadata: { submissionState: "rejected" },
		});

		const result = await tool.handler(
			{ prompt: "Fallback poster" },
			{} as ToolContext,
		);

		expect(result.success).toBe(true);
		expect(google.handler).toHaveBeenCalledOnce();
		expect(result.metadata).toMatchObject({
			attemptedRoutes: 2,
			route: { provider: "gemini" },
			usageReceipts: [
				expect.objectContaining({ provider: "openai", status: "failed" }),
				expect.objectContaining({ provider: "gemini", status: "succeeded" }),
			],
		});
		expect(usage.recordMedia).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ provider: "openai", status: "failed" }),
		);
		expect(usage.recordMedia).toHaveBeenNthCalledWith(
			4,
			expect.objectContaining({ provider: "gemini", status: "succeeded" }),
		);
	});

	it("does not fallback after an ambiguous provider failure", async () => {
		const usage = { recordMedia: vi.fn(async () => undefined) };
		const { tool, openaiGenerate, google } = setup(usage);
		vi.mocked(openaiGenerate.handler).mockResolvedValue({
			success: false,
			output: "",
			error: "OpenAI image API error (500): response lost",
			metadata: { submissionState: "unknown" },
		});

		const result = await tool.handler(
			{ prompt: "Do not duplicate" },
			{} as ToolContext,
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain("acceptance state may be ambiguous");
		expect(result.metadata?.usageReceipt).toMatchObject({
			mediaType: "image",
			provider: "openai",
			status: "unknown",
			outputCount: 0,
		});
		expect(google.handler).not.toHaveBeenCalled();
	});

	it("skips unavailable routes without invoking them", async () => {
		const { config, tool, openaiGenerate, google } = setup();
		config.ai.providers.openai.apiKey = "";

		const result = await tool.handler(
			{ prompt: "Use configured credentials" },
			{} as ToolContext,
		);

		expect(result.success).toBe(true);
		expect(openaiGenerate.handler).not.toHaveBeenCalled();
		expect(google.handler).toHaveBeenCalledOnce();
	});

	it("skips disabled internal implementations", async () => {
		const { config, tool, openaiGenerate, google } = setup();
		config.tools.disabled.push("codex_generate_image");

		const result = await tool.handler(
			{ prompt: "Use an enabled route" },
			{} as ToolContext,
		);

		expect(result.success).toBe(true);
		expect(openaiGenerate.handler).not.toHaveBeenCalled();
		expect(google.handler).toHaveBeenCalledOnce();
	});

	it("skips routes that cannot preserve explicit provider controls", async () => {
		const { tool, openaiGenerate, google } = setup();

		const result = await tool.handler(
			{ prompt: "Grounded illustration", enable_grounding: true },
			{} as ToolContext,
		);

		expect(result.success).toBe(true);
		expect(openaiGenerate.handler).not.toHaveBeenCalled();
		expect(google.handler).toHaveBeenCalledWith(
			expect.objectContaining({ enable_grounding: true }),
			expect.anything(),
		);
	});

	it("enforces the multimedia image enable switch", async () => {
		const { config, tool, openaiGenerate, google } = setup();
		config.multimedia!.image.enabled = false;

		const result = await tool.handler(
			{ prompt: "Disabled request" },
			{} as ToolContext,
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain("disabled");
		expect(openaiGenerate.handler).not.toHaveBeenCalled();
		expect(google.handler).not.toHaveBeenCalled();
	});

	it("downgrades an unsupported quality to auto on the Google fallback instead of aborting", async () => {
		const { config, tool, google } = setup();
		// Force the OpenAI primary to be unavailable so the request falls back
		// to the Google route.
		config.ai.providers.openai.apiKey = "";

		const result = await tool.handler(
			{ prompt: "Poster", quality: "high" },
			{} as ToolContext,
		);

		expect(result.success).toBe(true);
		expect(google.handler).toHaveBeenCalledOnce();
		// The OpenAI-only quality knob never reaches the Google handler.
		expect(google.handler).toHaveBeenCalledWith(
			expect.not.objectContaining({ quality: "high" }),
			expect.anything(),
		);
		// ...and the caller is told the quality was ignored rather than blocked.
		expect(result.metadata?.warnings).toEqual(
			expect.arrayContaining([expect.stringContaining("quality='high'")]),
		);
	});

	it("surfaces the primary provider error instead of a trivial fallback error", async () => {
		const { config, tool, openaiGenerate } = setup();
		// Primary Codex/OpenAI route returns a definitive 403 (provider-error).
		vi.mocked(openaiGenerate.handler).mockResolvedValue({
			success: false,
			output: "",
			error: 'OpenAI image API error (403): {"detail":"Forbidden"}',
			metadata: { submissionState: "rejected" },
		});
		// Make the Google fallback unavailable so its own error would otherwise
		// become the final surfaced message.
		config.ai.providers.gemini.apiKey = "";

		const result = await tool.handler(
			{ prompt: "Wedding hero", quality: "high" },
			{} as ToolContext,
		);

		expect(result.success).toBe(false);
		// The real provider failure (the 403) is surfaced...
		expect(result.error).toContain("(403)");
		// ...NOT the secondary "credentials not configured" fallback error.
		expect(result.error).not.toContain("Provider credentials are not configured");
	});
});
