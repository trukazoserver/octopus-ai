import type { MCPServerConfig, Plugin, SlashCommand } from "./types.js";

export class PluginRegistry {
	private plugins: Map<string, Plugin> = new Map();

	public register(plugin: Plugin): void {
		this.plugins.set(plugin.manifest.name, plugin);
	}

	public async unregister(name: string): Promise<void> {
		const plugin = this.plugins.get(name);
		if (plugin) {
			if (plugin.onUnload) {
				await plugin.onUnload();
			}
			this.plugins.delete(name);
		}
	}

	public get(name: string): Plugin | undefined {
		return this.plugins.get(name);
	}

	public getAll(): Plugin[] {
		return Array.from(this.plugins.values());
	}

	public getCommands(): SlashCommand[] {
		const commands: SlashCommand[] = [];
		for (const plugin of this.plugins.values()) {
			if (plugin.commands) {
				commands.push(...plugin.commands);
			}
		}
		return commands;
	}

	public getMCPServers(): MCPServerConfig[] {
		const servers: MCPServerConfig[] = [];
		for (const plugin of this.plugins.values()) {
			if (plugin.mcpServers) {
				servers.push(...plugin.mcpServers);
			}
		}
		return servers;
	}
}
