import { type ExecException, exec } from "node:child_process";
import {
	mkdir,
	mkdir as mkdirAsync,
	readFile,
	unlink,
	writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ToolDefinition, ToolResult } from "./registry.js";

const execAsync = promisify(exec);

export interface CodeExecutionResult {
	success: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
	executionTime: number;
	language: string;
	artifacts: string[];
}

export interface CodeExecutorConfig {
	enabled: boolean;
	timeout: number;
	maxOutputBytes: number;
	allowedLanguages: string[];
	workspaceDir: string;
	tempDir: string;
	sandboxMode: "docker" | "local" | "isolated";
}

const DEFAULT_CODE_CONFIG: CodeExecutorConfig = {
	enabled: true,
	timeout: 30000,
	maxOutputBytes: 1024 * 1024,
	allowedLanguages: ["javascript", "typescript", "python", "bash", "sql", "powershell"],
	workspaceDir: "~/.octopus/workspace",
	tempDir: "~/.octopus/tmp",
	sandboxMode: "local",
};

const LANGUAGE_CONFIG: Record<
	string,
	{
		extension: string;
		command: (filePath: string) => string;
		prepare?: (filePath: string, code: string) => Promise<string>;
	}
> = {
	javascript: {
		extension: "js",
		command: (fp) => `node "${fp}"`,
	},
	typescript: {
		extension: "mts",
		command: (fp) => `node --experimental-strip-types "${fp}"`,
	},
	python: {
		extension: "py",
		command: (fp) => `python3 "${fp}"`,
	},
	bash: {
		extension: "sh",
		command: (fp) => `bash "${fp}"`,
	},
	sql: {
		extension: "sql",
		command: () => `echo "SQL execution requires a database connection"`,
	},
	powershell: {
		extension: "ps1",
		command: (fp) => `powershell -ExecutionPolicy Bypass -File "${fp}"`,
	},
};

export class CodeExecutor {
	private config: CodeExecutorConfig;
	private tempCounter = 0;

	constructor(config?: Partial<CodeExecutorConfig>) {
		this.config = { ...DEFAULT_CODE_CONFIG, ...config };
	}

	async initialize(): Promise<void> {
		const tempDir = this.resolvePath(this.config.tempDir);
		const workspaceDir = this.resolvePath(this.config.workspaceDir);
		await mkdirAsync(tempDir, { recursive: true });
		await mkdirAsync(workspaceDir, { recursive: true });
	}

	async executeCode(
		code: string,
		language: string,
		options?: {
			timeout?: number;
			input?: string;
			workspaceFiles?: Record<string, string>;
		},
	): Promise<CodeExecutionResult> {
		if (!this.config.enabled) {
			return {
				success: false,
				stdout: "",
				stderr: "Code execution is disabled in configuration",
				exitCode: 1,
				executionTime: 0,
				language,
				artifacts: [],
			};
		}

		const normalizedLang = language
			.toLowerCase()
			.replace(/^(ts|js)$/, (m) => (m === "ts" ? "typescript" : "javascript"));

		if (!this.config.allowedLanguages.includes(normalizedLang)) {
			return {
				success: false,
				stdout: "",
				stderr: `Language '${normalizedLang}' is not allowed. Allowed: ${this.config.allowedLanguages.join(", ")}`,
				exitCode: 1,
				executionTime: 0,
				language: normalizedLang,
				artifacts: [],
			};
		}

		const langConfig = LANGUAGE_CONFIG[normalizedLang];
		if (!langConfig) {
			return {
				success: false,
				stdout: "",
				stderr: `No execution configuration for language: ${normalizedLang}`,
				exitCode: 1,
				executionTime: 0,
				language: normalizedLang,
				artifacts: [],
			};
		}

		const tempDir = this.resolvePath(this.config.tempDir);
		const sessionId = `exec_${Date.now()}_${++this.tempCounter}`;
		const sessionDir = path.join(tempDir, sessionId);
		await mkdirAsync(sessionDir, { recursive: true });

		try {
			if (options?.workspaceFiles) {
				for (const [fileName, content] of Object.entries(
					options.workspaceFiles,
				)) {
					const filePath = path.join(sessionDir, fileName);
					await mkdirAsync(path.dirname(filePath), { recursive: true });
					await writeFile(filePath, content, "utf-8");
				}
			}

			const fileName = `main.${langConfig.extension}`;
			const filePath = path.join(sessionDir, fileName);
			await writeFile(filePath, code, "utf-8");

			if (langConfig.prepare) {
				await langConfig.prepare(filePath, code);
			}

			const command = langConfig.command(filePath);
			const timeout = options?.timeout ?? this.config.timeout;
			const startTime = Date.now();

			let result: { stdout: string; stderr: string; exitCode: number };
			try {
				const execOptions: {
					cwd: string;
					timeout: number;
					maxBuffer: number;
					env: Record<string, string | undefined>;
				} = {
					cwd: sessionDir,
					timeout,
					maxBuffer: this.config.maxOutputBytes,
					env: {
						...process.env,
						NODE_NO_WARNINGS: "1",
					},
				};

				if (options?.input) {
					const { stdout, stderr } = await new Promise<{
						stdout: string;
						stderr: string;
					}>((resolve, reject) => {
						const child = exec(
							command,
							execOptions,
							(err: ExecException | null, stdout: string, stderr: string) => {
								if (err) reject(err);
								else resolve({ stdout, stderr });
							},
						);
						child.stdin?.end(options.input);
					});
					result = { stdout, stderr, exitCode: 0 };
				} else {
					const { stdout, stderr } = await execAsync(command, execOptions);
					result = { stdout, stderr, exitCode: 0 };
				}
			} catch (err) {
				const error = err as Error & {
					stdout?: string;
					stderr?: string;
					code?: number;
					killed?: boolean;
				};
				result = {
					stdout: error.stdout ?? "",
					stderr: `${
						(error.killed ? `Execution timed out after ${timeout}ms\n` : "") +
						(error.stderr ?? "")
					}\n${error.message}`,
					exitCode: error.killed ? 124 : (error.code ?? 1),
				};
			}

			const executionTime = Date.now() - startTime;

			const artifacts = await this.detectArtifacts(sessionDir, fileName);

			if (result.stdout.length > this.config.maxOutputBytes) {
				result.stdout = `${result.stdout.slice(0, this.config.maxOutputBytes)}\n... [output truncated at ${this.config.maxOutputBytes} bytes]`;
			}

			return {
				success: result.exitCode === 0,
				...result,
				executionTime,
				language: normalizedLang,
				artifacts,
			};
		} finally {
			await this.cleanup(sessionDir);
		}
	}

	async executeAndCollect(
		code: string,
		language: string,
		options?: {
			timeout?: number;
			input?: string;
		},
	): Promise<CodeExecutionResult & { files: Record<string, string> }> {
		const tempDir = this.resolvePath(this.config.tempDir);
		const sessionId = `collect_${Date.now()}_${++this.tempCounter}`;
		const sessionDir = path.join(tempDir, sessionId);
		await mkdirAsync(sessionDir, { recursive: true });

		const result = await this.executeCode(code, language, {
			...options,
			workspaceFiles: {},
		});

		const files: Record<string, string> = {};
		for (const artifact of result.artifacts) {
			try {
				const content = await readFile(artifact, "utf-8");
				files[path.basename(artifact)] = content;
			} catch {
				/* ignore */
			}
		}

		return { ...result, files };
	}

	createTools(): ToolDefinition[] {
		return [
			this.createExecuteCodeTool(),
			this.createInstallPackageTool(),
			this.createCreateToolTool(),
			this.createWorkspaceTool(),
		];
	}

	private createExecuteCodeTool(): ToolDefinition {
		return {
			name: "execute_code",
			description:
				"Execute code in JavaScript, TypeScript, Python, or Bash. Returns stdout, stderr, and any generated artifacts. Use this to run calculations, process data, test code snippets, or perform any computational task.",
			uiIcon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: pulse 2s infinite ease-in-out"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>`,
			parameters: {
				code: {
					type: "string",
					description: "The code to execute",
					required: true,
				},
				language: {
					type: "string",
					description:
						"Programming language: javascript, typescript, python, bash, powershell",
					required: true,
				},
				timeout: {
					type: "number",
					description: "Timeout in milliseconds (default 30000, max 120000)",
				},
				input: {
					type: "string",
					description: "Optional stdin input for the program",
				},
			},
			handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
				const code = String(params.code);
				const language = String(params.language);
				const timeout = params.timeout
					? Math.min(Number(params.timeout), 120000)
					: undefined;
				const input = params.input ? String(params.input) : undefined;

				const result = await this.executeCode(code, language, {
					timeout,
					input,
				});

				let output = "";
				if (result.stdout) output += result.stdout;
				if (result.stderr) {
					output += `${output ? "\n" : ""}[stderr]\n${result.stderr}`;
				}
				output += `\n[Execution: ${result.executionTime}ms, exit code: ${result.exitCode}]`;

				if (result.artifacts.length > 0) {
					output += `\n[Artifacts: ${result.artifacts.join(", ")}]`;
				}

				return {
					success: result.success,
					output: result.success ? output : "",
					error: result.success ? undefined : output,
					metadata: {
						executionTime: result.executionTime,
						exitCode: result.exitCode,
						language: result.language,
						artifacts: result.artifacts,
					},
				};
			},
		};
	}

	private createInstallPackageTool(): ToolDefinition {
		return {
			name: "install_package",
			description:
				"Install an npm or pip package to extend available capabilities. Use 'npm' for Node.js packages or 'pip' for Python packages.",
			uiIcon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: pulse 2s infinite ease-in-out"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>`,
			parameters: {
				package: {
					type: "string",
					description:
						"Package name (e.g. 'lodash' for npm, 'requests' for pip)",
					required: true,
				},
				manager: {
					type: "string",
					description: "Package manager: 'npm' or 'pip' (default: 'npm')",
				},
			},
			handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
				const pkg = String(params.package);
				const manager = String(params.manager ?? "npm");

				if (!/^[a-zA-Z0-9@._/-]+$/.test(pkg)) {
					return {
						success: false,
						output: "",
						error: `Invalid package name: ${pkg}`,
					};
				}

				let command: string;
				if (manager === "pip") {
					command = `pip install "${pkg}" --target "${this.resolvePath(this.config.workspaceDir)}/python-libs" 2>&1 || pip3 install "${pkg}" --target "${this.resolvePath(this.config.workspaceDir)}/python-libs" 2>&1`;
				} else {
					const wsDir = this.resolvePath(this.config.workspaceDir);
					command = `cd "${wsDir}" && npm install "${pkg}" --save 2>&1`;
				}

				try {
					const { stdout, stderr } = await execAsync(command, {
						timeout: 120000,
						maxBuffer: 1024 * 1024 * 5,
					});
					return {
						success: true,
						output: stdout + (stderr ? `\n[stderr]\n${stderr}` : ""),
					};
				} catch (err) {
					const error = err as Error & { stdout?: string; stderr?: string };
					return {
						success: false,
						output: error.stdout ?? "",
						error: error.stderr ?? error.message,
					};
				}
			},
		};
	}

	private createCreateToolTool(): ToolDefinition {
		return {
			name: "create_tool",
			description:
				"Create a new tool/plugin that can be used by Octopus AI. Provide a name, description, the code implementation, and the tool will be saved and registered for future use. The code should export a default function that receives params and returns a result.",
			uiIcon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: pulse 2s infinite ease-in-out"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>`,
			parameters: {
				name: {
					type: "string",
					description:
						"Tool name (lowercase, hyphens allowed, e.g. 'format-json')",
					required: true,
				},
				description: {
					type: "string",
					description: "What the tool does",
					required: true,
				},
				uiIcon: {
					type: "string",
					description: "An SVG markup string for the tool's icon. Should include CSS animation (e.g. style='animation: pulse 2s infinite ease-in-out') to make it look dynamic.",
				},
				code: {
					type: "string",
					description:
						"The tool implementation code. Must export a default async function(params) that returns { success, output, error? }",
					required: true,
				},
				language: {
					type: "string",
					description: "Language of the tool code (default: 'javascript')",
				},
				parameters_schema: {
					type: "string",
					description:
						'JSON string describing tool parameters, e.g. \'{"input":{"type":"string","description":"Input data","required":true}}\'',
				},
			},
			handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
				const name = String(params.name)
					.toLowerCase()
					.replace(/[^a-z0-9-]/g, "-");
				const description = String(params.description);
				const code = String(params.code);
				const language = String(params.language ?? "javascript");
				const parametersSchema = params.parameters_schema
					? String(params.parameters_schema)
					: "{}";

				if (!name || name.length < 2) {
					return {
						success: false,
						output: "",
						error: "Tool name must be at least 2 characters",
					};
				}

				if (!/^[a-z][a-z0-9-]*$/.test(name)) {
					return {
						success: false,
						output: "",
						error:
							"Tool name must start with a letter and contain only lowercase letters, numbers, and hyphens",
					};
				}

				const skillsDir = path.join(os.homedir(), ".octopus", "tools");
				await mkdirAsync(skillsDir, { recursive: true });

				const toolDir = path.join(skillsDir, name);
				await mkdirAsync(toolDir, { recursive: true });

				const ext = language === "typescript" ? "mts" : "mjs";
				const codePath = path.join(toolDir, `index.${ext}`);
				await writeFile(codePath, code, "utf-8");

				const uiIcon = params.uiIcon ? String(params.uiIcon) : undefined;

				const manifest = {
					name,
					version: "1.0.0",
					description,
					uiIcon,
					language,
					type: "dynamic-tool",
					parameters: JSON.parse(parametersSchema),
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				};
				const manifestPath = path.join(toolDir, "manifest.json");
				await writeFile(
					manifestPath,
					JSON.stringify(manifest, null, 2),
					"utf-8",
				);

				return {
					success: true,
					output: `Tool '${name}' created successfully at ${toolDir}\n\nFiles created:\n- ${codePath}\n- ${manifestPath}\n\nThe tool will be available after restart or via dynamic loading.`,
					metadata: { toolName: name, path: toolDir },
				};
			},
		};
	}

	private createWorkspaceTool(): ToolDefinition {
		return {
			name: "manage_workspace",
			description:
				"Manage the workspace directory. List, read, write, or delete files in the Octopus AI workspace. Use this to organize project files, save outputs, and manage artifacts.",
			uiIcon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: pulse 2s infinite ease-in-out"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`,
			parameters: {
				action: {
					type: "string",
					description: "Action: 'list', 'read', 'write', 'delete', 'mkdir'",
					required: true,
				},
				path: {
					type: "string",
					description: "File or directory path relative to workspace root",
					required: true,
				},
				content: {
					type: "string",
					description: "Content to write (for 'write' action)",
				},
			},
			handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
				const action = String(params.action);
				const relPath = String(params.path);
				const content = params.content ? String(params.content) : undefined;

				const workspaceRoot = this.resolvePath(this.config.workspaceDir);
				const fullPath = path.resolve(workspaceRoot, relPath);

				if (!fullPath.startsWith(workspaceRoot)) {
					return {
						success: false,
						output: "",
						error: "Access denied: path outside workspace",
					};
				}

				switch (action) {
					case "list": {
						try {
							const entries = await import("node:fs/promises").then((fs) =>
								fs.readdir(fullPath, { withFileTypes: true }),
							);
							const listing = entries.map((e) => ({
								name: e.name,
								type: e.isDirectory() ? "dir" : "file",
							}));
							return {
								success: true,
								output: JSON.stringify(listing, null, 2),
							};
						} catch (err) {
							return {
								success: false,
								output: "",
								error: `Failed to list: ${err instanceof Error ? err.message : String(err)}`,
							};
						}
					}
					case "read": {
						try {
							const data = await readFile(fullPath, "utf-8");
							return { success: true, output: data };
						} catch (err) {
							return {
								success: false,
								output: "",
								error: `Failed to read: ${err instanceof Error ? err.message : String(err)}`,
							};
						}
					}
					case "write": {
						if (content === undefined) {
							return {
								success: false,
								output: "",
								error: "Content is required for write action",
							};
						}
						try {
							await mkdirAsync(path.dirname(fullPath), { recursive: true });
							await writeFile(fullPath, content, "utf-8");
							return {
								success: true,
								output: `Written ${content.length} bytes to ${relPath}`,
							};
						} catch (err) {
							return {
								success: false,
								output: "",
								error: `Failed to write: ${err instanceof Error ? err.message : String(err)}`,
							};
						}
					}
					case "delete": {
						try {
							await unlink(fullPath);
							return {
								success: true,
								output: `Deleted ${relPath}`,
							};
						} catch (err) {
							return {
								success: false,
								output: "",
								error: `Failed to delete: ${err instanceof Error ? err.message : String(err)}`,
							};
						}
					}
					case "mkdir": {
						try {
							await mkdirAsync(fullPath, { recursive: true });
							return {
								success: true,
								output: `Created directory ${relPath}`,
							};
						} catch (err) {
							return {
								success: false,
								output: "",
								error: `Failed to create directory: ${err instanceof Error ? err.message : String(err)}`,
							};
						}
					}
					default:
						return {
							success: false,
							output: "",
							error: `Unknown action: ${action}. Use: list, read, write, delete, mkdir`,
						};
				}
			},
		};
	}

	private async detectArtifacts(
		sessionDir: string,
		mainFile: string,
	): Promise<string[]> {
		const artifacts: string[] = [];
		try {
			const entries = await import("node:fs/promises").then((fs) =>
				fs.readdir(sessionDir, { withFileTypes: true }),
			);
			for (const entry of entries) {
				if (entry.name !== mainFile && entry.isFile()) {
					artifacts.push(path.join(sessionDir, entry.name));
				}
			}
		} catch {
			/* ignore */
		}
		return artifacts;
	}

	private async cleanup(dir: string): Promise<void> {
		try {
			await import("node:fs/promises").then((fs) =>
				fs.rm(dir, { recursive: true, force: true }),
			);
		} catch {
			/* ignore cleanup failures */
		}
	}

	private resolvePath(p: string): string {
		if (p.startsWith("~")) {
			return path.join(os.homedir(), p.slice(1));
		}
		return path.resolve(p);
	}
}

export function createCodeTools(
	config?: Partial<CodeExecutorConfig>,
): ToolDefinition[] {
	const executor = new CodeExecutor(config);
	return executor.createTools();
}
