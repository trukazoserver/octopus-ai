import type { ToolDefinition } from "./registry.js";
import { DockerSandbox } from "./sandbox.js";

export function createSandboxTools(): ToolDefinition[] {
	const sandbox = new DockerSandbox({
		image: "node:20-slim",
		memoryLimit: "512m",
		timeout: 60000,
		allowUnsafeFallback: false,
		validateCommands: true,
	});

	return [
		{
			name: "sandbox_execute",
			description:
				"Execute a command in an isolated Docker container sandbox. Use this for running untrusted code, installing packages in isolation, or performing potentially destructive operations safely. The container has no network access and is destroyed after execution. Requires Docker to be installed.",
			uiIcon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: pulse 2s infinite ease-in-out"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="3" y1="15" x2="21" y2="15"></line><line x1="9" y1="3" x2="9" y2="21"></line><line x1="15" y1="3" x2="15" y2="21"></line></svg>`,
			parameters: {
				command: {
					type: "string",
					description:
						"The shell command to execute inside the Docker container (e.g. 'node -e \"console.log(1+1)\"').",
					required: true,
				},
				image: {
					type: "string",
					description:
						"Docker image to use (default: node:20-slim). Use python:3.12-slim for Python, etc.",
				},
			},
			handler: async (args) => {
				const command = String(args.command);
				if (!command) {
					return {
						success: false,
						output: "",
						error: "Missing 'command' parameter.",
					};
				}

				// Override image if specified
				if (args.image && typeof args.image === "string") {
					(sandbox as any).image = args.image;
				}

				try {
					const available = await sandbox.isAvailable();
					if (!available) {
						return {
							success: false,
							output: "",
							error:
								"Docker is not installed or not running. Cannot execute in sandbox. Install Docker Desktop to enable this feature.",
						};
					}

					const result = await sandbox.execute(command);
					const output = [
						result.stdout ? `STDOUT:\n${result.stdout}` : "",
						result.stderr ? `STDERR:\n${result.stderr}` : "",
						`Exit Code: ${result.exitCode}`,
					]
						.filter(Boolean)
						.join("\n\n");

					return {
						success: result.exitCode === 0,
						output,
						error:
							result.exitCode !== 0
								? `Command exited with code ${result.exitCode}`
								: undefined,
					};
				} catch (err: unknown) {
					return {
						success: false,
						output: "",
						error: `Sandbox execution failed: ${(err as Error).message}`,
					};
				}
			},
		},
	];
}
