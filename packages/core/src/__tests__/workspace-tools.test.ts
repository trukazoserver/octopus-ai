import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CodeExecutor } from "../tools/code-executor.js";
import { ToolExecutor } from "../tools/executor.js";
import { createShellTool } from "../tools/shell.js";
import { ToolRegistry } from "../tools/registry.js";

function tempDir(prefix: string): string {
	return path.join(process.env.TEMP ?? "/tmp", `${prefix}-${Date.now()}`);
}

describe("manage_workspace via ToolExecutor", () => {
	async function setup() {
		const workspace = tempDir("octopus-mw");
		const registry = new ToolRegistry();
		const codeExecutor = new CodeExecutor({
			allowedPaths: [workspace],
			workspaceDir: workspace,
			tempDir: path.join(workspace, "tmp"),
		});
		await codeExecutor.initialize();
		for (const tool of codeExecutor.createTools()) registry.register(tool);
		const executor = new ToolExecutor(registry, {
			sandboxCommands: false,
			allowedPaths: [workspace],
		});
		return { workspace, executor };
	}

	it("accepts a relative path inside the workspace", async () => {
		const { executor } = await setup();
		const res = await executor.execute("manage_workspace", {
			action: "write",
			path: "proyecto/file.txt",
			content: "hola",
		});
		expect(res.success).toBe(true);
	});

	it("rejects a relative path that escapes the workspace", async () => {
		const { executor } = await setup();
		const res = await executor.execute("manage_workspace", {
			action: "write",
			path: "../evil.txt",
			content: "x",
		});
		expect(res.success).toBe(false);
	});

	it("rejects reads through a junction pointing outside the workspace", async () => {
		const { workspace, executor } = await setup();
		const outside = tempDir("octopus-mw-sym-out");
		await mkdir(outside, { recursive: true });
		await writeFile(path.join(outside, "secret.txt"), "topsecret");

		let linkCreated = true;
		try {
			await symlink(
				outside,
				path.join(workspace, "link"),
				process.platform === "win32" ? "junction" : "dir",
			);
		} catch {
			linkCreated = false;
		}
		if (!linkCreated) return;

		const res = await executor.execute("manage_workspace", {
			action: "read",
			path: "link/secret.txt",
		});
		expect(res.success).toBe(false);
		expect(res.error).toMatch(
			/outside the allowed paths|symlink|junction|outside workspace/i,
		);

		await rm(workspace, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	});
});

describe("run_command cwd via ToolExecutor", () => {
	it("anchors a relative cwd to the workspace", async () => {
		const workspace = tempDir("octopus-sh");
		await mkdir(path.join(workspace, "proyecto"), { recursive: true });
		const registry = new ToolRegistry();
		registry.register(
			createShellTool({
				sandboxCommands: false,
				allowedPaths: [workspace],
				workspaceDir: workspace,
			}),
		);
		const executor = new ToolExecutor(registry, {
			sandboxCommands: false,
			allowedPaths: [workspace],
		});

		const res = await executor.execute("run_command", {
			command: 'node -e "console.log(process.cwd())"',
			cwd: "proyecto",
		});
		expect(res.success).toBe(true);
		expect(res.output).toContain(path.join(workspace, "proyecto"));
	});

	it("rejects a relative cwd that escapes the workspace", async () => {
		const workspace = tempDir("octopus-sh2");
		const registry = new ToolRegistry();
		registry.register(
			createShellTool({
				sandboxCommands: false,
				allowedPaths: [workspace],
				workspaceDir: workspace,
			}),
		);
		const executor = new ToolExecutor(registry, {
			sandboxCommands: false,
			allowedPaths: [workspace],
		});

		const res = await executor.execute("run_command", {
			command: "echo hi",
			cwd: "../outside",
		});
		expect(res.success).toBe(false);
	});
});
