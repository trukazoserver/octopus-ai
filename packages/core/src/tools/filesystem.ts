import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolDefinition, ToolResult } from "./registry.js";

function expandHome(filePath: string): string {
	if (filePath.startsWith("~")) {
		return path.join(os.homedir(), filePath.slice(1));
	}
	return filePath;
}

function isPathAllowed(resolvedPath: string, allowedPaths: string[]): boolean {
	if (allowedPaths.length === 0) return true;
	const expandedAllowed = allowedPaths.map((p) => {
		const expanded = expandHome(p);
		return path.resolve(expanded);
	});
	return expandedAllowed.some((allowed) => resolvedPath.startsWith(allowed));
}

const FILE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: pulse 2s infinite ease-in-out"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>`;
const DIR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: pulse 2s infinite ease-in-out"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;

export function createFileSystemTools(
	allowedPaths: string[],
): ToolDefinition[] {
	const read_file: ToolDefinition = {
		name: "read_file",
		description: "Read the contents of a file at the specified path",
		uiIcon: FILE_SVG,
		parameters: {
			path: {
				type: "string",
				description: "The path to the file to read",
				required: true,
			},
		},
		handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
			const filePath = String(params.path);
			const resolved = path.resolve(expandHome(filePath));
			if (!isPathAllowed(resolved, allowedPaths)) {
				return {
					success: false,
					output: "",
					error: `Access denied: path '${resolved}' is not within allowed paths`,
				};
			}
			const content = await readFile(resolved, "utf-8");
			return { success: true, output: content };
		},
	};

	const write_file: ToolDefinition = {
		name: "write_file",
		description: "Write content to a file at the specified path",
		uiIcon: FILE_SVG,
		parameters: {
			path: {
				type: "string",
				description: "The path to the file to write",
				required: true,
			},
			content: {
				type: "string",
				description: "The content to write to the file",
				required: true,
			},
		},
		handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
			const filePath = String(params.path);
			const content = String(params.content);
			const resolved = path.resolve(expandHome(filePath));
			if (!isPathAllowed(resolved, allowedPaths)) {
				return {
					success: false,
					output: "",
					error: `Access denied: path '${resolved}' is not within allowed paths`,
				};
			}
			await mkdir(path.dirname(resolved), { recursive: true });
			await writeFile(resolved, content, "utf-8");
			return {
				success: true,
				output: `Successfully wrote ${content.length} bytes to ${resolved}`,
			};
		},
	};

	const list_directory: ToolDefinition = {
		name: "list_directory",
		description: "List the contents of a directory",
		uiIcon: DIR_SVG,
		parameters: {
			path: {
				type: "string",
				description: "The path to the directory to list",
				required: true,
			},
		},
		handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
			const dirPath = String(params.path);
			const resolved = path.resolve(expandHome(dirPath));
			if (!isPathAllowed(resolved, allowedPaths)) {
				return {
					success: false,
					output: "",
					error: `Access denied: path '${resolved}' is not within allowed paths`,
				};
			}
			const entries = await readdir(resolved);
			const detailed = await Promise.all(
				entries.map(async (entry) => {
					const fullPath = path.join(resolved, entry);
					try {
						const stats = await stat(fullPath);
						return {
							name: entry,
							type: stats.isDirectory() ? "directory" : "file",
							size: stats.size,
						};
					} catch {
						return { name: entry, type: "unknown", size: 0 };
					}
				}),
			);
			return { success: true, output: JSON.stringify(detailed, null, 2) };
		},
	};

	const search_files: ToolDefinition = {
		name: "search_files",
		description: "Search for files matching a glob pattern within a directory",
		uiIcon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: pulse 2s infinite ease-in-out"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
		parameters: {
			path: {
				type: "string",
				description: "The base directory to search in",
				required: true,
			},
			pattern: {
				type: "string",
				description: "Glob pattern to match files against",
				required: true,
			},
		},
		handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
			const dirPath = String(params.path);
			const pattern = String(params.pattern);
			const resolved = path.resolve(expandHome(dirPath));
			if (!isPathAllowed(resolved, allowedPaths)) {
				return {
					success: false,
					output: "",
					error: `Access denied: path '${resolved}' is not within allowed paths`,
				};
			}

			const regex = globToRegex(pattern);
			const results: string[] = [];

			async function walk(dir: string): Promise<void> {
				const entries = await readdir(dir, { withFileTypes: true });
				for (const entry of entries) {
					const fullPath = path.join(dir, entry.name);
					if (!isPathAllowed(fullPath, allowedPaths)) continue;
					if (entry.isDirectory()) {
						await walk(fullPath);
					} else if (regex.test(entry.name)) {
						results.push(fullPath);
					}
				}
			}

			await walk(resolved);
			return { success: true, output: JSON.stringify(results, null, 2) };
		},
	};

	const create_directory: ToolDefinition = {
		name: "create_directory",
		description: "Create a directory and all parent directories recursively",
		uiIcon: DIR_SVG,
		parameters: {
			path: {
				type: "string",
				description: "The path of the directory to create",
				required: true,
			},
		},
		handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
			const dirPath = String(params.path);
			const resolved = path.resolve(expandHome(dirPath));
			if (!isPathAllowed(resolved, allowedPaths)) {
				return {
					success: false,
					output: "",
					error: `Access denied: path '${resolved}' is not within allowed paths`,
				};
			}
			await mkdir(resolved, { recursive: true });
			return {
				success: true,
				output: `Directory created: ${resolved}`,
			};
		},
	};

	return [
		read_file,
		write_file,
		list_directory,
		search_files,
		create_directory,
	];
}

function globToRegex(glob: string): RegExp {
	const regexStr = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${regexStr}$`, "i");
}
