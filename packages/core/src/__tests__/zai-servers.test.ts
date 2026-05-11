import { describe, expect, it } from "vitest";
import { getZaiMCPConfigs } from "../plugins/mcp/zai-servers.js";

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
});
