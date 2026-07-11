import { describe, expect, it } from "vitest";
import {
	getZaiMCPConfigs,
	resolveZaiMCPAuth,
} from "../plugins/mcp/zai-servers.js";

describe("getZaiMCPConfigs", () => {
	it("builds configs for all supported Z.ai MCP servers", () => {
		const configs = getZaiMCPConfigs("test-api-key");

		expect(Object.keys(configs)).toEqual([
			"zai-web-reader",
			"zai-web-search",
			"zai-zread",
			"zai-vision",
		]);

		expect(configs["zai-web-reader"]).toEqual({
			type: "streamable-http",
			url: "https://api.z.ai/api/mcp/web_reader/mcp",
			headers: {
				Authorization: "Bearer test-api-key",
			},
			command: "streamable-http",
			args: [],
			env: {},
		});

		expect(configs["zai-web-search"]?.headers?.Authorization).toBe(
			"Bearer test-api-key",
		);
		expect(configs["zai-zread"]?.headers?.Authorization).toBe(
			"Bearer test-api-key",
		);
		expect(configs["zai-vision"]).toEqual({
			command: "npx",
			args: ["-y", "@z_ai/mcp-server@latest"],
			env: {
				Z_AI_API_KEY: "test-api-key",
				Z_AI_MODE: "ZAI",
			},
		});
	});

	it("uses ZHIPU mode for BigModel API and Coding Plan credentials", () => {
		const auth = resolveZaiMCPAuth(
			{ mode: "coding-plan", codingApiKey: "plan-key" },
			{},
		);
		expect(auth).toEqual({ apiKey: "plan-key", platform: "ZHIPU" });
		if (!auth) throw new Error("Expected resolved Zhipu MCP auth");
		expect(
			getZaiMCPConfigs(auth.apiKey, auth.platform)["zai-vision"],
		).toMatchObject({ env: { Z_AI_API_KEY: "plan-key", Z_AI_MODE: "ZHIPU" } });
	});

	it("resolves normal, coding, configured-env, and well-known environment keys", () => {
		expect(
			resolveZaiMCPAuth({ mode: "global", apiKey: "global-key" }, {}),
		).toEqual({ apiKey: "global-key", platform: "ZAI" });
		expect(
			resolveZaiMCPAuth(undefined, { ZAI_CODING_API_KEY: "zai-coding" }),
		).toEqual({ apiKey: "zai-coding", platform: "ZAI" });
		expect(
			resolveZaiMCPAuth(undefined, {
				ZHIPU_CODING_API_KEY: "zhipu-coding",
			}),
		).toEqual({ apiKey: "zhipu-coding", platform: "ZHIPU" });
		expect(
			resolveZaiMCPAuth(
				{ mode: "coding-plan" },
				{
					ZHIPU_CODING_API_KEY: "zhipu-coding",
					ZHIPU_API_KEY: "zhipu-normal",
				},
			),
		).toEqual({ apiKey: "zhipu-coding", platform: "ZHIPU" });
		expect(
			resolveZaiMCPAuth(
				{ mode: "api", apiKeyEnv: "CUSTOM_ZHIPU_KEY" },
				{ CUSTOM_ZHIPU_KEY: "custom-key" },
			),
		).toEqual({ apiKey: "custom-key", platform: "ZHIPU" });
	});
});
