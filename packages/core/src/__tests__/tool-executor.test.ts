import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolExecutor } from "../tools/executor.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolDefinition, ToolResult } from "../tools/registry.js";

function createTestTool(overrides?: Partial<ToolDefinition>): ToolDefinition {
	return {
		name: "test-tool",
		description: "A test tool",
		parameters: {
			input: { type: "string", description: "Input value", required: true },
			optional_param: { type: "string", description: "Optional value" },
		},
		handler: vi.fn().mockImplementation(async (params) => ({
			success: true,
			output: `processed: ${params.input}`,
		})),
		...overrides,
	};
}

function createPathTool(): ToolDefinition {
	return {
		name: "file-reader",
		description: "Reads files",
		parameters: {
			path: { type: "string", description: "File path", required: true },
		},
		handler: vi.fn().mockImplementation(async () => ({
			success: true,
			output: "file contents",
		})),
	};
}

function createCommandTool(): ToolDefinition {
	return {
		name: "shell-runner",
		description: "Runs shell commands",
		parameters: {
			command: { type: "string", description: "Shell command", required: true },
		},
		handler: vi.fn().mockImplementation(async () => ({
			success: true,
			output: "command output",
		})),
	};
}

describe("ToolExecutor", () => {
	let registry: ToolRegistry;

	beforeEach(() => {
		registry = new ToolRegistry();
	});

	describe("execute", () => {
		it("should return error for missing tool", async () => {
			const executor = new ToolExecutor(registry, {
				sandboxCommands: false,
				allowedPaths: [],
			});
			const result = await executor.execute("nonexistent", {});
			expect(result.success).toBe(false);
			expect(result.error).toContain("Tool not found: nonexistent");
		});

		it("should execute a registered tool and return its result", async () => {
			const tool = createTestTool();
			registry.register(tool);
			const executor = new ToolExecutor(registry, {
				sandboxCommands: false,
				allowedPaths: [],
			});

			const result = await executor.execute("test-tool", { input: "hello" });
			expect(result.success).toBe(true);
			expect(result.output).toBe("processed: hello");
			expect(tool.handler).toHaveBeenCalledWith({ input: "hello" });
		});

		it("should return error for missing required parameters", async () => {
			const tool = createTestTool();
			registry.register(tool);
			const executor = new ToolExecutor(registry, {
				sandboxCommands: false,
				allowedPaths: [],
			});

			const result = await executor.execute("test-tool", {});
			expect(result.success).toBe(false);
			expect(result.error).toContain("Missing required parameters");
			expect(result.error).toContain("input");
		});

		it("should not require optional parameters", async () => {
			const tool = createTestTool();
			registry.register(tool);
			const executor = new ToolExecutor(registry, {
				sandboxCommands: false,
				allowedPaths: [],
			});

			const result = await executor.execute("test-tool", { input: "test" });
			expect(result.success).toBe(true);
		});

		it("should block paths outside allowed paths", async () => {
			const tool = createPathTool();
			registry.register(tool);
			const executor = new ToolExecutor(registry, {
				sandboxCommands: false,
				allowedPaths: ["/safe/dir"],
			});

			const result = await executor.execute("file-reader", {
				path: "/etc/passwd",
			});
			expect(result.success).toBe(false);
			expect(result.error).toContain("Access denied");
		});

		it("should allow paths within allowed paths", async () => {
			const tool = createPathTool();
			registry.register(tool);
			const executor = new ToolExecutor(registry, {
				sandboxCommands: false,
				allowedPaths: ["/safe/dir"],
			});

			const result = await executor.execute("file-reader", {
				path: "/safe/dir/file.txt",
			});
			expect(result.success).toBe(true);
			expect(result.output).toBe("file contents");
		});

		it("should block dangerous commands in sandbox mode", async () => {
			const tool = createCommandTool();
			registry.register(tool);
			const executor = new ToolExecutor(registry, {
				sandboxCommands: true,
				allowedPaths: [],
			});

			const result = await executor.execute("shell-runner", {
				command: "rm -rf /",
			});
			expect(result.success).toBe(false);
			expect(result.error).toContain("blocked by sandbox policy");
		});

		it("should block shutdown commands in sandbox mode", async () => {
			const tool = createCommandTool();
			registry.register(tool);
			const executor = new ToolExecutor(registry, {
				sandboxCommands: true,
				allowedPaths: [],
			});

			const result = await executor.execute("shell-runner", {
				command: "shutdown -h now",
			});
			expect(result.success).toBe(false);
			expect(result.error).toContain("blocked by sandbox policy");
		});

		it("should allow safe commands in sandbox mode", async () => {
			const tool = createCommandTool();
			registry.register(tool);
			const executor = new ToolExecutor(registry, {
				sandboxCommands: true,
				allowedPaths: [],
			});

			const result = await executor.execute("shell-runner", {
				command: "ls -la",
			});
			expect(result.success).toBe(true);
		});

		it("should allow dangerous commands when sandbox is off", async () => {
			const tool = createCommandTool();
			registry.register(tool);
			const executor = new ToolExecutor(registry, {
				sandboxCommands: false,
				allowedPaths: [],
			});

			const result = await executor.execute("shell-runner", {
				command: "rm -rf /",
			});
			expect(result.success).toBe(true);
		});

		it("should handle tool handler errors gracefully", async () => {
			const tool = createTestTool({
				handler: vi.fn().mockRejectedValue(new Error("Handler blew up")),
			});
			registry.register(tool);
			const executor = new ToolExecutor(registry, {
				sandboxCommands: false,
				allowedPaths: [],
			});

			const result = await executor.execute("test-tool", { input: "fail" });
			expect(result.success).toBe(false);
			expect(result.error).toContain("Tool execution failed");
			expect(result.error).toContain("Handler blew up");
		});

		it("should handle non-Error throws from handler", async () => {
			const tool = createTestTool({
				handler: vi.fn().mockRejectedValue("string error"),
			});
			registry.register(tool);
			const executor = new ToolExecutor(registry, {
				sandboxCommands: false,
				allowedPaths: [],
			});

			const result = await executor.execute("test-tool", { input: "fail" });
			expect(result.success).toBe(false);
			expect(result.error).toContain("string error");
		});

		it("should allow null param values for required fields", async () => {
			const tool = createTestTool();
			registry.register(tool);
			const executor = new ToolExecutor(registry, {
				sandboxCommands: false,
				allowedPaths: [],
			});

			const result = await executor.execute("test-tool", { input: null });
			expect(result.success).toBe(false);
			expect(result.error).toContain("Missing required parameters");
		});
	});

	describe("executeMultiple", () => {
		it("should execute multiple tools in parallel", async () => {
			const tool1 = createTestTool({ name: "tool-a" });
			const tool2 = createTestTool({ name: "tool-b" });
			registry.register(tool1);
			registry.register(tool2);
			const executor = new ToolExecutor(registry, {
				sandboxCommands: false,
				allowedPaths: [],
			});

			const results = await executor.executeMultiple([
				{ name: "tool-a", params: { input: "first" } },
				{ name: "tool-b", params: { input: "second" } },
			]);
			expect(results).toHaveLength(2);
			expect(results[0]?.success).toBe(true);
			expect(results[0]?.output).toBe("processed: first");
			expect(results[1]?.success).toBe(true);
			expect(results[1]?.output).toBe("processed: second");
		});

		it("should include errors for missing tools in results", async () => {
			const tool = createTestTool();
			registry.register(tool);
			const executor = new ToolExecutor(registry, {
				sandboxCommands: false,
				allowedPaths: [],
			});

			const results = await executor.executeMultiple([
				{ name: "test-tool", params: { input: "ok" } },
				{ name: "missing-tool", params: {} },
			]);
			expect(results).toHaveLength(2);
			expect(results[0]?.success).toBe(true);
			expect(results[1]?.success).toBe(false);
			expect(results[1]?.error).toContain("Tool not found");
		});
	});
});
