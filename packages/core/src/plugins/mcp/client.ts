import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EnvironmentFilter } from "../../security/environment-filter.js";
import { SecretRedactor } from "../../security/secret-redactor.js";
import type { MCPServerConfig } from "../types.js";

// Vision/analysis tools (e.g. Z.ai glm-4.6v analyzing a 2K/4K image) can take
// 60-90s to respond. 45s aborted those calls mid-flight (the agent reported
// "the analysis timed out" while the MCP process kept running and finished
// later). 120s leaves headroom without hanging forever on a dead server.
const MCP_REQUEST_TIMEOUT_MS = 120_000;

export interface MCPSpawnCommand {
	command: string;
	shell: boolean;
}

export interface MCPClientOptions {
	envFilter?: EnvironmentFilter;
	redactor?: SecretRedactor;
}

export function resolveMCPSpawnCommand(
	command: string,
	platform = process.platform,
): MCPSpawnCommand {
	if (
		platform === "win32" &&
		["npx", "npm", "pnpm", "yarn", "bun"].includes(command)
	) {
		return {
			command: `${command}.cmd`,
			shell: true,
		};
	}

	return {
		command,
		shell: false,
	};
}

function resolveTemplateValue(value: string): string {
	return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (match, key: string) => {
		return process.env[key] ?? match;
	});
}

function resolveTemplateRecord(
	record?: Record<string, string>,
): Record<string, string> | undefined {
	if (!record) return undefined;
	return Object.fromEntries(
		Object.entries(record).map(([key, value]) => [
			key,
			resolveTemplateValue(value),
		]),
	);
}

function resolveConfigTemplates(config: MCPServerConfig): MCPServerConfig {
	return {
		...config,
		url: config.url ? resolveTemplateValue(config.url) : config.url,
		command: config.command
			? resolveTemplateValue(config.command)
			: config.command,
		args: (config.args ?? []).map((arg) => resolveTemplateValue(arg)),
		env: resolveTemplateRecord(config.env),
		headers: resolveTemplateRecord(config.headers),
	};
}

export function createMCPProcessEnv(
	baseEnv: NodeJS.ProcessEnv,
	serverEnv: Record<string, string> | undefined,
	envFilter = new EnvironmentFilter(),
): NodeJS.ProcessEnv {
	return { ...envFilter.filter(baseEnv), ...(serverEnv ?? {}) };
}

export class MCPClient {
	private config: MCPServerConfig;
	private envFilter: EnvironmentFilter;
	private redactor: SecretRedactor;
	private process: ChildProcess | null = null;
	private pendingRequests = new Map<
		string,
		{ resolve: (val: unknown) => void; reject: (err: Error) => void }
	>();
	private buffer = "";
	private isReady = false;
	private httpSessionId?: string;

	constructor(config: MCPServerConfig, options: MCPClientOptions = {}) {
		this.config = resolveConfigTemplates(config);
		this.envFilter = options.envFilter ?? new EnvironmentFilter();
		this.redactor = options.redactor ?? new SecretRedactor();
	}

	/**
	 * Wait for the mcp-remote proxy to signal readiness.
	 * mcp-remote prints "Proxy established" to stderr when ready.
	 * We wait up to `timeout` ms for this signal.
	 */
	private waitForReady(timeout = 60_000): Promise<void> {
		return new Promise((resolve) => {
			let settled = false;
			let onData: ((chunk: Buffer) => void) | undefined;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (onData) this.process?.stderr?.off("data", onData);
				resolve();
			};
			const timer = setTimeout(() => {
				// Even if we didn't see the ready signal, try anyway after timeout
				finish();
			}, timeout);

			if (this.isReady) {
				finish();
				return;
			}

			// Check if args contain "mcp-remote" — only wait for proxy servers
			const args = this.config.args || [];
			const isMcpRemote = args.some(
				(a) => typeof a === "string" && a.includes("mcp-remote"),
			);

			if (!isMcpRemote) {
				finish();
				return;
			}

			// Listen on stderr for "Proxy established" or "Local STDIO server running"
			if (this.process?.stderr) {
				let stderrBuffer = "";
				onData = (chunk: Buffer) => {
					stderrBuffer = `${stderrBuffer}${chunk.toString("utf-8")}`.slice(-16_384);
					if (
						stderrBuffer.includes("Proxy established") ||
						stderrBuffer.includes("Local STDIO server running") ||
						stderrBuffer.includes("Connected to remote server")
					) {
						this.isReady = true;
						// Give it a small extra moment to fully stabilize
						setTimeout(finish, 500);
					}
				};
				this.process.stderr.on("data", onData);
			} else {
				// No stderr available, just wait 5 seconds for mcp-remote to start
				setTimeout(finish, 5000);
			}
		});
	}

	public async connect(): Promise<void> {
		if (this.config.url) {
			const endpoint = new URL(this.config.url);
			if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
				throw new Error("Remote MCP URL must use HTTP or HTTPS");
			}
			await this.connectHttp();
			return;
		}

		return new Promise((resolve, reject) => {
			try {
				if (!this.config.command) {
					reject(new Error("MCP stdio server requires a command"));
					return;
				}
				const spawnCommand = resolveMCPSpawnCommand(this.config.command);
				this.process = spawn(spawnCommand.command, this.config.args || [], {
					env: createMCPProcessEnv(
						process.env,
						this.config.env,
						this.envFilter,
					),
					stdio: ["pipe", "pipe", "pipe"], // changed stderr from "inherit" to "pipe" so we can read it
					shell: spawnCommand.shell,
				});

				// Forward stderr to console for debugging
				if (this.process.stderr) {
					this.process.stderr.on("data", (chunk: Buffer) => {
						const text = this.redactor.redactText(chunk.toString("utf-8"));
						console.error(
							`[MCP ${this.config.args?.find((a) => typeof a === "string" && a.includes("mcp-remote")) ? "remote" : "local"}] ${text.trim()}`,
						);
					});
				}

				this.process.on("error", (err) => {
					if (this.pendingRequests.size === 0) {
						reject(new Error(this.redactor.redactText(err.message)));
					}
				});

				this.process.on("exit", () => {
					for (const {
						reject: rejectRequest,
					} of this.pendingRequests.values()) {
						rejectRequest(new Error("Process exited"));
					}
					this.pendingRequests.clear();
					this.process = null;
				});

				if (this.process.stdout) {
					this.process.stdout.on("data", (chunk: Buffer) => {
						this.buffer += chunk.toString("utf-8");
						if (Buffer.byteLength(this.buffer, "utf8") > 10 * 1024 * 1024) {
							void this.disconnect();
							return;
						}
						this.processBuffer();
					});
				}

				// Wait for mcp-remote to be ready before sending initialize
				this.waitForReady()
					.then(() => {
						// Standard MCP initialization handshake
						this.request("initialize", {
							protocolVersion: "2024-11-05",
							capabilities: {},
							clientInfo: {
								name: "OctopusAI",
								version: "0.1.0",
							},
						})
							.then(() => {
								this.notify("notifications/initialized", {});
								resolve();
							})
							.catch((err) => {
								// Fallback to ping for non-standard servers
								this.request("ping", {})
									.then(() => resolve())
									.catch(() =>
										reject(new Error(this.redactor.redactText(err.message))),
									);
							});
					})
					.catch(reject);
			} catch (error) {
				reject(error);
			}
		});
	}

	public async disconnect(): Promise<void> {
		if (this.config.url) {
			this.httpSessionId = undefined;
			return;
		}

		if (this.process) {
			this.process.kill();
			this.process = null;
		}
		for (const { reject: rejectRequest } of this.pendingRequests.values()) {
			rejectRequest(new Error("Client disconnected"));
		}
		this.pendingRequests.clear();
		this.buffer = "";
	}

	/**
	 * Send a raw JSON-RPC request to the MCP server.
	 * Used for protocol methods like "initialize", "tools/list", "ping", etc.
	 */
	public async request<T>(method: string, params: unknown): Promise<T> {
		if (this.config.url) {
			return this.requestHttp<T>(method, params);
		}

		return new Promise((resolve, reject) => {
			if (!this.process || !this.process.stdin) {
				return reject(new Error("Process is not running"));
			}

			const id = randomUUID();
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(
					new Error(
						`MCP request "${method}" timed out after ${MCP_REQUEST_TIMEOUT_MS}ms`,
					),
				);
			}, MCP_REQUEST_TIMEOUT_MS);
			this.pendingRequests.set(id, {
				resolve: (val: unknown) => {
					clearTimeout(timer);
					resolve(val as T);
				},
				reject: (err: Error) => {
					clearTimeout(timer);
					reject(err);
				},
			});

			const message = {
				jsonrpc: "2.0",
				id,
				method,
				params,
			};

			this.process.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
				if (error) {
					clearTimeout(timer);
					this.pendingRequests.delete(id);
					reject(error);
				}
			});
		});
	}

	/**
	 * Call an MCP tool by name using the proper "tools/call" JSON-RPC method.
	 * This follows the MCP specification: method="tools/call", params={name, arguments}.
	 */
	public async callTool<T>(
		toolName: string,
		args: Record<string, unknown>,
	): Promise<T> {
		return this.request<T>("tools/call", {
			name: toolName,
			arguments: args,
		});
	}

	public notify(method: string, params: unknown): void {
		if (this.config.url) {
			void this.postHttp({
				jsonrpc: "2.0",
				method,
				params,
			}).catch(() => {});
			return;
		}

		if (!this.process || !this.process.stdin) {
			throw new Error("Process is not running");
		}

		const message = {
			jsonrpc: "2.0",
			method,
			params,
		};

		this.process.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private async connectHttp(): Promise<void> {
		await this.requestHttp("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: {
				name: "OctopusAI",
				version: "0.1.0",
			},
		});
		this.notify("notifications/initialized", {});
	}

	private async requestHttp<T>(method: string, params: unknown): Promise<T> {
		const id = randomUUID();
		const result = await this.postHttp({
			jsonrpc: "2.0",
			id,
			method,
			params,
		});

		if (typeof result === "object" && result !== null) {
			const message = result as Record<string, unknown>;
			if (message.error) {
				const err = message.error as Record<string, unknown>;
				throw new Error(
					this.redactor.redactText(String(err.message ?? "JSON-RPC Error")),
				);
			}
			if ("result" in message) {
				return message.result as T;
			}
			if ("code" in message || "msg" in message) {
				throw new Error(
					this.redactor.redactText(
						String(message.msg ?? message.code ?? "MCP HTTP error"),
					),
				);
			}
		}

		throw new Error("Invalid MCP HTTP response");
	}

	private async postHttp(message: Record<string, unknown>): Promise<unknown> {
		if (!this.config.url) {
			throw new Error("MCP HTTP server requires a url");
		}

		const response = await fetch(this.config.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				...(this.httpSessionId ? { "mcp-session-id": this.httpSessionId } : {}),
				...(this.config.headers ?? {}),
			},
			body: JSON.stringify(message),
			signal: AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS),
			redirect: "error",
		});

		const sessionId = response.headers.get("mcp-session-id");
		if (sessionId) this.httpSessionId = sessionId;
		const contentLength = Number(response.headers.get("content-length") ?? 0);
		if (contentLength > 10 * 1024 * 1024) {
			throw new Error("MCP HTTP response exceeds 10 MB");
		}

		const text = await response.text();
		if (Buffer.byteLength(text, "utf8") > 10 * 1024 * 1024) {
			throw new Error("MCP HTTP response exceeds 10 MB");
		}
		if (!response.ok) {
			throw new Error(
				this.redactor.redactText(text || `MCP HTTP error ${response.status}`),
			);
		}

		if (!text.trim()) return {};
		const contentType = response.headers.get("content-type") ?? "";
		if (contentType.includes("text/event-stream") || text.includes("data:")) {
			const dataLine = text
				.split(/\r?\n/)
				.map((line) => line.trim())
				.find((line) => line.startsWith("data:"));
			if (!dataLine) return {};
			return JSON.parse(dataLine.slice("data:".length).trim());
		}

		return JSON.parse(text);
	}

	private processBuffer() {
		let newlineIndex = this.buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = this.buffer.slice(0, newlineIndex).trim();
			this.buffer = this.buffer.slice(newlineIndex + 1);

			if (!line) {
				newlineIndex = this.buffer.indexOf("\n");
				continue;
			}

			try {
				const message = JSON.parse(line);
				this.handleMessage(message);
			} catch (error) {
				// Ignore non-JSON lines (mcp-remote might print text to stdout in some cases)
			}
			newlineIndex = this.buffer.indexOf("\n");
		}
	}

	private handleMessage(message: Record<string, unknown>) {
		if (message.jsonrpc !== "2.0") return;

		if (
			"id" in message &&
			typeof message.id === "string" &&
			this.pendingRequests.has(message.id)
		) {
			const request = this.pendingRequests.get(message.id);
			if (request) {
				this.pendingRequests.delete(message.id);

				if ("error" in message && message.error) {
					request.reject(
						new Error(
							this.redactor.redactText(
								(message.error as Record<string, string>).message ||
									"JSON-RPC Error",
							),
						),
					);
				} else {
					request.resolve(message.result);
				}
			}
		}
	}
}
