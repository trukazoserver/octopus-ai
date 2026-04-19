import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { MCPServerConfig } from "../types.js";

export class MCPClient {
	private config: MCPServerConfig;
	private process: ChildProcess | null = null;
	// biome-ignore lint/suspicious/noExplicitAny: JSON-RPC results can be any type
	private pendingRequests = new Map<
		string,
		{ resolve: (val: any) => void; reject: (err: any) => void }
	>();
	private buffer = "";

	constructor(config: MCPServerConfig) {
		this.config = config;
	}

	public async connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			try {
				this.process = spawn(this.config.command, this.config.args || [], {
					env: { ...process.env, ...this.config.env },
					stdio: ["pipe", "pipe", "inherit"],
				});

				this.process.on("error", (err) => {
					if (this.pendingRequests.size === 0) {
						reject(err);
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
						this.processBuffer();
					});
				}

				this.request("ping", {})
					.then(() => {
						resolve();
					})
					.catch((err) => {
						reject(err);
					});
			} catch (error) {
				reject(error);
			}
		});
	}

	public async disconnect(): Promise<void> {
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

	public async request<T>(method: string, params: unknown): Promise<T> {
		return new Promise((resolve, reject) => {
			if (!this.process || !this.process.stdin) {
				return reject(new Error("Process is not running"));
			}

			const id = randomUUID();
			this.pendingRequests.set(id, { resolve, reject });

			const message = {
				jsonrpc: "2.0",
				id,
				method,
				params,
			};

			this.process.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
				if (error) {
					this.pendingRequests.delete(id);
					reject(error);
				}
			});
		});
	}

	public notify(method: string, params: unknown): void {
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
				console.error("Failed to parse JSON-RPC message:", error);
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
							(message.error as Record<string, string>).message ||
								"JSON-RPC Error",
						),
					);
				} else {
					request.resolve(message.result);
				}
			}
		}
	}
}
