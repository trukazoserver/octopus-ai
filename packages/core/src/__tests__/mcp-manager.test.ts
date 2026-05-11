import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../tools/registry.js";

const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockRequest = vi.fn();
const mockCallTool = vi.fn();

vi.mock("../plugins/mcp/client.js", () => ({
	MCPClient: class {
		connect = mockConnect;
		disconnect = mockDisconnect;
		request = mockRequest;
		callTool = mockCallTool;
	},
}));

import { MCPManager } from "../plugins/mcp/manager.js";

describe("MCPManager", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	function registerLocalReadTool(registry: ToolRegistry): void {
		registry.register({
			name: "read_file",
			description: "Read a local workspace file",
			parameters: {
				path: {
					type: "string",
					description: "Path to the local file",
					required: true,
				},
			},
			handler: async () => ({
				success: true,
				output: "local file contents",
			}),
		});
	}

	it("aliases colliding MCP tool names without breaking the local tool", async () => {
		const registry = new ToolRegistry();
		registerLocalReadTool(registry);

		mockRequest.mockResolvedValue({
			tools: [
				{
					name: "search_doc",
					description: "Search repo docs",
					inputSchema: {
						properties: {
							repo_name: {
								type: "string",
								description: "Repository name",
							},
						},
						required: ["repo_name"],
					},
				},
				{
					name: "read_file",
					description: "Read a GitHub file",
					inputSchema: {
						properties: {
							repo_name: {
								type: "string",
								description: "Repository name",
							},
							file_path: {
								type: "string",
								description: "Path in repository",
							},
						},
						required: ["repo_name", "file_path"],
					},
				},
			],
		});
		mockCallTool.mockResolvedValue({
			content: [{ text: "remote file contents" }],
		});

		const manager = new MCPManager();
		manager.setToolRegistry(registry);

		const server = await manager.addServer("zai-zread", {
			command: "npx",
			args: ["-y", "mcp-remote@latest"],
			env: {},
		});

		expect(server.status).toBe("connected");
		expect(server.tools).toEqual(["search_doc", "zai-zread__read_file"]);
		expect(manager.findServerForTool("zai-zread__read_file")).toBe("zai-zread");
		expect(registry.get("read_file")?.description).toBe(
			"Read a local workspace file",
		);

		const remoteReadTool = registry.get("zai-zread__read_file");
		expect(remoteReadTool).toBeDefined();
		if (!remoteReadTool) {
			throw new Error("Expected aliased ZRead tool to be registered");
		}

		const result = await remoteReadTool.handler(
			{
				repo_name: "owner/repo",
				file_path: "README.md",
			},
			{} as never,
		);

		expect(mockCallTool).toHaveBeenCalledWith("read_file", {
			repo_name: "owner/repo",
			file_path: "README.md",
		});
		expect(result).toEqual({
			success: true,
			output: "remote file contents",
		});
	});

	it("unregisters published MCP tool names when a server is removed", async () => {
		const registry = new ToolRegistry();
		registerLocalReadTool(registry);

		mockRequest.mockResolvedValue({
			tools: [
				{
					name: "search_doc",
					description: "Search repo docs",
					inputSchema: {},
				},
				{
					name: "read_file",
					description: "Read a GitHub file",
					inputSchema: {},
				},
			],
		});

		const manager = new MCPManager();
		manager.setToolRegistry(registry);

		await manager.addServer("zai-zread", {
			command: "npx",
			args: ["-y", "mcp-remote@latest"],
			env: {},
		});

		expect(registry.has("search_doc")).toBe(true);
		expect(registry.has("zai-zread__read_file")).toBe(true);

		await manager.removeServer("zai-zread");

		expect(registry.has("search_doc")).toBe(false);
		expect(registry.has("zai-zread__read_file")).toBe(false);
		expect(registry.has("read_file")).toBe(true);
	});
});
