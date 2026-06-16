import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ToolExecutor } from "../tools/executor.js";
import { createFileSystemTools } from "../tools/filesystem.js";
import { ToolRegistry } from "../tools/registry.js";

describe("filesystem tools", () => {
	it("blocks sibling paths that only share an allowed path prefix", async () => {
		const allowedPath = path.join(
			process.env.TEMP ?? "/tmp",
			`octopus-fs-allowed-${Date.now()}`,
		);
		const siblingPath = `${allowedPath}-evil`;
		const tools = createFileSystemTools([allowedPath]);
		const listTool = tools.find((tool) => tool.name === "list_directory");

		expect(listTool).toBeDefined();
		const result = await listTool?.handler({ path: siblingPath });

		expect(result.success).toBe(false);
		expect(result.error).toContain("Access denied");
	});

	it("resolves relative write paths against the workspace dir, not cwd", async () => {
		const workspace = path.join(
			process.env.TEMP ?? "/tmp",
			`octopus-fs-workspace-${Date.now()}`,
		);
		const tools = createFileSystemTools([workspace], workspace);
		const writeTool = tools.find((tool) => tool.name === "write_file");
		expect(writeTool).toBeDefined();

		const result = await writeTool?.handler({
			path: "proj/index.html",
			content: "<h1>hi</h1>",
		});

		expect(result?.success).toBe(true);
		expect(result?.output).toContain(
			path.join(workspace, "proj", "index.html"),
		);
		// Must not land in the process working directory.
		expect(result?.output).not.toContain(
			path.resolve(process.cwd(), "proj", "index.html"),
		);
	});
});

describe("filesystem tools via ToolExecutor", () => {
	function buildExecutor(allowed: string[], workspace: string) {
		const registry = new ToolRegistry();
		for (const tool of createFileSystemTools(allowed, workspace))
			registry.register(tool);
		return new ToolExecutor(registry, {
			sandboxCommands: false,
			allowedPaths: allowed,
		});
	}

	it("routes a relative write to the workspace (prevalidation does not block)", async () => {
		const workspace = path.join(
			process.env.TEMP ?? "/tmp",
			`octopus-exec-ws-${Date.now()}`,
		);
		const executor = buildExecutor([workspace], workspace);

		const res = await executor.execute("write_file", {
			path: "proj/index.html",
			content: "<h1>hi</h1>",
		});

		expect(res.success).toBe(true);
		expect(res.output).toContain(path.join(workspace, "proj", "index.html"));
	});

	it("rejects relative paths that escape the workspace", async () => {
		const workspace = path.join(
			process.env.TEMP ?? "/tmp",
			`octopus-exec-esc-${Date.now()}`,
		);
		const executor = buildExecutor([workspace], workspace);

		for (const bad of ["../evil.txt", "../../Documents/x.txt"]) {
			const res = await executor.execute("write_file", {
				path: bad,
				content: "x",
			});
			expect(res.success).toBe(false);
			expect(res.error).toMatch(/escape/i);
		}
	});

	it("allows absolute paths within allowedPaths and denies outside", async () => {
		const workspace = path.join(
			process.env.TEMP ?? "/tmp",
			`octopus-exec-ws2-${Date.now()}`,
		);
		const allowed = path.join(
			process.env.TEMP ?? "/tmp",
			`octopus-exec-allowed-${Date.now()}`,
		);
		const outside = path.join(
			process.env.TEMP ?? "/tmp",
			`octopus-exec-outside-${Date.now()}`,
		);
		const executor = buildExecutor([workspace, allowed], workspace);

		const ok = await executor.execute("write_file", {
			path: path.join(allowed, "hello.txt"),
			content: "x",
		});
		expect(ok.success).toBe(true);

		const denied = await executor.execute("write_file", {
			path: path.join(outside, "nope.txt"),
			content: "x",
		});
		expect(denied.success).toBe(false);
	});
});

describe("file operation tools (move/copy/delete)", () => {
	it("move_file relocates a workspace file and rejects escapes", async () => {
		const workspace = path.join(
			process.env.TEMP ?? "/tmp",
			`octopus-mv-${Date.now()}`,
		);
		const tools = createFileSystemTools([workspace], workspace);
		const write = tools.find((t) => t.name === "write_file");
		const move = tools.find((t) => t.name === "move_file");
		expect(write).toBeDefined();
		expect(move).toBeDefined();

		await write?.handler({ path: "a.txt", content: "x" });
		const ok = await move?.handler({
			source: "a.txt",
			destination: "sub/b.txt",
		});
		expect(ok?.success).toBe(true);
		expect(ok?.output).toContain(path.join(workspace, "sub", "b.txt"));

		const esc = await move?.handler({
			source: "a.txt",
			destination: "../evil.txt",
		});
		expect(esc?.success).toBe(false);
	});

	it("copy_file duplicates a workspace file and rejects escapes", async () => {
		const workspace = path.join(
			process.env.TEMP ?? "/tmp",
			`octopus-cp-${Date.now()}`,
		);
		const tools = createFileSystemTools([workspace], workspace);
		const write = tools.find((t) => t.name === "write_file");
		const copy = tools.find((t) => t.name === "copy_file");

		await write?.handler({ path: "a.txt", content: "data" });
		const ok = await copy?.handler({ source: "a.txt", destination: "b.txt" });
		expect(ok?.success).toBe(true);
		expect(ok?.output).toContain(path.join(workspace, "b.txt"));

		const esc = await copy?.handler({
			source: "a.txt",
			destination: "../../Documents/x.txt",
		});
		expect(esc?.success).toBe(false);
	});

	it("delete_file removes a workspace file and rejects escapes", async () => {
		const workspace = path.join(
			process.env.TEMP ?? "/tmp",
			`octopus-rm-${Date.now()}`,
		);
		const tools = createFileSystemTools([workspace], workspace);
		const write = tools.find((t) => t.name === "write_file");
		const del = tools.find((t) => t.name === "delete_file");

		await write?.handler({ path: "a.txt", content: "x" });
		const ok = await del?.handler({ path: "a.txt" });
		expect(ok?.success).toBe(true);
		expect(ok?.output).toContain(path.join(workspace, "a.txt"));

		const esc = await del?.handler({ path: "../evil.txt" });
		expect(esc?.success).toBe(false);
	});
});

describe("file operation tools via ToolExecutor", () => {
	function buildExecutor(allowed: string[], workspace: string) {
		const registry = new ToolRegistry();
		for (const tool of createFileSystemTools(allowed, workspace))
			registry.register(tool);
		return new ToolExecutor(registry, {
			sandboxCommands: false,
			allowedPaths: allowed,
		});
	}

	it("move_file via ToolExecutor routes to workspace and rejects escapes", async () => {
		const workspace = path.join(
			process.env.TEMP ?? "/tmp",
			`octopus-exec-mv-${Date.now()}`,
		);
		const executor = buildExecutor([workspace], workspace);
		await executor.execute("write_file", { path: "a.txt", content: "x" });

		const res = await executor.execute("move_file", {
			source: "a.txt",
			destination: "moved/b.txt",
		});
		expect(res.success).toBe(true);
		expect(res.output).toContain(path.join(workspace, "moved", "b.txt"));

		const esc = await executor.execute("move_file", {
			source: "moved/b.txt",
			destination: "../evil.txt",
		});
		expect(esc.success).toBe(false);
	});

	it("copy_file via ToolExecutor", async () => {
		const workspace = path.join(
			process.env.TEMP ?? "/tmp",
			`octopus-exec-cp-${Date.now()}`,
		);
		const executor = buildExecutor([workspace], workspace);
		await executor.execute("write_file", { path: "a.txt", content: "x" });

		const res = await executor.execute("copy_file", {
			source: "a.txt",
			destination: "b.txt",
		});
		expect(res.success).toBe(true);
	});

	it("delete_file via ToolExecutor removes a workspace file and rejects escapes", async () => {
		const workspace = path.join(
			process.env.TEMP ?? "/tmp",
			`octopus-exec-rm-${Date.now()}`,
		);
		const executor = buildExecutor([workspace], workspace);
		await executor.execute("write_file", { path: "a.txt", content: "x" });

		const res = await executor.execute("delete_file", { path: "a.txt" });
		expect(res.success).toBe(true);

		const esc = await executor.execute("delete_file", { path: "../evil.txt" });
		expect(esc.success).toBe(false);
	});
});

describe("symlink/junction escape protection", () => {
	it("rejects reads that follow a link pointing outside the workspace", async () => {
		const workspace = path.join(
			process.env.TEMP ?? "/tmp",
			`octopus-sym-${Date.now()}`,
		);
		const outside = path.join(
			process.env.TEMP ?? "/tmp",
			`octopus-sym-out-${Date.now()}`,
		);
		await fs.mkdir(workspace, { recursive: true });
		await fs.mkdir(outside, { recursive: true });
		await fs.writeFile(path.join(outside, "secret.txt"), "topsecret");

		let linkCreated = true;
		try {
			await fs.symlink(
				outside,
				path.join(workspace, "link"),
				process.platform === "win32" ? "junction" : "dir",
			);
		} catch {
			linkCreated = false; // platform/privileges do not allow creating the link
		}
		if (!linkCreated) return; // skip: cannot exercise the protection here

		const tools = createFileSystemTools([workspace], workspace);
		const read = tools.find((t) => t.name === "read_file");
		const res = await read?.handler({ path: "link/secret.txt" });
		expect(res?.success).toBe(false);
		expect(res?.error).toMatch(/outside the allowed paths|symlink|junction/i);

		await fs.rm(workspace, { recursive: true, force: true });
		await fs.rm(outside, { recursive: true, force: true });
	});

	it("search_files does not return files reached through a junction", async () => {
		const workspace = path.join(
			process.env.TEMP ?? "/tmp",
			`octopus-search-${Date.now()}`,
		);
		const outside = path.join(
			process.env.TEMP ?? "/tmp",
			`octopus-search-out-${Date.now()}`,
		);
		await fs.mkdir(workspace, { recursive: true });
		await fs.mkdir(outside, { recursive: true });
		await fs.writeFile(path.join(outside, "leaked.txt"), "secret");

		let linkCreated = true;
		try {
			await fs.symlink(
				outside,
				path.join(workspace, "link"),
				process.platform === "win32" ? "junction" : "dir",
			);
		} catch {
			linkCreated = false;
		}
		if (!linkCreated) return;

		const tools = createFileSystemTools([workspace], workspace);
		const search = tools.find((t) => t.name === "search_files");
		const res = await search?.handler({ path: ".", pattern: "*.txt" });
		expect(res?.success).toBe(true);
		const found = JSON.parse(res?.output ?? "[]") as string[];
		expect(found.some((p) => p.includes("leaked.txt"))).toBe(false);

		await fs.rm(workspace, { recursive: true, force: true });
		await fs.rm(outside, { recursive: true, force: true });
	});
});

describe("search_files glob patterns", () => {
	it("matches **, segment *, and nested patterns against relative paths", async () => {
		const workspace = path.join(
			process.env.TEMP ?? "/tmp",
			`octopus-glob-${Date.now()}`,
		);
		await fs.mkdir(path.join(workspace, "src", "sub"), { recursive: true });
		await fs.writeFile(path.join(workspace, "a.ts"), "x");
		await fs.writeFile(path.join(workspace, "notes.txt"), "x");
		await fs.writeFile(path.join(workspace, "src", "app.tsx"), "x");
		await fs.writeFile(path.join(workspace, "src", "keep.ts"), "x");
		await fs.writeFile(path.join(workspace, "src", "sub", "deep.ts"), "x");

		const tools = createFileSystemTools([workspace], workspace);
		const search = tools.find((t) => t.name === "search_files");
		const run = async (pattern: string) => {
			const res = await search?.handler({ path: ".", pattern });
			return (JSON.parse(res?.output ?? "[]") as string[]).map((p) =>
				path.basename(p),
			);
		};

		expect((await run("**/*.ts")).sort()).toEqual(
			["a.ts", "keep.ts", "deep.ts"].sort(),
		);
		expect(await run("src/*.tsx")).toEqual(["app.tsx"]);
		expect(await run("*.txt")).toEqual(["notes.txt"]);
		expect(await run("src/sub/*.ts")).toEqual(["deep.ts"]);

		await fs.rm(workspace, { recursive: true, force: true });
	});
});
