export interface ZaiMCPConfig {
  apiKey: string;
  enabledServers: string[];
}

export const ZAI_MCP_SERVERS = {
  "web-reader": {
    name: "Web Reader",
    type: "streamable-http",
    url: "https://open.bigmodel.cn/api/mcp/web_reader/mcp",
    sseUrl: "https://open.bigmodel.cn/api/mcp/web_reader/sse",
    description: "Fetches URL content, extracts title, body, metadata, links",
    tools: ["webReader"],
  },
  "web-search": {
    name: "Web Search",
    type: "streamable-http",
    url: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
    sseUrl: "https://open.bigmodel.cn/api/mcp/web_search_prime/sse",
    description: "Web search returning titles, URLs, summaries",
    tools: ["webSearchPrime"],
  },
  "zread": {
    name: "ZRead (GitHub Repos)",
    type: "streamable-http",
    url: "https://open.bigmodel.cn/api/mcp/zread/mcp",
    sseUrl: "https://open.bigmodel.cn/api/mcp/zread/sse",
    description: "Search and read GitHub repository docs, issues, files",
    tools: ["search_doc", "get_repo_structure", "read_file"],
  },
  "vision": {
    name: "Vision Understanding",
    type: "stdio",
    command: "npx",
    args: ["-y", "@z_ai/mcp-server"],
    envKey: "Z_AI_API_KEY",
    envMode: "Z_AI_MODE",
    description: "Image analysis, OCR, error diagnosis, diagram understanding, data visualization, video analysis",
    tools: [
      "ui_to_artifact",
      "extract_text_from_screenshot",
      "diagnose_error_screenshot",
      "understand_technical_diagram",
      "analyze_data_visualization",
      "ui_diff_check",
      "image_analysis",
      "video_analysis",
    ],
  },
} as const;

export type ZaiMCPServerName = keyof typeof ZAI_MCP_SERVERS;

export function getZaiMCPConfigs(apiKey: string): Record<string, import("../../plugins/types.js").MCPServerConfig> {
  const configs: Record<string, import("../../plugins/types.js").MCPServerConfig> = {};

  configs["zai-web-reader"] = {
    command: "npx",
    args: ["-y", "@anthropic-ai/mcp-remote@latest", ZAI_MCP_SERVERS["web-reader"].url, "--header", `Authorization:Bearer ${apiKey}`],
    env: {},
  };

  configs["zai-web-search"] = {
    command: "npx",
    args: ["-y", "@anthropic-ai/mcp-remote@latest", ZAI_MCP_SERVERS["web-search"].url, "--header", `Authorization:Bearer ${apiKey}`],
    env: {},
  };

  configs["zai-zread"] = {
    command: "npx",
    args: ["-y", "@anthropic-ai/mcp-remote@latest", ZAI_MCP_SERVERS["zread"].url, "--header", `Authorization:Bearer ${apiKey}`],
    env: {},
  };

  configs["zai-vision"] = {
    command: "npx",
    args: ["-y", "@z_ai/mcp-server"],
    env: {
      Z_AI_API_KEY: apiKey,
      Z_AI_MODE: "ZHIPU",
    },
  };

  return configs;
}
