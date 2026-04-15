import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { ToolDefinition, ToolResult } from "./registry.js";

function expandHome(filePath: string): string {
  if (filePath.startsWith("~")) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

function isPathAllowed(
  resolvedPath: string,
  allowedPaths: string[],
): boolean {
  const expandedAllowed = allowedPaths.map((p) => {
    const expanded = expandHome(p);
    return path.resolve(expanded);
  });
  return expandedAllowed.some((allowed) => resolvedPath.startsWith(allowed));
}

export function createFileSystemTools(
  allowedPaths: string[],
): ToolDefinition[] {
  const read_file: ToolDefinition = {
    name: "read_file",
    description: "Read the contents of a file at the specified path",
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
    description:
      "Search for files matching a glob pattern within a directory",
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

  return [read_file, write_file, list_directory, search_files, create_directory];
}

function globToRegex(glob: string): RegExp {
  let regexStr = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regexStr}$`, "i");
}
