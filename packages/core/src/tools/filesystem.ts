import {
	copyFile,
	lstat,
	mkdir,
	readFile,
	readdir,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	assertRealPathInside,
	expandHome,
	isPathInsideAny,
} from "../utils/path-safety.js";
import type { ToolDefinition, ToolResult } from "./registry.js";

function isPathAllowed(resolvedPath: string, allowedPaths: string[]): boolean {
	const expandedAllowed = allowedPaths.map((p) => {
		const expanded = expandHome(p);
		return path.resolve(expanded);
	});
	return isPathInsideAny(resolvedPath, expandedAllowed);
}

const FILE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: pulse 2s infinite ease-in-out"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>`;
const DIR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: pulse 2s infinite ease-in-out"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;

export function createFileSystemTools(
	allowedPaths: string[],
	workspaceDir: string = path.join(os.homedir(), ".octopus", "workspace"),
): ToolDefinition[] {
	// Relative paths resolve against the Octopus workspace (not process.cwd()),
	// so generated files always land in a single predictable place instead of
	// polluting whatever directory Octopus was launched from. Parent-directory
	// escapes (..) are rejected; to reach files outside the workspace the agent
	// must use an absolute/~/ path within the allowed paths.
	const resolveToolPath = (
		filePath: string,
	): { ok: true; resolved: string } | { ok: false; error: string } => {
		const expanded = expandHome(filePath);
		if (path.isAbsolute(expanded)) {
			return { ok: true, resolved: path.resolve(expanded) };
		}
		const resolved = path.resolve(workspaceDir, expanded);
		if (!isPathInsideAny(resolved, [workspaceDir])) {
			return {
				ok: false,
				error: `Relative path '${filePath}' escapes the Octopus workspace. To read or write files outside ~/.octopus/workspace, use an absolute path or ~/... within your allowed paths.`,
			};
		}
		return { ok: true, resolved };
	};
	// Combines the lexical allowed-paths check with a real-path (symlink/junction)
	// check. Returns null when the path is authorized, or an error ToolResult.
	const authorize = async (resolved: string): Promise<ToolResult | null> => {
		if (!isPathAllowed(resolved, allowedPaths)) {
			return {
				success: false,
				output: "",
				error: `Access denied: path '${resolved}' is not within allowed paths`,
			};
		}
		try {
			await assertRealPathInside(resolved, allowedPaths);
		} catch (err) {
			return {
				success: false,
				output: "",
				error: err instanceof Error ? err.message : String(err),
			};
		}
		return null;
	};
	const read_file: ToolDefinition = {
		name: "read_file",
		description: "Read the contents of a file at the specified path",
		uiIcon: FILE_SVG,
		managesOwnPathPolicy: true,
		parameters: {
			path: {
				type: "string",
				description: "The path to the file to read",
				required: true,
			},
		},
		handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
			const filePath = String(params.path);
			const pathResult = resolveToolPath(filePath);
			if (!pathResult.ok) {
				return { success: false, output: "", error: pathResult.error };
			}
			const resolved = pathResult.resolved;
			const denied = await authorize(resolved);
			if (denied) return denied;
			const content = await readFile(resolved, "utf-8");
			return { success: true, output: content };
		},
	};

	const write_file: ToolDefinition = {
		name: "write_file",
		description:
			"Write content to a file at the specified path. On success the tool returns the ABSOLUTE path of the written file — always report that absolute path to the user (not just the filename) and, for HTML or other viewable files, preview it with browser_open_file so the user can see it.",
		uiIcon: FILE_SVG,
		managesOwnPathPolicy: true,
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
			const pathResult = resolveToolPath(filePath);
			if (!pathResult.ok) {
				return { success: false, output: "", error: pathResult.error };
			}
			const resolved = pathResult.resolved;
			const denied = await authorize(resolved);
			if (denied) return denied;
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
		managesOwnPathPolicy: true,
		parameters: {
			path: {
				type: "string",
				description: "The path to the directory to list",
				required: true,
			},
		},
		handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
			const dirPath = String(params.path);
			const pathResult = resolveToolPath(dirPath);
			if (!pathResult.ok) {
				return { success: false, output: "", error: pathResult.error };
			}
			const resolved = pathResult.resolved;
			const denied = await authorize(resolved);
			if (denied) return denied;
			const entries = await readdir(resolved);
			const detailed = await Promise.all(
				entries.map(async (entry) => {
					const fullPath = path.join(resolved, entry);
					try {
						const stats = await lstat(fullPath);
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
		description:
			"Search for files matching a glob pattern within a directory. `**` matches across directories (e.g. **/*.ts), `*` matches within one path segment (e.g. src/*.tsx), `?` matches one char. Patterns match the path relative to the search directory.",
		uiIcon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: pulse 2s infinite ease-in-out"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
		managesOwnPathPolicy: true,
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
			const pathResult = resolveToolPath(dirPath);
			if (!pathResult.ok) {
				return { success: false, output: "", error: pathResult.error };
			}
			const resolved = pathResult.resolved;
			const denied = await authorize(resolved);
			if (denied) return denied;

			const regex = globToRegex(pattern);
			const results: string[] = [];

			const baseDir = resolved;
			async function walk(dir: string): Promise<void> {
				const entries = await readdir(dir, { withFileTypes: true });
				for (const entry of entries) {
					const fullPath = path.join(dir, entry.name);
					// Authorize each entry (allowed paths + realpath) so a
					// symlink/junction inside the tree can't leak paths outside.
					const denied = await authorize(fullPath);
					if (denied) continue;
					if (entry.isDirectory()) {
						await walk(fullPath);
					} else {
						const rel = path
							.relative(baseDir, fullPath)
							.split(path.sep)
							.join("/");
						if (regex.test(rel)) results.push(fullPath);
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
		managesOwnPathPolicy: true,
		parameters: {
			path: {
				type: "string",
				description: "The path of the directory to create",
				required: true,
			},
		},
		handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
			const dirPath = String(params.path);
			const pathResult = resolveToolPath(dirPath);
			if (!pathResult.ok) {
				return { success: false, output: "", error: pathResult.error };
			}
			const resolved = pathResult.resolved;
			const denied = await authorize(resolved);
			if (denied) return denied;
			await mkdir(resolved, { recursive: true });
			return {
				success: true,
				output: `Directory created: ${resolved}`,
			};
		},
	};

	const move_file: ToolDefinition = {
		name: "move_file",
		description: "Move or rename a file from source to destination",
		uiIcon: FILE_SVG,
		managesOwnPathPolicy: true,
		parameters: {
			source: {
				type: "string",
				description: "Path of the file to move",
				required: true,
			},
			destination: {
				type: "string",
				description: "Destination path",
				required: true,
			},
		},
		handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
			const src = resolveToolPath(String(params.source));
			if (!src.ok) return { success: false, output: "", error: src.error };
			const dest = resolveToolPath(String(params.destination));
			if (!dest.ok) return { success: false, output: "", error: dest.error };
			const srcDenied = await authorize(src.resolved);
			if (srcDenied) return srcDenied;
			const destDenied = await authorize(dest.resolved);
			if (destDenied) return destDenied;
			try {
				await mkdir(path.dirname(dest.resolved), { recursive: true });
				await rename(src.resolved, dest.resolved);
				return {
					success: true,
					output: `Moved ${src.resolved} -> ${dest.resolved}`,
				};
			} catch (err) {
				return {
					success: false,
					output: "",
					error: `Failed to move: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
		},
	};

	const copy_file: ToolDefinition = {
		name: "copy_file",
		description: "Copy a file from source to destination",
		uiIcon: FILE_SVG,
		managesOwnPathPolicy: true,
		parameters: {
			source: {
				type: "string",
				description: "Path of the file to copy",
				required: true,
			},
			destination: {
				type: "string",
				description: "Destination path",
				required: true,
			},
		},
		handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
			const src = resolveToolPath(String(params.source));
			if (!src.ok) return { success: false, output: "", error: src.error };
			const dest = resolveToolPath(String(params.destination));
			if (!dest.ok) return { success: false, output: "", error: dest.error };
			const srcDenied = await authorize(src.resolved);
			if (srcDenied) return srcDenied;
			const destDenied = await authorize(dest.resolved);
			if (destDenied) return destDenied;
			try {
				await mkdir(path.dirname(dest.resolved), { recursive: true });
				await copyFile(src.resolved, dest.resolved);
				return {
					success: true,
					output: `Copied ${src.resolved} -> ${dest.resolved}`,
				};
			} catch (err) {
				return {
					success: false,
					output: "",
					error: `Failed to copy: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
		},
	};

	const delete_file: ToolDefinition = {
		name: "delete_file",
		description: "Delete a file",
		uiIcon: FILE_SVG,
		managesOwnPathPolicy: true,
		parameters: {
			path: {
				type: "string",
				description: "Path of the file to delete",
				required: true,
			},
		},
		handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
			const pathResult = resolveToolPath(String(params.path));
			if (!pathResult.ok) {
				return { success: false, output: "", error: pathResult.error };
			}
			const resolved = pathResult.resolved;
			const denied = await authorize(resolved);
			if (denied) return denied;
			try {
				await unlink(resolved);
				return { success: true, output: `Deleted ${resolved}` };
			} catch (err) {
				return {
					success: false,
					output: "",
					error: `Failed to delete: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
		},
	};

	return [
		read_file,
		write_file,
		list_directory,
		search_files,
		create_directory,
		move_file,
		copy_file,
		delete_file,
	];
}

function globToRegex(glob: string): RegExp {
	// Translate a glob into a regex matched against forward-slash relative paths.
	// ** matches across directories; * matches within a single segment; ? is one
	// non-separator char. Backslashes are treated as separators too.
	const normalized = glob.replace(/\\/g, "/");
	const special = new Set([
		".",
		"+",
		"^",
		"$",
		"{",
		"}",
		"(",
		")",
		"|",
		"[",
		"]",
		"\\",
	]);
	let pattern = "^";
	let i = 0;
	while (i < normalized.length) {
		const c = normalized[i];
		if (c === "*") {
			if (normalized[i + 1] === "*") {
				i += 2;
				if (normalized[i] === "/") i += 1;
				pattern += "(?:.*/)?";
			} else {
				pattern += "[^/]*";
				i += 1;
			}
		} else if (c === "?") {
			pattern += "[^/]";
			i += 1;
		} else if (special.has(c)) {
			pattern += `\\${c}`;
			i += 1;
		} else {
			pattern += c;
			i += 1;
		}
	}
	pattern += "$";
	return new RegExp(pattern, "i");
}
