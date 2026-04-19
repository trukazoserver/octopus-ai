import { describe, expect, it, vi } from "vitest";
import { CodeExecutor } from "../tools/code-executor.js";

describe("CodeExecutor", () => {
	describe("constructor", () => {
		it("should use default config when none provided", () => {
			const executor = new CodeExecutor();
			expect(executor).toBeInstanceOf(CodeExecutor);
		});

		it("should merge partial config with defaults", () => {
			const executor = new CodeExecutor({ timeout: 5000 });
			expect(executor).toBeInstanceOf(CodeExecutor);
		});

		it("should accept full config override", () => {
			const executor = new CodeExecutor({
				enabled: false,
				timeout: 10000,
				maxOutputBytes: 2048,
				allowedLanguages: ["javascript"],
				workspaceDir: "/tmp/ws",
				tempDir: "/tmp/tmp",
				sandboxMode: "local",
			});
			expect(executor).toBeInstanceOf(CodeExecutor);
		});
	});

	describe("executeCode", () => {
		it("should return error when execution is disabled", async () => {
			const executor = new CodeExecutor({ enabled: false });
			const result = await executor.executeCode(
				"console.log('hi')",
				"javascript",
			);
			expect(result.success).toBe(false);
			expect(result.stderr).toContain("disabled");
			expect(result.exitCode).toBe(1);
		});

		it("should return error for disallowed language", async () => {
			const executor = new CodeExecutor({ allowedLanguages: ["javascript"] });
			const result = await executor.executeCode("print('hello')", "ruby");
			expect(result.success).toBe(false);
			expect(result.stderr).toContain("not allowed");
		});

		it("should return error for unknown language config", async () => {
			const executor = new CodeExecutor({
				allowedLanguages: ["javascript", "cobol"],
			});
			const result = await executor.executeCode("DISPLAY 'HI'", "cobol");
			expect(result.success).toBe(false);
			expect(result.stderr).toContain("No execution configuration");
		});

		it("should execute simple JavaScript code and return stdout", async () => {
			const executor = new CodeExecutor({
				tempDir: `${process.env.TEMP ?? "/tmp"}/octopus-test-${Date.now()}`,
			});
			await executor.initialize();

			const result = await executor.executeCode(
				'console.log("hello from test")',
				"javascript",
			);
			expect(result.success).toBe(true);
			expect(result.stdout.trim()).toBe("hello from test");
			expect(result.language).toBe("javascript");
			expect(result.executionTime).toBeGreaterThanOrEqual(0);
		}, 15000);

		it("should normalize language aliases (js -> javascript)", async () => {
			const executor = new CodeExecutor({
				tempDir: `${process.env.TEMP ?? "/tmp"}/octopus-test-alias`,
			});
			await executor.initialize();

			const result = await executor.executeCode(
				'console.log("alias test")',
				"js",
			);
			expect(result.success).toBe(true);
			expect(result.language).toBe("javascript");
		}, 15000);

		it("should capture stderr for code with warnings", async () => {
			const executor = new CodeExecutor({
				tempDir: `${process.env.TEMP ?? "/tmp"}/octopus-test-stderr`,
			});
			await executor.initialize();

			const result = await executor.executeCode(
				'console.error("warn message")',
				"javascript",
			);
			expect(result.stderr).toContain("warn message");
		}, 15000);

		it("should return non-zero exit code for failing code", async () => {
			const executor = new CodeExecutor({
				tempDir: `${process.env.TEMP ?? "/tmp"}/octopus-test-fail`,
			});
			await executor.initialize();

			const result = await executor.executeCode(
				"throw new Error('intentional failure')",
				"javascript",
			);
			expect(result.success).toBe(false);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("intentional failure");
		}, 15000);

		it("should respect custom timeout option", async () => {
			const executor = new CodeExecutor({
				tempDir: `${process.env.TEMP ?? "/tmp"}/octopus-test-timeout`,
				timeout: 1000,
			});
			await executor.initialize();

			const result = await executor.executeCode(
				"setTimeout(() => {}, 10000)",
				"javascript",
				{ timeout: 500 },
			);
			expect(result.success).toBe(false);
		}, 10000);
	});

	describe("createTools", () => {
		it("should return an array of tool definitions", () => {
			const executor = new CodeExecutor();
			const tools = executor.createTools();
			expect(Array.isArray(tools)).toBe(true);
			expect(tools.length).toBe(4);
		});

		it("should include execute_code tool", () => {
			const executor = new CodeExecutor();
			const tools = executor.createTools();
			const execTool = tools.find((t) => t.name === "execute_code");
			expect(execTool).toBeDefined();
			expect(execTool?.parameters).toHaveProperty("code");
			expect(execTool?.parameters).toHaveProperty("language");
		});

		it("should include install_package tool", () => {
			const executor = new CodeExecutor();
			const tools = executor.createTools();
			const pkgTool = tools.find((t) => t.name === "install_package");
			expect(pkgTool).toBeDefined();
			expect(pkgTool?.parameters).toHaveProperty("package");
			expect(pkgTool?.parameters).toHaveProperty("manager");
		});

		it("should include create_tool tool", () => {
			const executor = new CodeExecutor();
			const tools = executor.createTools();
			const createTool = tools.find((t) => t.name === "create_tool");
			expect(createTool).toBeDefined();
			expect(createTool?.parameters).toHaveProperty("name");
			expect(createTool?.parameters).toHaveProperty("code");
		});

		it("should include manage_workspace tool", () => {
			const executor = new CodeExecutor();
			const tools = executor.createTools();
			const wsTool = tools.find((t) => t.name === "manage_workspace");
			expect(wsTool).toBeDefined();
			expect(wsTool?.parameters).toHaveProperty("action");
			expect(wsTool?.parameters).toHaveProperty("path");
		});
	});

	describe("tool handlers", () => {
		it("execute_code handler should return formatted result", async () => {
			const executor = new CodeExecutor({
				tempDir: `${process.env.TEMP ?? "/tmp"}/octopus-test-handler`,
			});
			await executor.initialize();

			const tools = executor.createTools();
			const execTool = tools.find((t) => t.name === "execute_code");
			expect(execTool).toBeDefined();
			const result = await execTool?.handler({
				code: 'console.log("handler test")',
				language: "javascript",
			});
			expect(result.success).toBe(true);
			expect(result.output).toContain("handler test");
			expect(result.output).toContain("Execution:");
			expect(result.metadata).toHaveProperty("executionTime");
			expect(result.metadata).toHaveProperty("language");
		}, 15000);

		it("install_package handler should reject invalid package names", async () => {
			const executor = new CodeExecutor();
			const tools = executor.createTools();
			const pkgTool = tools.find((t) => t.name === "install_package");
			expect(pkgTool).toBeDefined();
			const result = await pkgTool?.handler({
				package: "evil-pkg; rm -rf /",
				manager: "npm",
			});
			expect(result.success).toBe(false);
			expect(result.error).toContain("Invalid package name");
		});

		it("create_tool handler should reject short names", async () => {
			const executor = new CodeExecutor();
			const tools = executor.createTools();
			const createTool = tools.find((t) => t.name === "create_tool");
			expect(createTool).toBeDefined();
			const result = await createTool?.handler({
				name: "x",
				description: "test",
				code: "export default async function() {}",
			});
			expect(result.success).toBe(false);
			expect(result.error).toContain("at least 2 characters");
		});

		it("create_tool handler should reject names not starting with letter", async () => {
			const executor = new CodeExecutor();
			const tools = executor.createTools();
			const createTool = tools.find((t) => t.name === "create_tool");
			expect(createTool).toBeDefined();
			const result = await createTool?.handler({
				name: "123-tool",
				description: "test",
				code: "export default async function() {}",
			});
			expect(result.success).toBe(false);
			expect(result.error).toContain("must start with a letter");
		});

		it("manage_workspace handler should reject paths outside workspace", async () => {
			const executor = new CodeExecutor({
				workspaceDir: `${process.env.TEMP ?? "/tmp"}/octopus-test-ws`,
			});
			const tools = executor.createTools();
			const wsTool = tools.find((t) => t.name === "manage_workspace");
			expect(wsTool).toBeDefined();
			const result = await wsTool?.handler({
				action: "read",
				path: "../../etc/passwd",
			});
			expect(result.success).toBe(false);
			expect(result.error).toContain("Access denied");
		});

		it("manage_workspace handler should reject unknown actions", async () => {
			const executor = new CodeExecutor({
				workspaceDir: `${process.env.TEMP ?? "/tmp"}/octopus-test-ws2`,
			});
			const tools = executor.createTools();
			const wsTool = tools.find((t) => t.name === "manage_workspace");
			expect(wsTool).toBeDefined();
			const result = await wsTool?.handler({
				action: "explode",
				path: ".",
			});
			expect(result.success).toBe(false);
			expect(result.error).toContain("Unknown action");
		});
	});
});
