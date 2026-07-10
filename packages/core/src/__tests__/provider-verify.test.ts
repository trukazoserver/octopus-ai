import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../ai/providers/anthropic.js";
import { verifyModelsGet } from "../ai/providers/base.js";
import { CodexProvider } from "../ai/providers/codex.js";
import { CohereProvider } from "../ai/providers/cohere.js";
import { GoogleProvider } from "../ai/providers/google.js";
import { OpenAICompatibleProvider } from "../ai/providers/openai-compatible.js";
import { ZhipuProvider } from "../ai/providers/zhipu.js";
import type { ProviderConfig } from "../ai/types.js";
import { clearProviderCredentials } from "../transport/server.js";

/** Build a minimal ProviderConfig, overriding the fields a provider needs. */
function cfg(overrides: Record<string, unknown> = {}): ProviderConfig {
	return { apiKey: "k", ...overrides } as unknown as ProviderConfig;
}

/** Mock fetch returning the given status (and optional body text). */
function mockFetch(status: number, body = ""): ReturnType<typeof vi.fn> {
	return vi.fn().mockResolvedValue({
		ok: status >= 200 && status < 300,
		status,
		text: () => Promise.resolve(body),
	});
}

describe("verifyModelsGet (helper)", () => {
	it("returns ok:true on 200", async () => {
		vi.stubGlobal("fetch", mockFetch(200));
		const r = await verifyModelsGet("https://x/models", {});
		expect(r).toEqual({ ok: true });
	});
	it("returns 'Credenciales inválidas' on 401/403", async () => {
		vi.stubGlobal("fetch", mockFetch(401));
		const r = await verifyModelsGet("https://x/models", {});
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/inválidas/i);
	});
	it("returns error with status text on other statuses", async () => {
		vi.stubGlobal("fetch", mockFetch(500, "boom"));
		const r = await verifyModelsGet("https://x/models", {});
		expect(r.ok).toBe(false);
		expect(r.error).toContain("500");
	});
	it("treats 400 mentioning 'API key' as invalid credentials", async () => {
		vi.stubGlobal(
			"fetch",
			mockFetch(400, '{"error":{"message":"Please pass a valid API key"}}'),
		);
		const r = await verifyModelsGet("https://x/models", {});
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/inválidas/i);
	});
	it("returns network error message on throw", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
		const r = await verifyModelsGet("https://x/models", {});
		expect(r.ok).toBe(false);
		expect(r.error).toBe("ECONNRESET");
	});
});

describe("verifyKey() per provider", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("OpenAICompatible: ok on 200, error on 401", async () => {
		vi.stubGlobal("fetch", mockFetch(200));
		const p = new OpenAICompatibleProvider({
			...cfg({ apiKey: "k" }),
			baseUrl: "https://api.deepseek.com",
			prefix: "deepseek",
		});
		expect(await p.verifyKey()).toEqual({ ok: true });

		vi.stubGlobal("fetch", mockFetch(401));
		const p2 = new OpenAICompatibleProvider({
			...cfg({ apiKey: "bad" }),
			baseUrl: "https://api.x.ai/v1",
			prefix: "xai",
		});
		const r = await p2.verifyKey();
		expect(r.ok).toBe(false);
	});

	it("Anthropic: sends x-api-key + anthropic-version, hits {baseUrl}/models", async () => {
		const fetchMock = mockFetch(200);
		vi.stubGlobal("fetch", fetchMock);
		await new AnthropicProvider(cfg({ apiKey: "anthropic-key" })).verifyKey();
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.anthropic.com/v1/models");
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers["x-api-key"]).toBe("anthropic-key");
		expect(headers["anthropic-version"]).toBe("2023-06-01");
	});

	it("Google api-key: hits generativelanguage /v1beta/openai/models", async () => {
		const fetchMock = mockFetch(200);
		vi.stubGlobal("fetch", fetchMock);
		await new GoogleProvider(cfg({ apiKey: "g-key" })).verifyKey();
		const [url] = fetchMock.mock.calls[0];
		expect(url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/openai/models",
		);
	});

	it("Google vertex mode: no network — delegates to isAvailable()", async () => {
		const fetchMock = mockFetch(200);
		vi.stubGlobal("fetch", fetchMock);
		const p = new GoogleProvider(
			cfg({ authMode: "vertex", credentialsFile: "", projectId: "" }),
		);
		const r = await p.verifyKey();
		expect(r.ok).toBe(false); // no projectId → not available
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("Zhipu: hits {baseUrl}/models with Bearer", async () => {
		const fetchMock = mockFetch(200);
		vi.stubGlobal("fetch", fetchMock);
		await new ZhipuProvider(cfg({ apiKey: "z-key" })).verifyKey();
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url).endsWith("/models")).toBe(true);
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer z-key");
	});

	it("Cohere: hits {baseUrl}/models with Bearer", async () => {
		const fetchMock = mockFetch(200);
		vi.stubGlobal("fetch", fetchMock);
		await new CohereProvider(cfg({ apiKey: "c-key" })).verifyKey();
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url).endsWith("/models")).toBe(true);
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer c-key");
	});

	it("Codex: hits {baseUrl}/models with originator", async () => {
		const fetchMock = mockFetch(200);
		vi.stubGlobal("fetch", fetchMock);
		await new CodexProvider(cfg({ accessToken: "codex-token" })).verifyKey();
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toMatch(/\/models\?client_version=/);
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer codex-token");
		expect(headers.originator).toBeTruthy();
	});
});

describe("clearProviderCredentials", () => {
	it("clears common credential fields and leaves preferences", () => {
		const prov = {
			apiKey: "k",
			apiKeyEnv: "KEY",
			accessToken: "t",
			accessTokenEnv: "TOK",
			oauthAccessToken: "oa",
			oauthRefreshToken: "or",
			oauthClientId: "cid",
			oauthClientSecret: "csec",
			oauthExpiresAt: 123,
			browserCookies: "ck",
			browserUserAgent: "ua",
			credentialsJson: "{}",
			accountId: "acc",
			baseUrl: "https://x",
			models: ["m"],
			authMode: "oauth",
		};
		clearProviderCredentials(prov, "anthropic");
		for (const f of [
			"apiKey",
			"apiKeyEnv",
			"accessToken",
			"accessTokenEnv",
			"oauthAccessToken",
			"oauthRefreshToken",
			"oauthClientId",
			"oauthClientSecret",
			"browserCookies",
			"browserUserAgent",
			"credentialsJson",
			"accountId",
		]) {
			expect(prov[f]).toBe("");
		}
		expect(prov.oauthExpiresAt).toBeUndefined();
		expect(prov.authMode).toBeUndefined(); // non-openai → cleared
		// preferences preserved
		expect(prov.baseUrl).toBe("https://x");
		expect(prov.models).toEqual(["m"]);
	});

	it("also clears credentialsFile + projectId for vertex, keeps location", () => {
		const prov = {
			credentialsFile: "/sa.json",
			projectId: "proj-1",
			location: "us-central1",
			apiKey: "k",
		};
		clearProviderCredentials(prov, "vertex");
		expect(prov.credentialsFile).toBe("");
		expect(prov.projectId).toBe("");
		expect(prov.location).toBe("us-central1");
	});

	it("openai keeps authMode forced to api-key", () => {
		const prov = { apiKey: "k", authMode: "codex", accessToken: "t" };
		clearProviderCredentials(prov, "openai");
		expect(prov.authMode).toBe("api-key");
		expect(prov.accessToken).toBe("");
	});
});
