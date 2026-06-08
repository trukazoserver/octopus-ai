import type { MCPServerConfig } from "../types.js";

export interface ZaiMCPConfig {
	apiKey: string;
	enabledServers: string[];
}

export const ZAI_MCP_SERVERS = {
	"web-reader": {
		name: "Web Reader",
		type: "streamable-http",
		url: "https://api.z.ai/api/mcp/web_reader/mcp",
		sseUrl: "https://api.z.ai/api/mcp/web_reader/sse",
		description: "Fetches URL content, extracts title, body, metadata, links",
		tools: ["webReader"],
	},
	"web-search": {
		name: "Web Search",
		type: "streamable-http",
		url: "https://api.z.ai/api/mcp/web_search_prime/mcp",
		sseUrl: "https://api.z.ai/api/mcp/web_search_prime/sse",
		description: "Web search returning titles, URLs, summaries",
		tools: ["webSearchPrime"],
	},
	zread: {
		name: "ZRead (GitHub Repos)",
		type: "streamable-http",
		url: "https://api.z.ai/api/mcp/zread/mcp",
		sseUrl: "https://api.z.ai/api/mcp/zread/sse",
		description: "Search and read GitHub repository docs, issues, files",
		tools: ["search_doc", "get_repo_structure", "read_file"],
	},
	vision: {
		name: "Vision Understanding",
		type: "stdio",
		command: "npx",
		args: ["-y", "@z_ai/mcp-server@latest"],
		envKey: "Z_AI_API_KEY",
		envMode: "Z_AI_MODE",
		description:
			"Image analysis, OCR, error diagnosis, diagram understanding, data visualization, video analysis",
		tools: [
			"ui_to_artifact",
			"extract_text_from_screenshot",
			"diagnose_error_screenshot",
			"understand_technical_diagram",
			"analyze_data_visualization",
			"ui_diff_check",
			"analyze_image",
			"analyze_video",
		],
	},
} as const;

export type ZaiMCPServerName = keyof typeof ZAI_MCP_SERVERS;

function createRemoteMCPConfig(url: string, apiKey: string): MCPServerConfig {
	return {
		type: "streamable-http",
		url,
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
		command: "streamable-http",
		args: [],
		env: {},
	};
}

export function getZaiMCPConfigs(
	apiKey: string,
): Record<string, MCPServerConfig> {
	const configs: Record<string, MCPServerConfig> = {};

	configs["zai-web-reader"] = createRemoteMCPConfig(
		ZAI_MCP_SERVERS["web-reader"].url,
		apiKey,
	);

	configs["zai-web-search"] = createRemoteMCPConfig(
		ZAI_MCP_SERVERS["web-search"].url,
		apiKey,
	);

	configs["zai-zread"] = createRemoteMCPConfig(
		ZAI_MCP_SERVERS.zread.url,
		apiKey,
	);

	configs["zai-vision"] = {
		command: "npx",
		args: ["-y", "@z_ai/mcp-server@latest"],
		env: {
			Z_AI_API_KEY: apiKey,
			Z_AI_MODE: "ZAI",
		},
	};

	return configs;
}
