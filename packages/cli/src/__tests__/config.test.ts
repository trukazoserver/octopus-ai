import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	load: vi.fn(),
	save: vi.fn(),
	validate: vi.fn(),
}));

vi.mock("@octopus-ai/core", () => ({
	ConfigLoader: vi.fn().mockImplementation(() => ({
		load: mocks.load,
		save: mocks.save,
	})),
	ConfigValidator: vi.fn().mockImplementation(() => ({
		validate: mocks.validate,
	})),
}));

const baseConfig = () => ({
	memory: {
		embeddings: {
			enabled: false,
			provider: "auto",
			apiType: "openai",
			model: "",
			baseUrl: "",
			apiKey: "",
			apiKeyEnv: "",
			task: "document",
			dimensions: 1024,
			maxBatchSize: 32,
			maxTextLength: 8000,
			cacheSize: 500,
			failureRetryMs: 60000,
		},
	},
});

describe("config command", () => {
	beforeEach(() => {
		vi.resetModules();
		mocks.load.mockReset();
		mocks.save.mockReset();
		mocks.validate.mockReset();
		mocks.load.mockReturnValue(baseConfig());
		mocks.validate.mockReturnValue({ valid: true, errors: [] });
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("configures OpenAI embeddings with the default env var", async () => {
		const { createConfigCommand } = await import("../commands/config.js");

		await createConfigCommand().parseAsync(["embeddings", "openai"], {
			from: "user",
		});

		expect(mocks.save).toHaveBeenCalledTimes(1);
		expect(mocks.save.mock.calls[0][0].memory.embeddings).toEqual(
			expect.objectContaining({
				enabled: true,
				provider: "openai",
				apiType: "openai",
				authMode: "api-key",
				model: "text-embedding-3-small",
				dimensions: 1536,
				apiKeyEnv: "OPENAI_API_KEY",
			}),
		);
	});

	it("configures Google Vertex embeddings credentials", async () => {
		const { createConfigCommand } = await import("../commands/config.js");

		await createConfigCommand().parseAsync(
			[
				"embeddings",
				"google",
				"--auth-mode",
				"vertex",
				"--project-id",
				"octopus-project",
				"--credentials-file",
				"C:/creds/service-account.json",
			],
			{ from: "user" },
		);

		expect(mocks.save).toHaveBeenCalledTimes(1);
		expect(mocks.save.mock.calls[0][0].memory.embeddings).toEqual(
			expect.objectContaining({
				enabled: true,
				provider: "google",
				apiType: "google",
				authMode: "vertex",
				model: "gemini-embedding-2",
				dimensions: 768,
				projectId: "octopus-project",
				credentialsFile: "C:/creds/service-account.json",
			}),
		);
	});
});
