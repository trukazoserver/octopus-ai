import type { MCPServerConfig } from "../types.js";
import { MCPClient } from "./client.js";

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
		try {
			await this.connectServer(name);
		} catch (err) {
			entry.status = "error";
			entry.error = err instanceof Error ? err.message : String(err);
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
		for (const tool of existing.tools) {
			this.toolToServer.delete(tool);
		}
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
		existing.status = "disconnected";
		existing.tools = [];
		existing.error = undefined;
		try {
			await this.connectServer(name);
		} catch (err) {
			existing.status = "error";
			existing.error = err instanceof Error ? err.message : String(err);
		}
		return existing;
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
		return client.request(toolName, params);
	}

	findServerForTool(toolName: string): string | undefined {
		return this.toolToServer.get(toolName);
	}

	private async connectServer(name: string): Promise<void> {
		const entry = this.servers.get(name);
		if (!entry) return;

		const client = new MCPClient({
			command: entry.config.command,
			args: entry.config.args ?? [],
			env: entry.config.env,
		});

		await client.connect();
		this.clients.set(name, client);
		entry.status = "connected";
		entry.error = undefined;

		try {
			const toolsResult = await client.request("tools/list", {});
			if (typeof toolsResult === "object" && toolsResult !== null) {
				const tools =
					(toolsResult as { tools?: Array<{ name: string }> }).tools ?? [];
				entry.tools = tools.map((t) => t.name);
				for (const tool of tools) {
					this.toolToServer.set(tool.name, name);
				}
			}
		} catch {
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
