import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
	type CommandApprovalConfig,
	CommandApprovalService,
} from "../security/command-approval.js";
import {
	EnvironmentFilter,
	type EnvironmentFilterConfig,
} from "../security/environment-filter.js";
import { PathSafetyPolicy } from "../security/path-safety-policy.js";
import { SecretRedactor } from "../security/secret-redactor.js";
import type { ToolDefinition, ToolResult } from "./registry.js";

const execAsync = promisify(exec);

export function createShellTool(config: {
	sandboxCommands: boolean;
	allowedPaths?: string[];
	commandApproval?: CommandApprovalConfig;
	envFiltering?: EnvironmentFilterConfig;
	redactor?: SecretRedactor;
}): ToolDefinition {
	const approval = new CommandApprovalService({
		mode: config.sandboxCommands ? "smart" : "off",
		...config.commandApproval,
	});
	const pathPolicy = new PathSafetyPolicy({
		allowedPaths: config.allowedPaths,
	});
	const envFilter = new EnvironmentFilter(config.envFiltering);
	const redactor = config.redactor ?? new SecretRedactor();

	return {
		name: "run_command",
		description: "Execute a shell command and return stdout and stderr",
		uiIcon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: pulse 2s infinite ease-in-out"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`,
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
			let cwd: string | undefined;
			try {
				cwd = params.cwd
					? pathPolicy.assertAllowed(String(params.cwd), "Command cwd")
					: undefined;
			} catch (error) {
				return {
					success: false,
					output: "",
					error: error instanceof Error ? error.message : String(error),
				};
			}
			const timeout = params.timeout ? Number(params.timeout) : 30000;

			const decision = approval.evaluate(command);
			if (!decision.allowed) {
				return {
					success: false,
					output: "",
					error: decision.reason ?? "Command blocked by security policy",
				};
			}

			try {
				const { stdout, stderr } = await execAsync(command, {
					cwd,
					timeout,
					maxBuffer: 1024 * 1024 * 10,
					env: envFilter.filter(process.env),
				});
				const output = redactor.redactText(
					stdout + (stderr ? `\n[stderr]\n${stderr}` : ""),
				);
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
						output: redactor.redactText(error.stdout ?? ""),
						error: `Command timed out after ${timeout}ms`,
					};
				}
				const output = redactor.redactText(
					(error.stdout ?? "") +
						(error.stderr ? `\n[stderr]\n${error.stderr}` : ""),
				);
				return {
					success: false,
					output,
					error: redactor.redactText(error.message),
				};
			}
		},
	};
}
