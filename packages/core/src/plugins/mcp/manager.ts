import { EnvironmentFilter } from "../../security/environment-filter.js";
import { SecretRedactor } from "../../security/secret-redactor.js";
import type { ToolDefinition, ToolRegistry } from "../../tools/registry.js";
import type { MCPServerConfig } from "../types.js";
import { MCPClient } from "./client.js";

export interface MCPManagerOptions {
	envFilter?: EnvironmentFilter;
	redactor?: SecretRedactor;
}

interface MCPToolSchemaProperty {
	type?: string;
	description?: string;
}

interface MCPToolSchema {
	properties?: Record<string, MCPToolSchemaProperty>;
	required?: string[];
}

interface MCPListedTool {
	name: string;
	description?: string;
	inputSchema?: MCPToolSchema;
}

interface MCPToolResultContentItem extends Record<string, unknown> {
	text?: string;
}

interface MCPToolResult {
	content?: MCPToolResultContentItem[];
}

export interface MCPManagedServer {
	name: string;
	config: MCPServerConfig;
	status: "connected" | "disconnected" | "error";
	tools: string[];
	error?: string;
}

export class MCPManager {
	private servers: Map<string, MCPManagedServer> = new Map();
	private clients: Map<string, MCPClient> = new Map();
	private toolToServer: Map<string, string> = new Map();
	private persistCallback?: (servers: Record<string, MCPServerConfig>) => void;
	private toolRegistry?: ToolRegistry;
	private envFilter: EnvironmentFilter;
	private redactor: SecretRedactor;

	constructor(options: MCPManagerOptions = {}) {
		this.envFilter = options.envFilter ?? new EnvironmentFilter();
		this.redactor = options.redactor ?? new SecretRedactor();
	}

	setToolRegistry(registry: ToolRegistry): void {
		this.toolRegistry = registry;
	}

	setPersistCallback(
		cb: (servers: Record<string, MCPServerConfig>) => void,
	): void {
		this.persistCallback = cb;
	}

	private persist(): void {
		if (!this.persistCallback) return;
		const entries: Record<string, MCPServerConfig> = {};
		for (const [name, entry] of this.servers) {
			entries[name] = entry.config;
		}
		this.persistCallback(entries);
	}

	async loadPersisted(configs: Record<string, MCPServerConfig>): Promise<void> {
		for (const [name, config] of Object.entries(configs)) {
			if (this.servers.has(name)) continue;
			await this.addServer(name, config);
		}
	}

	async syncServers(configs: Record<string, MCPServerConfig>): Promise<void> {
		const currentNames = new Set(this.servers.keys());
		const targetNames = new Set(Object.keys(configs));

		for (const name of currentNames) {
			if (!targetNames.has(name)) {
				await this.removeServer(name);
			}
		}

		for (const [name, config] of Object.entries(configs)) {
			const existing = this.servers.get(name);
			if (!existing) {
				await this.addServer(name, config);
			} else if (JSON.stringify(existing.config) !== JSON.stringify(config)) {
				await this.removeServer(name);
				await this.addServer(name, config);
			}
		}

		this.persist();
	}

	async addServer(
		name: string,
		config: MCPServerConfig,
	): Promise<MCPManagedServer> {
		const entry: MCPManagedServer = {
			name,
			config,
			status: "disconnected",
			tools: [],
		};
		this.servers.set(name, entry);
		if (config.enabled !== false) {
			try {
				await this.connectServer(name);
			} catch (err) {
				entry.status = "error";
				entry.error = this.redactError(err);
			}
		}
		this.persist();
		return entry;
	}

	async setServerEnabled(
		name: string,
		enabled: boolean,
	): Promise<MCPManagedServer | null> {
		const entry = this.servers.get(name);
		if (!entry) return null;
		entry.config.enabled = enabled;

		const client = this.clients.get(name);
		if (!enabled) {
			if (client) {
				try {
					await client.disconnect();
				} catch {
					/* ignore */
				}
				this.clients.delete(name);
			}
			this.unregisterPublishedTools(entry.tools);
			entry.tools = [];
			entry.status = "disconnected";
			entry.error = undefined;
			this.persist();
			return entry;
		}

		if (!client) {
			entry.status = "disconnected";
			entry.error = undefined;
			try {
				await this.connectServer(name);
			} catch (err) {
				entry.status = "error";
				entry.error = this.redactError(err);
			}
		}
		this.persist();
		return entry;
	}

	async removeServer(name: string): Promise<boolean> {
		const client = this.clients.get(name);
		if (client) {
			try {
				await client.disconnect();
			} catch {
				/* ignore */
			}
			this.clients.delete(name);
		}
		const existing = this.servers.get(name);
		if (!existing) return false;
		this.unregisterPublishedTools(existing.tools);
		this.servers.delete(name);
		this.persist();
		return true;
	}

	async restartServer(name: string): Promise<MCPManagedServer | null> {
		const existing = this.servers.get(name);
		if (!existing) return null;
		const client = this.clients.get(name);
		if (client) {
			try {
				await client.disconnect();
			} catch {
				/* ignore */
			}
			this.clients.delete(name);
		}
		this.unregisterPublishedTools(existing.tools);
		existing.status = "disconnected";
		existing.tools = [];
		existing.error = undefined;
		if (existing.config.enabled === false) {
			this.persist();
			return existing;
		}
		try {
			await this.connectServer(name);
		} catch (err) {
			existing.status = "error";
			existing.error = this.redactError(err);
		}
		return existing;
	}

	private redactError(error: unknown): string {
		return this.redactor.redactText(
			error instanceof Error ? error.message : String(error),
		);
	}

	listServers(): MCPManagedServer[] {
		return Array.from(this.servers.values());
	}

	getServer(name: string): MCPManagedServer | undefined {
		return this.servers.get(name);
	}

	async callTool(
		serverName: string,
		toolName: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		const client = this.clients.get(serverName);
		if (!client) throw new Error(`MCP server "${serverName}" not connected`);
		// Use the proper MCP "tools/call" method instead of raw request
		return client.callTool(toolName, params);
	}

	findServerForTool(toolName: string): string | undefined {
		return this.toolToServer.get(toolName);
	}

	private unregisterPublishedTools(toolNames: string[]): void {
		for (const toolName of toolNames) {
			this.toolToServer.delete(toolName);
			this.toolRegistry?.unregister(toolName);
		}
	}

	private getPublishedToolName(serverName: string, toolName: string): string {
		const isUnused =
			!this.toolToServer.has(toolName) && !this.toolRegistry?.has(toolName);
		if (isUnused) return toolName;

		const baseAlias = `${serverName}__${toolName}`;
		let alias = baseAlias;
		let suffix = 2;
		while (this.toolToServer.has(alias) || this.toolRegistry?.has(alias)) {
			alias = `${baseAlias}_${suffix}`;
			suffix += 1;
		}
		return alias;
	}

	private async connectServer(name: string): Promise<void> {
		const entry = this.servers.get(name);
		if (!entry) return;
		if (entry.config.enabled === false) {
			entry.status = "disconnected";
			entry.tools = [];
			entry.error = undefined;
			return;
		}

		const client = new MCPClient(
			{
				...entry.config,
				args: entry.config.args ?? [],
			},
			{ envFilter: this.envFilter, redactor: this.redactor },
		);

		await client.connect();
		this.clients.set(name, client);
		entry.status = "connected";
		entry.error = undefined;
		const publishedToolNames: string[] = [];

		try {
			const toolsResult = await client.request("tools/list", {});
			if (typeof toolsResult === "object" && toolsResult !== null) {
				const tools = (toolsResult as { tools?: MCPListedTool[] }).tools ?? [];

				for (const tool of tools) {
					const publishedToolName = this.getPublishedToolName(name, tool.name);
					publishedToolNames.push(publishedToolName);
					this.toolToServer.set(publishedToolName, name);

					// If we have a global ToolRegistry attached, register the MCP tool
					if (this.toolRegistry) {
						const parameters: Record<
							string,
							{ type: string; description: string; required?: boolean }
						> = {};

						if (tool.inputSchema?.properties) {
							const requiredFields = Array.isArray(tool.inputSchema.required)
								? tool.inputSchema.required
								: [];

							for (const [key, prop] of Object.entries(
								tool.inputSchema.properties,
							)) {
								parameters[key] = {
									type: prop.type || "string",
									description: prop.description || "",
									required: requiredFields.includes(key),
								};
							}
						}

						const toolDef: ToolDefinition = {
							name: publishedToolName,
							description: tool.description || `MCP Tool: ${tool.name}`,
							metadata: {
								source: "mcp",
								serverName: name,
								originalToolName: tool.name,
							},
							parameters,
							handler: async (params: Record<string, unknown>) => {
								try {
									const result = await this.callTool(name, tool.name, params);

									// MCP protocol usually returns result.content[0].text
									let outputStr = "";
									if (
										result &&
										typeof result === "object" &&
										"content" in result
									) {
										const content = (result as MCPToolResult).content;
										if (Array.isArray(content) && content.length > 0) {
											outputStr = content
												.map((item) => item.text || JSON.stringify(item))
												.join("\n");
										} else {
											outputStr = JSON.stringify(result);
										}
									} else {
										outputStr =
											typeof result === "string"
												? result
												: JSON.stringify(result);
									}

									return {
										success: true,
										output: outputStr,
									};
								} catch (err) {
									return {
										success: false,
										output: "",
										error: this.redactError(err),
									};
								}
							},
						};

						this.toolRegistry.register(toolDef);
					}
				}
				entry.tools = publishedToolNames;
			}
		} catch (e) {
			this.unregisterPublishedTools(publishedToolNames);
			console.error(
				`Error loading tools for MCP server ${name}:`,
				this.redactError(e),
			);
			entry.tools = [];
		}
	}

	async shutdown(): Promise<void> {
		for (const [name] of this.clients) {
			const client = this.clients.get(name);
			if (client) {
				try {
					await client.disconnect();
				} catch {
					/* ignore */
				}
			}
		}
		this.clients.clear();
		for (const entry of this.servers.values()) {
			entry.status = "disconnected";
		}
	}
}
