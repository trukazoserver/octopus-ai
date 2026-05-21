import { afterEach, describe, expect, it } from "vitest";
import { resolveProviderConfig } from "../ai/router.js";

const envKeys = [
	"OPENAI_API_KEY",
	"OPENAI_BASE_URL",
	"CODEX_API_KEY",
	"CODEX_ACCESS_TOKEN",
	"OPENROUTER_BASE_URL",
	"ZAI_CODING_API_KEY",
	"ZHIPU_CODING_API_KEY",
	"ZAI_API_KEY",
	"ZHIPU_API_KEY",
	"GOOGLE_AUTH_MODE",
	"GOOGLE_BASE_URL",
	"GEMINI_BASE_URL",
	"GOOGLE_VERTEX_BASE_URL",
	"VERTEXAI",
];

const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
	for (const key of envKeys) {
		const original = originalEnv.get(key);
		if (original === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = original;
		}
	}
});

describe("resolveProviderConfig", () => {
	it("lets env base URLs override materialized defaults", () => {
		process.env.OPENROUTER_BASE_URL = "https://router.example/v1";

		const config = resolveProviderConfig("openrouter", {
			apiKey: "key",
			baseUrl: "https://openrouter.ai/api/v1",
		});

		expect(config.baseUrl).toBe("https://router.example/v1");
	});

	it("preserves explicit base URLs over env overrides", () => {
		process.env.OPENROUTER_BASE_URL = "https://router.example/v1";

		const config = resolveProviderConfig("openrouter", {
			apiKey: "key",
			baseUrl: "https://custom.example/v1",
		});

		expect(config.baseUrl).toBe("https://custom.example/v1");
	});

	it("infers Z.ai global API mode from global env key", () => {
		process.env.ZAI_API_KEY = "global-key";

		const config = resolveProviderConfig("zhipu", {
			apiKey: "",
			mode: "coding-plan",
		});

		expect(config.mode).toBe("global");
		expect(config.apiKey).toBe("global-key");
	});

	it("does not use coding keys for explicit normal Z.ai modes", () => {
		process.env.ZHIPU_CODING_API_KEY = "coding-key";

		const config = resolveProviderConfig("zhipu", {
			apiKey: "",
			mode: "api",
		});

		expect(config.mode).toBe("api");
		expect(config.apiKey).toBeUndefined();
	});

	it("keeps configured Z.ai key with configured coding mode", () => {
		process.env.ZAI_API_KEY = "global-key";

		const config = resolveProviderConfig("zhipu", {
			apiKey: "configured-key",
			mode: "coding-plan",
		});

		expect(config.mode).toBe("coding-plan");
		expect(config.apiKey).toBe("configured-key");
	});

	it("does not treat CODEX_ACCESS_TOKEN as an OpenAI API key", () => {
		process.env.CODEX_ACCESS_TOKEN = "codex-token";

		const config = resolveProviderConfig("openai", {
			apiKey: "",
			authMode: "codex",
			baseUrl: "https://api.openai.com/v1",
		});

		expect(config.apiKey).toBeUndefined();
		expect(config.accessToken).toBe("codex-token");
	});

	it("uses Vertex-specific base URL env only in Google Vertex mode", () => {
		process.env.VERTEXAI = "true";
		process.env.GEMINI_BASE_URL = "https://gemini.example/v1";
		process.env.GOOGLE_VERTEX_BASE_URL = "https://vertex.example/v1";

		const config = resolveProviderConfig("google", {
			apiKey: "",
			authMode: "api-key",
		});

		expect(config.authMode).toBe("vertex");
		expect(config.baseUrl).toBe("https://vertex.example/v1");
	});
});
