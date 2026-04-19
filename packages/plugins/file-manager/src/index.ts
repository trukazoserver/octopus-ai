import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { Plugin } from "@octopus-ai/core";

async function safeReadDir(dirPath: string): Promise<string> {
	try {
		const entries = await readdir(dirPath, { withFileTypes: true });
		const results = await Promise.all(
			entries.slice(0, 100).map(async (entry) => {
				const fullPath = path.join(dirPath, entry.name);
				try {
					const s = await stat(fullPath);
					return {
						name: entry.name,
						type: entry.isDirectory() ? "dir" : "file",
						size: s.size,
						modified: s.mtime.toISOString().split("T")[0],
					};
				} catch {
					return { name: entry.name, type: "unknown", size: 0, modified: "" };
				}
			}),
		);
		return JSON.stringify(results, null, 2);
	} catch (err) {
		return `Error listing directory: ${err instanceof Error ? err.message : String(err)}`;
	}
}

async function safeReadFile(filePath: string): Promise<string> {
	try {
		const content = await readFile(filePath, "utf-8");
		return content;
	} catch (err) {
		return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
	}
}

async function safeWriteFile(
	filePath: string,
	content: string,
): Promise<string> {
	try {
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, content, "utf-8");
		return `Successfully wrote ${content.length} bytes to ${filePath}`;
	} catch (err) {
		return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
	}
}

async function searchInFiles(
	dirPath: string,
	pattern: string,
	maxResults = 50,
): Promise<string> {
	const regex = new RegExp(pattern, "i");
	const results: Array<{ file: string; line: number; content: string }> = [];

	async function walk(dir: string): Promise<void> {
		if (results.length >= maxResults) return;
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (results.length >= maxResults) return;
			const fullPath = path.join(dir, entry.name);
			if (
				entry.isDirectory() &&
				!entry.name.startsWith(".") &&
				entry.name !== "node_modules"
			) {
				await walk(fullPath);
			} else if (entry.isFile()) {
				try {
					const content = await readFile(fullPath, "utf-8");
					const lines = content.split("\n");
					for (let i = 0; i < lines.length; i++) {
						if (results.length >= maxResults) return;
						if (regex.test(lines[i] ?? "")) {
							results.push({
								file: fullPath,
								line: i + 1,
								content: (lines[i] ?? "").trim().slice(0, 100),
							});
						}
					}
				} catch {
					/* skip unreadable files */
				}
			}
		}
	}

	try {
		await walk(dirPath);
		if (results.length === 0) {
			return `No matches found for pattern: ${pattern}`;
		}
		return results.map((r) => `${r.file}:${r.line}: ${r.content}`).join("\n");
	} catch (err) {
		return `Error searching: ${err instanceof Error ? err.message : String(err)}`;
	}
}

const plugin: Plugin = {
	manifest: {
		name: "file-manager",
		version: "1.0.0",
		description:
			"File system operations: list, read, write, search, and manage files",
		author: "OctopusTeam",
	},
	commands: [
		{
			name: "/ls",
			description: "List directory contents. Usage: /ls <path>",
			execute: async (args: string[]) => {
				const dirPath = args[0] ?? ".";
				return safeReadDir(path.resolve(dirPath));
			},
		},
		{
			name: "/read",
			description: "Read file contents. Usage: /read <file-path>",
			execute: async (args: string[]) => {
				const filePath = args[0];
				if (!filePath) return "Usage: /read <file-path>";
				return safeReadFile(path.resolve(filePath));
			},
		},
		{
			name: "/write",
			description:
				"Write content to a file. Usage: /write <file-path> <content>",
			execute: async (args: string[]) => {
				const filePath = args[0];
				const content = args.slice(1).join(" ");
				if (!filePath || !content) return "Usage: /write <file-path> <content>";
				return safeWriteFile(path.resolve(filePath), content);
			},
		},
		{
			name: "/search",
			description:
				"Search for a pattern in files. Usage: /search <dir-path> <regex-pattern>",
			execute: async (args: string[]) => {
				const dirPath = args[0] ?? ".";
				const pattern = args.slice(1).join(" ");
				if (!pattern) return "Usage: /search <dir-path> <regex-pattern>";
				return searchInFiles(path.resolve(dirPath), pattern);
			},
		},
	],
	onLoad: async () => {},
};

export default plugin;
