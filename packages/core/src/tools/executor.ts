import * as os from "node:os";
import * as path from "node:path";
import type { ToolDefinition, ToolResult, ToolContext } from "./registry.js";
import type { ToolRegistry } from "./registry.js";
import { mediaContext } from "./media.js";

const DEFAULT_TOOL_TIMEOUT_MS = 45_000;
const LONG_RUNNING_TOOL_TIMEOUT_MS = 90_000;
const DELEGATE_TASK_TIMEOUT_MS = 300_000;
const CAPTCHA_TOOL_TIMEOUT_MS = 150_000;
const SCRAPING_TOOL_TIMEOUT_MS = 165_000;

export interface ToolTimeoutConfig {
	defaultMs?: number;
	longRunningMs?: number;
	captchaMs?: number;
	scrapingMs?: number;
	byTool?: Record<string, number>;
}

export interface ToolExecutionContext {
	model?: string;
	usesZaiVisionToolForImages?: boolean;
}

export class ToolExecutor {
	private registry: ToolRegistry;
	private sandboxCommands: boolean;
	private allowedPaths: string[];
	private timeouts: Required<ToolTimeoutConfig>;

	constructor(
		registry: ToolRegistry,
		config: {
			sandboxCommands: boolean;
			allowedPaths: string[];
			timeouts?: ToolTimeoutConfig;
		},
	) {
		this.registry = registry;
		this.sandboxCommands = config.sandboxCommands;
		this.allowedPaths = config.allowedPaths.map((p) =>
			path.resolve(p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p),
		);
		this.timeouts = this.normalizeTimeouts(config.timeouts);
	}

	updateConfig(config: { timeouts?: ToolTimeoutConfig }): void {
		if (config.timeouts) {
			this.timeouts = this.normalizeTimeouts(config.timeouts);
		}
	}

	getTimeoutConfig(): Required<ToolTimeoutConfig> {
		return {
			...this.timeouts,
			byTool: { ...this.timeouts.byTool },
		};
	}

	private normalizeTimeouts(
		timeouts?: ToolTimeoutConfig,
	): Required<ToolTimeoutConfig> {
		const positive = (value: unknown, fallback: number) => {
			const parsed = typeof value === "number" ? value : Number(value);
			return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
		};
		const byTool: Record<string, number> = {};
		for (const [toolName, timeoutMs] of Object.entries(timeouts?.byTool ?? {})) {
			byTool[toolName] = positive(timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
		}
		return {
			defaultMs: positive(timeouts?.defaultMs, DEFAULT_TOOL_TIMEOUT_MS),
			longRunningMs: positive(
				timeouts?.longRunningMs,
				LONG_RUNNING_TOOL_TIMEOUT_MS,
			),
			captchaMs: positive(timeouts?.captchaMs, CAPTCHA_TOOL_TIMEOUT_MS),
			scrapingMs: positive(timeouts?.scrapingMs, SCRAPING_TOOL_TIMEOUT_MS),
			byTool,
		};
	}

	private getTimeoutMs(toolName: string): number {
		const toolOverride = this.timeouts.byTool[toolName];
		if (Number.isFinite(toolOverride) && toolOverride > 0) {
			return toolOverride;
		}
		if (toolName === "browser_solve_captchas") {
			return this.timeouts.captchaMs;
		}
		if (toolName === "delegate_task") {
			return DELEGATE_TASK_TIMEOUT_MS;
		}
		if (toolName === "decodo_scrape") {
			return this.timeouts.scrapingMs;
		}
		if (toolName.startsWith("browser_") || toolName.includes("web") || toolName.includes("search")) {
			return this.timeouts.longRunningMs;
		}
		return this.timeouts.defaultMs;
	}

	private async withTimeout<T>(
		operation: Promise<T>,
		timeoutMs: number,
		label: string,
	): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				operation,
				new Promise<T>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
						timeoutMs,
					);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	async execute(
		toolName: string,
		params: Record<string, unknown>,
		executionContext?: ToolExecutionContext,
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
					error: "Command blocked by sandbox policy",
				};
			}
		}

		try {
			const context: ToolContext = {
				media: mediaContext,
			};
			if (executionContext) context.agent = executionContext;
			const result = await this.withTimeout(
				tool.handler(params, context),
				this.getTimeoutMs(toolName),
				`Tool ${toolName}`,
			);
			return result;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
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
