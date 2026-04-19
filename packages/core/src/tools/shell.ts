import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDefinition, ToolResult } from "./registry.js";

const execAsync = promisify(exec);

const DANGEROUS_PATTERNS = [
	/rm\s+-rf\s+\//,
	/rm\s+-rf\s+\~/,
	/:\(\)\{\s*:\|\:&\s*\}/,
	/\bformat\s+[a-zA-Z]:/i,
	/\bdel\s+\/[sS]/,
	/\brd\s+\/[sS]/,
	/\bshutdown\b/,
	/\breboot\b/,
	/\bmkfs\b/,
	/\bdd\s+if=/,
	/\b>\s*\/dev\//,
	/\bchmod\s+-R\s+777\s+\//,
	/\bchown\s+-R\s+\//,
	/\bmv\s+\/\s+/,
	/\bkill\s+-9\s+1\b/,
];

function isCommandDangerous(command: string): boolean {
	return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}

export function createShellTool(config: {
	sandboxCommands: boolean;
}): ToolDefinition {
	return {
		name: "run_command",
		description: "Execute a shell command and return stdout and stderr",
		parameters: {
			command: {
				type: "string",
				description: "The shell command to execute",
				required: true,
			},
			cwd: {
				type: "string",
				description:
					"Working directory for the command (defaults to current directory)",
			},
			timeout: {
				type: "number",
				description: "Timeout in milliseconds (defaults to 30000)",
			},
		},
		handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
			const command = String(params.command);
			const cwd = params.cwd ? String(params.cwd) : undefined;
			const timeout = params.timeout ? Number(params.timeout) : 30000;

			if (config.sandboxCommands && isCommandDangerous(command)) {
				return {
					success: false,
					output: "",
					error: `Command blocked by sandbox: '${command}' matches a dangerous pattern`,
				};
			}

			try {
				const { stdout, stderr } = await execAsync(command, {
					cwd,
					timeout,
					maxBuffer: 1024 * 1024 * 10,
				});
				const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
				return { success: true, output };
			} catch (err) {
				const error = err as Error & {
					stdout?: string;
					stderr?: string;
					killed?: boolean;
				};
				if (error.killed) {
					return {
						success: false,
						output: error.stdout ?? "",
						error: `Command timed out after ${timeout}ms`,
					};
				}
				const output =
					(error.stdout ?? "") +
					(error.stderr ? `\n[stderr]\n${error.stderr}` : "");
				return {
					success: false,
					output,
					error: error.message,
				};
			}
		},
	};
}
