import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface SandboxConfig {
	/**
	 * Docker image to use for sandboxed execution
	 */
	image?: string;
	/**
	 * Memory limit for container (e.g., "512m", "1g")
	 */
	memoryLimit?: string;
	/**
	 * Execution timeout in milliseconds
	 */
	timeout?: number;
	/**
	 * Whether to allow execution when Docker is unavailable
	 * WARNING: Setting this to true is a security risk!
	 */
	allowUnsafeFallback?: boolean;
	/**
	 * Whether to validate commands for dangerous patterns
	 */
	validateCommands?: boolean;
}

/**
 * Dangerous command patterns that should be blocked
 * These can bypass basic security measures
 */
const DANGEROUS_PATTERNS = [
	/rm\s+-rf?\s+\/.*/, // Recursive delete from root
	/\>\s*\/.*/, // Redirect to system files
	/\|.*rm\b/, // Pipes into delete
	/chmod\s+000/, // Removing all permissions
	/dd\s+if=.*of=\/dev\//, // Direct disk writes
	/:\(\)\{\s*:\|:&\s*\};:/, // Fork bomb
	/mkfs\.*/, // Filesystem creation
	/>\s*\/dev\/sd[a-z]/, // Direct disk access
	/curl.*\|.*sh/, // Download and execute pipe
	/wget.*\|.*sh/, // Download and execute pipe
];

export class DockerSandbox {
	private image: string;
	private memoryLimit: string;
	private timeout: number;
	private allowUnsafeFallback: boolean;
	private validateCommands: boolean;

	constructor(config: SandboxConfig = {}) {
		this.image = config.image ?? "node:20-slim";
		this.memoryLimit = config.memoryLimit ?? "512m";
		this.timeout = config.timeout ?? 30000;
		this.allowUnsafeFallback = config.allowUnsafeFallback ?? false;
		this.validateCommands = config.validateCommands ?? true;
	}

	/**
	 * Check if Docker is available
	 */
	async isAvailable(): Promise<boolean> {
		try {
			await execAsync("docker --version", { timeout: 5000 });
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Validate command for dangerous patterns
	 * @throws Error if dangerous patterns are detected
	 */
	private validateCommand(command: string): void {
		if (!this.validateCommands) return;

		const normalizedCommand = command.toLowerCase().trim();

		for (const pattern of DANGEROUS_PATTERNS) {
			if (pattern.test(normalizedCommand)) {
				throw new Error(
					`Command contains potentially dangerous pattern: ${pattern.source}. Execution blocked for security reasons.`,
				);
			}
		}
	}

	/**
	 * Execute a command in a sandboxed environment
	 * @param command - Command to execute
	 * @param options - Execution options
	 * @returns Execution result
	 * @throws Error if Docker is unavailable and unsafe fallback is disabled
	 */
	async execute(
		command: string,
		options?: {
			mounts?: Array<{ host: string; container: string; readonly?: boolean }>;
		},
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		// Validate command for dangerous patterns
		this.validateCommand(command);

		const available = await this.isAvailable();

		if (!available) {
			if (this.allowUnsafeFallback) {
				console.warn(
					"[SECURITY WARNING] Docker unavailable. Executing command directly on host without sandbox. This is a security risk!",
				);
				return this.executeUnsafe(command);
			}

			throw new Error(
				"Docker is not available. Please install Docker or set allowUnsafeFallback=true (not recommended for production).",
			);
		}

		return this.executeInDocker(command, options?.mounts);
	}

	/**
	 * Execute command in Docker container (sandboxed)
	 */
	private async executeInDocker(
		command: string,
		mounts?: Array<{ host: string; container: string; readonly?: boolean }>,
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const mountArgs = (mounts ?? [])
			.map((m) => {
				const readonlyFlag = m.readonly ? ":ro" : "";
				return `-v "${m.host}:${m.container}${readonlyFlag}"`;
			})
			.join(" ");

		// Security: isolate container with no network, memory limits, and remove after execution
		const dockerCommand = [
			"docker",
			"run",
			"--rm",
			`--memory="${this.memoryLimit}"`,
			"--network=none",
			"--cap-drop=ALL",
			"--security-opt=no-new-privileges",
			mountArgs,
			`"${this.image}"`,
			"sh",
			"-c",
			JSON.stringify(command),
		].join(" ");

		try {
			const { stdout, stderr } = await execAsync(dockerCommand, {
				timeout: this.timeout,
				maxBuffer: 1024 * 1024 * 10,
			});
			return { stdout, stderr, exitCode: 0 };
		} catch (err) {
			const error = err as Error & {
				stdout?: string;
				stderr?: string;
				code?: number;
			};
			return {
				stdout: error.stdout ?? "",
				stderr: error.stderr ?? "",
				exitCode: error.code ?? 1,
			};
		}
	}

	/**
	 * Execute command directly on host (UNSAFE - only used when fallback is enabled)
	 */
	private async executeUnsafe(
		command: string,
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		try {
			const { stdout, stderr } = await execAsync(command, {
				timeout: this.timeout,
				maxBuffer: 1024 * 1024 * 10,
			});
			return {
				stdout,
				stderr: `[UNSAFE EXECUTION] Command executed without Docker sandbox\n${stderr}`,
				exitCode: 0,
			};
		} catch (err) {
			const error = err as Error & {
				stdout?: string;
				stderr?: string;
				code?: number;
			};
			return {
				stdout: error.stdout ?? "",
				stderr: `[UNSAFE EXECUTION] Command executed without Docker sandbox\n${error.stderr ?? ""}\n${error.message}`,
				exitCode: error.code ?? 1,
			};
		}
	}
}
