import * as path from "node:path";
import * as os from "node:os";
import type { ToolDefinition, ToolResult } from "./registry.js";
import { ToolRegistry } from "./registry.js";

export class ToolExecutor {
  private registry: ToolRegistry;
  private sandboxCommands: boolean;
  private allowedPaths: string[];

  constructor(
    registry: ToolRegistry,
    config: { sandboxCommands: boolean; allowedPaths: string[] },
  ) {
    this.registry = registry;
    this.sandboxCommands = config.sandboxCommands;
    this.allowedPaths = config.allowedPaths.map((p) =>
      path.resolve(p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p),
    );
  }

  async execute(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    const tool = this.registry.get(toolName);
    if (!tool) {
      return {
        success: false,
        output: "",
        error: `Tool not found: ${toolName}`,
      };
    }

    const validation = this.validateParams(tool, params);
    if (!validation.valid) {
      return {
        success: false,
        output: "",
        error: `Missing required parameters: ${validation.missing.join(", ")}`,
      };
    }

    if (params.path && typeof params.path === "string") {
      const resolved = path.resolve(
        params.path.startsWith("~")
          ? path.join(os.homedir(), params.path.slice(1))
          : params.path,
      );
      if (
        this.allowedPaths.length > 0 &&
        !this.allowedPaths.some((allowed) => resolved.startsWith(allowed))
      ) {
        return {
          success: false,
          output: "",
          error: `Access denied: path '${resolved}' is not within allowed paths`,
        };
      }
    }

    if (
      this.sandboxCommands &&
      params.command &&
      typeof params.command === "string"
    ) {
      const dangerous = [
        /rm\s+-rf\s+\//,
        /:\(\)\{\s*:\|\:&\s*\}/,
        /\bformat\s+[a-zA-Z]:/i,
        /\bdel\s+\/[sS]/,
        /\bshutdown\b/,
        /\breboot\b/,
        /\bmkfs\b/,
      ];
      if (dangerous.some((p) => p.test(params.command as string))) {
        return {
          success: false,
          output: "",
          error: `Command blocked by sandbox policy`,
        };
      }
    }

    try {
      const result = await tool.handler(params);
      return result;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: "",
        error: `Tool execution failed: ${message}`,
      };
    }
  }

  async executeMultiple(
    calls: Array<{ name: string; params: Record<string, unknown> }>,
  ): Promise<ToolResult[]> {
    return Promise.all(
      calls.map((call) => this.execute(call.name, call.params)),
    );
  }

  private validateParams(
    tool: ToolDefinition,
    params: Record<string, unknown>,
  ): { valid: boolean; missing: string[] } {
    const requiredKeys = Object.entries(tool.parameters)
      .filter(([, param]) => param.required)
      .map(([key]) => key);

    const missing = requiredKeys.filter(
      (key) => params[key] === undefined || params[key] === null,
    );

    return {
      valid: missing.length === 0,
      missing,
    };
  }
}
