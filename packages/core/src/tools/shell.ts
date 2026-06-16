import { exec } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
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
import { assertRealPathInside, resolveRelativePathInside } from "../utils/path-safety.js";
import type { ToolDefinition, ToolResult } from "./registry.js";

const execAsync = promisify(exec);

export function createShellTool(config: {
	sandboxCommands: boolean;
	allowedPaths?: string[];
	workspaceDir?: string;
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
	const workspaceDir =
		config.workspaceDir ?? path.join(os.homedir(), ".octopus", "workspace");

	return {
		name: "run_command",
		description: "Execute a shell command and return stdout and stderr",
		managesOwnPathPolicy: true,
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
					"Working directory for the command (defaults to the Octopus workspace ~/.octopus/workspace). Absolute/~/ paths must be within the allowed paths.",
			},
			timeout: {
				type: "number",
				description: "Timeout in milliseconds (defaults to 30000)",
			},
		},
		handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
			const command = String(params.command);
			let cwd: string;
			try {
				if (params.cwd) {
					const requested = String(params.cwd);
					const expanded = requested.startsWith("~")
						? path.join(os.homedir(), requested.slice(1))
						: requested;
					if (path.isAbsolute(expanded)) {
						// Absolute/~/ cwd must be within allowed paths (explicit request).
						cwd = pathPolicy.assertAllowed(expanded, "Command cwd");
					} else {
						// Relative cwd is anchored to the workspace and must not escape.
						const inside = resolveRelativePathInside(workspaceDir, expanded);
						if (!inside) {
							return {
								success: false,
								output: "",
								error: `Relative cwd '${requested}' escapes the Octopus workspace. Use an absolute/~/ path within your allowed paths to run elsewhere.`,
							};
						}
						cwd = pathPolicy.assertAllowed(inside, "Command cwd");
					}
				} else {
					cwd = pathPolicy.assertAllowed(workspaceDir, "Command cwd");
				}
				// Guard against symlinks/junctions: the real cwd must stay inside the
				// allowed paths, otherwise a linked dir could redirect execution.
				await assertRealPathInside(cwd, pathPolicy.getAllowedPaths());
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
